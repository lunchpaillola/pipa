import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { initializePipa, startPipa } from "../../src/app.mjs";
import { createManifest, pipaPaths } from "../../src/state.mjs";
import { createRuntimeFixture } from "../../test/helpers/runtime-fixture.mjs";

console.log(`Revision: ${execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim()}`);
console.log(`Working tree: ${execFileSync("git", ["status", "--porcelain"], { encoding: "utf8" }).trim() ? "dirty (development capture only)" : "clean"}`);
console.log("Deterministic application-entry capture: fake Slack/auth/Chat/executor; no Socket connection, live enforcement or rendering.");
const readme = await readFile(new URL("../../README.md", import.meta.url), "utf8");
const allScopes = createManifest("Pipa").oauth_config.scopes.bot;
for (const [name, missing, expectedCount] of [
  ["healthy (chat:write without assistant:write)", ["assistant:write"], 0],
  ["missing chat:write (transitional status alternative retained)", ["chat:write"], 1],
  ["optional/private losses", ["files:write", "reactions:write", "groups:history"], 4],
]) {
  const fixture = await createRuntimeFixture();
  try {
    const paths = pipaPaths(fixture.home);
    const grantedScopes = allScopes.filter(scope => !missing.includes(scope));
    const checkSlackToken = async () => ({ ok: true, grantedScopes });
    console.log(`\n=== ${name} ===`);
    console.log(`Missing bot grants: ${missing.join(", ")}`);
    console.log("initializePipa notices (warn callback -> stderr):");
    const initLines = [];
    await initializePipa({ botName: "Pipa", slackAppToken: "xapp-fixture", slackBotToken: "xoxb-fixture", workingDirectory: fixture.workspace }, {
      paths, environment: fixture.env, checkSlackToken,
      checkSlackAppToken: async () => ({ ok: true }), checkOpenCode: async () => "1.19.0",
      warn: message => { initLines.push(message); process.stderr.write(`${message}\n`); },
    });
    const handlers = {};
    const posts = [];
    const startLines = [];
    let statusRejections = 0;
    let reactionRejections = 0;
    console.log("startPipa notices (warn callback -> stderr):");
    const app = await startPipa({
        paths, checkSlackToken, routinesEnabled: false,
        chat: { onNewMention(handler) { handlers.mention = handler; }, onSubscribedMessage(handler) { handlers.reply = handler; }, async initialize() {}, async shutdown() {} },
        executor: { runTurn: async () => ({ text: "Reply delivered.", sessionId: "ses_fixture" }), stopAll() {} },
        slackFetch: async () => Response.json({ ok: true, messages: [] }),
        warn: message => { startLines.push(message); process.stderr.write(`${message}\n`); },
      });
    fixture.defer(() => app.shutdown(), "application");
    assert.deepEqual(startLines, initLines, "init/start copy and line order must match");
    assert.equal(initLines.length, expectedCount);
    if (expectedCount === 1) assert.ok(readme.includes(initLines[0]), "core notice matches documented copy");
    if (expectedCount === 4) {
      assert.deepEqual(initLines, [
        "⚠ WARNING — File uploads unavailable. To enable uploads, ask your Slack app admin to grant files:write (bot).",
        "⚠ WARNING — Receipt and result reactions unavailable. To enable reactions, ask your Slack app admin to grant reactions:write (bot).",
        "⚠ WARNING — Unmentioned private-channel follow-ups and preceding thread context unavailable. If you use private channels, ask your Slack app admin to grant groups:history (bot).",
        "Still available: Public-channel text requests and replies.",
      ]);
    }
    console.log(`PASS: init/start ${expectedCount ? "copy and line order" : "healthy silence"}; ${expectedCount} notice lines each.`);
    if (expectedCount !== 4) continue;
    const thread = {
      id: "slack:C1:1.0", channel: { isDM: false, channelVisibility: "public" },
      adapter: {
        async addReaction() { reactionRejections++; throw new Error("missing_scope"); },
        async removeReaction() { reactionRejections++; throw new Error("missing_scope"); },
      },
      async subscribe() {},
      async startTyping() { statusRejections++; throw new Error("missing_scope"); },
      async post(payload) { posts.push(payload); console.log(`Fake Slack post ${posts.length}: ${JSON.stringify(payload)}`); },
    };
    await handlers.mention(thread, { id: "1", text: "@Pipa work", author: { userId: "U1" }, raw: {} });
    await fixture.waitFor(() => posts.length === 1);
    await handlers.reply(thread, { id: "2", text: "follow up", author: { userId: "U1" }, raw: { ts: "2.0", thread_ts: "1.0" } });
    await fixture.waitFor(() => posts.length === 2);
    assert.deepEqual(posts, [{ markdown: "Reply delivered." }, { markdown: "Reply delivered." }]);
    assert.equal(startLines.length, expectedCount, "notices must not repeat per request");
    assert.ok(statusRejections >= 2 && reactionRejections >= 2);
    console.log(`PASS: mention + subscribed reply delivered; status rejections=${statusRejections}, reaction rejections>=2. No live messages.`);
  } finally {
    await fixture.teardown();
  }
}
console.log("PASS: all captures and assertions; isolated state cleaned up.");
