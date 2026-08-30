import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { pipaPaths, writePrivateJson } from "../src/state.mjs";

const cli = new URL("../bin/pipa.mjs", import.meta.url);

async function setup(allowedSlackChannelIds = ["C123"]) {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-cli-"));
  const paths = pipaPaths(home);
  await writePrivateJson(paths.config, {
    botName: "Pipa",
    workingDirectory: home,
    slackAppToken: "test-app-token",
    slackBotToken: "test-bot-token",
    allowedSlackChannelIds,
    allowedSlackUserIds: [],
  });
  return { home, paths };
}

function run(home, ...args) {
  return spawnSync(process.execPath, [cli.pathname, "routine", ...args], {
    encoding: "utf8",
    env: { ...process.env, PIPA_HOME: home },
  });
}

function json(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

test("preview normalizes schedules without writing state", async () => {
  const { home, paths } = await setup();
  const result = json(run(home, "create", "--prompt", "brief", "--timezone", "America/New_York", "--channel", "C123", "--every", "1d", "--times", "05:00", "--preview", "--json"));
  assert.equal(result.ok, true);
  assert.equal(result.preview, true);
  assert.equal(result.routine.prompt, "brief");
  assert.deepEqual(result.routine.schedule, { type: "recurring", frequency: "daily", interval: 1, times: ["05:00"], weekdays: [], until: null });
  assert.deepEqual(result.routine.destination, { channelId: "C123", threadTs: null });
  await assert.rejects(readFile(paths.routines), { code: "ENOENT" });

  const before = Date.now();
  const relative = json(run(home, "create", "--prompt", "later", "--timezone", "UTC", "--channel", "C123", "--in", "5m", "--preview", "--json"));
  assert.ok(Date.parse(relative.routine.schedule.at) >= before + 299_000);
  assert.ok(Date.parse(relative.routine.schedule.at) <= Date.now() + 301_000);

  const everyThirty = json(run(home, "create", "--prompt", "often", "--timezone", "UTC", "--channel", "C123", "--every", "30m", "--preview", "--json"));
  assert.equal(everyThirty.routine.schedule.frequency, "minutes");
  assert.equal(everyThirty.routine.schedule.interval, 30);

  const inclusive = json(run(home, "create", "--prompt", "evening", "--timezone", "America/New_York", "--channel", "C123", "--every", "1d", "--times", "19:00", "--until", "2030-09-05", "--preview", "--json"));
  assert.equal(inclusive.routine.schedule.until, "2030-09-05");
});

test("create, list, show, edit, run, and delete preserve lifecycle fields", async () => {
  const { home } = await setup();
  const created = json(run(home, "create", "--prompt", "daily", "--timezone", "UTC", "--channel", "C123", "--thread", "123.456", "--every", "30m", "--json")).routine;
  assert.equal(json(run(home, "list", "--json")).routines.length, 1);
  assert.deepEqual(json(run(home, "show", created.id, "--json")).routine, created);

  const inactive = json(run(home, "edit", created.id, "--status", "inactive", "--json")).routine;
  assert.equal(inactive.status, "inactive");
  assert.equal(inactive.nextRunAt, null);
  const requested = json(run(home, "run", created.id, "--json")).routine;
  assert.ok(requested.runRequestedAt);
  assert.equal(requested.status, "inactive");
  assert.deepEqual(requested.schedule, created.schedule);

  const active = json(run(home, "edit", created.id, "--status", "active", "--json")).routine;
  assert.equal(active.status, "active");
  assert.ok(active.nextRunAt);
  assert.equal(json(run(home, "delete", created.id, "--json")).deleted, created.id);
  assert.deepEqual(json(run(home, "list", "--json")).routines, []);
});

test("reactivating a stale one-time routine requires a new future schedule", async () => {
  const { home } = await setup();
  const created = json(run(home, "create", "--prompt", "once", "--timezone", "UTC", "--channel", "C123", "--at", "2030-01-01T00:00:00Z", "--json")).routine;
  json(run(home, "edit", created.id, "--status", "inactive", "--json"));
  const stateFile = pipaPaths(home).routines;
  const state = JSON.parse(await readFile(stateFile, "utf8"));
  state.routines[0].schedule.at = "2020-01-01T00:00:00.000Z";
  await writeFile(stateFile, JSON.stringify(state));

  const failed = run(home, "edit", created.id, "--status", "active", "--json");
  assert.notEqual(failed.status, 0);
  assert.match(JSON.parse(failed.stdout).error.message, /no future occurrence/u);
  const reactivated = json(run(home, "edit", created.id, "--status", "active", "--at", "2031-01-01T00:00:00Z", "--json")).routine;
  assert.equal(reactivated.status, "active");
});

test("rejects malformed and disallowed destinations without mutating state", async () => {
  const { home, paths } = await setup(["C123"]);
  for (const channel of ["general", "current_channel", "C999"]) {
    const result = run(home, "create", "--prompt", "nope", "--timezone", "UTC", "--channel", channel, "--every", "1h", "--json");
    assert.notEqual(result.status, 0);
    assert.equal(JSON.parse(result.stdout).ok, false);
  }
  await assert.rejects(readFile(paths.routines), { code: "ENOENT" });

  const created = json(run(home, "create", "--prompt", "allowed", "--timezone", "UTC", "--channel", "C123", "--every", "1h", "--json")).routine;
  const edit = run(home, "edit", created.id, "--channel", "C999", "--json");
  assert.notEqual(edit.status, 0);
  assert.equal(JSON.parse(edit.stdout).ok, false);
  assert.equal(JSON.parse(await readFile(paths.routines, "utf8")).routines[0].destination.channelId, "C123");
});

test("prompt files preserve exact multiline and shell-like bytes", async () => {
  const { home } = await setup();
  const promptFile = path.join(home, "prompt.txt");
  const prompt = "  --option `tick` $(touch nope) \"quotes\"\nUnicode café  \n";
  await writeFile(promptFile, prompt);
  const result = json(run(home, "create", "--prompt-file", promptFile, "--timezone", "UTC", "--channel", "C123", "--weekdays", "2,4,6", "--times", "09:00,15:00,18:00", "--until", "2030-09-05", "--every", "1w", "--preview", "--json"));
  assert.equal(result.routine.prompt, prompt);
  assert.deepEqual(result.routine.schedule.weekdays, [2, 4, 6]);
  assert.deepEqual(result.routine.schedule.times, ["09:00", "15:00", "18:00"]);
  assert.equal(result.routine.schedule.until, "2030-09-05");
});
