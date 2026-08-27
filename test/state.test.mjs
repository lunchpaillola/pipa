import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireInstanceLock, createManifest, createManifestUrl, createSessionStore, loadConfig, loadSessions, pipaPaths, saveConfig, stopInstance } from "../src/state.mjs";

test("manifest preserves approved capabilities and substitutes the bot name", () => {
  const manifest = createManifest('Workshop "Bot"');
  assert.equal(manifest.display_information.name, 'Workshop "Bot"');
  assert.equal(manifest.features.bot_user.display_name, 'Workshop "Bot"');
  assert.match(manifest.display_information.description, /^Workshop "Bot" /u);
  assert.match(manifest.display_information.long_description, /^Workshop "Bot" /u);
  assert.doesNotMatch(`${manifest.display_information.description} ${manifest.display_information.long_description}`, /Pippette/u);
  assert.deepEqual(manifest.oauth_config.scopes.user, ["files:read", "files:write"]);
  assert.ok(manifest.oauth_config.scopes.bot.includes("channels:read"));
  assert.ok(manifest.oauth_config.scopes.bot.includes("users:read"));
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

  const valid = { ...base, allowedSlackChannelIds: ["C1", "C2"], allowedSlackUserIds: ["U1"] };
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
  ]) {
    await writeConfig({ ...base, [key]: value });
    await assert.rejects(loadConfig(file), /Invalid Pipa config/u);
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

test("stops the process recorded in the instance lock", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-stop-"));
  const file = pipaPaths(home).lock;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, "12345");
  let signal;
  assert.equal(await stopInstance(file, (pid, received) => { signal = { pid, received }; }), 12345);
  assert.deepEqual(signal, { pid: 12345, received: "SIGTERM" });
});
