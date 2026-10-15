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
import { createRuntimeFixture } from "./helpers/runtime-fixture.mjs";

const cli = fileURLToPath(new URL("../bin/pipa.mjs", import.meta.url));

for (const failure of ["authentication", "protocol", "temporary"]) test(`U1 ordinary Managed readiness policy: ${failure}`, { timeout: 45000 }, async (t) => {
  const runtime = await createRuntimeFixture({ timeoutMs: 42000 });
  t.after(() => runtime.teardown());
  const paths = pipaPaths(runtime.home);
  const reservation = createServer();
  await new Promise((resolve) => reservation.listen(0, "127.0.0.1", resolve));
  const port = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const config = { botName: "Pipa", workingDirectory: runtime.workspace, slackMode: "managed", openCodeHostname: "127.0.0.1", openCodePort: port };
  await writePrivateJson(paths.config, config);
  const before = await readFile(paths.config, "utf8");
  const fakeBin = path.join(runtime.root, "bin");
  await mkdir(fakeBin);
  const script = path.join(fakeBin, "fake.cjs");
  await writeFile(script, `
    if (process.argv.includes('--version')) { console.log('OpenCode 1.19.0'); process.exit(0); }
    const http = require('node:http');
    const server = http.createServer((req, res) => { res.writeHead(${failure === "authentication" ? 401 : failure === "temporary" ? 503 : 200}, { 'content-type': 'application/json' }); res.end('{}'); });
    server.listen(Number(process.argv[process.argv.indexOf('--port') + 1]), '127.0.0.1');
    process.on('SIGTERM', () => server.close());
  `);
  const executable = path.join(fakeBin, process.platform === "win32" ? "opencode.cmd" : "opencode");
  await writeFile(executable, process.platform === "win32" ? `@ECHO off\r\n"${process.execPath}" "%~dp0fake.cjs" %*\r\n` : `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  runtime.env.PATH = `${fakeBin}${path.delimiter}${runtime.env.PATH}`;
  const { child, exited } = runtime.spawn(process.execPath, [cli, "start"]);
  let stderr = "";
  child.stderr.on("data", (data) => { stderr += data; });
  if (failure === "temporary") {
    await runtime.waitFor(() => stderr.includes("Managed restart unavailable"), { timeoutMs: 35000, label: "temporary readiness policy" });
    assert.equal(child.exitCode, null);
    assert.ok(await readInstanceLock(paths.lock));
    const request = spawnSync(process.execPath, [cli, "restart"], { env: runtime.env, encoding: "utf8" });
    assert.equal(request.status, 0, request.stderr);
    await delay(300);
    assert.equal((await restartStatus({ home: runtime.home })).state, "requested", "unready Managed must not claim restart readiness");
    child.kill("SIGTERM");
    assert.equal((await exited).code, 0);
  } else {
    assert.equal((await exited).code, 1);
    assert.match(stderr, failure === "authentication" ? /authentication failed/iu : /identity protocol/iu);
    assert.doesNotMatch(stderr, /Managed restart unavailable/u);
  }
  assert.equal(await readInstanceLock(paths.lock), null);
  assert.equal(await readFile(paths.config, "utf8"), before);
});

test("restart requests rather than claims success and status survives the caller", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-restart-cli-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const release = await acquireInstanceLock(pipaPaths(home).lock);
  t.after(release);
  const invoke = (...args) => spawnSync(process.execPath, [cli, "restart", ...args], {
    encoding: "utf8", env: { ...process.env, PIPA_HOME: home },
  });
  assert.match(invoke("--status").stdout, /No restart/u);
  const requested = invoke("--channel", "C123", "--thread", "123.456");
  assert.equal(requested.status, 0, requested.stderr);
  assert.match(requested.stdout, /Restart requested/u);
  assert.doesNotMatch(requested.stdout, /completed|success/iu);
  const status = invoke("--status");
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /requested/u);
  assert.match(status.stdout, new RegExp(release.identity.generation, "u"));
  const saved = JSON.parse(await readFile(path.join(home, ".pipa", "restarts", `${release.identity.generation}.request.json`), "utf8"));
  assert.deepEqual(saved.destination, { channelId: "C123", threadTs: "123.456" });
  assert.notEqual(invoke("--bogus").status, 0);
});

for (const version of ["1.19.0", "2.0.29"]) for (const mode of ["ready", "unready", "startup-failure", "authentication", "wrong-generation"]) test(`isolated Managed restart ${version}: ${mode}`, { timeout: 60_000 }, async (t) => {
  const runtime = await createRuntimeFixture({ timeoutMs: 59000 });
  const home = runtime.home;
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
    if (process.argv.includes('--version')) { console.log(${JSON.stringify(version)}); process.exit(0); }
    if (process.env.PIPA_HOME !== ${JSON.stringify(home)}) throw new Error('Profile home changed in the tool environment.');
    if (process.env.PIPA_INTEGRATION_SENTINEL !== 'integration-kept') throw new Error('Integration environment lost.');
    if (process.env.PIPA_SLACK_BOT_TOKEN || process.env.Slack_Client_Secret) throw new Error('Slack secret reached engine.');
    if (process.env.PIPA_RESTART_ID && ${JSON.stringify(mode)} === 'startup-failure') process.exit(23);
    const server = http.createServer((req, res) => {
      if (req.url === '/shutdown') { res.end(); server.close(); return; }
      if (process.env.PIPA_RESTART_ID && ${JSON.stringify(mode)} === 'unready') res.statusCode = 503;
      if (req.headers.authorization !== 'Basic ' + Buffer.from('opencode:' + process.env.OPENCODE_SERVER_PASSWORD).toString('base64')
        || (process.env.PIPA_RESTART_ID && ${JSON.stringify(mode)} === 'authentication')) res.statusCode = 401;
      res.setHeader('content-type', 'application/json');
      const url = new URL(req.url, 'http://localhost');
      if (process.env.PIPA_RESTART_ID && ${JSON.stringify(mode)} === 'ready' && ['/path', '/api/location'].includes(url.pathname)) {
        require('node:fs').writeFileSync(${JSON.stringify(path.join(home, "workspace-probed"))}, 'waiting');
        if (!require('node:fs').existsSync(${JSON.stringify(path.join(home, "workspace-release"))})) res.statusCode = 503;
      }
      const body = ${JSON.stringify(version)}.startsWith('1.')
        ? url.pathname === '/global/health' ? { healthy: true, version: ${JSON.stringify(version)} } : url.pathname === '/path' ? { directory: ${JSON.stringify(home)} } : url.pathname === '/session/status' ? {} : null
        : url.pathname === '/api/info' ? { version: ${JSON.stringify(version)}, pid: process.pid, urls: [], paths: { tmp: ${JSON.stringify(runtime.temp)} } }
        : url.pathname === '/api/experimental/migration/v1' ? { status: 'completed', progress: null }
        : url.pathname === '/api/location' ? { directory: ${JSON.stringify(home)}, project: { id: 'prj_fixture', directory: ${JSON.stringify(home)}, canonical: ${JSON.stringify(home)} } } : null;
      if (!body && res.statusCode === 200) res.statusCode = 404;
      res.end(JSON.stringify(body ?? {}));
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
    if (process.env.PIPA_RESTART_ID && process.send && ${JSON.stringify(mode)} === 'wrong-generation') {
      const send = process.send.bind(process);
      process.send = (message, ...args) => send(message.type === 'ready' ? { ...message, generation: '00000000-0000-0000-0000-000000000000' } : message, ...args);
    }
  `);
  const environment = {
    ...runtime.env,
    PATH: `${fakeBin}${path.delimiter}${runtime.env.PATH}`,
    HOME: home, USERPROFILE: home, PIPA_HOME: path.relative(runtime.workspace, home),
    NODE_OPTIONS: `--import=${pathToFileURL(observer).href}`,
    PIPA_INTEGRATION_SENTINEL: "integration-kept",
    OPENCODE_SERVER_PASSWORD: "synthetic-private-password",
    PIPA_SLACK_BOT_TOKEN: "xoxb-forbidden-child-marker", Slack_Client_Secret: "forbidden-child-marker",
  };
  const original = runtime.spawn(process.execPath, [cli, "start"], { env: environment }).child;
  let output = "";
  for (const stream of [original.stdout, original.stderr]) stream.on("data", (chunk) => { output += chunk; });
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
      await runtime.teardown();
    }
  });
  // Requests may precede watcher startup; replacement readiness is asserted at
  // the authenticated workspace barrier below, never inferred from listening.
  await until(async () => fetch(url).then(() => true, () => false));
  const identity = await readInstanceLock(paths.lock);
  assert.equal(identity.pid, original.pid);
  const request = spawnSync(process.execPath, [cli, "restart"], { cwd: runtime.workspace, env: environment, encoding: "utf8" });
  assert.equal(request.status, 0, request.stderr);
  assert.match(request.stdout, /Restart requested/u);
  if (mode === "ready") {
    await until(() => readFile(path.join(home, "workspace-probed"), "utf8").catch(() => false));
    assert.equal((await restartStatus({ home })).state, "running", "Authenticated identity is not workspace readiness");
    assert.notEqual((await readInstanceLock(paths.lock)).generation, identity.generation);
    await assert.rejects(readFile(workerExit), { code: "ENOENT" });
    await writeFile(path.join(home, "workspace-release"), "ready");
  }
  const outcome = await until(async () => {
    const status = await restartStatus({ home });
    const lock = await readInstanceLock(paths.lock);
    if (lock && lock.pid !== original.pid) replacement = lock;
    if (status?.state === "unconfirmed") assert.fail(JSON.stringify(status));
    return ["completed", "failed"].includes(status?.state) ? status : false;
  }, 45_000);
  assert.equal(await originalExit, 0);
  assert.doesNotMatch(output + JSON.stringify(outcome), /synthetic-private-password|forbidden-child-marker/u);
  if (mode !== "ready") {
    assert.equal(outcome.state, "failed");
    assert.equal(outcome.phase, "starting");
    await until(async () => !await readInstanceLock(paths.lock));
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
  assert.equal((await fetch(url)).status, 401);
  assert.deepEqual(await readInstanceLock(paths.lock), replacement);
  const status = spawnSync(process.execPath, [cli, "restart", "--status"], { cwd: runtime.workspace, env: environment, encoding: "utf8" });
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
