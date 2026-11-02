import crossSpawn from "cross-spawn";
import { chmod, mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Importing this module allocates nothing. Environment isolation applies to children,
// not process.env: concurrent callers must never change the host's HOME or TMPDIR.
export const FIXTURE_TEARDOWN_TIMEOUT_MS = 60_000;
export async function createRuntimeFixture({ environment = process.env, allowEnvironment = [], timeoutMs = 30_000, cleanupTimeoutMs = 5_000, signal } = {}) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "pipa-contract-")));
  await chmod(root, 0o700);
  const directories = Object.fromEntries(["home", "workspace", "temp", "config", "data", "cache", "state", "appdata", "localappdata", "programdata"].map((name) => [name, path.join(root, name)]));
  const artifactRoot = path.join(directories.workspace, ".pipa", "artifacts");
  await Promise.all([...Object.values(directories), artifactRoot].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const env = {};
  const allowed = new Map([...allowEnvironment, "PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"].map((key) => [key.toUpperCase(), key]));
  for (const [key, value] of Object.entries(environment)) {
    if (allowed.has(key.toUpperCase()) && !/(?:^|_)SLACK(?:_[A-Z0-9]+)*_(?:TOKEN|SECRET)$/iu.test(key) && value !== undefined) env[allowed.get(key.toUpperCase())] = value;
  }
  Object.assign(env, {
    PIPA_TEST_RUNTIME: "1",
    HOME: directories.home, USERPROFILE: directories.home, PIPA_HOME: directories.home,
    XDG_CONFIG_HOME: directories.config, XDG_DATA_HOME: directories.data,
    XDG_CACHE_HOME: directories.cache, XDG_STATE_HOME: directories.state,
    TMPDIR: directories.temp, TMP: directories.temp, TEMP: directories.temp,
    APPDATA: directories.appdata, LOCALAPPDATA: directories.localappdata, ProgramData: directories.programdata,
    OPENCODE_DB: path.join(directories.data, "opencode.sqlite"),
    OPENCODE_CONFIG: path.join(directories.config, "opencode.json"),
  });
  const controller = new AbortController();
  const cleanups = [];
  const processCleanups = [];
  let teardownPromise;
  const timer = setTimeout(() => controller.abort(new Error("Runtime fixture deadline exceeded.")), timeoutMs);
  const externalAbort = () => controller.abort(signal.reason);
  signal?.addEventListener("abort", externalAbort, { once: true });

  function defer(cleanup, label = "resource") {
    if (teardownPromise) throw new Error("Runtime fixture is already closing.");
    cleanups.push({ cleanup, label });
  }

  function teardown() {
    if (teardownPromise) return teardownPromise;
    // Schedule after assigning the promise: abort listeners can re-enter teardown.
    teardownPromise = Promise.resolve().then(async () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", externalAbort);
      controller.abort(new Error("Runtime fixture closed."));
      const failures = [];
      const cleanupDeadline = Date.now() + FIXTURE_TEARDOWN_TIMEOUT_MS - cleanupTimeoutMs;
      for (const { cleanup, label } of [...cleanups.reverse(), ...processCleanups.reverse()]) {
        if (Date.now() >= cleanupDeadline) { failures.push(new Error("Runtime fixture teardown budget exhausted")); break; }
        try { await bounded(Promise.resolve().then(cleanup), { timeoutMs: Math.min(cleanupTimeoutMs, cleanupDeadline - Date.now()), label: `cleanup: ${label}` }); }
        catch (error) { failures.push(new Error(`Runtime fixture cleanup failed: ${label}: ${error.message}`)); }
      }
      if (failures.length) throw new AggregateError(failures, "Runtime fixture cleanup failed; private root retained.");
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });
    return teardownPromise;
  }
  controller.signal.addEventListener("abort", () => { void teardown().catch(() => undefined); }, { once: true });
  if (signal?.aborted) externalAbort();

  function spawn(command, args = [], options = {}) {
    controller.signal.throwIfAborted();
    const child = crossSpawn(command, args, {
      ...options, cwd: options.cwd ?? directories.workspace, env: options.env ?? env,
      detached: process.platform !== "win32", shell: false,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    void exited.catch(() => undefined);
    // Drain by default; callers may add bounded output observers before the next tick.
    child.stdout?.resume();
    child.stderr?.resume();
    processCleanups.push({ label: "process tree", cleanup: async () => {
      try {
        if (!child.pid) { await exited.catch(() => undefined); return; }
        // Only a live ChildProcess handle authorizes signaling its tree. Detached
        // Pipa replacements are stopped separately through their private profile.
        if (child.exitCode === null && child.signalCode === null) {
          if (process.platform === "win32") {
            const result = spawnSync(path.join(process.env.SystemRoot, "System32", "taskkill.exe"), ["/PID", String(child.pid), "/T", "/F"], {
              timeout: cleanupTimeoutMs, windowsHide: true, stdio: "ignore",
            });
            if (result.error) throw new Error("Fixture process-tree termination failed.");
          } else {
            try { process.kill(-child.pid, "SIGKILL"); }
            catch (error) { if (error.code !== "ESRCH") throw error; }
          }
        }
        await bounded(exited, { timeoutMs: cleanupTimeoutMs, label: "fixture process exit" });
      } finally {
        child.stdin?.destroy();
        child.stdout?.destroy();
        child.stderr?.destroy();
        if (child.connected) child.disconnect();
        child.unref();
      }
    } });
    return { child, exited };
  }

  async function listen(server) {
    controller.signal.throwIfAborted();
    const sockets = new Set();
    const connection = (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    };
    server.on("connection", connection);
    defer(async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve, reject) => server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve()));
      server.off("connection", connection);
    }, "listener");
    await bounded(new Promise((resolve, reject) => {
      const error = (failure) => { server.off("listening", ready); reject(failure); };
      const ready = () => { server.off("error", error); resolve(); };
      server.once("error", error);
      server.once("listening", ready);
      server.listen(0, "127.0.0.1");
    }), { signal: controller.signal, timeoutMs, label: "listener startup" });
    return `http://127.0.0.1:${server.address().port}`;
  }

  return { root, ...directories, artifactRoot, env, signal: controller.signal, defer, spawn, listen, teardown,
    abort: (reason = new Error("Runtime fixture aborted.")) => controller.abort(reason),
    waitFor: (check, options = {}) => waitFor(check, { timeoutMs, ...options, signal: controller.signal }),
  };
}

export async function bounded(operation, { timeoutMs = 5_000, signal, label = "operation" } = {}) {
  signal?.throwIfAborted();
  let timer;
  let abort;
  try {
    return await Promise.race([operation, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
      abort = () => reject(signal.reason);
      signal?.addEventListener("abort", abort, { once: true });
    })]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

export function waitFor(check, { timeoutMs = 5_000, intervalMs = 10, signal, label = "condition" } = {}) {
  // Do not start an orphan polling promise when a closing fixture is already aborted.
  signal?.throwIfAborted();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  return bounded((async () => {
    while (true) {
      combined.throwIfAborted();
      const value = await check();
      if (value) return value;
      await delay(intervalMs, undefined, { signal: combined });
    }
  })(), { timeoutMs, signal, label }).finally(() => controller.abort());
}
