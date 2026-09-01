import { constants } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DateTime, IANAZone } from "luxon";
import { pipaPaths, writePrivateJson } from "./state.mjs";

const FREQUENCIES = new Set(["minutes", "hours", "daily", "weekly"]);
const STATUSES = new Set(["active", "inactive", "completed"]);
const RUN_STATUSES = new Set(["succeeded", "failed", "aborted", "denied"]);

export function calculateNextRunAt(schedule, timezone, strictAfter, anchor = strictAfter) {
  validateTimezone(timezone);
  const after = parseTimestamp(strictAfter, "strict-future boundary");
  const start = parseTimestamp(anchor, "schedule anchor");
  assertCanonicalSchedule(schedule, timezone, start);

  if (schedule?.type === "once") {
    const at = parseTimestamp(schedule.at, "once timestamp");
    return at > after ? canonicalIso(at) : null;
  }
  if (schedule.frequency === "minutes" || schedule.frequency === "hours") {
    const milliseconds = schedule.interval * (schedule.frequency === "minutes" ? 60_000 : 3_600_000);
    const steps = Math.max(1, Math.floor((after.toMillis() - start.toMillis()) / milliseconds) + 1);
    const next = DateTime.fromMillis(start.toMillis() + steps * milliseconds, { zone: "utc" });
    return isWithinUntil(next, schedule.until, timezone) ? canonicalIso(next) : null;
  }

  const afterLocal = after.setZone(timezone);
  const anchorLocal = start.setZone(timezone);
  if (schedule.frequency === "daily") {
    const anchorDay = anchorLocal.startOf("day");
    const afterDay = afterLocal.startOf("day");
    const elapsed = Math.round(afterDay.diff(anchorDay, "days").days);
    const offset = modulo(-elapsed, schedule.interval);
    for (const day of [afterDay.plus({ days: offset }), afterDay.plus({ days: offset + schedule.interval })]) {
      const next = firstTimeAfter(day, schedule.times, after);
      if (next && isWithinUntil(next, schedule.until, timezone)) return canonicalIso(next);
    }
    return null;
  }

  const anchorWeek = anchorLocal.startOf("day").minus({ days: anchorLocal.weekday - 1 });
  const afterWeek = afterLocal.startOf("day").minus({ days: afterLocal.weekday - 1 });
  const elapsedWeeks = Math.round(afterWeek.diff(anchorWeek, "weeks").weeks);
  const weekOffset = modulo(-elapsedWeeks, schedule.interval);
  for (const week of [afterWeek.plus({ weeks: weekOffset }), afterWeek.plus({ weeks: weekOffset + schedule.interval })]) {
    for (const weekday of schedule.weekdays) {
      const next = firstTimeAfter(week.plus({ days: weekday - 1 }), schedule.times, after);
      if (next && isWithinUntil(next, schedule.until, timezone)) return canonicalIso(next);
    }
  }
  return null;
}

export function normalizeRoutine(input, now = DateTime.utc().toISO()) {
  if (!input || typeof input !== "object" || Array.isArray(input)) invalid("must be an object");
  const clock = parseTimestamp(now, "clock");
  const id = requiredString(input.id, "id");
  if (typeof input.prompt !== "string" || !input.prompt.trim()) invalid("prompt is empty");
  validateTimezone(input.timezone);
  const schedule = normalizeSchedule(input.schedule, input.timezone, clock);
  const destination = normalizeDestination(input.destination);
  const status = input.status ?? "active";
  if (!STATUSES.has(status)) invalid("status is unsupported");
  const createdAt = input.createdAt === undefined ? canonicalIso(clock) : canonicalTimestamp(input.createdAt, "createdAt");
  const updatedAt = input.updatedAt === undefined ? canonicalIso(clock) : canonicalTimestamp(input.updatedAt, "updatedAt");
  const runRequestedAt = input.runRequestedAt == null ? null : canonicalTimestamp(input.runRequestedAt, "runRequestedAt");
  const lastRun = input.lastRun == null ? null : normalizeLastRun(input.lastRun);
  const calculated = status === "active" ? calculateNextRunAt(schedule, input.timezone, canonicalIso(clock), createdAt) : null;
  if (status === "active" && calculated === null) invalid("active schedule has no future occurrence");

  return {
    id,
    prompt: input.prompt,
    schedule,
    timezone: input.timezone,
    destination,
    status,
    nextRunAt: calculated,
    runRequestedAt,
    createdAt,
    updatedAt,
    lastRun,
  };
}

export async function loadRoutineState(file = pipaPaths().routines) {
  let handle;
  try {
    const info = await lstat(file);
    if (!info.isFile()) throw new Error("routine state must be a regular file");
    handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const opened = await handle.stat();
    if (!opened.isFile()) throw new Error("routine state must be a regular file");
    const state = JSON.parse(await handle.readFile("utf8"));
    validateRoutineState(state);
    return state;
  } catch (error) {
    if (error?.code === "ENOENT") return { version: 1, routines: [] };
    throw new Error(`Could not read Pipa routines: ${error.message}`);
  } finally {
    await handle?.close();
  }
}

export async function acquireRoutineMutationLock(file = pipaPaths().routinesLock, options = {}) {
  const timeoutMs = options.timeoutMs ?? 2_000;
  const retryMs = options.retryMs ?? 10;
  const token = randomUUID();
  const startedAt = Date.now();
  await mkdir(file, { recursive: true, mode: 0o700 });
  const ticket = path.join(file, `${process.pid}-${token}.json`);
  const temporary = `${ticket}.tmp`;
  const createdAt = new Date().toISOString();
  await writeFile(temporary, JSON.stringify({ token, pid: process.pid, createdAt, choosing: true, number: 0 }), { mode: 0o600 });
  try {
    await link(temporary, ticket);
  } finally {
    await rm(temporary, { force: true });
  }
  let number;
  try {
    const existing = await readLockTickets(file);
    number = Math.max(0, ...existing.map((entry) => entry.owner?.number ?? 0)) + 1;
    await writeFile(ticket, JSON.stringify({ token, pid: process.pid, createdAt, choosing: false, number }));
    while (true) {
      let blocked = false;
      for (const entry of await readLockTickets(file)) {
        if (entry.owner?.token === token) continue;
        if (!entry.owner) {
          if (entry.pid && !isRunning(entry.pid)) await rm(entry.file, { force: true });
          else blocked = true;
          continue;
        }
        if (!isRunning(entry.owner.pid)) {
          await rm(entry.file, { force: true });
          continue;
        }
        if (entry.owner.choosing || entry.owner.number < number || (entry.owner.number === number && entry.owner.token < token)) blocked = true;
      }
      if (!blocked) break;
      if (Date.now() - startedAt >= timeoutMs) throw new Error("Routine mutation lock timed out.");
      await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  } catch (error) {
    await rm(ticket, { force: true });
    throw error;
  }

  let released = false;
  return async () => {
    if (released) return;
    released = true;
    const owner = await readLock(ticket);
    if (owner?.token === token) await rm(ticket, { force: true });
  };
}

export async function mutateRoutineState(mutator, paths = pipaPaths(), options = {}) {
  if (typeof mutator !== "function") throw new TypeError("Routine mutator must be a function.");
  const release = await acquireRoutineMutationLock(paths.routinesLock, options);
  try {
    const state = await loadRoutineState(paths.routines);
    const result = mutator(state);
    if (result && typeof result.then === "function") throw new TypeError("Routine mutator must be synchronous.");
    if (result === false) return state;
    validateRoutineState(state);
    await writePrivateJson(paths.routines, state);
    return state;
  } finally {
    await release();
  }
}

export async function requestRoutineRun(id, now = DateTime.utc().toISO(), paths = pipaPaths()) {
  let requested;
  await mutateRoutineState((state) => {
    const routine = state.routines.find((item) => item.id === id);
    if (!routine) throw new Error(`Routine not found: ${id}`);
    const clock = parseTimestamp(now, "clock");
    const previous = routine.runRequestedAt == null ? Number.NEGATIVE_INFINITY : parseTimestamp(routine.runRequestedAt, "runRequestedAt").toMillis();
    routine.runRequestedAt = canonicalIso(DateTime.fromMillis(Math.max(clock.toMillis(), previous + 1), { zone: "utc" }));
    routine.updatedAt = canonicalIso(clock);
    requested = structuredClone(routine);
  }, paths);
  return requested;
}

export function assertRoutineDestinationAllowed(destination, allowedChannelIds = []) {
  const normalized = normalizeDestination(destination);
  if (!/^[CG][A-Z0-9]+$/u.test(normalized.channelId)) invalid("destination channelId must be a concrete Slack channel ID");
  if (normalized.threadTs !== null && !/^\d+\.\d+$/u.test(normalized.threadTs)) invalid("destination threadTs is invalid");
  if (allowedChannelIds.length > 0 && !allowedChannelIds.includes(normalized.channelId)) invalid("destination channel is not allowed");
  return normalized;
}

export async function createRoutine(input, options = {}) {
  const now = options.now ?? DateTime.utc().toISO();
  const paths = options.paths ?? pipaPaths();
  const routine = normalizeRoutine(input, now);
  assertRoutineDestinationAllowed(routine.destination, options.allowedChannelIds);
  if (options.preview) return routine;
  await mutateRoutineState((state) => {
    if (state.routines.some((item) => item.id === routine.id)) throw new Error(`Routine already exists: ${routine.id}`);
    state.routines.push(routine);
  }, paths);
  return routine;
}

export async function editRoutine(id, changes, options = {}) {
  const now = options.now ?? DateTime.utc().toISO();
  const paths = options.paths ?? pipaPaths();
  let edited;
  await mutateRoutineState((state) => {
    const index = state.routines.findIndex((item) => item.id === id);
    if (index === -1) throw new Error(`Routine not found: ${id}`);
    const current = state.routines[index];
    const mutable = new Set(["prompt", "schedule", "timezone", "destination", "status"]);
    if (Object.keys(changes).some((key) => !mutable.has(key))) invalid("edit contains immutable fields");
    const candidate = {
      ...current,
      prompt: changes.prompt ?? current.prompt,
      schedule: changes.schedule ?? current.schedule,
      timezone: changes.timezone ?? current.timezone,
      status: changes.status ?? current.status,
      destination: changes.destination ? { ...current.destination, ...changes.destination } : current.destination,
      updatedAt: now,
    };
    const lifecycleUnchanged = changes.schedule === undefined && changes.timezone === undefined && changes.status === undefined;
    edited = lifecycleUnchanged
      ? { ...normalizeRoutine({ ...candidate, status: "inactive" }, now), status: current.status, nextRunAt: current.nextRunAt }
      : normalizeRoutine(candidate, now);
    assertRoutineDestinationAllowed(edited.destination, options.allowedChannelIds);
    state.routines[index] = edited;
  }, paths);
  return edited;
}

export async function deleteRoutine(id, paths = pipaPaths()) {
  await mutateRoutineState((state) => {
    const index = state.routines.findIndex((item) => item.id === id);
    if (index === -1) throw new Error(`Routine not found: ${id}`);
    state.routines.splice(index, 1);
  }, paths);
}

export function reconcileRoutineState(input, now = DateTime.utc().toISO()) {
  validateRoutineState(input);
  const state = structuredClone(input);
  const clock = parseTimestamp(now, "clock");
  const clockIso = canonicalIso(clock);
  for (const routine of state.routines) {
    if (routine.status !== "active") {
      routine.nextRunAt = null;
      continue;
    }
    if (parseTimestamp(routine.nextRunAt, "nextRunAt") > clock) continue;
    if (routine.schedule.type === "once") {
      routine.status = "inactive";
      routine.nextRunAt = null;
      routine.updatedAt = clockIso;
      continue;
    }
    const next = calculateNextRunAt(routine.schedule, routine.timezone, clockIso, routine.nextRunAt);
    routine.nextRunAt = next;
    routine.updatedAt = clockIso;
    if (next === null) routine.status = "completed";
  }
  validateRoutineState(state);
  return state;
}

export async function reconcileRoutines(now = DateTime.utc().toISO(), paths = pipaPaths()) {
  return mutateRoutineState((state) => {
    state.routines = reconcileRoutineState(state, now).routines;
  }, paths);
}

export async function mergeRoutineRunOutcome(snapshot, outcome, completedAt = DateTime.utc().toISO(), paths = pipaPaths()) {
  validateOutcome(snapshot, outcome);
  const completed = canonicalTimestamp(completedAt, "completedAt");
  let merged = null;
  await mutateRoutineState((state) => {
    const routine = state.routines.find((item) => item.id === snapshot.id);
    if (!routine) return false;
    const denialStillOwned = (snapshot.status === undefined || routine.status === snapshot.status)
      && (snapshot.destination === undefined || JSON.stringify(routine.destination) === JSON.stringify(snapshot.destination));

    if (snapshot.trigger === "run-now") {
      if (routine.runRequestedAt !== snapshot.runRequestedAt) return false;
      routine.runRequestedAt = null;
    } else {
      const ownsOccurrence = routine.status === "active"
        && routine.nextRunAt === snapshot.occurrenceAt
        && JSON.stringify(routine.schedule) === JSON.stringify(snapshot.schedule);
      if (!ownsOccurrence) return false;
      if (routine.schedule.type === "once") {
        routine.status = "completed";
        routine.nextRunAt = null;
      } else {
        routine.nextRunAt = calculateNextRunAt(routine.schedule, routine.timezone, completed, routine.createdAt);
        if (routine.nextRunAt === null) routine.status = "completed";
      }
    }
    if (outcome.status === "denied" && denialStillOwned) {
      routine.status = "inactive";
      routine.nextRunAt = null;
    }
    routine.lastRun = {
      trigger: snapshot.trigger,
      occurrenceAt: canonicalTimestamp(snapshot.occurrenceAt, "occurrenceAt"),
      completedAt: completed,
      status: outcome.status,
      errorCode: outcome.errorCode ?? null,
      errorSummary: outcome.errorSummary ?? null,
    };
    routine.updatedAt = completed;
    merged = structuredClone(routine);
  }, paths);
  return merged;
}

export function createRoutineScheduler(options) {
  const paths = options.paths ?? pipaPaths();
  const intervalMs = options.intervalMs ?? 30_000;
  const active = new Map();
  const blocked = new Set();
  let timer;
  let ticking = false;
  let currentTick = Promise.resolve();
  let started = false;
  let stopped = false;
  let stopReason;

  function tick() {
    if (stopped || ticking) return currentTick;
    ticking = true;
    currentTick = runTick().finally(() => { ticking = false; });
    return currentTick;
  }

  async function runTick() {
    const now = options.now?.() ?? DateTime.utc().toISO();
    const state = await loadRoutineState(paths.routines);
    if (stopped) return;
    for (const [id, entry] of active) {
      const current = state.routines.find((routine) => routine.id === id);
      if (!current || (entry.snapshot.status === "active" && current.status !== "active")) {
        entry.controller.abort(new Error("Routine was deactivated or deleted."));
        if (entry.sessionId) await Promise.resolve(options.abortTurn?.(entry.sessionId, entry.controller.signal.reason)).catch(() => undefined);
      }
    }
    for (const routine of state.routines) {
      if (stopped) break;
      if (active.has(routine.id) || blocked.has(routine.id)) continue;
      const scheduled = routine.status === "active" && routine.nextRunAt !== null && parseTimestamp(routine.nextRunAt, "nextRunAt") <= parseTimestamp(now, "clock");
      if (!scheduled && routine.runRequestedAt === null) continue;
      const trigger = scheduled ? "scheduled" : "run-now";
      const occurrenceAt = scheduled ? routine.nextRunAt : routine.runRequestedAt;
      const snapshot = structuredClone({ ...routine, trigger, occurrenceAt });
      const entry = { snapshot, controller: new AbortController(), sessionId: null };
      active.set(routine.id, entry);
      entry.done = run(entry);
      void entry.done.catch(options.onError ?? (() => undefined));
    }
  }

  async function run(entry) {
    let outcome;
    try {
      outcome = await options.execute(entry.snapshot, {
        signal: entry.controller.signal,
        onSession(sessionId) { entry.sessionId = sessionId; },
        async abort(reason) {
          entry.controller.abort(reason);
          if (entry.sessionId) await Promise.resolve(options.abortTurn?.(entry.sessionId, reason)).catch(() => undefined);
        },
      });
      outcome ??= { status: "succeeded" };
    } catch {
      outcome = entry.controller.signal.aborted
        ? { status: "aborted", errorCode: "aborted", errorSummary: "Routine execution was aborted." }
        : { status: "failed", errorCode: "executor_failed", errorSummary: "Routine execution failed." };
    }
    try {
      if (!stopped) await (options.mergeOutcome ?? mergeRoutineRunOutcome)(entry.snapshot, outcome, options.now?.() ?? DateTime.utc().toISO(), paths);
    } catch (error) {
      blocked.add(entry.snapshot.id);
      throw error;
    } finally {
      if (active.get(entry.snapshot.id) === entry) active.delete(entry.snapshot.id);
    }
  }

  return {
    async start() {
      if (started) throw new Error("Routine scheduler already started.");
      started = true;
      if (stopped) throw stopReason;
      await reconcileRoutines(options.now?.() ?? DateTime.utc().toISO(), paths);
      await tick();
      if (stopped) return;
      timer = (options.setInterval ?? setInterval)(() => { void tick().catch(options.onError ?? (() => undefined)); }, intervalMs);
      timer?.unref?.();
    },
    tick,
    stop(reason = new Error("Pipa stopped.")) {
      if (stopped) return;
      stopped = true;
      stopReason = reason;
      (options.clearInterval ?? clearInterval)(timer);
      for (const entry of active.values()) {
        entry.controller.abort(reason);
        if (entry.sessionId) void Promise.resolve(options.abortTurn?.(entry.sessionId, reason)).catch(() => undefined);
      }
    },
    async drain() {
      await currentTick.catch(() => undefined);
      while (active.size) await Promise.allSettled([...active.values()].map((entry) => entry.done));
    },
  };
}

function normalizeSchedule(schedule, timezone, clock, fail = invalid) {
  if (!schedule || typeof schedule !== "object" || Array.isArray(schedule)) fail("schedule must be an object");
  if (schedule.type === "once") return { type: "once", at: canonicalIso(parseTimestamp(schedule.at, "once timestamp", fail)) };
  if (schedule.type !== "recurring" || !FREQUENCIES.has(schedule.frequency)) fail("schedule frequency is unsupported");
  if (!Number.isSafeInteger(schedule.interval) || schedule.interval <= 0) fail("schedule interval must be a positive integer");
  const until = schedule.until == null ? null : normalizeDate(schedule.until, fail);
  const local = clock.setZone(timezone);
  let times = schedule.times ?? [];
  let weekdays = schedule.weekdays ?? [];
  if (!Array.isArray(times) || !Array.isArray(weekdays)) fail("schedule times and weekdays must be lists");
  if (schedule.frequency === "daily" || schedule.frequency === "weekly") {
    if (times.length === 0) times = [local.toFormat("HH:mm")];
    times = [...new Set(times.map((value) => normalizeTime(value, fail)))].sort();
  } else if (times.length !== 0 || weekdays.length !== 0) {
    fail("minute and hour schedules cannot have times or weekdays");
  }
  if (schedule.frequency === "weekly") {
    if (weekdays.length === 0) weekdays = [local.weekday];
    if (!weekdays.every((value) => Number.isInteger(value) && value >= 1 && value <= 7)) fail("weekdays must be integers from 1 to 7");
    weekdays = [...new Set(weekdays)].sort((left, right) => left - right);
  } else if (weekdays.length !== 0) {
    fail("only weekly schedules can have weekdays");
  }
  return { type: "recurring", frequency: schedule.frequency, interval: schedule.interval, times, weekdays, until };
}

function validateRoutineState(state) {
  if (!state || typeof state !== "object" || Array.isArray(state)) invalidState("must be an object");
  requireKeys(state, ["version", "routines"], "state");
  if (state.version !== 1) invalidState("unsupported version");
  if (!Array.isArray(state.routines)) invalidState("routines must be a list");
  const ids = new Set();
  for (const routine of state.routines) {
    validateCanonicalRoutine(routine);
    if (ids.has(routine.id)) invalidState(`duplicate routine id: ${routine.id}`);
    ids.add(routine.id);
  }
}

function validateCanonicalRoutine(routine) {
  if (!routine || typeof routine !== "object" || Array.isArray(routine)) invalidState("routine must be an object");
  requireKeys(routine, ["id", "prompt", "schedule", "timezone", "destination", "status", "nextRunAt", "runRequestedAt", "createdAt", "updatedAt", "lastRun"], "routine");
  requiredString(routine.id, "id", invalidState);
  if (typeof routine.prompt !== "string" || !routine.prompt.trim()) invalidState("prompt is empty");
  validateTimezone(routine.timezone, invalidState);
  const createdAt = canonicalTimestamp(routine.createdAt, "createdAt", invalidState);
  const updatedAt = canonicalTimestamp(routine.updatedAt, "updatedAt", invalidState);
  assertCanonicalSchedule(routine.schedule, routine.timezone, parseTimestamp(createdAt, "createdAt", invalidState));
  requireKeys(routine.destination, ["channelId", "threadTs"], "destination");
  normalizeDestination(routine.destination, invalidState);
  if (!STATUSES.has(routine.status)) invalidState("status is unsupported");
  if (updatedAt < createdAt) invalidState("updatedAt cannot precede createdAt");
  if (routine.runRequestedAt !== null) canonicalTimestamp(routine.runRequestedAt, "runRequestedAt", invalidState);
  if (routine.status === "active") {
    if (routine.nextRunAt === null) invalidState("active routine must have nextRunAt");
    const next = canonicalTimestamp(routine.nextRunAt, "nextRunAt", invalidState);
    const boundary = canonicalIso(parseTimestamp(next, "nextRunAt").minus({ milliseconds: 1 }));
    if (calculateNextRunAt(routine.schedule, routine.timezone, boundary, createdAt) !== next) invalidState("nextRunAt is not a schedule occurrence");
  } else if (routine.nextRunAt !== null) invalidState("inactive and completed routines cannot have nextRunAt");
  if (routine.lastRun !== null) normalizeLastRun(routine.lastRun, invalidState);
}

function assertCanonicalSchedule(schedule, timezone, clock) {
  if (!isDeepStrictEqual(schedule, normalizeSchedule(schedule, timezone, clock, invalidState))) {
    invalidState("schedule is not canonical");
  }
}

function normalizeLastRun(lastRun, fail = invalid) {
  if (!lastRun || typeof lastRun !== "object" || Array.isArray(lastRun)) fail("lastRun must be an object");
  requireKeys(lastRun, ["trigger", "occurrenceAt", "completedAt", "status", "errorCode", "errorSummary"], "lastRun", fail);
  if (lastRun.trigger !== "scheduled" && lastRun.trigger !== "run-now") fail("lastRun trigger is unsupported");
  if (!RUN_STATUSES.has(lastRun.status)) fail("lastRun status is unsupported");
  const errorCode = lastRun.errorCode == null ? null : requiredString(lastRun.errorCode, "lastRun errorCode", fail);
  const errorSummary = lastRun.errorSummary == null ? null : requiredString(lastRun.errorSummary, "lastRun errorSummary", fail);
  if (errorCode?.length > 64 || errorSummary?.length > 500) fail("lastRun error is too long");
  return {
    trigger: lastRun.trigger,
    occurrenceAt: canonicalTimestamp(lastRun.occurrenceAt, "lastRun occurrenceAt", fail),
    completedAt: canonicalTimestamp(lastRun.completedAt, "lastRun completedAt", fail),
    status: lastRun.status,
    errorCode,
    errorSummary,
  };
}

function normalizeDestination(destination, fail = invalid) {
  if (!destination || typeof destination !== "object" || Array.isArray(destination)) fail("destination must be an object");
  const channelId = requiredString(destination.channelId, "destination channelId", fail);
  const threadTs = destination.threadTs == null ? null : requiredString(destination.threadTs, "destination threadTs", fail);
  return { channelId, threadTs };
}

function validateOutcome(snapshot, outcome) {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) invalid("snapshot is invalid");
  requiredString(snapshot.id, "snapshot id");
  if (snapshot.trigger !== "scheduled" && snapshot.trigger !== "run-now") invalid("snapshot trigger is unsupported");
  if (snapshot.trigger === "run-now" && snapshot.runRequestedAt !== snapshot.occurrenceAt) invalid("run-now marker must own its occurrence");
  if (!outcome || !RUN_STATUSES.has(outcome.status)) invalid("outcome status is unsupported");
  if (outcome.errorCode != null && (typeof outcome.errorCode !== "string" || outcome.errorCode.length > 64)) invalid("outcome error code is invalid");
  if (outcome.errorSummary != null && (typeof outcome.errorSummary !== "string" || outcome.errorSummary.length > 500)) invalid("outcome error summary is invalid");
}

function firstTimeAfter(day, times, after) {
  for (const time of times) {
    const [hour, minute] = time.split(":").map(Number);
    const resolved = DateTime.fromObject({ year: day.year, month: day.month, day: day.day, hour, minute }, { zone: day.zoneName });
    if (!resolved.isValid) continue;
    const candidate = resolved.getPossibleOffsets().sort((left, right) => left.toMillis() - right.toMillis())[0];
    if (candidate > after) return candidate;
  }
  return null;
}

function isWithinUntil(value, until, timezone) {
  return until === null || value.setZone(timezone).toISODate() <= until;
}

function normalizeTime(value, fail = invalidState) {
  if (typeof value !== "string" || !/^(?:[01]\d|2[0-3]):[0-5]\d$/u.test(value)) fail("schedule time is invalid");
  return value;
}

function normalizeDate(value, fail = invalid) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) fail("until date is invalid");
  const parsed = DateTime.fromISO(value, { zone: "utc" });
  if (!parsed.isValid || parsed.toISODate() !== value) fail("until date is invalid");
  return value;
}

function validateTimezone(value, fail = invalid) {
  if (typeof value !== "string" || (value !== "UTC" && !value.includes("/")) || !IANAZone.isValidZone(value)) fail("timezone must be an IANA name");
}

function canonicalTimestamp(value, name, fail = invalid) {
  const parsed = parseTimestamp(value, name, fail);
  const canonical = canonicalIso(parsed);
  if (value !== canonical) fail(`${name} must be canonical UTC ISO`);
  return canonical;
}

function parseTimestamp(value, name, fail = invalid) {
  if (typeof value !== "string") fail(`${name} is invalid`);
  const parsed = DateTime.fromISO(value, { setZone: true });
  if (!parsed.isValid) fail(`${name} is invalid`);
  return parsed.toUTC();
}

function canonicalIso(value) {
  return value.toUTC().toISO({ suppressMilliseconds: false, includeOffset: true });
}

function requiredString(value, name, fail = invalid) {
  if (typeof value !== "string" || !value.trim()) fail(`${name} is missing`);
  return value;
}

function requireKeys(value, expected, name, fail = invalidState) {
  const keys = Object.keys(value).sort();
  const canonical = [...expected].sort();
  if (JSON.stringify(keys) !== JSON.stringify(canonical)) fail(`${name} has invalid fields`);
}

async function readLock(file) {
  try {
    const value = JSON.parse(await readFile(file, "utf8"));
    if (typeof value.token !== "string" || !Number.isSafeInteger(value.pid) || typeof value.createdAt !== "string"
      || typeof value.choosing !== "boolean" || !Number.isSafeInteger(value.number) || value.number < 0) return null;
    return value;
  } catch {
    return null;
  }
}

async function readLockTickets(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  return Promise.all(entries.filter((entry) => entry.isFile() && entry.name.endsWith(".json")).map(async (entry) => {
    const file = path.join(directory, entry.name);
    const pid = Number.parseInt(entry.name.split("-")[0], 10);
    return { file, pid: Number.isSafeInteger(pid) ? pid : null, owner: await readLock(file) };
  }));
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function modulo(value, divisor) {
  return ((value % divisor) + divisor) % divisor;
}

function invalid(message) {
  throw new Error(`Invalid routine: ${message}`);
}

function invalidState(message) {
  throw new Error(`Invalid routine state: ${message}`);
}
