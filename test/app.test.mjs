import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkSlackToken, createConversationRunner, initializePipa, startPipa } from "../src/app.mjs";
import { pipaPaths } from "../src/state.mjs";

test("init validates dependencies before replacing config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-init-"));
  const paths = pipaPaths(home);
  const input = { botName: "Local Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: home };
  await initializePipa(input, { paths, checkOpenCode: async () => "1.0.0", checkSlackToken: async () => ({ ok: true }) });
  const before = await readFile(paths.config, "utf8");
  await assert.rejects(
    initializePipa({ ...input, slackBotToken: "xoxb-rejected" }, { paths, checkOpenCode: async () => "1.0.0", checkSlackToken: async () => { throw new Error("rejected"); } }),
    /rejected/u,
  );
  assert.equal(await readFile(paths.config, "utf8"), before);
  assert.doesNotMatch(before.replace("xapp-test", "").replace("xoxb-test", ""), /xoxb|xapp/u);
});

test("Slack auth errors never include the token", async () => {
  await assert.rejects(
    checkSlackToken("xoxb-super-secret", async () => ({ ok: false, json: async () => ({ ok: false, error: "invalid_auth" }) })),
    (error) => error.message === "Slack rejected the bot token." && !error.message.includes("super-secret"),
  );
});

test("conversation runner serializes one thread, overlaps threads, and persists before release", async () => {
  const events = [];
  const sessions = new Map();
  const gates = new Map();
  const sessionStore = {
    get: (key) => sessions.get(key) ?? null,
    async set(key, value) { events.push(`save:${key}:${value}`); sessions.set(key, value); },
  };
  const runner = createConversationRunner({
    sessionStore,
    runTurn: async ({ prompt, sessionId }) => {
      events.push(`start:${prompt}:${sessionId}`);
      await new Promise((resolve) => gates.set(prompt, resolve));
      events.push(`end:${prompt}`);
      return { text: prompt, sessionId: `ses_${prompt}` };
    },
  });

  const first = runner.enqueue("A", { prompt: "one" });
  const second = runner.enqueue("A", { prompt: "two" });
  const other = runner.enqueue("B", { prompt: "other" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start:one:null", "start:other:null"]);
  gates.get("other")();
  await other;
  gates.get("one")();
  await first;
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(events.join("|"), /save:A:ses_one\|start:two:ses_one/u);
  gates.get("two")();
  await second;
});

test("failed turns release the conversation tail", async () => {
  let calls = 0;
  const runner = createConversationRunner({
    sessionStore: { get: () => null, set: async () => undefined },
    runTurn: async () => {
      calls += 1;
      if (calls === 1) throw new Error("failed");
      return { text: "recovered", sessionId: "ses_2" };
    },
  });
  await assert.rejects(runner.enqueue("A", { prompt: "one" }), /failed/u);
  assert.equal((await runner.enqueue("A", { prompt: "two" })).text, "recovered");
  assert.equal(calls, 2);
});

test("closing the runner prevents queued turns from starting", async () => {
  let release;
  const prompts = [];
  const runner = createConversationRunner({
    sessionStore: { get: () => null, set: async () => undefined },
    runTurn: async ({ prompt }) => {
      prompts.push(prompt);
      await new Promise((resolve) => release = resolve);
      return { text: prompt, sessionId: "ses_1" };
    },
  });
  const active = runner.enqueue("A", { prompt: "active" });
  const queued = runner.enqueue("A", { prompt: "queued" });
  await new Promise((resolve) => setImmediate(resolve));
  runner.close();
  release();
  await active;
  await assert.rejects(queued, /shutting down/u);
  assert.deepEqual(prompts, ["active"]);
});

test("Slack composition subscribes mentions, restores sessions, and ignores unsupported traffic", async () => {
  const handlers = {};
  const restored = [];
  const posts = [];
  const chat = {
    onNewMention(handler) { handlers.mention = handler; },
    onSubscribedMessage(handler) { handlers.subscribed = handler; },
    async initialize() { restored.push("initialized"); },
    thread(id) { return { subscribe: async () => restored.push(id) }; },
    async shutdown() { restored.push("shutdown"); },
  };
  const executor = {
    runTurn: async ({ prompt, sessionId }) => ({ text: `${prompt}:${sessionId ?? "new"}`, sessionId: sessionId ?? "ses_1" }),
    stopAll() { restored.push("stopped"); },
  };
  const sessions = new Map([["slack:C1:1.0", "ses_old"]]);
  const sessionStore = {
    keys: () => [...sessions.keys()],
    get: (key) => sessions.get(key) ?? null,
    async set(key, value) { sessions.set(key, value); },
  };
  const app = await startPipa({
    chat,
    executor,
    sessionStore,
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  });
  assert.deepEqual(restored, ["initialized", "slack:C1:1.0"]);

  const thread = { id: "slack:C2:2.0", channel: { isDM: false, channelVisibility: "private" }, subscribe: async () => restored.push("subscribed"), post: async (text) => posts.push(text) };
  await handlers.mention(thread, { text: "<@U1> ask <@U2> for help", author: { isMe: false }, raw: {} });
  await handlers.subscribed(thread, { text: "follow up", author: { isMe: false }, raw: {} });
  await handlers.subscribed({ ...thread, channel: { isDM: true } }, { text: "ignored", author: { isMe: false }, raw: {} });
  assert.deepEqual(posts, ["ask <@U2> for help:new", "follow up:ses_1"]);
  assert.equal(restored.filter((item) => item === "subscribed").length, 1);
  await app.shutdown();
  assert.deepEqual(restored.slice(-2), ["stopped", "shutdown"]);
});
