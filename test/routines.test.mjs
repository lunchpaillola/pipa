import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  acquireRoutineMutationLock,
  calculateNextRunAt,
  createRoutineScheduler,
  editRoutine,
  loadRoutineState,
  mergeRoutineRunOutcome,
  mutateRoutineState,
  normalizeRoutine,
  reconcileRoutineState,
  requestRoutineRun,
} from "../src/routines.mjs";
import { pipaPaths, writePrivateJson } from "../src/state.mjs";

const NOW = "2026-08-29T12:00:00.000Z";

function candidate(overrides = {}) {
  return {
    id: "morning-brief",
    prompt: "  exact prompt\n",
    schedule: { type: "recurring", frequency: "daily", interval: 1, times: ["09:00"], weekdays: [], until: null },
    timezone: "America/New_York",
    destination: { channelId: "C123", threadTs: null },
    ...overrides,
  };
}

test("normalizes once and each recurring frequency to strict-future occurrences", () => {
  const cases = [
    [{ type: "once", at: "2026-08-29T13:00:00Z" }, "2026-08-29T13:00:00.000Z"],
    [{ type: "recurring", frequency: "minutes", interval: 30, times: [], weekdays: [], until: null }, "2026-08-29T12:30:00.000Z"],
    [{ type: "recurring", frequency: "hours", interval: 2, times: [], weekdays: [], until: null }, "2026-08-29T14:00:00.000Z"],
    [{ type: "recurring", frequency: "daily", interval: 1, times: ["08:00", "09:00"], weekdays: [], until: null }, "2026-08-29T13:00:00.000Z"],
    [{ type: "recurring", frequency: "weekly", interval: 1, times: ["09:00"], weekdays: [2, 4, 6], until: null }, "2026-08-29T13:00:00.000Z"],
  ];

  for (const [schedule, expected] of cases) {
    const routine = normalizeRoutine(candidate({ schedule }), NOW);
    assert.equal(routine.nextRunAt, expected);
    assert.ok(Date.parse(routine.nextRunAt) > Date.parse(NOW));
  }
});

test("selects weekly weekday/time combinations and includes the until date", () => {
  const schedule = { type: "recurring", frequency: "weekly", interval: 1, times: ["18:00", "09:00", "15:00", "09:00"], weekdays: [6, 2, 4, 2], until: null };
  const routine = normalizeRoutine(candidate({ schedule }), "2026-08-31T12:00:00.000Z");
  assert.deepEqual(routine.schedule.times, ["09:00", "15:00", "18:00"]);
  assert.deepEqual(routine.schedule.weekdays, [2, 4, 6]);
  assert.equal(routine.nextRunAt, "2026-09-01T13:00:00.000Z");

  const daily = { type: "recurring", frequency: "daily", interval: 1, times: ["19:00"], weekdays: [], until: "2026-09-05" };
  assert.equal(calculateNextRunAt(daily, "America/New_York", "2026-09-05T20:00:00.000Z"), "2026-09-05T23:00:00.000Z");
  assert.equal(calculateNextRunAt(daily, "America/New_York", "2026-09-05T23:00:00.000Z"), null);
});

test("uses one wall-clock occurrence across DST gaps and repeats", () => {
  const daily = { type: "recurring", frequency: "daily", interval: 1, times: ["02:30"], weekdays: [], until: null };
  assert.equal(calculateNextRunAt(daily, "America/New_York", "2026-03-08T06:59:00.000Z"), "2026-03-08T07:30:00.000Z");

  const repeated = { ...daily, times: ["01:30"] };
  assert.equal(calculateNextRunAt(repeated, "America/New_York", "2026-11-01T04:00:00.000Z"), "2026-11-01T05:30:00.000Z");
  assert.equal(calculateNextRunAt(repeated, "America/New_York", "2026-11-01T05:30:00.000Z"), "2026-11-02T06:30:00.000Z");
});

test("fails closed on invalid routine inputs", () => {
  for (const overrides of [
    { timezone: "EST" },
    { schedule: { type: "recurring", frequency: "minutes", interval: 0, times: [], weekdays: [], until: null } },
    { schedule: { type: "recurring", frequency: "months", interval: 1, times: [], weekdays: [], until: null } },
    { schedule: { type: "recurring", frequency: "daily", interval: 1, times: ["25:00"], weekdays: [], until: null } },
    { prompt: " \n " },
  ]) assert.throws(() => normalizeRoutine(candidate(overrides), NOW), /Invalid routine/u);
});

test("private state rejects malformed, duplicate, and non-regular files without changing bytes", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  await mkdir(paths.directory, { recursive: true });
  await writeFile(paths.routines, "not-json");
  const before = await readFile(paths.routines, "utf8");
  await assert.rejects(loadRoutineState(paths.routines), /Could not read Pipa routines/u);
  await assert.rejects(mutateRoutineState(() => {}, paths), /Could not read Pipa routines/u);
  assert.equal(await readFile(paths.routines, "utf8"), before);

  const routine = normalizeRoutine(candidate(), NOW);
  await writeFile(paths.routines, JSON.stringify({ version: 1, routines: [routine, routine] }));
  await assert.rejects(loadRoutineState(paths.routines), /duplicate routine id/u);
  await writeFile(paths.routines, JSON.stringify({ version: 2, routines: [] }));
  await assert.rejects(loadRoutineState(paths.routines), /unsupported version/u);
  await writeFile(paths.routines, JSON.stringify({ version: 1, routines: [{ ...routine, nextRunAt: "2026-08-30T14:00:00.000Z" }] }));
  await assert.rejects(loadRoutineState(paths.routines), /not a schedule occurrence/u);

  const target = path.join(home, "target.json");
  await writeFile(target, JSON.stringify({ version: 1, routines: [] }));
  await writeFile(paths.routines, "replace-me");
  await rm(paths.routines);
  await symlink(target, paths.routines);
  await assert.rejects(loadRoutineState(paths.routines), /regular file/u);
});

test("serializes fresh mutations and writes private atomic JSON", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  await Promise.all(Array.from({ length: 8 }, (_, index) => mutateRoutineState((state) => {
    state.routines.push(normalizeRoutine(candidate({ id: `routine-${index}` }), NOW));
  }, paths)));
  const state = await loadRoutineState(paths.routines);
  assert.equal(state.routines.length, 8);
  if (process.platform !== "win32") {
    assert.equal((await stat(paths.routines)).mode & 0o777, 0o600);
    assert.equal((await stat(paths.directory)).mode & 0o777, 0o700);
  }
});

test("mutation locks recover dead owners, time out on live owners, and release by token", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-lock-"));
  const file = pipaPaths(home).routinesLock;
  await mkdir(file, { recursive: true });
  await writeFile(path.join(file, "99999999-dead.json"), JSON.stringify({ token: "dead", pid: 99999999, createdAt: NOW, choosing: false, number: 1 }));
  let active = 0;
  let maxActive = 0;
  await Promise.all(Array.from({ length: 3 }, async () => {
    const release = await acquireRoutineMutationLock(file, { timeoutMs: 500 });
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 5));
    active -= 1;
    await release();
  }));
  assert.equal(maxActive, 1);

  const releaseFirst = await acquireRoutineMutationLock(file, { timeoutMs: 100 });
  await assert.rejects(acquireRoutineMutationLock(file, { timeoutMs: 30 }), /timed out/u);
  await releaseFirst();
  const releaseSecond = await acquireRoutineMutationLock(file, { timeoutMs: 100 });
  await releaseFirst();
  await assert.rejects(acquireRoutineMutationLock(file, { timeoutMs: 30 }), /timed out/u);
  await releaseSecond();
});

test("run requests replace same-clock markers without changing lifecycle fields", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  const routine = normalizeRoutine(candidate(), NOW);
  await writePrivateJson(paths.routines, { version: 1, routines: [routine] });
  const first = await requestRoutineRun(routine.id, NOW, paths);
  const second = await requestRoutineRun(routine.id, NOW, paths);
  assert.notEqual(first.runRequestedAt, second.runRequestedAt);
  assert.ok(Date.parse(second.runRequestedAt) > Date.parse(first.runRequestedAt));
  assert.equal(second.status, routine.status);
  assert.equal(second.nextRunAt, routine.nextRunAt);
  assert.deepEqual(second.schedule, routine.schedule);
});

test("restart reconciliation skips stale recurrence, inactivates missed once, and preserves run-now", () => {
  const recurring = normalizeRoutine(candidate(), "2026-08-28T12:00:00.000Z");
  recurring.nextRunAt = "2026-08-28T13:00:00.000Z";
  recurring.runRequestedAt = "2026-08-29T11:00:00.000Z";
  const once = normalizeRoutine(candidate({ id: "once", schedule: { type: "once", at: "2026-08-29T11:00:00Z" } }), "2026-08-29T10:00:00.000Z");
  const state = reconcileRoutineState({ version: 1, routines: [recurring, once] }, NOW);
  assert.ok(Date.parse(state.routines[0].nextRunAt) > Date.parse(NOW));
  assert.equal(state.routines[0].runRequestedAt, "2026-08-29T11:00:00.000Z");
  assert.equal(state.routines[1].status, "inactive");
  assert.equal(state.routines[1].nextRunAt, null);
});

test("conditional outcome merges preserve edits, deletion, deactivation, and newer requests", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  const routine = normalizeRoutine(candidate(), NOW);
  routine.runRequestedAt = "2026-08-29T12:01:00.000Z";
  await writePrivateJson(paths.routines, { version: 1, routines: [routine] });

  const runSnapshot = { id: routine.id, trigger: "run-now", runRequestedAt: routine.runRequestedAt, occurrenceAt: routine.runRequestedAt };
  await requestRoutineRun(routine.id, routine.runRequestedAt, paths);
  await mergeRoutineRunOutcome(runSnapshot, { status: "failed", errorCode: "executor_failed", errorSummary: "bounded" }, "2026-08-29T12:02:00.000Z", paths);
  assert.notEqual((await loadRoutineState(paths.routines)).routines[0].runRequestedAt, null);

  const scheduledSnapshot = { id: routine.id, trigger: "scheduled", occurrenceAt: routine.nextRunAt, schedule: routine.schedule };
  await mutateRoutineState((state) => { state.routines[0].status = "inactive"; state.routines[0].nextRunAt = null; }, paths);
  await mergeRoutineRunOutcome(scheduledSnapshot, { status: "failed", errorCode: "delivery_failed" }, "2026-08-29T13:00:00.000Z", paths);
  const inactive = (await loadRoutineState(paths.routines)).routines[0];
  assert.equal(inactive.status, "inactive");
  assert.equal(inactive.nextRunAt, null);
  assert.equal(inactive.lastRun, null);

  await mutateRoutineState((state) => { state.routines.length = 0; }, paths);
  assert.equal(await mergeRoutineRunOutcome(scheduledSnapshot, { status: "succeeded" }, "2026-08-29T13:00:00.000Z", paths), null);
});

test("scheduled outcomes consume failures, final runs complete, denial deactivates, and run-now stays lifecycle-neutral", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  const final = normalizeRoutine(candidate({ schedule: { type: "recurring", frequency: "daily", interval: 1, times: ["09:00"], weekdays: [], until: "2026-08-29" } }), "2026-08-29T12:00:00.000Z");
  await writePrivateJson(paths.routines, { version: 1, routines: [final] });
  const snapshot = { id: final.id, trigger: "scheduled", occurrenceAt: final.nextRunAt, schedule: final.schedule };
  const completed = await mergeRoutineRunOutcome(snapshot, { status: "failed", errorCode: "executor_failed" }, final.nextRunAt, paths);
  assert.equal(completed.status, "completed");
  assert.equal(completed.nextRunAt, null);
  assert.equal(completed.lastRun.status, "failed");

  const denied = normalizeRoutine(candidate({ id: "denied" }), NOW);
  await mutateRoutineState((state) => { state.routines.push(denied); }, paths);
  const deniedResult = await mergeRoutineRunOutcome({ id: denied.id, trigger: "scheduled", occurrenceAt: denied.nextRunAt, schedule: denied.schedule }, { status: "denied", errorCode: "destination_denied" }, denied.nextRunAt, paths);
  assert.equal(deniedResult.status, "inactive");
  assert.equal(deniedResult.nextRunAt, null);

  const manual = normalizeRoutine(candidate({ id: "manual", status: "inactive" }), NOW);
  manual.runRequestedAt = "2026-08-29T12:01:00.000Z";
  await mutateRoutineState((state) => { state.routines.push(manual); }, paths);
  const manualResult = await mergeRoutineRunOutcome({ id: manual.id, trigger: "run-now", occurrenceAt: manual.runRequestedAt, runRequestedAt: manual.runRequestedAt }, { status: "failed", errorCode: "executor_failed" }, "2026-08-29T12:02:00.000Z", paths);
  assert.equal(manualResult.status, "inactive");
  assert.equal(manualResult.nextRunAt, null);
  assert.equal(manualResult.runRequestedAt, null);
});

test("scheduler runs different routines concurrently without overlapping the same routine", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  let now = "2026-08-29T12:00:00.000Z";
  const first = normalizeRoutine(candidate({ id: "first", schedule: { type: "recurring", frequency: "hours", interval: 1, times: [], weekdays: [], until: null } }), now);
  const second = normalizeRoutine(candidate({ id: "second", schedule: { type: "once", at: "2026-08-29T13:00:00Z" } }), now);
  await writePrivateJson(paths.routines, { version: 1, routines: [first, second] });
  const calls = [];
  const releases = [];
  const scheduler = createRoutineScheduler({
    paths,
    now: () => now,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    execute: async (snapshot) => {
      calls.push(snapshot);
      return new Promise((resolve) => releases.push(() => resolve({ status: "succeeded" })));
    },
  });
  await scheduler.start();
  assert.deepEqual(calls, []);

  await requestRoutineRun(first.id, "2026-08-29T12:30:00.000Z", paths);
  now = "2026-08-29T13:00:00.000Z";
  await scheduler.tick();
  await scheduler.tick();
  assert.equal(calls.length, 2);
  assert.ok(calls.every((snapshot) => snapshot.trigger === "scheduled"));
  releases.splice(0).forEach((release) => release());
  await scheduler.drain();

  await scheduler.tick();
  assert.equal(calls.length, 3);
  assert.equal(calls[2].id, "first");
  assert.equal(calls[2].trigger, "run-now");
  releases.splice(0).forEach((release) => release());
  await scheduler.drain();
  scheduler.stop();

  const state = await loadRoutineState(paths.routines);
  assert.equal(state.routines.find((routine) => routine.id === "first").runRequestedAt, null);
  assert.equal(state.routines.find((routine) => routine.id === "second").status, "completed");
});

test("scheduler aborts deactivated and deleted routines without resurrecting them", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  let now = "2026-08-29T12:00:00.000Z";
  const routines = ["inactive", "deleted"].map((id) => normalizeRoutine(candidate({ id, schedule: { type: "once", at: "2026-08-29T13:00:00Z" } }), now));
  await writePrivateJson(paths.routines, { version: 1, routines });
  const aborted = [];
  const scheduler = createRoutineScheduler({
    paths,
    now: () => now,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    abortTurn: async (sessionId) => aborted.push(sessionId),
    execute: async (snapshot, { signal, onSession }) => {
      onSession(`ses_${snapshot.id}`);
      return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  await scheduler.start();
  now = "2026-08-29T13:00:00.000Z";
  await scheduler.tick();
  await mutateRoutineState((state) => {
    state.routines[0].status = "inactive";
    state.routines[0].nextRunAt = null;
    state.routines.splice(1, 1);
  }, paths);
  await scheduler.tick();
  await scheduler.drain();
  scheduler.stop();

  assert.deepEqual(aborted.sort(), ["ses_deleted", "ses_inactive"]);
  const state = await loadRoutineState(paths.routines);
  assert.equal(state.routines.length, 1);
  assert.equal(state.routines[0].status, "inactive");
  assert.equal(state.routines[0].lastRun, null);
});

test("scheduler shutdown preserves a pending run-now marker", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  const routine = normalizeRoutine(candidate({ status: "inactive" }), NOW);
  routine.runRequestedAt = "2026-08-29T12:01:00.000Z";
  await writePrivateJson(paths.routines, { version: 1, routines: [routine] });
  const scheduler = createRoutineScheduler({
    paths,
    now: () => "2026-08-29T12:02:00.000Z",
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    execute: async (_, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  });
  await scheduler.start();
  scheduler.stop();
  await scheduler.drain();
  assert.equal((await loadRoutineState(paths.routines)).routines[0].runRequestedAt, routine.runRequestedAt);
});

test("long recurring runs skip elapsed occurrences", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  const routine = normalizeRoutine(candidate({ schedule: { type: "recurring", frequency: "minutes", interval: 30, times: [], weekdays: [], until: null } }), NOW);
  await writePrivateJson(paths.routines, { version: 1, routines: [routine] });
  const merged = await mergeRoutineRunOutcome({ id: routine.id, trigger: "scheduled", occurrenceAt: routine.nextRunAt, schedule: routine.schedule }, { status: "succeeded" }, "2026-08-29T15:05:00.000Z", paths);
  assert.equal(merged.nextRunAt, "2026-08-29T15:30:00.000Z");
});

test("a stopped in-flight tick cannot dispatch new work", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  let now = "2026-08-29T12:00:00.000Z";
  const routine = normalizeRoutine(candidate({ schedule: { type: "once", at: "2026-08-29T13:00:00Z" } }), now);
  await writePrivateJson(paths.routines, { version: 1, routines: [routine] });
  let calls = 0;
  const scheduler = createRoutineScheduler({
    paths,
    now: () => now,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    execute: async () => { calls += 1; return { status: "succeeded" }; },
  });
  await scheduler.start();
  now = "2026-08-29T13:00:00.000Z";
  const tick = scheduler.tick();
  scheduler.stop();
  await tick;
  await scheduler.drain();
  assert.equal(calls, 0);
});

test("run-now denial does not overwrite a concurrent destination edit", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  const routine = normalizeRoutine(candidate({ status: "inactive" }), NOW);
  routine.runRequestedAt = "2026-08-29T12:01:00.000Z";
  await writePrivateJson(paths.routines, { version: 1, routines: [routine] });
  await mutateRoutineState((state) => {
    state.routines[0].destination = { channelId: "C999", threadTs: null };
    state.routines[0].status = "active";
    state.routines[0].nextRunAt = routine.nextRunAt ?? "2026-08-29T13:00:00.000Z";
  }, paths);
  const merged = await mergeRoutineRunOutcome({
    ...routine,
    trigger: "run-now",
    occurrenceAt: routine.runRequestedAt,
  }, { status: "denied", errorCode: "destination_denied" }, "2026-08-29T12:02:00.000Z", paths);
  assert.equal(merged.status, "active");
  assert.equal(merged.destination.channelId, "C999");
  assert.equal(merged.runRequestedAt, null);
});

test("scheduled outcomes consume their occurrence without overwriting a destination edit", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  const routine = normalizeRoutine(candidate(), NOW);
  await writePrivateJson(paths.routines, { version: 1, routines: [routine] });
  await mutateRoutineState((state) => { state.routines[0].destination.channelId = "C999"; }, paths);

  const merged = await mergeRoutineRunOutcome({
    id: routine.id,
    trigger: "scheduled",
    occurrenceAt: routine.nextRunAt,
    schedule: routine.schedule,
    status: routine.status,
    destination: routine.destination,
  }, { status: "denied", errorCode: "destination_denied" }, "2026-08-29T13:00:00.000Z", paths);

  assert.equal(merged.status, "active");
  assert.equal(merged.destination.channelId, "C999");
  assert.ok(Date.parse(merged.nextRunAt) > Date.parse(routine.nextRunAt));
  assert.equal(merged.lastRun.status, "denied");
});

test("domain edits reject lifecycle-owned fields", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  const routine = normalizeRoutine(candidate(), NOW);
  await writePrivateJson(paths.routines, { version: 1, routines: [routine] });
  await assert.rejects(editRoutine(routine.id, { runRequestedAt: NOW }, { now: NOW, paths }), /immutable fields/u);
  assert.deepEqual((await loadRoutineState(paths.routines)).routines[0], routine);
});

test("prompt and destination edits preserve a due occurrence", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  const routine = normalizeRoutine(candidate({ schedule: { type: "once", at: "2026-08-29T13:00:00Z" } }), NOW);
  await writePrivateJson(paths.routines, { version: 1, routines: [routine] });
  const edited = await editRoutine(routine.id, { prompt: "updated", destination: { channelId: "C999" } }, {
    now: "2026-08-29T14:00:00.000Z",
    paths,
  });
  assert.equal(edited.nextRunAt, routine.nextRunAt);
  assert.equal(edited.prompt, "updated");
  assert.equal(edited.destination.channelId, "C999");
});

test("scheduler blocks a routine after outcome persistence fails", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routines-"));
  const paths = pipaPaths(home);
  let now = "2026-08-29T12:00:00.000Z";
  const routine = normalizeRoutine(candidate({ schedule: { type: "once", at: "2026-08-29T13:00:00Z" } }), now);
  await writePrivateJson(paths.routines, { version: 1, routines: [routine] });
  let calls = 0;
  const errors = [];
  const scheduler = createRoutineScheduler({
    paths,
    now: () => now,
    setInterval: () => ({ unref() {} }),
    clearInterval() {},
    onError: (error) => errors.push(error.message),
    execute: async () => { calls += 1; return { status: "succeeded" }; },
    mergeOutcome: async () => { throw new Error("disk failed"); },
  });
  await scheduler.start();
  now = "2026-08-29T13:00:00.000Z";
  await scheduler.tick();
  await scheduler.drain();
  await scheduler.tick();
  assert.equal(calls, 1);
  assert.deepEqual(errors, ["disk failed"]);
  scheduler.stop();
});
