import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm, readFile, stat, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireInstanceLock, pipaPaths, writePrivateJson } from "../src/state.mjs";
import { requestRestart, restartStatus, startRestartWatcher, runRestartWorker, reportRestartReady, reportRestartFailure } from "../src/restart.mjs";

async function fixture(t) {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-restart-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const release = await acquireInstanceLock(pipaPaths(home).lock);
  return { home, release };
}

test("concurrent requests join one immutable generation attempt", async (t) => {
  const { home, release } = await fixture(t);
  const requests = await Promise.all(Array.from({ length: 8 }, () => requestRestart({ home })));
  assert.equal(new Set(requests.map((request) => request.id)).size, 1);
  assert.equal(requests[0].generation, release.identity.generation);
  assert.equal((await restartStatus({ home })).state, "requested");
});

test("worker launch failure leaves original alive and saves a safe failure", async (t) => {
  const { home, release } = await fixture(t);
  await requestRestart({ home });
  let stopped = false;
  const watcher = startRestartWatcher({ home, identity: release.identity,
    shutdown: async () => { stopped = true; },
    spawn: () => { throw new Error("secret launch error"); },
  });
  t.after(() => watcher.stop());
  await watcher.poll();
  assert.equal(stopped, false);
  const status = await restartStatus({ home });
  assert.equal(status.state, "failed");
  assert.doesNotMatch(JSON.stringify(status), /secret/);
  assert.deepEqual(JSON.parse(await readFile(pipaPaths(home).lock, "utf8")), release.identity);
});

function peers() {
  const parent = new EventEmitter();
  const child = new EventEmitter();
  for (const [from, to] of [[parent, child], [child, parent]]) {
    from.connected = true;
    from.unref = () => { from.unreferenced = true; };
    from.send = (message, callback) => queueMicrotask(() => {
      if (!from.connected) return callback(new Error("closed"));
      to.emit("message", message);
      callback();
    });
    from.disconnect = () => {
      from.connected = false;
      to.connected = false;
      queueMicrotask(() => { from.emit("disconnect"); to.emit("disconnect"); });
    };
  }
  return [parent, child];
}

const limits = { armMs: 100, cleanupMs: 100, stopMs: 40, readyMs: 80, pollMs: 2 };

test("replacement readiness requires worker acceptance before detachment", async () => {
  const [worker, replacement] = peers();
  const id = randomUUID();
  let settled = false;
  const ready = reportRestartReady({ pid: 4242, generation: randomUUID() }, {
    peer: replacement, environment: { PIPA_RESTART_ID: id },
  }).finally(() => { settled = true; });
  await delay(1);
  assert.equal(settled, false);
  worker.disconnect();
  await assert.rejects(ready, /disconnected/);
});

test("real watcher/worker chain orders cleanup, process clearance and detached readiness", async (t) => {
  const { home, release } = await fixture(t);
  const request = await requestRestart({ home });
  const [worker, workerPeer] = peers();
  const [replacement, replacementPeer] = peers();
  replacement.pid = 4242;
  const events = [];
  let originalRunning = true;
  let finished;
  let workers = 0;
  const environment = { PATH: "test", PIPA_SLACK_BOT_TOKEN: "secret", Slack_Client_Secret: "secret", PIPA_HOME: "wrong" };
  const watcher = startRestartWatcher({ home, identity: release.identity, environment, limits,
    shutdown: async () => {
      events.push("cleanup");
      await release();
      setTimeout(() => { originalRunning = false; events.push("original-exit"); }, 8);
    },
    spawn(command, args, options) {
      workers += 1;
      assert.equal(command, process.execPath);
      assert.ok(path.isAbsolute(args[0]));
      assert.deepEqual(args.slice(1), ["--worker", request.id]);
      assert.equal(options.detached, true);
      assert.equal(options.shell, false);
      assert.deepEqual(options.stdio, ["ignore", "ignore", "ignore", "ipc"]);
      assert.deepEqual(options.env, { PATH: "test", PIPA_HOME: home });
      finished = runRestartWorker({ home, id: request.id, peer: workerPeer, environment, limits,
        running: (pid) => pid === 4242 || originalRunning,
        spawn(command, args, options) {
          events.push("replacement");
          assert.equal(command, process.execPath);
          assert.ok(path.isAbsolute(args[0]));
          assert.deepEqual(args.slice(1), ["start"]);
          assert.equal(options.detached, true);
          assert.equal(options.env.PIPA_HOME, home);
          assert.equal(options.env.PIPA_SLACK_BOT_TOKEN, undefined);
          assert.equal(options.env.Slack_Client_Secret, undefined);
          void (async () => {
            const identity = { pid: 4242, generation: randomUUID() };
            await writePrivateJson(pipaPaths(home).lock, identity);
            assert.equal((await restartStatus({ home })).state, "running");
            await reportRestartReady(identity, { peer: replacementPeer, environment: options.env });
          })();
          return replacement;
        },
      });
      return worker;
    },
  });
  t.after(() => watcher.stop());
  await Promise.all([watcher.poll(), watcher.poll(), watcher.poll()]);
  await finished;
  assert.equal(workers, 1);
  assert.deepEqual(events, ["cleanup", "original-exit", "replacement"]);
  assert.equal((await restartStatus({ home })).state, "completed");
  assert.equal(worker.connected, false);
  assert.equal(worker.unreferenced, true);
  assert.equal(replacement.connected, false);
  assert.equal(replacement.unreferenced, true);
  await release();
  assert.equal(JSON.parse(await readFile(pipaPaths(home).lock, "utf8")).pid, 4242);
});

test("expired and changed-generation requests are inert; status is read-only and stale", async (t) => {
  const { home, release } = await fixture(t);
  const request = await requestRestart({ home, now: () => Date.now() - 60_000 });
  const file = path.join(pipaPaths(home).directory, "restarts", `${request.id}.request.json`);
  const before = await stat(file);
  const watcher = startRestartWatcher({ home, identity: release.identity,
    spawn: () => assert.fail("must not spawn"), shutdown: () => assert.fail("must not stop") });
  t.after(() => watcher.stop());
  await watcher.poll();
  assert.equal((await restartStatus({ home })).state, "unconfirmed");
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
  if (process.platform !== "win32") assert.equal(before.mode & 0o777, 0o600);
  await release();
  const next = await acquireInstanceLock(pipaPaths(home).lock);
  await requestRestart({ home });
  await watcher.poll();
  await next();
});

for (const failure of ["error", "exit", "timeout", "late-armed", "late-error"]) {
  test(`worker ${failure} before armed keeps original running`, async (t) => {
    const { home, release } = await fixture(t);
    const request = await requestRestart({ home });
    const [worker] = peers();
    const watcher = startRestartWatcher({ home, identity: release.identity, limits: { ...limits, armMs: 5 },
      shutdown: () => assert.fail("must not shut down"),
      spawn() {
        if (failure === "error") queueMicrotask(() => worker.emit("error", new Error("secret")));
        if (failure === "exit") queueMicrotask(() => worker.emit("exit", 1));
        if (failure === "late-armed") setTimeout(() => worker.emit("message", { type: "armed", id: request.id }), 10);
        if (failure === "late-error") setTimeout(() => worker.emit("error", new Error("late secret")), 10);
        return worker;
      },
    });
    t.after(() => watcher.stop());
    await watcher.poll();
    await delay(15);
    assert.equal((await restartStatus({ home })).state, "failed");
    assert.equal(worker.connected, false);
    assert.equal(worker.unreferenced, true);
  });
}

for (const failure of ["cleanup", "cleanup-timeout", "lock", "process", "identity", "spawn", "exit", "error", "ready-timeout", "wrong-ready", "startup-failed"]) {
  test(`${failure} never reports success or deletes a conflicting lock`, async (t) => {
    const { home, release } = await fixture(t);
    const request = await requestRestart({ home });
    const [worker, workerPeer] = peers();
    const [replacement, replacementPeer] = peers();
    replacement.pid = 4242;
    let finished;
    let launches = 0;
    const watcher = startRestartWatcher({ home, identity: release.identity, limits,
      shutdown: async () => {
        if (failure === "cleanup") throw new Error("secret cleanup");
        if (failure === "cleanup-timeout") return new Promise(() => {});
        if (failure !== "lock") await release();
        if (failure === "identity") await writePrivateJson(pipaPaths(home).lock, { pid: 4242, generation: randomUUID() });
      },
      spawn() {
        finished = runRestartWorker({ home, id: request.id, peer: workerPeer, limits,
          running: () => failure === "process",
          spawn() {
            launches += 1;
            if (failure === "spawn") throw new Error("secret spawn");
            if (failure === "exit") queueMicrotask(() => replacement.emit("exit", 1));
            if (failure === "error") queueMicrotask(() => replacement.emit("error", new Error("secret error")));
            if (failure === "wrong-ready") queueMicrotask(() => replacement.emit("message", { type: "ready", id: request.id, pid: 999, generation: randomUUID() }));
            if (failure === "startup-failed") void reportRestartFailure({ peer: replacementPeer, environment: { PIPA_RESTART_ID: request.id } });
            return replacement;
          },
        });
        return worker;
      },
    });
    t.after(() => watcher.stop());
    await watcher.poll();
    await finished;
    const status = await restartStatus({ home });
    assert.equal(status.state, "failed");
    assert.doesNotMatch(JSON.stringify(status), /secret/);
    if (["cleanup", "cleanup-timeout", "lock", "process", "identity"].includes(failure)) assert.equal(launches, 0);
    if (failure === "identity") assert.equal(JSON.parse(await readFile(pipaPaths(home).lock, "utf8")).pid, 4242);
  });
}

test("numeric legacy locks remain stoppable but cannot request cooperative restart", async (t) => {
  const { home } = await fixture(t);
  await writeFile(pipaPaths(home).lock, String(process.pid));
  await assert.rejects(requestRestart({ home }), /manual stop\/start/);
});

test("independent concurrent watchers atomically accept only once", async (t) => {
  const { home, release } = await fixture(t);
  const request = await requestRestart({ home });
  let workers = 0;
  const watchers = Array.from({ length: 3 }, () => startRestartWatcher({ home, identity: release.identity, limits,
    shutdown: () => assert.fail("not armed"),
    spawn() { workers += 1; throw new Error("expected failure"); },
  }));
  await Promise.all(watchers.map((watcher) => watcher.poll()));
  watchers.forEach((watcher) => watcher.stop());
  assert.equal(workers, 1);
  assert.deepEqual(await requestRestart({ home }), request);
  assert.equal((await restartStatus({ home })).state, "failed");
});

test("dead worker status becomes unconfirmed and an old outcome cannot complete a new generation", async (t) => {
  const { home, release } = await fixture(t);
  const request = await requestRestart({ home });
  const file = path.join(pipaPaths(home).directory, "restarts", `${request.id}.status.json`);
  await writePrivateJson(file, { id: request.id, state: "running", phase: "starting", deadline: 1 });
  const before = await readFile(file, "utf8");
  assert.equal((await restartStatus({ home })).state, "unconfirmed");
  assert.equal(await readFile(file, "utf8"), before);
  await writePrivateJson(file, { id: request.id, state: "completed", phase: "ready", deadline: 1 });
  await release();
  const next = await acquireInstanceLock(pipaPaths(home).lock);
  await requestRestart({ home, now: () => request.createdAt + 1 });
  assert.equal((await restartStatus({ home })).state, "requested");
  assert.equal((await restartStatus({ home, id: request.id })).state, "completed");
  await next();
});
