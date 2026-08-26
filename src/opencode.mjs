import crossSpawn from "cross-spawn";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
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
    await waitForHealth(baseUrl, fetchImpl, headers, startupTimeoutMs);
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
      waitForHealth(baseUrl, fetchImpl, headers, startupTimeoutMs),
      exit.then((code) => { throw new Error(`OpenCode server exited before startup with code ${code}.`); }),
    ]);
    return ownedServer(baseUrl, child, exit, platform);
  } catch (error) {
    terminateChild(child, platform);
    await waitBounded(exit.catch(() => undefined), 5_000);
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
  const active = new Set();
  let stopped = false;

  async function request(pathname, init, workingDirectory, controller, acceptedStatuses = [200]) {
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
      if (isNetworkError(error)) options.onFatal?.(new Error("OpenCode server became unavailable."));
      throw error;
    }
    let text;
    try {
      text = await response.text();
    } catch (error) {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (isNetworkError(error)) options.onFatal?.(new Error("OpenCode server became unavailable."));
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

  async function runTurn({ prompt, sessionId, workingDirectory, contextEnvironment = {}, attachments = [] }) {
    if (!prompt?.trim()) throw new Error("A prompt is required.");
    if (stopped) throw new Error("Pipa is shutting down.");
    const temporaryDirectory = attachments.length ? await mkdtemp(path.join(os.tmpdir(), "pipa-files-")) : null;
    let turnError;

    try {
      const files = await stageAttachments(attachments, temporaryDirectory, timeoutMs, useDataUrls);
      if (stopped) throw new Error("Pipa is shutting down.");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error(`OpenCode timed out after ${timeoutMs}ms.`)), timeoutMs);
      active.add(controller);

      try {
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

        const baseline = new Set(messages.map((message) => message?.info?.id).filter(Boolean));
        const watcher = watchEvents({
          baseUrl,
          workingDirectory,
          sessionId: selectedSessionId,
          fetchImpl,
          headers,
          controller,
          requestTimeoutMs,
          onFatal: options.onFatal,
        });
        await watcher.ready;
        await request(`/session/${encodeURIComponent(selectedSessionId)}/prompt_async`, {
          method: "POST",
          body: JSON.stringify(promptBody(prompt.trim(), files, contextEnvironment)),
        }, workingDirectory, controller, [204]);

        while (true) {
          const [currentMessages, statuses] = await Promise.all([
            request(`/session/${encodeURIComponent(selectedSessionId)}/message?limit=1`, { method: "GET" }, workingDirectory, controller),
            request("/session/status", { method: "GET" }, workingDirectory, controller),
          ]);
          const finalMessage = latestAssistantMessage(currentMessages, baseline);
          const status = statuses?.[selectedSessionId]?.type;
          watcher.throwIfFailed();
          if (["error", "failed", "cancelled"].includes(status) || finalMessage?.error) throw new Error("OpenCode failed to complete the turn.");
          if (finalMessage && (status === "idle" || (!status && finalMessage.completed))) {
            if (!finalMessage.text) throw new Error("OpenCode completed without assistant text.");
            return { text: finalMessage.text, sessionId: selectedSessionId };
          }
          await watcher.next(pollIntervalMs);
        }
      } finally {
        clearTimeout(timer);
        controller.abort(new Error("OpenCode turn completed."));
        active.delete(controller);
      }
    } catch (error) {
      turnError = error;
      if (stopped) throw new Error("Pipa is shutting down.");
      throw error;
    } finally {
      if (temporaryDirectory) {
        try {
          await rm(temporaryDirectory, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        } catch (error) {
          if (!turnError) throw error;
          process.stderr.write("Pipa could not remove temporary attachment files.\n");
        }
      }
    }
  }

  return {
    runTurn,
    stopAll() {
      stopped = true;
      for (const controller of active) controller.abort(new Error("Pipa is shutting down."));
    },
  };
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

async function stageAttachments(attachments, temporaryDirectory, timeoutMs, useDataUrls) {
  const files = [];
  for (const [index, attachment] of attachments.entries()) {
    let data;
    try {
      data = await fetchAttachment(attachment, timeoutMs);
    } catch {
      throw new Error("Could not read one of the attached files. Please try uploading it again.");
    }
    if (data.byteLength > MAX_ATTACHMENT_BYTES) throw new Error("Attached files must be 100 MB or smaller.");
    try {
      const sanitizedName = path.basename(attachment.name || "attachment")
        .replace(/[<>:"/\\|?*\u0000-\u001f]/gu, "_")
        .replace(/[. ]+$/u, "");
      const filename = Array.from(sanitizedName).reduce(
        (result, character) => Buffer.byteLength(result + character) <= 200 ? result + character : result,
        "",
      ) || "attachment";
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

function promptBody(prompt, files, contextEnvironment) {
  const parts = [{ type: "text", text: prompt }, ...files.map((file) => ({ type: "file", ...file }))];
  const context = Object.entries(contextEnvironment).filter(([, value]) => value !== undefined && value !== null && String(value));
  return {
    parts,
    ...(context.length ? { system: `Runtime context for this turn:\n${context.map(([key, value]) => `${key}=${value}`).join("\n")}` } : {}),
  };
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

function watchEvents({ baseUrl, workingDirectory, sessionId, fetchImpl, headers, controller, requestTimeoutMs, onFatal }) {
  let readyResolve;
  let readyReject;
  let readySettled = false;
  let changedResolve;
  let changed = new Promise((resolve) => changedResolve = resolve);
  let terminalError;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  const wake = () => {
    changedResolve();
    changed = new Promise((resolve) => changedResolve = resolve);
  };
  void (async () => {
    while (!controller.signal.aborted) {
      try {
        const response = await fetchImpl(serverUrl(baseUrl, "/event", workingDirectory), {
          headers: { ...headers, accept: "text/event-stream" },
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(requestTimeoutMs)]),
        });
        if (!response.ok) throw new OpenCodeRequestError(response.status);
        if (!readySettled) {
          readySettled = true;
          readyResolve();
        }
        for await (const event of readServerSentEvents(response)) {
          if (eventSessionId(event) !== sessionId) continue;
          if (event?.type === "session.error") terminalError = new Error("OpenCode failed to complete the turn.");
          wake();
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        if (!readySettled && isNetworkError(error)) {
          const unavailable = new Error("OpenCode server became unavailable.");
          onFatal?.(unavailable);
          readySettled = true;
          readyReject(unavailable);
          return;
        }
        if (!readySettled && error instanceof OpenCodeRequestError) {
          readySettled = true;
          readyReject(error);
          return;
        }
      }
      await delay(250, controller.signal).catch(() => undefined);
    }
  })();

  return {
    ready,
    throwIfFailed() {
      if (terminalError) throw terminalError;
    },
    async next(delayMs) {
      await Promise.race([changed, delay(delayMs, controller.signal)]);
      if (terminalError) throw terminalError;
    },
  };
}

async function* readServerSentEvents(response) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const decoder = new TextDecoder();
  let buffer = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/gu, "\n");
    if (buffer.length > 1024 * 1024) throw new Error("OpenCode event exceeded 1 MB.");
    let boundary = buffer.indexOf("\n\n");
    while (boundary >= 0) {
      const chunk = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const data = chunk.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
      if (data) yield JSON.parse(data);
      boundary = buffer.indexOf("\n\n");
    }
  }
}

function eventSessionId(event) {
  if (!event || typeof event !== "object") return null;
  const properties = event.properties && typeof event.properties === "object" ? event.properties : event;
  return properties.sessionID ?? properties.sessionId ?? properties.part?.sessionID ?? null;
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

async function waitForHealth(baseUrl, fetchImpl, headers, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetchImpl(`${baseUrl}/global/health`, {
        headers,
        signal: AbortSignal.timeout(Math.min(5_000, Math.max(1, deadline - Date.now()))),
      });
      if (response.ok && (await response.json())?.healthy === true) return;
    } catch {
      // The server can accept its socket shortly before the health route is ready.
    }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throw new Error("OpenCode server health check timed out.");
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

function fetchAttachment(attachment, timeoutMs) {
  let timer;
  return Promise.race([
    attachment.fetchData(),
    new Promise((_, reject) => timer = setTimeout(() => reject(new Error(`Attachment download timed out after ${timeoutMs}ms.`)), timeoutMs)),
  ]).finally(() => clearTimeout(timer));
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

function waitBounded(promise, timeoutMs) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => timer = setTimeout(resolve, timeoutMs)),
  ]).finally(() => clearTimeout(timer));
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
