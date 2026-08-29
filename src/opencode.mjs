import crossSpawn from "cross-spawn";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SECRET_ENV_KEYS = new Set([
  "PIPA_SLACK_APP_TOKEN",
  "PIPA_SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
]);
const LISTENING_URL = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/u;

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;
const ARTIFACT_MARKER = "PIPA_ARTIFACTS:";
const MAX_ARTIFACT_DECLARATION_BYTES = 8 * 1024;
const MAX_ARTIFACT_PATH_BYTES = 1024;
const MAX_ARTIFACT_FILES = 10;

export class PipaStoppedError extends Error {
  constructor(message = "Pipa is shutting down.") {
    super(message);
  }
}

export function cleanChildEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !SECRET_ENV_KEYS.has(key.toUpperCase())));
}

export async function startSocketOpenCodeServer(config, options = {}) {
  const environment = options.environment ?? process.env;
  const attachUrl = options.attachUrl ?? environment.PIPA_OPENCODE_ATTACH_URL?.trim();
  const fetchImpl = options.fetch ?? fetch;
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  const headers = authenticationHeaders(environment);

  if (attachUrl) {
    const baseUrl = normalizeBaseUrl(attachUrl);
    await waitForWorkspace(baseUrl, config.workingDirectory, fetchImpl, headers, startupTimeoutMs);
    return externalServer(baseUrl);
  }

  const spawn = options.spawn ?? crossSpawn;
  const platform = options.platform ?? process.platform;
  const child = spawn("opencode", [
    "serve",
    "--hostname", "127.0.0.1",
    "--port", "0",
    "--log-level", "ERROR",
  ], {
    cwd: config.workingDirectory,
    env: cleanChildEnvironment(environment),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = waitForExit(child);

  try {
    const baseUrl = await Promise.race([
      readListeningUrl(child, startupTimeoutMs),
      exit.then((code) => { throw new Error(`OpenCode server exited before startup with code ${code}.`); }),
    ]);
    child.stdout?.resume();
    child.stderr?.resume();
    await Promise.race([
      waitForWorkspace(baseUrl, config.workingDirectory, fetchImpl, headers, startupTimeoutMs),
      exit.then((code) => { throw new Error(`OpenCode server exited before startup with code ${code}.`); }),
    ]);
    return ownedServer(baseUrl, child, exit, platform);
  } catch (error) {
    terminateChild(child, platform);
    await Promise.race([exit.catch(() => undefined), delay(5_000)]);
    throw error;
  }
}

export function createOpenCodeExecutor(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? fetch;
  const environment = options.environment ?? process.env;
  const headers = authenticationHeaders(environment);
  const timeoutMs = options.timeoutMs ?? 2.5 * 60 * 60 * 1000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const useDataUrls = !isLoopbackUrl(baseUrl);
  const remove = options.rm ?? rm;
  const artifactRoot = options.artifactRoot;
  const active = new Set();
  const activeSessions = new Map();
  let stopReason;

  async function request(pathname, init, workingDirectory, controller, acceptedStatuses = [200], reportFatal = true) {
    const url = serverUrl(baseUrl, pathname, workingDirectory);
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        headers: {
          ...headers,
          ...(init.body ? { "content-type": "application/json" } : {}),
          ...init.headers,
        },
        signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeoutMs)]),
      });
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (reportFatal && isNetworkError(error)) options.onFatal?.(new Error("OpenCode server became unavailable."));
      throw error;
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (reportFatal && isNetworkError(error)) options.onFatal?.(new Error("OpenCode server became unavailable."));
      throw error;
    }
    if (!acceptedStatuses.includes(response.status)) throw new OpenCodeRequestError(response.status);
    if (!text) return undefined;
    try {
      return JSON.parse(text);
    } catch {
      throw new Error("OpenCode returned an invalid response.");
    }
  }

  async function runTurn({ prompt, sessionId, workingDirectory, contextEnvironment = {}, attachments = [], signal, onSession, onInteraction, onPermissionReplied, onPermissionsReconciled }) {
    if (!prompt?.trim()) throw new Error("A prompt is required.");
    if (stopReason) throw stopReason;
    const temporaryDirectory = attachments.length ? await mkdtemp(path.join(os.tmpdir(), "pipa-files-")) : null;
    const slackTurn = contextEnvironment.PIPA_MESSAGE_CHANNEL === "slack";
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(new Error(`OpenCode timed out after ${timeoutMs}ms.`)), timeoutMs);
    active.add(controller);
    let artifactDirectory;

    try {
      try {
        const files = await stageAttachments(attachments, temporaryDirectory, timeoutMs, useDataUrls, controller.signal);
        if (stopReason) throw stopReason;
        let selectedSessionId = sessionId;
        let messages;
        if (selectedSessionId) {
          try {
            while (true) {
              const status = (await request("/session/status", { method: "GET" }, workingDirectory, controller))?.[selectedSessionId]?.type;
              if (status !== "busy" && status !== "retry") break;
              await delay(pollIntervalMs, controller.signal);
            }
            messages = await request(`/session/${encodeURIComponent(selectedSessionId)}/message?limit=1`, { method: "GET" }, workingDirectory, controller);
          } catch (error) {
            if (!(error instanceof OpenCodeRequestError) || error.status !== 404) throw error;
            selectedSessionId = null;
          }
        }
        if (!selectedSessionId) {
          const session = await request("/session", { method: "POST", body: "{}" }, workingDirectory, controller);
          if (!session?.id) throw new Error("OpenCode did not create a session.");
          selectedSessionId = session.id;
          messages = [];
        }

        activeSessions.set(selectedSessionId, { controller, workingDirectory });
        await onSession?.(selectedSessionId);
        if (controller.signal.aborted) throw controller.signal.reason;

        if (slackTurn && !useDataUrls && artifactRoot) {
          try {
            await mkdir(artifactRoot, { recursive: true, mode: 0o700 });
            artifactDirectory = await sessionArtifactDirectory(artifactRoot, selectedSessionId, workingDirectory);
            await remove(artifactDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
            await mkdir(artifactDirectory, { mode: 0o700 });
            await chmod(artifactDirectory, 0o700);
          } catch {}
        }

        const baseline = new Set(messages.map((message) => message?.info?.id).filter(Boolean));
        let dismissed = false;
        let permissionRejected = false;
        if (onInteraction) {
          const watcher = watchInteractions({
            baseUrl,
            fetchImpl,
            headers,
            requestTimeoutMs,
            sessionId: selectedSessionId,
            workingDirectory,
            controller,
            onInteraction,
            onPermissionReplied,
            onPermissionsReconciled,
            onPermissionRejected: () => { permissionRejected = true; },
            onDismiss: () => { dismissed = true; },
            requestTurn: request,
          });
          await watcher.ready;
        }
        await request(`/session/${encodeURIComponent(selectedSessionId)}/prompt_async`, {
          method: "POST",
          body: JSON.stringify(promptBody(prompt.trim(), files, contextEnvironment, artifactDirectory)),
        }, workingDirectory, controller, [204]);

        while (true) {
          const [currentMessages, statuses] = await Promise.all([
            request(`/session/${encodeURIComponent(selectedSessionId)}/message?limit=1`, { method: "GET" }, workingDirectory, controller),
            request("/session/status", { method: "GET" }, workingDirectory, controller),
          ]);
          const finalMessage = latestAssistantMessage(currentMessages, baseline);
          const status = statuses?.[selectedSessionId]?.type;
          if (dismissed && status !== "busy" && status !== "retry") return { text: "", sessionId: selectedSessionId };
          if (["error", "failed", "cancelled"].includes(status) || finalMessage?.error) throw new Error("OpenCode failed to complete the turn.");
          if (finalMessage && (status === "idle" || (!status && finalMessage.completed))) {
            if (!finalMessage.text && permissionRejected) return { text: "Stopped after a permission was rejected.", sessionId: selectedSessionId };
            if (!finalMessage.text) throw new Error("OpenCode completed without assistant text.");
            const parsed = slackTurn ? parseArtifactDeclaration(finalMessage.text) : { text: finalMessage.text };
            const artifacts = artifactDirectory && parsed.paths ? await readArtifacts(artifactDirectory, parsed.paths, options.onArtifactOpened) : [];
            return {
              text: parsed.text,
              sessionId: selectedSessionId,
              ...(artifacts.length ? { files: artifacts } : {}),
            };
          }
          await delay(pollIntervalMs, controller.signal);
        }
      } finally {
        clearTimeout(timer);
        controller.abort(new Error("OpenCode turn completed."));
        active.delete(controller);
        for (const [sessionId, turn] of activeSessions) {
          if (turn.controller === controller) activeSessions.delete(sessionId);
        }
      }
    } catch (error) {
      if (stopReason) throw stopReason;
      throw error;
    } finally {
      if (temporaryDirectory) {
        try {
          await remove(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
          process.stderr.write("Pipa could not remove temporary attachment files.\n");
        }
      }
      if (artifactDirectory) {
        try {
          await remove(artifactDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch {
          process.stderr.write("Pipa could not remove temporary artifact files.\n");
        }
      }
      signal?.removeEventListener("abort", abort);
    }
  }

  return {
    runTurn,
    async abortTurn(sessionId, reason = new Error("OpenCode turn aborted.")) {
      const turn = activeSessions.get(sessionId);
      if (!turn) return;
      const abortController = new AbortController();
      try {
        await request(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }, turn.workingDirectory, abortController, [200, 204, 404], false);
      } catch {
        // Local cancellation still supersedes the turn if OpenCode's abort request fails.
      } finally {
        abortController.abort(reason);
        turn.controller.abort(reason);
      }
    },
    stopAll(reason = new PipaStoppedError()) {
      stopReason ??= reason;
      for (const controller of active) controller.abort(stopReason);
    },
  };
}

async function sessionArtifactDirectory(root, sessionId, workingDirectory) {
  if (!/^[A-Za-z0-9_-]{1,200}$/u.test(sessionId)) throw new Error("OpenCode returned an invalid session ID.");
  const stats = await lstat(root);
  if (!stats.isDirectory() || stats.isSymbolicLink()) throw new Error("Pipa's artifact root must be a directory, not a symlink.");
  const [resolvedRoot, resolvedWorkingDirectory] = await Promise.all([realpath(root), realpath(workingDirectory)]);
  const relative = path.relative(resolvedWorkingDirectory, resolvedRoot);
  if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Pipa's artifact root must be inside the working directory.");
  return path.join(resolvedRoot, sessionId);
}

export function startOpenCodeServer(config, options = {}) {
  const spawn = options.spawn ?? crossSpawn;
  const platform = options.platform ?? process.platform;
  const child = spawn("opencode", [
    "serve",
    "--hostname", config.openCodeHostname,
    "--port", String(config.openCodePort),
    "--log-level", "ERROR",
  ], {
    cwd: config.workingDirectory,
    env: cleanChildEnvironment(options.environment ?? process.env),
    shell: false,
    stdio: "inherit",
  });
  let stopping = false;
  const exit = waitForExit(child).then((code) => {
    if (!stopping) throw new Error(`OpenCode server exited unexpectedly with code ${code}.`);
  });

  return {
    wait: () => exit,
    stop(signal) {
      if (stopping) return;
      stopping = true;
      terminateChild(child, platform, signal);
    },
  };
}

export async function runOpenCodeVersion(options = {}) {
  const spawn = options.spawn ?? crossSpawn;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = spawn("opencode", ["--version"], {
    env: cleanChildEnvironment(options.environment ?? process.env),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timer;
  try {
    const operation = Promise.all([collect(child.stdout), collect(child.stderr), waitForExit(child)]);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        terminateChild(child, platform);
        reject(new Error(`OpenCode version check timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    });
    const [stdout, stderr, code] = await Promise.race([operation, timeout]);
    if (code !== 0) throw new Error(stderr.trim() || "OpenCode version check failed.");
    return stdout.trim();
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("OpenCode is unavailable. Install it and make sure `opencode --version` succeeds.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function stageAttachments(attachments, temporaryDirectory, timeoutMs, useDataUrls, signal) {
  const files = [];
  for (const [index, attachment] of attachments.entries()) {
    let data;
    try {
      data = await fetchAttachment(attachment, timeoutMs, signal);
    } catch {
      throw new Error("Could not read one of the attached files. Please try uploading it again.");
    }
    if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Attached files must be 100 MB or smaller.");
    try {
      const filename = sanitizeFilename(path.basename(attachment.name || "attachment"), "attachment");
      const file = path.join(temporaryDirectory, `${index + 1}-${filename}`);
      await writeFile(file, data);
      const mime = attachment.mimeType || "application/octet-stream";
      files.push({
        filename,
        mime,
        url: useDataUrls ? `data:${mime};base64,${Buffer.from(data).toString("base64")}` : pathToFileURL(file).href,
      });
    } catch {
      throw new Error("Could not read one of the attached files. Please try uploading it again.");
    }
  }
  return files;
}

function promptBody(prompt, files, contextEnvironment, artifactDirectory) {
  const parts = [{ type: "text", text: prompt }, ...files.map((file) => ({ type: "file", ...file }))];
  const context = Object.entries(contextEnvironment).filter(([, value]) => value !== undefined && value !== null && String(value));
  const instructions = [];
  if (context.length) instructions.push(`Slack context for this turn (provided here, not as shell environment variables):\n${context.map(([key, value]) => `${key}=${value}`).join("\n")}`);
  if (contextEnvironment.PIPA_MESSAGE_CHANNEL === "slack") {
    instructions.push("Keep naturally short answers inline. For deeper work or larger deliverables, keep the Slack response concise and use the most suitable artifact format.");
    if (artifactDirectory) instructions.push(`To attach files, copy up to 10 top-level files (100 MB total) to this private artifact directory: ${artifactDirectory}\nEnd with exactly one final line: ${ARTIFACT_MARKER} [\"report.csv\",\"brief.pdf\"]`);
  }
  return {
    parts,
    ...(instructions.length ? { system: instructions.join("\n\n") } : {}),
  };
}

function parseArtifactDeclaration(text) {
  const lines = text.split(/\r?\n/u);
  const declarations = lines.map((line, index) => line.startsWith(ARTIFACT_MARKER) ? { line, index } : null).filter(Boolean);
  const cleanText = lines.filter((line) => !line.startsWith(ARTIFACT_MARKER)).join("\n").trim();
  const lastNonblank = lines.findLastIndex((line) => line.trim());
  if (declarations.length !== 1 || declarations[0].index !== lastNonblank) return { text: cleanText };
  const declaration = declarations[0].line;
  if (!declaration.startsWith(`${ARTIFACT_MARKER} `) || Buffer.byteLength(declaration) > MAX_ARTIFACT_DECLARATION_BYTES) return { text: cleanText };
  let paths;
  try {
    paths = JSON.parse(declaration.slice(ARTIFACT_MARKER.length + 1));
  } catch {
    return { text: cleanText };
  }
  if (!Array.isArray(paths) || !paths.length || paths.length > MAX_ARTIFACT_FILES || paths.some((item) => typeof item !== "string")) return { text: cleanText };
  if (new Set(paths).size !== paths.length || paths.some((item) => !validArtifactPath(item))) return { text: cleanText };
  return { text: cleanText, paths };
}

function validArtifactPath(value) {
  if (!value || Buffer.byteLength(value) > MAX_ARTIFACT_PATH_BYTES || value.includes("\0") || value.includes("\\") || path.isAbsolute(value)) return false;
  const parts = value.split("/");
  return parts.length === 1 && parts[0] !== "." && parts[0] !== "..";
}

async function readArtifacts(directory, paths, onOpened) {
  const files = [];
  let total = 0;
  try {
    const root = await realpath(directory);
    for (const relativePath of paths) {
      const filename = path.resolve(root, relativePath);
      if (!filename.startsWith(`${root}${path.sep}`)) throw new Error("Artifact path escaped its directory.");
      let current = root;
      for (const part of relativePath.split("/")) {
        current = path.join(current, part);
        if ((await lstat(current)).isSymbolicLink()) throw new Error("Artifact path contains a symbolic link.");
      }
      const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const before = await handle.stat({ bigint: true });
        await onOpened?.(filename);
        const size = Number(before.size);
        if (!before.isFile() || size > MAX_ATTACHMENT_BYTES || total + size > MAX_ATTACHMENT_BYTES) throw new Error("Artifact exceeds delivery limits.");
        const data = Buffer.alloc(size + 1);
        let bytesRead = 0;
        while (bytesRead < data.length) {
          const read = await handle.read(data, bytesRead, data.length - bytesRead, bytesRead);
          if (!read.bytesRead) break;
          bytesRead += read.bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const current = await lstat(filename, { bigint: true });
        if (bytesRead !== size || changedFile(before, after) || current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino) throw new Error("Artifact changed while being read.");
        total += size;
        files.push({ data: data.subarray(0, size), filename: sanitizeFilename(path.basename(relativePath)) });
      } finally {
        await handle.close();
      }
    }
    return files;
  } catch {
    return [];
  }
}

function changedFile(before, after) {
  return before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs;
}

function sanitizeFilename(value, fallback = "artifact") {
  const sanitized = value.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_").replace(/[. ]+$/u, "");
  return Array.from(sanitized).reduce((result, character) => Buffer.byteLength(result + character) <= 200 ? result + character : result, "") || fallback;
}

function latestAssistantMessage(messages, baseline) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message?.info?.id || baseline.has(message.info.id) || message.info.role !== "assistant") continue;
    return {
      completed: typeof message.info.time?.completed === "number",
      error: message.info.error,
      text: message.parts
        .filter((part) => part.type === "text" && typeof part.text === "string" && part.text)
        .map((part) => part.text)
        .join("\n")
        .trim(),
    };
  }
  return null;
}

function ownedServer(baseUrl, child, exit, platform) {
  let stopping = false;
  let rejectFailure;
  const failure = new Promise((_, reject) => rejectFailure = reject);
  const wait = Promise.race([exit.then((code) => {
    if (!stopping) throw new Error(`OpenCode server exited unexpectedly with code ${code}.`);
  }), failure]);
  void wait.catch(() => undefined);
  return {
    baseUrl,
    owned: true,
    wait: () => wait,
    fail(error) {
      if (!stopping) rejectFailure(error);
    },
    stop(signal = "SIGTERM") {
      if (stopping) return;
      stopping = true;
      terminateChild(child, platform, signal);
    },
  };
}

function externalServer(baseUrl) {
  let resolveWait;
  let rejectWait;
  let stopped = false;
  const wait = new Promise((resolve, reject) => {
    resolveWait = resolve;
    rejectWait = reject;
  });
  void wait.catch(() => undefined);
  return {
    baseUrl,
    owned: false,
    wait: () => wait,
    fail(error) {
      if (!stopped) rejectWait(error);
    },
    stop() {
      if (stopped) return;
      stopped = true;
      resolveWait();
    },
  };
}

async function waitForWorkspace(baseUrl, workingDirectory, fetchImpl, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const status = await fetchImpl(serverUrl(baseUrl, "/session/status", workingDirectory), {
        headers,
        signal: AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - Date.now()))),
      });
      const sessions = status.ok ? await status.json() : null;
      if (sessions && typeof sessions === "object" && !Array.isArray(sessions)
        && Object.values(sessions).every((session) => session && typeof session === "object" && typeof session.type === "string")) return;
    } catch {
      // OpenCode can accept its socket before the configured workspace is ready.
    }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throw new Error("OpenCode workspace readiness check timed out.");
}

function readListeningUrl(child, timeoutMs) {
  return new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => {
      child.stdout?.off("data", inspect);
      child.stderr?.off("data", inspect);
    };
    const finish = (callback, value) => {
      clearTimeout(timer);
      cleanup();
      callback(value);
    };
    const inspect = (chunk) => {
      output = (output + chunk).slice(-16_384);
      const match = output.match(LISTENING_URL);
      if (!match) return;
      finish(resolve, normalizeBaseUrl(match[0]));
    };
    const timer = setTimeout(() => finish(reject, new Error("OpenCode server did not report its listening URL.")), timeoutMs);
    timer.unref?.();
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
  });
}

function authenticationHeaders(environment) {
  const password = environment.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = environment.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

function normalizeBaseUrl(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("OpenCode server URL must use http or https.");
  return url.href.replace(/\/+$/u, "");
}

function isLoopbackUrl(value) {
  const hostname = new URL(value).hostname;
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function serverUrl(baseUrl, pathname, workingDirectory) {
  const url = new URL(`${baseUrl}${pathname}`);
  if (workingDirectory) url.searchParams.set("directory", workingDirectory);
  return url;
}

function fetchAttachment(attachment, timeoutMs, signal) {
  return Promise.race([
    attachment.fetchData(),
    delay(timeoutMs, signal).then(() => { throw new Error(`Attachment download timed out after ${timeoutMs}ms.`); }),
  ]);
}

function delay(delayMs, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const settle = (callback, value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => settle(reject, signal.reason);
    const timer = setTimeout(() => settle(resolve), delayMs);
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function watchInteractions({ baseUrl, fetchImpl, headers, requestTimeoutMs, sessionId, workingDirectory, controller, onInteraction, onPermissionReplied, onPermissionsReconciled, onPermissionRejected, onDismiss, requestTurn }) {
  const seenIds = new Set();
  const messages = new Map();
  const parents = new Map();
  const interactionSessionIds = new Set([sessionId]);
  let resolveReady;
  let rejectReady;
  let subscribed = false;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  const dispatch = async (event) => {
    const type = event.type === "question.asked" ? "question" : event.type === "permission.asked" ? "permission" : null;
    const properties = event.properties && typeof event.properties === "object" ? event.properties : event.data && typeof event.data === "object" ? event.data : event;
    const interactionSessionId = properties?.sessionID ?? properties?.sessionId;
    const requestId = properties?.requestID ?? properties?.requestId ?? properties?.id;
    if (!type || (interactionSessionId !== sessionId && !await belongsToSession(interactionSessionId)) || !requestId || seenIds.has(`${type}:${requestId}`)) return;
    seenIds.add(`${type}:${requestId}`);
    const request = type === "permission" ? await hydratePermission(properties, interactionSessionId) : properties;
    void settleInteraction({ type, requestId, sessionId: interactionSessionId, request, onInteraction, onPermissionRejected, onDismiss, controller, workingDirectory, requestTurn });
  };

  const belongsToSession = async (candidate) => {
    const original = candidate;
    const visited = new Set();
    while (candidate && !visited.has(candidate)) {
      if (candidate === sessionId) {
        interactionSessionIds.add(original);
        return true;
      }
      visited.add(candidate);
      if (!parents.has(candidate)) parents.set(candidate, requestTurn(`/session/${encodeURIComponent(candidate)}`, { method: "GET" }, workingDirectory, controller)
        .then((session) => session?.parentID));
      candidate = await parents.get(candidate);
    }
    return false;
  };

  const hydratePermission = async (permission, interactionSessionId) => {
    const tool = permission.tool;
    if (!tool?.messageID || !tool.callID) return permission;
    if (!messages.has(tool.messageID)) {
      messages.set(tool.messageID, requestTurn(`/session/${encodeURIComponent(interactionSessionId)}/message?limit=100`, { method: "GET" }, workingDirectory, controller)
        .then((items) => items.flatMap((message) => message.info?.id === tool.messageID ? message.parts ?? [] : [])));
    }
    const part = (await messages.get(tool.messageID)).find((item) => item.callID === tool.callID);
    return part ? { ...permission, tool: { ...tool, name: part.tool, input: part.state?.input } } : permission;
  };

  const reconcile = async () => {
    const permissions = await requestTurn("/permission", { method: "GET" }, workingDirectory, controller);
    const pending = (await Promise.all((permissions ?? []).map(async (permission) => {
      return await belongsToSession(permission?.sessionID) ? permission : null;
    }))).filter(Boolean);
    await Promise.all(pending.map((permission) => dispatch({ type: "permission.asked", properties: permission })));
    for (const interactionSessionId of interactionSessionIds) {
      const requests = pending.filter((permission) => permission.sessionID === interactionSessionId);
      onPermissionsReconciled?.({ sessionId: interactionSessionId, requestIds: new Set(requests.map((permission) => permission.id)) });
    }
  };

  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const url = serverUrl(baseUrl, "/event", workingDirectory);
        const response = await fetchImpl(url, {
          headers: { ...headers, accept: "text/event-stream" },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeoutMs)]),
        });
        if (!response.ok) throw new OpenCodeRequestError(response.status);
        await reconcile();
        if (!subscribed) {
          subscribed = true;
          resolveReady();
        }
        for await (const event of readServerSentEvents(response, controller.signal)) {
          if (controller.signal.aborted) return;
          const properties = event.properties && typeof event.properties === "object" ? event.properties : event.data && typeof event.data === "object" ? event.data : event;
          const interactionSessionId = properties?.sessionID ?? properties?.sessionId;
          if (event.type === "permission.replied" && (interactionSessionId === sessionId || await belongsToSession(interactionSessionId))) {
            onPermissionReplied?.({ sessionId: interactionSessionId, requestId: properties?.requestID ?? properties?.requestId, reply: properties?.reply });
            await reconcile();
            continue;
          }
          await dispatch(event);
        }
        await reconcile();
        await delay(250, controller.signal).catch(() => undefined);
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!subscribed) {
          rejectReady(error);
          return;
        }
        await delay(250, controller.signal).catch(() => undefined);
      }
    }
  })();
  return { ready };
}

async function settleInteraction({ type, requestId, sessionId, request: interactionRequest, onInteraction, onPermissionRejected, onDismiss, controller, workingDirectory, requestTurn }) {
  try {
    const decision = await abortable(Promise.resolve().then(() => onInteraction({
      type,
      sessionId,
      request: interactionRequest,
      signal: controller.signal,
    })), controller.signal);
    if (decision?.type === "cancelled" || decision?.type === "stopped") return;
    if (decision?.type === "stop") {
      onDismiss?.();
      if (type === "question") await requestTurn(`/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" }, workingDirectory, controller, [200, 204, 404], false);
      else await requestTurn(`/permission/${encodeURIComponent(requestId)}/reply`, { method: "POST", body: JSON.stringify({ reply: "reject" }) }, workingDirectory, controller, [200, 204, 404], false);
      await requestTurn(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }, workingDirectory, controller, [200, 204], false);
      return;
    }
    if (type === "question" && decision?.type === "answer") {
      await requestTurn(`/question/${encodeURIComponent(requestId)}/reply`, { method: "POST", body: JSON.stringify({ answers: decision.answers }) }, workingDirectory, controller, [200, 204, 404], false);
    } else if (type === "question" && decision?.type === "reject") {
      await requestTurn(`/question/${encodeURIComponent(requestId)}/reject`, { method: "POST" }, workingDirectory, controller, [200, 204, 404], false);
    } else if (type === "permission" && (decision?.type === "reply" || decision?.type === "reject")) {
      const reply = decision.type === "reject" ? "reject" : decision.reply;
      if (!["once", "always", "reject"].includes(reply)) throw new Error("Invalid OpenCode permission decision.");
      if (reply === "reject") onPermissionRejected?.();
      await requestTurn(`/permission/${encodeURIComponent(requestId)}/reply`, { method: "POST", body: JSON.stringify({ reply }) }, workingDirectory, controller, [200, 204, 404], false);
    } else {
      throw new Error(`Invalid OpenCode ${type} decision.`);
    }
  } catch (error) {
    if (!controller.signal.aborted) process.stderr.write(`OpenCode interaction handler error: ${error.message}\n`);
  }
}

async function* readServerSentEvents(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const abort = () => reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = chunk.split("\n");
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trim();
        const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        if (data) {
          try {
            const event = JSON.parse(data);
            yield type ? { id, type, data: event } : event;
          } catch { /* ponytail: skip non-JSON SSE frames */ }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally {
    signal?.removeEventListener("abort", abort);
  }
}

function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const settle = (callback, value) => {
      signal.removeEventListener("abort", abort);
      callback(value);
    };
    const abort = () => settle(reject, signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then((value) => settle(resolve, value), (error) => settle(reject, error));
  });
}

function isNetworkError(error) {
  return error instanceof TypeError || ["ECONNREFUSED", "ECONNRESET", "EPIPE"].includes(error?.cause?.code ?? error?.code);
}

class OpenCodeRequestError extends Error {
  constructor(status) {
    super(`OpenCode request failed with status ${status}.`);
    this.status = status;
  }
}

function collect(stream, limit = 10 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let output = "";
    stream.on("data", (chunk) => {
      output += chunk;
      if (output.length > limit) stream.destroy(new Error("OpenCode output exceeded 10 MB."));
    });
    stream.once("error", reject);
    stream.once("end", () => resolve(output));
  });
}

function waitForExit(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve(code ?? 1));
  });
}

function terminateChild(child, platform, signal) {
  if (platform === "win32" && child.pid) {
    const taskkill = crossSpawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    const fallback = () => child.kill("SIGKILL");
    taskkill.once("error", fallback);
    taskkill.once("close", (code) => { if (code !== 0) fallback(); });
    const force = setTimeout(fallback, 5_000);
    force.unref?.();
    child.once("close", () => clearTimeout(force));
    return;
  }
  child.kill(signal);
  const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
  force.unref?.();
  child.once("close", () => clearTimeout(force));
}
