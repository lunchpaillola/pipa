import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireInstanceLock, createManifest, createManifestUrl, createSessionStore, createModelSetting, loadConfig, loadSessions, pipaPaths, saveConfig, slackCommandName, stopInstance, watchInstanceStop, writePrivateJson } from "../src/state.mjs";
import { createRuntimeFixture } from "./helpers/runtime-fixture.mjs";
import { staleInstance } from "./helpers/stale-instance.mjs";

test("a live PID with a different birth identity is stale, not a stop target", async (t) => {
  const runtime = await createRuntimeFixture();
  t.after(() => runtime.teardown());
  const file = pipaPaths(runtime.home).lock;
  const stale = staleInstance(process.pid);
  await writePrivateJson(file, stale);
  assert.equal(await stopInstance(file), null);
  const module = new URL("../src/state.mjs", import.meta.url).href;
  const launches = Array.from({ length: 4 }, () => {
    const fixture = runtime.spawn(process.execPath, ["--input-type=module", "-e", `
      const { acquireInstanceLock } = await import(${JSON.stringify(module)});
      process.stdin.resume();
      process.stdin.once('data', async () => {
        try {
          const release = await acquireInstanceLock(${JSON.stringify(file)});
          process.stdout.write('won');
          process.stdin.once('end', async () => { await release(); });
        } catch (error) { process.stdout.write(error.message); }
      });
    `], { stdio: ["pipe", "pipe", "pipe"] });
    const result = new Promise((resolve) => fixture.child.stdout.once("data", (data) => resolve(String(data))));
    return { ...fixture, result: Promise.race([result, fixture.exited.then(({ code }) => `exited (${code})`)]) };
  });
  for (const { child } of launches) child.stdin.write("start\n");
  const results = await Promise.all(launches.map(({ result }) => result));
  assert.equal(results.filter((result) => result === "won").length, 1, JSON.stringify(results));
  const owner = JSON.parse(await readFile(file, "utf8"));
  assert.equal(owner.pid, launches[results.indexOf("won")].child.pid);
  assert.notEqual(owner.generation, stale.generation);
  for (const { child } of launches) child.stdin.end();
  await Promise.all(launches.map(({ exited }) => exited));
  await assert.rejects(readFile(file), { code: "ENOENT" });
});

test("malformed birth information never makes a live owner's lock removable", async (t) => {
  const runtime = await createRuntimeFixture();
  t.after(() => runtime.teardown());
  const file = pipaPaths(runtime.home).lock;
  const identity = { ...staleInstance(process.pid), birth: `${process.platform}:` };
  await writePrivateJson(file, identity);
  await assert.rejects(acquireInstanceLock(file), /Invalid Pipa instance lock/u);
  await assert.rejects(stopInstance(file), /Invalid Pipa instance lock/u);
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), identity);
});

test("start recovers after an owner exits without cleanup, including older lock formats", async (t) => {
  const runtime = await createRuntimeFixture();
  t.after(() => runtime.teardown());
  const file = pipaPaths(runtime.home).lock;
  const module = new URL("../src/state.mjs", import.meta.url).href;
  const { child, exited } = runtime.spawn(process.execPath, ["--input-type=module", "-e", `
    const { acquireInstanceLock } = await import(${JSON.stringify(module)});
    await acquireInstanceLock(${JSON.stringify(file)});
    process.exit(37);
  `]);
  assert.equal((await exited).code, 37);
  const abandoned = JSON.parse(await readFile(file, "utf8"));
  assert.equal(abandoned.pid, child.pid);
  for (const identity of [abandoned, abandoned.pid, { pid: abandoned.pid, generation: abandoned.generation }]) {
    await writePrivateJson(file, identity);
    const replacement = await acquireInstanceLock(file);
    assert.notEqual(replacement.identity.generation, abandoned.generation);
    await replacement();
  }
});

test("installation command names are shared with the manifest and fit Slack's limit", () => {
  for (const [name, command] of [
    ["Pipa", "/pipa"], ["Chopper", "/chopper"], ["Pipwick", "/pipwick"],
    ['  Workshop "Bot"  ', "/workshop-bot"], ["Pipa_Test.2!", "/pipa-test-2"],
    ["Café 🧪", "/cafe"], ["A".repeat(35), `/${"a".repeat(31)}`],
    ["🤖", "/pipa"], ["東京", "/pipa"], ["!!!", "/pipa"],
    [`${"A".repeat(30)} !bot`, `/${"a".repeat(30)}`],
  ]) {
    assert.equal(slackCommandName(name), command);
    assert.equal(createManifest(name).features.slash_commands[0].command, command);
    assert.deepEqual(createManifest(name).features.slash_commands.map((entry) => entry.command), command === "/pipa" ? ["/pipa"] : [command, "/pipa"]);
    assert.match(command, /^\/[a-z0-9-]{1,31}$/u);
  }
  for (const name of ["", "A".repeat(36), "line\nbreak"]) {
    assert.throws(() => slackCommandName(name), /Bot name/u);
  }
});

test("model saves serialize, reload unrelated fields, and recover after failed persistence", async () => {
  const paths = pipaPaths(await mkdtemp(path.join(os.tmpdir(), "pipa-model-")));
  const base = { botName: "Pipa", workingDirectory: "/work", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", extra: { preserved: true } };
  await writePrivateJson(paths.config, base);
  let fail = true;
  const setting = createModelSetting(paths.config, async (file, value) => {
    if (fail) { fail = false; throw new Error("disk failure"); }
    await writePrivateJson(file, value);
  });
  const a = { providerID: "openai", modelID: "model/a" };
  const b = { providerID: "fireworks-ai", modelID: "accounts/router.b" };
  await assert.rejects(setting.save(a), /disk failure/u);
  assert.equal((await loadConfig(paths.config)).defaultModel, undefined);
  await Promise.all([setting.save(a), setting.save(b)]);
  assert.deepEqual(await loadConfig(paths.config), { ...base, slackMode: "socket", defaultModel: b });
  const before = await readFile(paths.config, "utf8");
  await assert.rejects(setting.save({ providerID: "", modelID: "x" }), /model/u);
  await assert.rejects(setting.save(a, () => { throw new Error("denied"); }), /denied/u);
  assert.equal(await readFile(paths.config, "utf8"), before);
  if (process.platform !== "win32") assert.equal((await stat(paths.config)).mode & 0o777, 0o600);
});

test("an invalid optional default does not block config authorization or repairing the selection", async (t) => {
  const runtime = await createRuntimeFixture();
  t.after(() => runtime.teardown());
  const file = pipaPaths(runtime.home).config;
  const config = { botName: "Pipa", workingDirectory: runtime.workspace, slackAppToken: "xapp-test", slackBotToken: "xoxb-test", allowedSlackUserIds: ["U1"], defaultModel: { providerID: "", modelID: "bad" } };
  await writePrivateJson(file, config);
  assert.deepEqual((await loadConfig(file)).allowedSlackUserIds, ["U1"]);
  const setting = createModelSetting(file);
  await assert.rejects(setting.save(config.defaultModel), /Invalid model/u);
  await setting.save({ providerID: "native", modelID: "repaired" });
  assert.deepEqual((await loadConfig(file)).defaultModel, { providerID: "native", modelID: "repaired" });
  await writePrivateJson(file, { ...config, allowedSlackUserIds: "U1" });
  await assert.rejects(loadConfig(file), /allowedSlackUserIds/u);
});

test("manifest preserves approved capabilities and substitutes the bot name", () => {
  const manifest = createManifest('Workshop "Bot"');
  assert.equal(manifest.display_information.name, 'Workshop "Bot"');
  assert.equal(manifest.features.bot_user.display_name, 'Workshop "Bot"');
  assert.match(manifest.display_information.description, /^Workshop "Bot" /u);
  assert.match(manifest.display_information.long_description, /^Workshop "Bot" /u);
  assert.doesNotMatch(`${manifest.display_information.description} ${manifest.display_information.long_description}`, /Pippette/u);
  assert.deepEqual(manifest.oauth_config.scopes.user, ["files:read", "files:write"]);
  assert.ok(manifest.oauth_config.scopes.bot.includes("channels:read"));
  assert.ok(manifest.oauth_config.scopes.bot.includes("assistant:write"));
  assert.ok(manifest.oauth_config.scopes.bot.includes("users:read"));
  assert.ok(manifest.oauth_config.scopes.bot.includes("commands"));
  assert.equal(manifest.features.slash_commands[0].command, "/workshop-bot");
  assert.equal(manifest.features.slash_commands[0].usage_hint, "model");
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, ["app_mention", "message.channels", "message.groups"]);
  assert.equal(manifest.settings.interactivity.is_enabled, true);
  assert.equal(manifest.settings.socket_mode_enabled, true);
  const url = new URL(createManifestUrl(manifest));
  assert.equal(url.origin + url.pathname, "https://api.slack.com/apps");
  assert.equal(url.searchParams.get("new_app"), "1");
  assert.deepEqual(JSON.parse(url.searchParams.get("manifest_json")), manifest);
});

test("config and sessions are stored separately with private permissions", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-state-"));
  const paths = pipaPaths(home);
  await saveConfig({ botName: "Pipa", slackAppToken: "xapp-secret", slackBotToken: "xoxb-secret", workingDirectory: home }, paths);
  const store = await createSessionStore(paths.sessions);
  await store.set("slack:C1:1.0", "ses_1");

  assert.equal(JSON.parse(await readFile(paths.sessions, "utf8"))["slack:C1:1.0"], "ses_1");
  assert.doesNotMatch(await readFile(paths.sessions, "utf8"), /xoxb|xapp/u);
  if (process.platform !== "win32") assert.equal((await stat(paths.config)).mode & 0o777, 0o600);
});

test("routine and OpenCode recovery paths are separate and the atomic JSON writer is reusable", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-state-"));
  const paths = pipaPaths(home);
  assert.equal(paths.routines, path.join(paths.directory, "routines.json"));
  assert.equal(paths.routinesLock, path.join(paths.directory, "routines.lock"));
  assert.equal(new Set([paths.config, paths.sessions, paths.routines]).size, 3);
  await writePrivateJson(paths.routines, { version: 1, routines: [] });
  assert.deepEqual(JSON.parse(await readFile(paths.routines, "utf8")), { version: 1, routines: [] });
  if (process.platform !== "win32") assert.equal((await stat(paths.routines)).mode & 0o777, 0o600);
});

test("config validates Socket and Managed profiles", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-config-"));
  const file = pipaPaths(home).config;
  await mkdir(path.dirname(file), { recursive: true });
  const writeConfig = (config) => writeFile(file, JSON.stringify(config));
  const shared = { botName: "Pipa", workingDirectory: home };

  await writeConfig({ ...shared, slackAppToken: "xapp-test", slackBotToken: "xoxb-test" });
  assert.equal((await loadConfig(file)).slackMode, "socket");
  for (const missing of ["slackAppToken", "slackBotToken"]) {
    const config = { ...shared, slackMode: "socket", slackAppToken: "xapp-test", slackBotToken: "xoxb-test" };
    delete config[missing];
    await writeConfig(config);
    await assert.rejects(loadConfig(file), new RegExp(`${missing} is missing`, "u"));
  }

  const managed = { ...shared, slackMode: "managed", openCodeHostname: "127.0.0.1", openCodePort: 4096 };
  await writeConfig(managed);
  assert.deepEqual(await loadConfig(file), managed);
  for (const [openCodeHostname, openCodePort] of [["", 4096], ["127.0.0.1", 1.5], ["127.0.0.1", 0], ["127.0.0.1", 65536]]) {
    await writeConfig({ ...managed, openCodeHostname, openCodePort });
    await assert.rejects(loadConfig(file), /Invalid Pipa config/u);
  }

  await writeConfig({ ...shared, slackMode: "not-a-real-mode-secret" });
  await assert.rejects(loadConfig(file), (error) => !error.message.includes("not-a-real-mode-secret"));
});

test("config validates allowed Slack access lists", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-config-"));
  const file = pipaPaths(home).config;
  await mkdir(path.dirname(file), { recursive: true });
  const writeConfig = (config) => writeFile(file, JSON.stringify(config));
  const base = { botName: "Pipa", workingDirectory: home, slackAppToken: "xapp-test", slackBotToken: "xoxb-test" };

  const valid = { ...base, allowedSlackChannelIds: ["C1", "C2"], allowedSlackUserIds: ["U1"], allowedSlackBotIds: ["B1"] };
  await writeConfig(valid);
  assert.deepEqual(await loadConfig(file), { ...valid, slackMode: "socket" });

  await writeConfig(base);
  assert.deepEqual(await loadConfig(file), { ...base, slackMode: "socket" });

  for (const [key, value] of [
    ["allowedSlackChannelIds", "C1"],
    ["allowedSlackChannelIds", [1]],
    ["allowedSlackChannelIds", ["", "C1"]],
    ["allowedSlackUserIds", 42],
    ["allowedSlackUserIds", [null]],
    ["allowedSlackUserIds", [" "]],
    ["allowedSlackBotIds", "B1"],
    ["allowedSlackBotIds", [1]],
    ["allowedSlackBotIds", ["", "B1"]],
  ]) {
    await writeConfig({ ...base, [key]: value });
    await assert.rejects(loadConfig(file), /Invalid Pipa config/u);
  }
});

test("config validates the mentionOnly flag", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-config-"));
  const file = pipaPaths(home).config;
  await mkdir(path.dirname(file), { recursive: true });
  const writeConfig = (config) => writeFile(file, JSON.stringify(config));
  const base = { botName: "Pipa", workingDirectory: home, slackAppToken: "xapp-test", slackBotToken: "xoxb-test" };

  await writeConfig({ ...base, mentionOnly: true });
  assert.equal((await loadConfig(file)).mentionOnly, true);
  await writeConfig({ ...base, mentionOnly: false });
  assert.equal((await loadConfig(file)).mentionOnly, false);
  await writeConfig(base);
  assert.equal((await loadConfig(file)).mentionOnly, undefined);

  for (const mentionOnly of ["true", 1, null]) {
    await writeConfig({ ...base, mentionOnly });
    await assert.rejects(loadConfig(file), /mentionOnly must be a boolean/u);
  }
});

test("malformed session state fails instead of discarding continuity", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-state-"));
  const file = pipaPaths(home).sessions;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "not-json");
  await assert.rejects(loadSessions(file), /Could not read Pipa sessions/u);
  await writeFile(file, JSON.stringify({ valid: "ses_1", invalid: null }));
  await assert.rejects(loadSessions(file), /invalid session for invalid/u);
});

test("a failed session write does not poison later writes", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-state-"));
  let writes = 0;
  const store = await createSessionStore(pipaPaths(home).sessions, async () => {
    writes += 1;
    if (writes === 1) throw new Error("disk unavailable");
  });
  await assert.rejects(store.set("slack:C1:1", "ses_1"), /disk unavailable/u);
  await store.set("slack:C2:2", "ses_2");
  assert.equal(writes, 2);
});

test("instance lock rejects a second process and can be reacquired", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-lock-"));
  const file = pipaPaths(home).lock;
  const release = await acquireInstanceLock(file);
  await assert.rejects(acquireInstanceLock(file), /already running/u);
  await release();
  const releaseAgain = await acquireInstanceLock(file);
  await releaseAgain();

  const simultaneous = await Promise.allSettled([acquireInstanceLock(file), acquireInstanceLock(file)]);
  assert.deepEqual(simultaneous.map(({ status }) => status).sort(), ["fulfilled", "rejected"]);
  await simultaneous.find(({ status }) => status === "fulfilled").value();
});

test("live legacy numeric and generation locks fail closed", async (t) => {
  const runtime = await createRuntimeFixture();
  t.after(() => runtime.teardown());
  const file = pipaPaths(runtime.home).lock;
  for (const identity of [process.pid, { pid: process.pid, generation: randomUUID() }]) {
    await writePrivateJson(file, identity);
    await assert.rejects(stopInstance(file), /Cannot verify.*original terminal/u);
    await assert.rejects(acquireInstanceLock(file), /Cannot verify.*automatic launchers/u);
    assert.deepEqual(JSON.parse(await readFile(file, "utf8")), identity);
  }
});

test("lock generations are unique and an old release cannot delete a replacement", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-lock-"));
  const file = pipaPaths(home).lock;
  const release = await acquireInstanceLock(file);
  assert.equal(release.identity.pid, process.pid);
  assert.ok(release.identity.generation);
  await release();
  const replacement = await acquireInstanceLock(file);
  assert.notEqual(replacement.identity.generation, release.identity.generation);
  await release();
  assert.deepEqual(JSON.parse(await readFile(file, "utf8")), replacement.identity);
  await replacement();
});

test("stop requests reach only their owning generation", async (t) => {
  const runtime = await createRuntimeFixture();
  t.after(() => runtime.teardown());
  const file = pipaPaths(runtime.home).lock;
  const release = await acquireInstanceLock(file);
  assert.equal(await stopInstance(file), process.pid);
  await release();
  const replacement = await acquireInstanceLock(file);
  t.after(replacement);
  let requested = false;
  const unwatch = watchInstanceStop(replacement.identity, () => { requested = true; }, file);
  t.after(unwatch);
  await writeFile(`${file}.${release.identity.generation}.stop`, "");
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(requested, false);
  assert.equal(await stopInstance(file), process.pid);
  await runtime.waitFor(() => requested, { label: "stop request reached owner" });
});
