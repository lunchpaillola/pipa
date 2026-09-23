import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { acquireInstanceLock, pipaPaths, readInstanceLock, writePrivateJson } from "../src/state.mjs";
import { restartStatus } from "../src/restart.mjs";

const cli = fileURLToPath(new URL("../bin/pipa.mjs", import.meta.url));

test("restart requests rather than claims success and status survives the caller", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-restart-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const release = await acquireInstanceLock(pipaPaths(home).lock);
  t.after(release);
  const invoke = (...args) => spawnSync(process.execPath, [cli, "restart", ...args], {
    encoding: "utf8", env: { ...process.env, PIPA_HOME: home },
  });
  assert.match(invoke("--status").stdout, /No restart/u);
  const requested = invoke();
  assert.equal(requested.status, 0, requested.stderr);
  assert.match(requested.stdout, /Restart requested/u);
  assert.doesNotMatch(requested.stdout, /completed|success/iu);
  const status = invoke("--status");
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /requested/u);
  assert.match(status.stdout, new RegExp(release.identity.generation, "u"));
  assert.notEqual(invoke("--bogus").status, 0);
});

for (const mode of ["ready", "unready", "startup-failure"]) test(`isolated Managed restart: ${mode}`, { timeout: 60_000 }, async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-detached-"));
  const paths = pipaPaths(home);
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const url = `http://127.0.0.1:${port}`;
  const fakeBin = path.join(home, "bin");
  await mkdir(fakeBin);
  await writePrivateJson(paths.config, {
    botName: "Isolated", workingDirectory: home, slackMode: "managed",
    openCodeHostname: "127.0.0.1", openCodePort: port,
    allowedSlackUserIds: ["U123"], allowedSlackChannelIds: ["C123"],
  });
  const configBefore = await readFile(paths.config, "utf8");
  await writeFile(path.join(fakeBin, "server.cjs"), `
    const http = require('node:http');
    if (process.env.PIPA_HOME !== ${JSON.stringify(home)}) throw new Error('Profile home changed in the tool environment.');
    if (process.env.PIPA_RESTART_ID && ${JSON.stringify(mode)} === 'startup-failure') process.exit(23);
    const server = http.createServer((req, res) => {
      if (req.url === '/shutdown') { res.end(); server.close(); return; }
      if (process.env.PIPA_RESTART_ID && ${JSON.stringify(mode)} === 'unready') res.statusCode = 503;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({}));
    });
    server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
    process.on('SIGTERM', () => server.close());
  `);
  const executable = path.join(fakeBin, process.platform === "win32" ? "opencode.cmd" : "opencode");
  await writeFile(executable, process.platform === "win32"
    ? `@ECHO off\r\n"${process.execPath}" "%~dp0server.cjs" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "${path.join(fakeBin, "server.cjs")}" "$@"\n`);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  // Observe the real worker's exit without replacing any process boundary.
  const observer = path.join(home, "observe.mjs");
  const workerExit = path.join(home, "worker-exit");
  await writeFile(observer, `import { writeFileSync } from 'node:fs';
    if (process.argv[2] === '--worker') process.on('exit', () => writeFileSync(${JSON.stringify(workerExit)}, String(process.pid)));
  `);
  const environment = {
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
    ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT } : {}),
    HOME: home, USERPROFILE: home, PIPA_HOME: path.relative(process.cwd(), home),
    NODE_OPTIONS: `--import=${pathToFileURL(observer).href}`,
  };
  const original = spawn(process.execPath, [cli, "start"], { env: environment, stdio: "ignore" });
  const originalExit = new Promise((resolve, reject) => {
    original.once("error", reject);
    original.once("exit", (code) => resolve(code));
  });
  let replacement;
  t.after(async () => {
    await fetch(`${url}/shutdown`, { signal: AbortSignal.timeout(2_000) }).catch(() => undefined);
    try { await until(async () => !await readInstanceLock(paths.lock), 8_000); }
    finally {
      // Windows fixture wrappers are process trees; never strand their Node child.
      for (const pid of [original.exitCode === null ? original.pid : null, replacement?.pid].filter(Boolean)) {
        if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/t", "/f"], { stdio: "ignore" });
        else { try { process.kill(pid, "SIGTERM"); } catch {} }
      }
      await rm(home, { recursive: true, force: true });
    }
  });
  await until(async () => fetch(`${url}/session/status`).then((response) => response.ok, () => false));
  const identity = await readInstanceLock(paths.lock);
  assert.equal(identity.pid, original.pid);
  const request = spawnSync(process.execPath, [cli, "restart"], { env: environment, encoding: "utf8" });
  assert.equal(request.status, 0, request.stderr);
  assert.match(request.stdout, /Restart requested/u);
  const outcome = await until(async () => {
    const status = await restartStatus({ home });
    const lock = await readInstanceLock(paths.lock);
    if (lock && lock.pid !== original.pid) replacement = lock;
    if (status?.state === "unconfirmed") assert.fail(JSON.stringify(status));
    return ["completed", "failed"].includes(status?.state) ? status : false;
  }, 45_000);
  assert.equal(await originalExit, 0);
  if (mode !== "ready") {
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.phase, "starting");
    assert.equal(await readInstanceLock(paths.lock), null);
    await assert.rejects(fetch(`${url}/session/status`, { signal: AbortSignal.timeout(1_000) }));
    await until(() => readFile(workerExit, "utf8").catch(() => false));
    assert.equal(await readFile(paths.config, "utf8"), configBefore);
    return;
  }
  assert.equal(outcome.state, "completed", JSON.stringify(outcome));
  replacement = outcome.replacement;
  assert.notEqual(replacement.pid, original.pid);
  assert.notEqual(replacement.generation, identity.generation);
  await until(() => readFile(workerExit, "utf8").catch(() => false));
  await delay(300);
  assert.equal((await fetch(`${url}/session/status`)).ok, true);
  assert.deepEqual(await readInstanceLock(paths.lock), replacement);
  const status = spawnSync(process.execPath, [cli, "restart", "--status"], { env: environment, encoding: "utf8" });
  assert.equal(JSON.parse(status.stdout).state, "completed");
  assert.equal(await readFile(paths.config, "utf8"), configBefore);
});

async function until(check, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await delay(50);
  }
  assert.fail("Isolated lifecycle condition timed out.");
}

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
  return spawnSync(process.execPath, [cli, "routine", ...args], {
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

  const channelOnly = json(run(home, "edit", created.id, "--thread", "none", "--json")).routine;
  assert.equal(channelOnly.destination.threadTs, null);

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

test("prompt files stay inside the configured workspace and reject symlinks", async () => {
  const { home } = await setup();
  const outside = await mkdtemp(path.join(os.tmpdir(), "pipa-prompt-outside-"));
  const outsideFile = path.join(outside, "secret.txt");
  await writeFile(outsideFile, "secret");
  const escaped = run(home, "create", "--prompt-file", outsideFile, "--timezone", "UTC", "--channel", "C123", "--in", "5m", "--preview", "--json");
  assert.notEqual(escaped.status, 0);
  assert.match(JSON.parse(escaped.stdout).error.message, /configured working directory/u);

  if (process.platform !== "win32") {
    const link = path.join(home, "prompt-link.txt");
    await symlink(outsideFile, link);
    const linked = run(home, "create", "--prompt-file", link, "--timezone", "UTC", "--channel", "C123", "--in", "5m", "--preview", "--json");
    assert.notEqual(linked.status, 0);
    assert.match(JSON.parse(linked.stdout).error.message, /configured working directory|symbolic link/u);

    const nested = path.join(home, "prompts");
    await mkdir(nested);
    await symlink(outside, path.join(nested, "outside"));
    const nestedLink = run(home, "create", "--prompt-file", path.join(nested, "outside", "secret.txt"), "--timezone", "UTC", "--channel", "C123", "--in", "5m", "--preview", "--json");
    assert.notEqual(nestedLink.status, 0);
    assert.match(JSON.parse(nestedLink.stdout).error.message, /configured working directory/u);
  }

  const oversized = path.join(home, "oversized.txt");
  await writeFile(oversized, Buffer.alloc((1024 * 1024) + 1));
  const tooLarge = run(home, "create", "--prompt-file", oversized, "--timezone", "UTC", "--channel", "C123", "--in", "5m", "--preview", "--json");
  assert.notEqual(tooLarge.status, 0);
  assert.match(JSON.parse(tooLarge.stdout).error.message, /no larger than 1 MB/u);
});
