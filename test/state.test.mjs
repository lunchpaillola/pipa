import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createManifest, createSessionStore, loadSessions, pipaPaths, saveConfig } from "../src/state.mjs";

test("manifest preserves approved capabilities and substitutes the bot name", () => {
  const manifest = createManifest('Workshop "Bot"');
  assert.equal(manifest.display_information.name, 'Workshop "Bot"');
  assert.equal(manifest.features.bot_user.display_name, 'Workshop "Bot"');
  assert.match(manifest.display_information.long_description, /^Workshop "Bot" /u);
  assert.deepEqual(manifest.oauth_config.scopes.user, ["files:read", "files:write"]);
  assert.deepEqual(manifest.settings.event_subscriptions.bot_events, ["app_mention", "message.channels", "message.groups"]);
  assert.equal(manifest.settings.interactivity.is_enabled, true);
  assert.equal(manifest.settings.socket_mode_enabled, true);
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
