import crossSpawn from "cross-spawn";
import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, mkdtemp, open, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createV1Adapter } from "./opencode-v1.mjs";
import { createV2Adapter } from "./opencode-v2.mjs";

const SLACK_SECRET_ENV_KEY = /(?:^|_)SLACK(?:_[A-Z0-9]+)*_(?:TOKEN|SECRET)$/iu;
const LISTENING_URL = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):\d+/u;

export const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;
export const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const ARTIFACT_MARKER = "PIPA_ARTIFACTS:";
const MAX_ARTIFACT_DECLARATION_BYTES = 8 * 1024;
const MAX_ARTIFACT_PATH_BYTES = 1024;
const MAX_ARTIFACT_FILES = 10;

export class PipaStoppedError extends Error {
  constructor(message = "Pipa is shutting down.") {
    super(message);
  }
}

export class PipaRestartingError extends PipaStoppedError {}

export class OpenCodeReadinessError extends Error {}

export function parseOpenCodeVersion(output) {
  const match = /^(?:OpenCode\s+)?v?((0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?)$/iu.exec(String(output ?? "").trim());
  if (!match || match[3]?.split(".").some((part) => /^0\d+$/u.test(part))) throw new Error("OpenCode identity has an invalid version. Check `opencode --version` and the selected server URL.");
  const major = Number(match[2]);
  if (major !== 1 && major !== 2) throw new Error("Unsupported OpenCode major. Install a supported v1 or v2 runtime and check `opencode --version`.");
  return { version: match[1], major };
}

export function cleanChildEnvironment(environment = process.env) {
  return {
    ...Object.fromEntries(Object.entries(environment).filter(([key]) => !SLACK_SECRET_ENV_KEY.test(key))),
    PIPA_HOME: path.resolve(environment.PIPA_HOME || os.homedir()),
  };
}

export async function startSocketOpenCodeServer(config, options = {}) {
  const environment = options.environment ?? process.env;
  const attachUrl = options.attachUrl ?? environment.PIPA_OPENCODE_ATTACH_URL?.trim();
  const startupTimeoutMs = options.startupTimeoutMs ?? 30_000;
  if (attachUrl) {
    const baseUrl = normalizeBaseUrl(attachUrl);
    const connection = await checkOpenCodeConnection(baseUrl, config.workingDirectory, { ...options, environment });
    return { ...externalServer(baseUrl), connection };
  }

  const identity = parseOpenCodeVersion(await (options.checkOpenCode ?? runOpenCodeVersion)(options));
  options.signal?.throwIfAborted();
  const childEnvironment = ownedEnvironment(environment, identity.major);
  const spawn = options.spawn ?? crossSpawn;
  const platform = options.platform ?? process.platform;
  const child = spawn("opencode", [
    "serve",
    "--hostname", "127.0.0.1",
    "--port", "0",
    "--log-level", identity.major === 1 ? "ERROR" : "error",
  ], {
    cwd: config.workingDirectory,
    env: childEnvironment,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exit = waitForExit(child);

  const controller = new AbortController();
  const startupSignal = AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]);
  try {
    const baseUrl = await Promise.race([
      readListeningUrl(child, startupTimeoutMs, startupSignal),
      exit.then((code) => { throw new Error(`OpenCode server exited before startup with code ${code}.`); }),
    ]);
    child.stdout?.resume();
    child.stderr?.resume();
    const connection = await Promise.race([
      checkOpenCodeConnection(baseUrl, config.workingDirectory, { ...options, environment: childEnvironment, identity, signal: startupSignal }),
      exit.then((code) => { throw new Error(`OpenCode server exited before startup with code ${code}.`); }),
    ]);
    return { ...ownedServer(baseUrl, child, exit, platform), connection };
  } catch (error) {
    terminateChild(child, platform);
    await Promise.race([exit.catch(() => undefined), delay(5_000)]);
    throw error;
  } finally {
    controller.abort();
  }
}

export function createOpenCodeExecutor(options = {}) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetch ?? fetch;
  const environment = options.environment ?? process.env;
  let headers = options.connection?.headers ?? authenticationHeaders(environment);
  const pollIntervalMs = options.pollIntervalMs ?? 1_000;
  const useDataUrls = !isLoopbackUrl(baseUrl);
  const remove = options.rm ?? rm;
  const artifactRoot = options.artifactRoot;
  const active = new Set();
  const activeSessions = new Map();
  let adapter;
  let capabilities;
  let readiness;
  let stopReason;

  async function ready(workingDirectory) {
    readiness ??= (async () => {
      const connection = options.connection ?? await checkOpenCodeConnection(baseUrl, workingDirectory, { ...options, environment, fetch: fetchImpl });
      headers = connection.headers ?? headers;
      capabilities = Object.freeze({ modelDiscovery: connection.major === 2, liveModelSwitch: connection.major === 2 });
      adapter = connection.major === 2
        ? createV2Adapter({ ...options, baseUrl, fetch: fetchImpl, headers, environment, pollIntervalMs })
        : createV1Adapter({ request, baseUrl, fetchImpl, headers, pollIntervalMs });
      await adapter.ready?.(workingDirectory);
    })();
    await readiness;
    // Failed turn cleanup blocks subsequent turns even after initial readiness resolved.
    await adapter.ready?.(workingDirectory);
  }

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
        signal: controller.signal,
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
    if (sessionId && activeSessions.has(sessionId)) throw new Error("OpenCode attribution conflict: the session already has an active writer.");
    let temporaryDirectory;
    const slackTurn = contextEnvironment.PIPA_MESSAGE_CHANNEL === "slack";
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    active.add(controller);
    if (sessionId) activeSessions.set(sessionId, { controller, workingDirectory, resolved: false });
    let artifactDirectory;

    try {
      try {
        temporaryDirectory = attachments.length ? await mkdtemp(path.join(os.tmpdir(), "pipa-files-")) : null;
        controller.signal.throwIfAborted();
        const files = await stageAttachments(attachments, temporaryDirectory, useDataUrls, controller.signal);
        if (stopReason) throw stopReason;
        await ready(workingDirectory);
        const prepared = await adapter.resolveSession(sessionId, workingDirectory, controller);
        const selectedSessionId = prepared.sessionId;

        if (activeSessions.has(selectedSessionId) && activeSessions.get(selectedSessionId).controller !== controller) throw new Error("OpenCode attribution conflict: the session already has an active writer.");
        activeSessions.set(selectedSessionId, { controller, workingDirectory, resolved: true });
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

        const text = await adapter.execute({ ...prepared, workingDirectory, controller, prompt, files,
          instructions: turnInstructions(contextEnvironment, artifactDirectory), onInteraction, onPermissionReplied, onPermissionsReconciled });
        const parsed = slackTurn ? parseArtifactDeclaration(text) : { text };
        const artifacts = artifactDirectory && parsed.paths ? await readArtifacts(artifactDirectory, parsed.paths, options.onArtifactOpened) : [];
        return { text: parsed.text, sessionId: selectedSessionId, ...(artifacts.length ? { files: artifacts } : {}) };
      } catch (error) {
        if (controller.signal.aborted) throw controller.signal.reason;
        throw error;
      } finally {
        controller.abort(new Error("OpenCode turn completed."));
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
      active.delete(controller);
      for (const [sessionId, turn] of activeSessions) {
        if (turn.controller === controller) activeSessions.delete(sessionId);
      }
    }
  }

  return {
    // Unknown until authenticated runtime negotiation has completed.
    get capabilities() { return capabilities; },
    ready,
    runTurn,
    async listModels({ workingDirectory, signal } = {}) {
      if (stopReason) throw stopReason;
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      active.add(controller);
      try {
        await ready(workingDirectory);
        controller.signal.throwIfAborted();
        if (!capabilities.modelDiscovery) throw new Error("OpenCode model discovery is not supported by this adapter.");
        const catalog = await adapter.listModels(workingDirectory, controller.signal);
        controller.signal.throwIfAborted();
        return catalog;
      } finally {
        controller.abort();
        active.delete(controller);
        signal?.removeEventListener("abort", abort);
      }
    },
    async switchModel({ sessionId, model, workingDirectory, signal } = {}) {
      if (stopReason) throw stopReason;
      const controller = new AbortController();
      const abort = () => controller.abort(signal.reason);
      if (signal?.aborted) abort();
      else signal?.addEventListener("abort", abort, { once: true });
      active.add(controller);
      try {
        await ready(workingDirectory);
        controller.signal.throwIfAborted();
        if (!capabilities.liveModelSwitch) throw new Error("OpenCode live model switching is not supported by this adapter.");
        return await adapter.switchModel(sessionId, model, workingDirectory, controller.signal);
      } finally {
        controller.abort();
        active.delete(controller);
        signal?.removeEventListener("abort", abort);
      }
    },
    async abortTurn(sessionId, reason = new Error("OpenCode turn aborted.")) {
      const turn = activeSessions.get(sessionId);
      if (!turn) return;
      try {
        if (turn.resolved) await adapter.abortTurn(sessionId, turn.workingDirectory);
      } catch {
        // Local cancellation still supersedes the turn if OpenCode's abort request fails.
      } finally {
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

export async function startOpenCodeServer(config, options = {}) {
  const identity = parseOpenCodeVersion(await (options.checkOpenCode ?? runOpenCodeVersion)(options));
  options.signal?.throwIfAborted();
  const environment = ownedEnvironment(options.environment ?? process.env, identity.major);
  const spawn = options.spawn ?? crossSpawn;
  const platform = options.platform ?? process.platform;
  const child = spawn("opencode", [
    "serve",
    "--hostname", config.openCodeHostname,
    "--port", String(config.openCodePort),
    "--log-level", identity.major === 1 ? "ERROR" : "error",
  ], {
    cwd: config.workingDirectory,
    env: environment,
    shell: false,
    stdio: config.openCodePort === 0 ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  let stopping = false;
  const exit = waitForExit(child).then((code) => {
    if (!stopping) throw new Error(`OpenCode server exited unexpectedly with code ${code}.`);
  });
  void exit.catch(() => undefined);

  const listening = config.openCodePort === 0 ? readListeningUrl(child, options.startupTimeoutMs ?? 30_000, options.signal) : null;
  void listening?.catch(() => undefined);
  const server = {
    async ready() {
      const controller = new AbortController();
      const hostname = config.openCodeHostname.includes(":") && !config.openCodeHostname.startsWith("[") ? `[${config.openCodeHostname}]` : config.openCodeHostname;
      try {
        const baseUrl = listening ? await Promise.race([listening, exit.then(() => { throw new Error("OpenCode stopped before reporting its listening URL."); })]) : `http://${hostname}:${config.openCodePort}`;
        child.stdout?.resume();
        child.stderr?.resume();
        server.connection = await Promise.race([
          checkOpenCodeConnection(baseUrl, config.workingDirectory, { ...options, environment, identity,
            signal: AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]) }),
          exit.then(() => { throw new Error("OpenCode stopped before workspace readiness."); }),
        ]);
      } finally { controller.abort(); }
    },
    wait: () => exit,
    stop(signal) {
      if (stopping) return;
      stopping = true;
      terminateChild(child, platform, signal);
    },
  };
  return server;
}

export async function runOpenCodeVersion(options = {}) {
  options.signal?.throwIfAborted();
  const spawn = options.spawn ?? crossSpawn;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = spawn("opencode", ["--version"], {
    env: cleanChildEnvironment(options.environment ?? process.env),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let timer;
  const abort = () => terminateChild(child, platform);
  options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const operation = Promise.all([collect(child.stdout), collect(child.stderr), waitForExit(child)]);
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => {
        terminateChild(child, platform);
        reject(new Error(`OpenCode version check timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
    });
    const [stdout, stderr, code] = await (options.signal ? abortable(Promise.race([operation, timeout]), options.signal) : Promise.race([operation, timeout]));
    if (code !== 0) throw new Error(stderr.trim() || "OpenCode version check failed.");
    return stdout.trim();
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("OpenCode is unavailable. Install it and make sure `opencode --version` succeeds.");
    throw error;
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener("abort", abort);
  }
}

async function stageAttachments(attachments, temporaryDirectory, useDataUrls, signal) {
  const files = [];
  for (const [index, attachment] of attachments.entries()) {
    if (attachment.size !== undefined && (!Number.isSafeInteger(attachment.size) || attachment.size < 0 || attachment.size > MAX_ATTACHMENT_BYTES)) throw new Error("Attached files must be 10 MiB or smaller.");
    let data;
    try {
      data = await abortable(attachment.fetchData(), signal);
    } catch {
      throw new Error("Could not read one of the attached files. Please try uploading it again.");
    }
    if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Attached files must be 10 MiB or smaller.");
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

function turnInstructions(contextEnvironment, artifactDirectory) {
  const context = Object.entries(contextEnvironment).filter(([, value]) => value !== undefined && value !== null && String(value));
  const instructions = ["For scheduling requests, consult `pipa routine --help`, convert timezone wording to an IANA timezone, preview first, show the normalized details, and create only after user confirmation."];
  const restartCommand = contextEnvironment.PIPA_MESSAGE_CHANNEL === "slack" && contextEnvironment.PIPA_CURRENT_SLACK_CHANNEL_ID
    ? `pipa restart --channel ${contextEnvironment.PIPA_CURRENT_SLACK_CHANNEL_ID}${contextEnvironment.PIPA_CURRENT_SLACK_THREAD_TS ? ` --thread ${contextEnvironment.PIPA_CURRENT_SLACK_THREAD_TS}` : ""}`
    : "pipa restart";
  instructions.push(`When asked to restart Pipa, run \`${restartCommand}\`; existing messaging authorization is sufficient. It requests a detached restart and may end this turn. Use \`pipa restart --status\` to inspect the durable outcome; do not claim completion from the request alone. Both commands must run on the Pipa host, not a remote attached OpenCode host. If you lack command access to the Pipa host, explain that limitation instead of running them remotely. The Pipa profile home on that host is ${JSON.stringify(path.resolve(process.env.PIPA_HOME || os.homedir()))}; ensure PIPA_HOME has this value in the command environment. Do not use sequential stop/start or OpenCode /instance/dispose: that disposes an instance, not restarts the server.`);
  if (context.length) instructions.push(`Slack context for this turn (provided here, not as shell environment variables):\n${context.map(([key, value]) => `${key}=${value}`).join("\n")}`);
  if (contextEnvironment.PIPA_MESSAGE_CHANNEL === "slack") {
    instructions.push("Keep naturally short answers inline. For deeper work or larger deliverables, keep the Slack response concise and use the most suitable artifact format.");
    if (artifactDirectory) instructions.push(`To attach files, copy up to 10 top-level files (100 MB total) to this private artifact directory: ${artifactDirectory}\nOnly if you created files, end your response with exactly one final line in this format: ${ARTIFACT_MARKER} [\"report.csv\",\"brief.pdf\"]\nDo not emit ${ARTIFACT_MARKER} otherwise.`);
  }
  return instructions.join("\n\n");
}

function parseArtifactDeclaration(text) {
  const lines = text.split(/\r?\n/u);
  const declarations = lines.map((line, index) => {
    const markerIndex = line.indexOf(ARTIFACT_MARKER);
    return markerIndex < 0 ? null : { line: line.slice(markerIndex), index, markerIndex };
  }).filter(Boolean);
  const cleanText = lines.map((line) => {
    const markerIndex = line.indexOf(ARTIFACT_MARKER);
    return markerIndex < 0 ? line : line.slice(0, markerIndex).trimEnd();
  }).join("\n").trim();
  const lastNonblank = lines.findLastIndex((line) => line.trim());
  if (declarations.length !== 1 || declarations[0].index !== lastNonblank || declarations[0].markerIndex !== 0) return { text: cleanText };
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
        if (!before.isFile() || size > MAX_ARTIFACT_BYTES || total + size > MAX_ARTIFACT_BYTES) throw new Error("Artifact exceeds delivery limits.");
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

export async function checkOpenCodeConnection(baseUrl, workingDirectory, options = {}) {
  baseUrl = normalizeBaseUrl(baseUrl);
  const fetchImpl = options.fetch ?? fetch;
  const environment = options.environment ?? process.env;
  const signal = options.signal;
  const deadline = Date.now() + (options.startupTimeoutMs ?? 30_000);
  let connection;
  let stage = "workspace readiness";
  async function read(pathname, headers, directory, candidate = false) {
    const url = serverUrl(baseUrl, pathname, directory);
    const response = await fetchImpl(url, {
      headers,
      redirect: "manual",
      signal: AbortSignal.any([AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - Date.now()))), ...(signal ? [signal] : [])]),
    });
    if (!response.ok) await response.body?.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) throw new Error("OpenCode authentication failed. Check OPENCODE_SERVER_USERNAME/OPENCODE_SERVER_PASSWORD for v1 or OPENCODE_PASSWORD (then OPENCODE_SERVER_PASSWORD) for v2 credentials.");
    if ([502, 503, 504].includes(response.status)) throw new OpenCodeReadinessError("OpenCode is temporarily unavailable.");
    if (candidate && [404, 405].includes(response.status)) return null;
    if (!response.ok) throw new Error(`OpenCode protocol check failed (HTTP ${response.status}). Check the server URL and supported runtime.`);
    try { return await response.json(); }
    catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      if (candidate) return null; // Legacy identity routes on v2 serve the web UI.
      throw new Error("OpenCode protocol check returned invalid JSON. Check the server URL and runtime.");
    }
  }
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    try {
      if (!connection) {
        const v1Headers = authenticationHeaders(environment, 1);
        const health = await read("/global/health", v1Headers, undefined, true);
        if (typeof health?.healthy === "boolean" && typeof health.version === "string") {
          const identity = parseOpenCodeVersion(health.version);
          if (identity.major !== 1) throw new Error("OpenCode identity/protocol mismatch at /global/health.");
          if (!health.healthy) throw new OpenCodeReadinessError("OpenCode is not healthy yet.");
          connection = { ...identity, headers: v1Headers };
        } else {
          const headers = authenticationHeaders(environment, 2);
          const info = await read("/api/info", headers, undefined, true);
          if (!info || typeof info.version !== "string" || !Number.isSafeInteger(info.pid) || info.pid <= 0
            || !Array.isArray(info.urls) || !info.urls.every((url) => typeof url === "string") || typeof info.paths?.tmp !== "string") {
            throw new Error("OpenCode identity protocol is unsupported. Check the selected server URL and install a supported v1 or v2 runtime.");
          }
          const identity = parseOpenCodeVersion(info.version);
          if (identity.major !== 2) throw new Error("OpenCode identity/protocol mismatch at /api/info.");
          connection = { ...identity, headers };
        }
        if (options.identity && options.identity.version !== connection.version) throw new Error("OpenCode CLI/server identity mismatch. Check the executable and selected listening server.");
      }
      const headers = connection.headers;
      if (connection.major === 2) {
        stage = "migration";
        const migration = await read("/api/experimental/migration/v1", headers);
        if (migration?.status === "error" && typeof migration.error === "string") throw new Error("OpenCode migration failed. Resolve the migration with OpenCode before starting Pipa; Pipa state has been retained.");
        if (migration?.status === "required" || (migration?.status === "running" && typeof migration.progress?.label === "string")) {
          throw new OpenCodeReadinessError("OpenCode migration is not complete.");
        }
        if (migration?.status !== "completed") throw new Error("OpenCode migration protocol has an invalid status. Check the supported runtime.");
        stage = "workspace readiness";
        const locationUrl = `/api/location?${new URLSearchParams({ "location[directory]": workingDirectory })}`;
        const location = await read(locationUrl, headers);
        if (typeof location?.directory !== "string" || !path.isAbsolute(location.directory) || typeof location.project?.id !== "string"
          || typeof location.project?.directory !== "string" || typeof location.project?.canonical !== "string") throw new Error("OpenCode location protocol has an invalid schema.");
        if (path.resolve(location.directory) !== path.resolve(workingDirectory)) throw new Error("OpenCode workspace identity mismatch. Select a server serving the configured working directory.");
      } else {
        const location = await read("/path", headers, workingDirectory);
        if (typeof location?.directory !== "string" || !path.isAbsolute(location.directory)) throw new Error("OpenCode workspace protocol has an invalid schema.");
        if (path.resolve(location.directory) !== path.resolve(workingDirectory)) throw new Error("OpenCode workspace identity mismatch. Select a server serving the configured working directory.");
        const sessions = await read("/session/status", headers, workingDirectory);
        if (!sessions || typeof sessions !== "object" || Array.isArray(sessions)
          || !Object.values(sessions).every((session) => session && typeof session === "object" && typeof session.type === "string")) throw new Error("OpenCode workspace protocol has an invalid status schema.");
      }
      return { ...connection, baseUrl, workingDirectory };
    } catch (error) {
      if (signal?.aborted) throw signal.reason;
      if (!(error instanceof OpenCodeReadinessError) && !isNetworkError(error) && error.name !== "TimeoutError") throw error;
    }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())), signal);
  }
  throw new OpenCodeReadinessError(`OpenCode ${stage} check timed out. ${stage === "migration" ? "Complete the migration with OpenCode before starting Pipa; Pipa state has been retained." : "Check the server and configured working directory."}`);
}

function readListeningUrl(child, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => {
      child.stdout?.off("data", inspect);
      child.stderr?.off("data", inspect);
      child.off("close", closed);
      signal?.removeEventListener("abort", abort);
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
    const closed = () => finish(reject, new Error("OpenCode stopped before reporting its listening URL."));
    const abort = () => finish(reject, signal.reason);
    timer.unref?.();
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("close", closed);
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
  });
}

function authenticationHeaders(environment, major = 1) {
  const password = major === 2 ? environment.OPENCODE_PASSWORD || environment.OPENCODE_SERVER_PASSWORD : environment.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = major === 2 ? "opencode" : environment.OPENCODE_SERVER_USERNAME?.trim() || "opencode";
  return { authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}` };
}

function ownedEnvironment(environment, major) {
  const clean = cleanChildEnvironment(environment);
  const password = (major === 2 ? clean.OPENCODE_PASSWORD || clean.OPENCODE_SERVER_PASSWORD : clean.OPENCODE_SERVER_PASSWORD) || randomBytes(32).toString("hex");
  clean.OPENCODE_SERVER_PASSWORD = password;
  if (major === 2) {
    clean.OPENCODE_PASSWORD = password;
    clean.OPENCODE_SERVER_USERNAME = "opencode";
    // 2.0.29's grouped Base64 regex exhausts Bun's default regexp stack on
    // valid 10 MiB files. This VM ceiling fixes it without changing file bytes.
    clean.BUN_JSC_maxRegExpStackSize ??= String(512 * 1024 * 1024);
  }
  return clean;
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
