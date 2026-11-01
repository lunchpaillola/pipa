import crossSpawn from "cross-spawn";
import { chmod, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { inheritedOwnership, journal, launchOwned, stopOwned } from "./runtime-ownership.mjs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Importing this module allocates nothing. Environment isolation applies to children,
// not process.env: concurrent callers must never change the host's HOME or TMPDIR.
export const FIXTURE_TEARDOWN_TIMEOUT_MS = 60_000;
export async function createRuntimeFixture({ environment = process.env, allowEnvironment = [], timeoutMs = 30_000, cleanupTimeoutMs = 5_000, signal, parent } = {}) {
  const inherited = parent?.ownership ?? inheritedOwnership();
  const root = await realpath(await mkdtemp(path.join(inherited?.root ?? os.tmpdir(), "pipa-contract-")));
  await chmod(root, 0o700);
  const ownership = inherited ? { ...inherited, root } : { base: root, root, key: randomUUID() };
  if (!inherited) {
    await writeFile(path.join(root, "ownership.key"), ownership.key, { mode: 0o600 });
    await writeFile(path.join(root, "ownership.jsonl"), "", { mode: 0o600 });
  }
  journal(ownership, { kind: "root" });
  const directories = Object.fromEntries(["home", "workspace", "temp", "config", "data", "cache", "state", "appdata", "localappdata", "programdata"].map((name) => [name, path.join(root, name)]));
  const artifactRoot = path.join(directories.workspace, ".pipa", "artifacts");
  await Promise.all([...Object.values(directories), artifactRoot].map((directory) => mkdir(directory, { recursive: true, mode: 0o700 })));
  const env = {};
  const allowed = new Map([...allowEnvironment, "PATH", "SystemRoot", "WINDIR", "ComSpec", "PATHEXT"].map((key) => [key.toUpperCase(), key]));
  for (const [key, value] of Object.entries(environment)) {
    if (allowed.has(key.toUpperCase()) && !/(?:^|_)SLACK(?:_[A-Z0-9]+)*_(?:TOKEN|SECRET)$/iu.test(key) && value !== undefined) env[allowed.get(key.toUpperCase())] = value;
  }
  Object.assign(env, {
    PIPA_TEST_OWNERSHIP: JSON.stringify(ownership),
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
      for (const { cleanup, label } of cleanups.reverse()) {
        if (Date.now() >= cleanupDeadline) { failures.push(new Error("Runtime fixture teardown budget exhausted")); break; }
        try { await bounded(Promise.resolve().then(cleanup), { timeoutMs: Math.min(cleanupTimeoutMs, cleanupDeadline - Date.now()), label: `cleanup: ${label}` }); }
        catch (error) { failures.push(new Error(`Runtime fixture cleanup failed: ${label}: ${error.message}`)); }
      }
      try { await stopOwned(ownership, cleanupTimeoutMs); }
      catch (error) { failures.push(error); }
      if (failures.length) throw new AggregateError(failures, "Runtime fixture cleanup failed; private root retained.");
      await rm(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    });
    return teardownPromise;
  }
  controller.signal.addEventListener("abort", () => { void teardown().catch(() => undefined); }, { once: true });
  if (signal?.aborted) externalAbort();

  function spawn(command, args = [], options = {}) {
    controller.signal.throwIfAborted();
    const child = launchOwned(crossSpawn, command, args, {
      ...options, cwd: options.cwd ?? directories.workspace, env: options.env ?? env,
      detached: process.platform !== "win32", shell: false,
      stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
    }, ownership);
    const exited = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    void exited.catch(() => undefined);
    // Drain by default; callers may add bounded output observers before the next tick.
    child.stdout?.resume();
    child.stderr?.resume();
    defer(async () => {
      if (!child.pid) { await exited.catch(() => undefined); return; }
      if (process.platform === "win32") {
        // CIM identity checks, descendant discovery and taskkill belong to the
        // journal supervisor, including children whose leaders already exited.
        return;
      } else {
        // The ChildProcess still owns its live leader. Journal verification owns
        // group killing, including leaders that already exited and detached heirs.
        if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
        await bounded(exited, { timeoutMs: 500, label: "process exit" }).catch(() => undefined);
        return;
      }
    }, "process tree");
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

  return { root, ownership, ...directories, artifactRoot, env, signal: controller.signal, defer, spawn, listen, teardown,
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
