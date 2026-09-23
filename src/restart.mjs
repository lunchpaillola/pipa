import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { cleanChildEnvironment } from "./opencode.mjs";
import { isRunning, pipaPaths, readInstanceLock, writePrivateJson } from "./state.mjs";

const WORKER = fileURLToPath(import.meta.url);
const CLI = fileURLToPath(new URL("../bin/pipa.mjs", import.meta.url));
const LIMITS = { armMs: 10_000, cleanupMs: 30_000, stopMs: 15_000, readyMs: 60_000, pollMs: 100 };
const ACCEPT_MS = 15_000;
const SAFE_FAILURES = new Set([
  "Child startup failed.", "Child process could not start.", "Child exited before handoff.",
  "Restart IPC disconnected before handoff.", "Restart handoff timed out.",
  "Restart IPC send timed out.", "Restart IPC send failed.", "Restart IPC unavailable.",
  "Restart acceptance expired.", "Cleanup timed out.", "Cleanup failed.",
  "Instance changed.", "Original instance did not stop.", "Replacement identity not confirmed.",
]);
const safeFailure = (error) => SAFE_FAILURES.has(error?.message) ? ` ${error.message}` : "";
const validId = (id) => typeof id === "string" && /^[a-f0-9-]{36}$/u.test(id);
const same = (a, b) => a && b && a.pid === b.pid && a.generation === b.generation;
const homePath = (home) => path.resolve(home ?? (process.env.PIPA_HOME || os.homedir()));
const fileFor = (home, id, kind) => {
  if (!validId(id)) throw new Error("Invalid restart identity.");
  return path.join(pipaPaths(home).directory, "restarts", `${id}.${kind}.json`);
};

async function readOptional(file) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Could not read restart state.");
  }
}

async function publish(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value), { mode: 0o600 });
    await link(temporary, file);
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally { await rm(temporary, { force: true }); }
}

function validRequest(request, identity) {
  return request && validId(request.id) && request.id === request.generation
    && same(request, identity) && Number.isFinite(request.createdAt)
    && request.expiresAt === request.createdAt + ACCEPT_MS;
}

// Generation is identity, not a grant: local execution keeps the existing local-user authority.
export async function requestRestart({ home, running = isRunning, now = Date.now } = {}) {
  home = homePath(home);
  const identity = await readInstanceLock(pipaPaths(home).lock);
  if (!identity || !running(identity.pid)) throw new Error("Pipa is not running.");
  if (!identity.generation) throw new Error("This Pipa needs one manual stop/start before restart is available.");
  const createdAt = now();
  const request = { ...identity, id: identity.generation, createdAt, expiresAt: createdAt + ACCEPT_MS };
  const file = fileFor(home, request.id, "request");
  const created = await publish(file, request);
  const stored = await readOptional(file);
  if (!validRequest(stored, identity)) throw new Error("Invalid restart request.");
  if (!created) {
    const status = await restartStatus({ home, id: stored.id, now });
    if (!["requested", "running"].includes(status?.state)) {
      throw new Error(`Restart ${stored.id} is ${status?.state ?? "unconfirmed"}. Inspect \`pipa restart --status\` before a manual stop/start.`);
    }
  }
  return stored;
}

// Read-only: expiry changes the displayed outcome, never the persisted records.
export async function restartStatus({ home, id, now = Date.now } = {}) {
  home = homePath(home);
  if (!id) {
    const directory = path.join(pipaPaths(home).directory, "restarts");
    const files = await readdir(directory).catch((error) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    const requests = await Promise.all(files.filter((file) => /^[a-f0-9-]{36}\.request\.json$/u.test(file))
      .map((file) => readOptional(path.join(directory, file))));
    id = requests.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt)[0]?.id;
    if (!id) return null;
  }
  const request = await readOptional(fileFor(home, id, "request"));
  if (!request) return null;
  const status = await readOptional(fileFor(home, id, "status"))
    ?? await readOptional(fileFor(home, id, "acceptance"))
    ?? { id, state: "requested", phase: "acceptance", updatedAt: request.createdAt, deadline: request.expiresAt };
  if (!["completed", "failed"].includes(status.state) && now() > status.deadline) {
    return { ...status, state: "unconfirmed", error: `Restart ${status.phase} was not confirmed before its deadline. Inspect Pipa before trying a manual start.` };
  }
  return status;
}

function statusRecord(id, state, phase, deadline, error) {
  return { id, state, phase, updatedAt: Date.now(), deadline, ...(error ? { error } : {}) };
}

function detach(child) {
  if (child?.connected) child.disconnect();
  child?.unref();
}

// One bounded listener handles spawn errors, early exits, disconnects and expected IPC.
function receive(peer, type, id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const finish = (error, message) => {
      clearTimeout(timer);
      peer.off("message", messageReceived);
      peer.off("exit", exited);
      peer.off("disconnect", disconnected);
      // Keep a harmless error listener for a delayed spawn error after timeout.
      peer.off("error", failed);
      peer.on("error", ignoreError);
      if (error) reject(error);
      else resolve(message);
    };
    const messageReceived = (message) => {
      if (message?.id !== id) return;
      if (message.type === "failed") finish(new Error("Child startup failed."));
      else if (message.type === type) finish(null, message);
    };
    const failed = () => finish(new Error("Child process could not start."));
    const exited = () => finish(new Error("Child exited before handoff."));
    const disconnected = () => finish(new Error("Restart IPC disconnected before handoff."));
    const timer = setTimeout(() => finish(new Error("Restart handoff timed out.")), timeoutMs);
    peer.on("message", messageReceived);
    peer.once("error", failed);
    peer.once("exit", exited);
    peer.once("disconnect", disconnected);
  });
}
function ignoreError() {}

function send(peer, message, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Restart IPC send timed out.")), timeoutMs);
    try {
      peer.send(message, (error) => {
        clearTimeout(timer);
        if (error) reject(new Error("Restart IPC send failed."));
        else resolve();
      });
    } catch {
      clearTimeout(timer);
      reject(new Error("Restart IPC unavailable."));
    }
  });
}

function spawnOptions(home, environment) {
  const env = cleanChildEnvironment(environment);
  delete env.PIPA_RESTART_ID;
  return { detached: true, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...env, PIPA_HOME: home }, windowsHide: true };
}

// Call only inside the lock-owning Pipa process, never the requesting OpenCode turn.
// shutdown must stop intake, await cleanup AND release its own lock, then resolve.
export function startRestartWatcher({ home, identity, shutdown, spawn: spawnImpl = spawn,
  environment = process.env, limits = {}, onError = () => {} }) {
  home = homePath(home);
  const timing = { ...LIMITS, ...limits };
  let pending;
  let stopped = false;
  let accepted = false;
  const poll = () => {
    if (pending) return pending;
    if (stopped || accepted) return Promise.resolve();
    pending = accept().finally(() => { pending = null; });
    return pending;
  };
  async function accept() {
    const request = await readOptional(fileFor(home, identity.generation, "request"));
    if (stopped || !validRequest(request, identity) || Date.now() > request.expiresAt
      || !same(await readInstanceLock(pipaPaths(home).lock), identity)) return;
    const file = fileFor(home, request.id, "acceptance");
    if (!await publish(file, statusRecord(request.id, "requested", "arming", Date.now() + timing.armMs))) return;
    accepted = true;
    let child;
    let phase = "arming";
    try {
      child = spawnImpl(process.execPath, [WORKER, "--worker", request.id], spawnOptions(home, environment));
      await receive(child, "armed", request.id, timing.armMs);
      if (stopped || !child.connected || child.exitCode != null || child.signalCode != null
        || Date.now() > request.expiresAt || !same(await readInstanceLock(pipaPaths(home).lock), identity)) {
        throw new Error("Restart acceptance expired.");
      }
      await writePrivateJson(file, statusRecord(request.id, "running", "cleanup", Date.now() + timing.cleanupMs));
      phase = "cleanup";
      let timer;
      try {
        await Promise.race([Promise.resolve().then(shutdown), new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error("Cleanup timed out.")), timing.cleanupMs);
        })]);
      } finally { clearTimeout(timer); }
      phase = "handoff";
      await send(child, { type: "cleanup", id: request.id, ok: true }, timing.armMs);
    } catch (error) {
      await writePrivateJson(file, statusRecord(request.id, "failed", phase, Date.now(),
        `Restart ${phase} failed.${safeFailure(error)} Inspect Pipa and its owned runtime before a manual stop/start.`));
    } finally { detach(child); }
  }
  const timer = setInterval(() => { void poll().catch(onError); }, timing.pollMs);
  timer.unref();
  return { poll, stop() { stopped = true; clearInterval(timer); } };
}

export async function runRestartWorker({ home, id, peer = process, spawn: spawnImpl = spawn,
  environment = process.env, running = isRunning, limits = {} }) {
  home = homePath(home);
  const timing = { ...LIMITS, ...limits };
  const request = await readOptional(fileFor(home, id, "request"));
  if (!validRequest(request, await readInstanceLock(pipaPaths(home).lock)) || Date.now() > request.expiresAt) return;
  let child;
  let phase = "cleanup";
  let ownsStatus = false;
  const file = fileFor(home, id, "status");
  try {
    const cleanup = receive(peer, "cleanup", id, timing.cleanupMs + timing.armMs);
    // Attach a rejection handler before the asynchronous send can fail.
    void cleanup.catch(ignoreError);
    await send(peer, { type: "armed", id }, timing.armMs);
    const outcome = await cleanup;
    if (outcome.ok !== true) throw new Error("Cleanup failed.");
    const acceptance = await readOptional(fileFor(home, id, "acceptance"));
    if (acceptance?.state !== "running" || Date.now() > acceptance.deadline) return;
    // Parent writes only acceptance; this worker alone writes progress after cleanup handoff.
    ownsStatus = true;
    phase = "waiting-for-stop";
    await writePrivateJson(file, statusRecord(id, "running", phase, Date.now() + timing.stopMs));
    if (peer.connected) peer.disconnect();
    const deadline = Date.now() + timing.stopMs;
    while (true) {
      const lock = await readInstanceLock(pipaPaths(home).lock);
      if (lock && !same(lock, request)) throw new Error("Instance changed.");
      if (!lock && !running(request.pid)) break;
      if (Date.now() >= deadline) throw new Error("Original instance did not stop.");
      await delay(timing.pollMs);
    }
    phase = "starting";
    await writePrivateJson(file, statusRecord(id, "running", phase, Date.now() + timing.readyMs));
    const options = spawnOptions(home, environment);
    options.env.PIPA_RESTART_ID = id;
    child = spawnImpl(process.execPath, [CLI, "start"], options);
    const ready = await receive(child, "ready", id, timing.readyMs);
    const replacement = await readInstanceLock(pipaPaths(home).lock);
    if (ready.pid !== child.pid || !validId(ready.generation) || ready.generation === request.generation
      || !same(ready, replacement) || !running(ready.pid) || child.exitCode != null || child.signalCode != null) {
      throw new Error("Replacement identity not confirmed.");
    }
    await send(child, { type: "accepted", id }, timing.armMs);
    await writePrivateJson(file, { ...statusRecord(id, "completed", "ready", Date.now()), replacement });
  } catch (error) {
    if (ownsStatus) await writePrivateJson(file, statusRecord(id, "failed", phase, Date.now(),
      `Restart ${phase} failed.${safeFailure(error)} Inspect Pipa before a manual start; a replacement may still be starting.`));
  } finally {
    detach(child);
    if (peer.connected) peer.disconnect();
  }
}

// Report readiness only after full profile startup; wait for worker acceptance.
export async function reportRestartReady(identity, { peer = process, environment = process.env } = {}) {
  const id = environment.PIPA_RESTART_ID;
  if (!id) return;
  if (!validId(id) || !validId(identity?.generation)) throw new Error("Invalid restart readiness identity.");
  const accepted = receive(peer, "accepted", id, LIMITS.armMs);
  void accepted.catch(ignoreError);
  await send(peer, { type: "ready", id, ...identity }, LIMITS.armMs);
  await accepted;
}

export async function reportRestartFailure({ peer = process, environment = process.env } = {}) {
  const id = environment.PIPA_RESTART_ID;
  if (validId(id) && peer.connected) await send(peer, { type: "failed", id }, LIMITS.armMs).catch(ignoreError);
}

if (process.argv[1] && path.resolve(process.argv[1]) === WORKER && process.argv[2] === "--worker") {
  await runRestartWorker({ id: process.argv[3] }).catch(() => { process.exitCode = 1; });
  if (process.connected) process.disconnect();
}
