import crossSpawn from "cross-spawn";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const SECRET_ENV_KEYS = new Set([
  "PIPA_SLACK_APP_TOKEN",
  "PIPA_SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
]);

export const MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024;

export function cleanChildEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !SECRET_ENV_KEYS.has(key.toUpperCase())));
}

export function buildRunArguments({ prompt, sessionId, workingDirectory, attachUrl, files = [] }) {
  const args = ["run", "--format", "json", "--dir", workingDirectory];
  if (attachUrl) args.push("--attach", attachUrl);
  if (sessionId) args.push("--session", sessionId);
  for (const file of files) args.push("--file", file);
  args.push("--", prompt);
  return args;
}

export function createOpenCodeExecutor(options = {}) {
  const spawn = options.spawn ?? crossSpawn;
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const attachUrl = options.attachUrl ?? environment.PIPA_OPENCODE_ATTACH_URL?.trim();
  const timeoutMs = options.timeoutMs ?? 2.5 * 60 * 60 * 1000;
  const children = new Set();
  let stopped = false;

  async function runTurn({ prompt, sessionId, workingDirectory, contextEnvironment = {}, attachments = [] }) {
    if (!prompt?.trim()) throw new Error("A prompt is required.");
    if (stopped) throw new Error("Pipa is shutting down.");
    const temporaryDirectory = attachments.length ? await mkdtemp(path.join(os.tmpdir(), "pipa-files-")) : null;
    let turnError;

    try {
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
          const name = Array.from(sanitizedName).reduce(
            (result, character) => Buffer.byteLength(result + character) <= 200 ? result + character : result,
            "",
          ) || "attachment";
          const file = path.join(temporaryDirectory, `${index + 1}-${name}`);
          await writeFile(file, data);
          files.push(file);
        } catch {
          throw new Error("Could not read one of the attached files. Please try uploading it again.");
        }
      }

      if (stopped) throw new Error("Pipa is shutting down.");
      const child = spawn("opencode", buildRunArguments({ prompt, sessionId, workingDirectory, attachUrl, files }), {
        cwd: workingDirectory,
        env: { ...cleanChildEnvironment(environment), ...contextEnvironment },
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      children.add(child);
      const exit = waitForExit(child);
      void exit.finally(() => children.delete(child)).catch(() => undefined);
      let timer;

      try {
        const operation = Promise.all([collect(child.stdout), collect(child.stderr), exit]);
        const timeout = new Promise((_, reject) => {
          timer = setTimeout(() => {
            terminateChild(child, platform);
            reject(new Error(`OpenCode timed out after ${timeoutMs}ms.`));
          }, timeoutMs);
        });
        const [stdout, stderr, code] = await Promise.race([operation, timeout]);
        const output = parseOpenCodeOutput(stdout);
        if (output.error) throw new Error(output.error);
        if (code !== 0) throw new Error(output.error || stderr.trim() || `OpenCode exited with code ${code}.`);
        if (!output.text) throw new Error("OpenCode completed without assistant text.");
        return { text: output.text, sessionId: output.sessionId ?? sessionId ?? null };
      } catch (error) {
        terminateChild(child, platform);
        await exit.catch(() => undefined);
        throw error;
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      turnError = error;
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
      for (const child of children) terminateChild(child, platform);
    },
  };
}

function fetchAttachment(attachment, timeoutMs) {
  let timer;
  return Promise.race([
    attachment.fetchData(),
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Attachment download timed out after ${timeoutMs}ms.`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
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
    if (error?.code === "ENOENT") {
      throw new Error("OpenCode is unavailable. Install it and make sure `opencode --version` succeeds.");
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

export function parseOpenCodeOutput(stdout) {
  let text = "";
  let sessionId = null;
  let error = "";

  for (const line of stdout.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line);
      const candidate = event.part?.type === "text" ? event.part.text : event.type === "text" ? event.text : null;
      if (typeof candidate === "string" && candidate.trim()) text = candidate.trim();
      const eventSessionId = event.sessionID ?? event.sessionId ?? event.part?.sessionID;
      if (typeof eventSessionId === "string" && eventSessionId) sessionId = eventSessionId;
      const eventError = event.error?.data?.message ?? event.error?.message;
      if (typeof eventError === "string" && eventError.trim()) error = eventError.trim();
    } catch {
      // OpenCode can emit non-JSON diagnostics between JSON events.
    }
  }
  return { text, sessionId, error };
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

function terminateChild(child, platform) {
  if (platform === "win32" && child.pid) {
    crossSpawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" });
    return;
  }
  child.kill();
  const force = setTimeout(() => child.kill("SIGKILL"), 5_000);
  force.unref?.();
}
