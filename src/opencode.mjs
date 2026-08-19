import { spawn as nodeSpawn } from "node:child_process";

const SECRET_ENV_KEYS = new Set([
  "PIPA_SLACK_APP_TOKEN",
  "PIPA_SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
]);

export function opencodeCommand(platform = process.platform) {
  return platform === "win32" ? "opencode.cmd" : "opencode";
}

export function cleanChildEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !SECRET_ENV_KEYS.has(key)));
}

export function buildRunArguments({ prompt, sessionId, workingDirectory }) {
  const args = ["run", "--format", "json", "--dir", workingDirectory];
  if (sessionId) args.push("--session", sessionId);
  args.push("--", prompt);
  return args;
}

export function createOpenCodeExecutor(options = {}) {
  const spawn = options.spawn ?? nodeSpawn;
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const children = new Set();

  async function runTurn({ prompt, sessionId, workingDirectory }) {
    if (!prompt?.trim()) throw new Error("A prompt is required.");
    const child = spawn(opencodeCommand(platform), buildRunArguments({ prompt, sessionId, workingDirectory }), {
      cwd: workingDirectory,
      env: cleanChildEnvironment(environment),
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    children.add(child);
    const exit = waitForExit(child);

    try {
      const [stdout, stderr, code] = await Promise.all([
        collect(child.stdout),
        collect(child.stderr),
        exit,
      ]);
      const output = parseOpenCodeOutput(stdout);
      if (code !== 0) throw new Error(output.error || stderr.trim() || `OpenCode exited with code ${code}.`);
      if (!output.text) throw new Error("OpenCode completed without assistant text.");
      return { text: output.text, sessionId: output.sessionId ?? sessionId ?? null };
    } catch (error) {
      child.kill();
      await exit.catch(() => undefined);
      throw error;
    } finally {
      children.delete(child);
    }
  }

  return {
    runTurn,
    stopAll() {
      for (const child of children) child.kill();
    },
  };
}

export async function runOpenCodeVersion(options = {}) {
  const spawn = options.spawn ?? nodeSpawn;
  const platform = options.platform ?? process.platform;
  const child = spawn(opencodeCommand(platform), ["--version"], {
    env: cleanChildEnvironment(options.environment ?? process.env),
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    const [stdout, stderr, code] = await Promise.all([collect(child.stdout), collect(child.stderr), waitForExit(child)]);
    if (code !== 0) throw new Error(stderr.trim() || "OpenCode version check failed.");
    return stdout.trim();
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("OpenCode is unavailable. Install it and make sure `opencode --version` succeeds.");
    }
    throw error;
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
