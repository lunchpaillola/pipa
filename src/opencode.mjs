import crossSpawn from "cross-spawn";

const SECRET_ENV_KEYS = new Set([
  "PIPA_SLACK_APP_TOKEN",
  "PIPA_SLACK_BOT_TOKEN",
  "SLACK_APP_TOKEN",
  "SLACK_BOT_TOKEN",
]);

export function opencodeCommand(platform = process.platform) {
  return "opencode";
}

export function cleanChildEnvironment(environment = process.env) {
  return Object.fromEntries(Object.entries(environment).filter(([key]) => !SECRET_ENV_KEYS.has(key.toUpperCase())));
}

export function buildRunArguments({ prompt, sessionId, workingDirectory }) {
  const args = ["run", "--format", "json", "--dir", workingDirectory];
  if (sessionId) args.push("--session", sessionId);
  args.push("--", prompt);
  return args;
}

export function createOpenCodeExecutor(options = {}) {
  const spawn = options.spawn ?? crossSpawn;
  const platform = options.platform ?? process.platform;
  const environment = options.environment ?? process.env;
  const timeoutMs = options.timeoutMs ?? 2.5 * 60 * 60 * 1000;
  const children = new Set();

  async function runTurn({ prompt, sessionId, workingDirectory, contextEnvironment = {} }) {
    if (!prompt?.trim()) throw new Error("A prompt is required.");
    const child = spawn(opencodeCommand(platform), buildRunArguments({ prompt, sessionId, workingDirectory }), {
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
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    runTurn,
    stopAll() {
      for (const child of children) terminateChild(child, platform);
    },
  };
}

export async function runOpenCodeVersion(options = {}) {
  const spawn = options.spawn ?? crossSpawn;
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const child = spawn(opencodeCommand(platform), ["--version"], {
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
