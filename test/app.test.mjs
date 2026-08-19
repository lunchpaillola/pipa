import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkSlackAppToken, checkSlackToken, createConversationRunner, initializePipa, startPipa } from "../src/app.mjs";
import { createSessionStore, pipaPaths } from "../src/state.mjs";

test("init validates dependencies before replacing config", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-init-"));
  const paths = pipaPaths(home);
  const input = { botName: "Local Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: home };
  const valid = { paths, checkOpenCode: async () => "1.0.0", checkSlackAppToken: async () => ({ ok: true }), checkSlackToken: async () => ({ ok: true }) };
  await initializePipa(input, valid);
  const before = await readFile(paths.config, "utf8");
  const manifestBefore = await readFile(paths.manifest, "utf8");
  const file = path.join(home, "not-a-directory");
  await writeFile(file, "x");
  const failures = [
    () => initializePipa({ ...input, workingDirectory: file }, valid),
    () => initializePipa(input, { ...valid, checkOpenCode: async () => { throw new Error("OpenCode missing"); } }),
    () => initializePipa(input, { ...valid, checkOpenCode: async () => "2.0.0" }),
    () => initializePipa(input, { ...valid, checkSlackAppToken: async () => { throw new Error("app rejected"); } }),
    () => initializePipa({ ...input, slackBotToken: "xoxb-rejected" }, { ...valid, checkSlackToken: async () => { throw new Error("bot rejected"); } }),
  ];
  for (const fail of failures) {
    await assert.rejects(fail());
    assert.equal(await readFile(paths.config, "utf8"), before);
    assert.equal(await readFile(paths.manifest, "utf8"), manifestBefore);
  }
  assert.doesNotMatch(before.replace("xapp-test", "").replace("xoxb-test", ""), /xoxb|xapp/u);
});

test("Slack auth errors never include the token", async () => {
  await assert.rejects(
    checkSlackToken("xoxb-super-secret", async () => ({ ok: false, json: async () => ({ ok: false, error: "invalid_auth" }) })),
    (error) => error.message === "Slack rejected the bot token." && !error.message.includes("super-secret"),
  );
  await assert.rejects(
    checkSlackAppToken("xapp-super-secret", async () => ({ ok: false, json: async () => ({ ok: false, error: "invalid_auth" }) })),
    (error) => error.message.includes("connections:write") && !error.message.includes("super-secret"),
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

test("conversation tail preserves Slack delivery order", async () => {
  const events = [];
  let releaseDelivery;
  const runner = createConversationRunner({
    sessionStore: { get: () => null, set: async () => undefined },
    runTurn: async ({ prompt }) => {
      events.push(`run:${prompt}`);
      return { text: prompt, sessionId: `ses_${prompt}` };
    },
  });
  const first = runner.enqueue("A", {
    prompt: "one",
    deliver: async () => {
      events.push("deliver:one");
      await new Promise((resolve) => releaseDelivery = resolve);
    },
  });
  const second = runner.enqueue("A", { prompt: "two", deliver: async () => events.push("deliver:two") });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["run:one", "deliver:one"]);
  releaseDelivery();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["run:one", "deliver:one", "run:two", "deliver:two"]);
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
  const calls = [];
  const executor = {
    runTurn: async ({ prompt, sessionId, contextEnvironment }) => {
      calls.push({ prompt, sessionId, contextEnvironment });
      if (prompt === "secret failure") throw new Error("bad xoxb-secret and xapp-secret");
      return { text: prompt === "long" ? "x".repeat(7001) : `${prompt}:${sessionId ?? "new"}`, sessionId: sessionId ?? "ses_1" };
    },
    stopAll() { restored.push("stopped"); },
  };
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-restart-"));
  const sessionFile = pipaPaths(home).sessions;
  const firstStore = await createSessionStore(sessionFile);
  await firstStore.set("slack:C1:1.0", "ses_old");
  const sessionStore = await createSessionStore(sessionFile);
  const app = await startPipa({
    chat,
    executor,
    sessionStore,
    checkSlackToken: async () => ({ ok: true }),
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  });
  assert.deepEqual(restored, ["slack:C1:1.0", "initialized"]);

  const human = { id: "U3", userId: "U3", isMe: false, isBot: false };
  const restoredPosts = [];
  const restoredThread = { id: "slack:C1:1.0", channel: { isDM: false, channelVisibility: "private" }, post: async (text) => restoredPosts.push(text) };
  await handlers.subscribed(restoredThread, { text: "continue", author: human, raw: {} });
  assert.deepEqual(restoredPosts, ["continue:ses_old"]);
  assert.equal(calls[0].sessionId, "ses_old");

  const thread = { id: "slack:C2:2.0", channel: { isDM: false, channelVisibility: "private" }, subscribe: async () => restored.push("subscribed"), post: async (text) => posts.push(text) };
  await handlers.mention(thread, { text: "@U1 ask <@U2> for help", author: human, raw: {} });
  await handlers.subscribed(thread, { text: "<@U2> follow up", author: human, raw: {} });
  const beforeIgnored = calls.length;
  for (const [threadOverride, messageOverride] of [
    [{ channel: { isDM: true } }, {}],
    [{ channel: { isDM: false, channelVisibility: "external" } }, {}],
    [{}, { author: { ...human, isMe: true } }],
    [{}, { author: { ...human, isBot: true } }],
    [{}, { raw: { subtype: "message_changed" } }],
    [{}, { text: "  " }],
  ]) {
    await handlers.subscribed({ ...thread, ...threadOverride }, { text: "ignored", author: human, raw: {}, ...messageOverride });
  }
  assert.equal(calls.length, beforeIgnored);
  await handlers.subscribed(thread, { text: "long", author: human, raw: {} });
  await handlers.subscribed(thread, { text: "secret failure", author: human, raw: {} });
  assert.deepEqual(posts.slice(0, 2), ["ask <@U2> for help:new", "<@U2> follow up:ses_1"]);
  assert.deepEqual(posts.slice(2, 5).map((part) => part.length), [3500, 3500, 1]);
  assert.equal(posts.at(-1), "Pipa failed: bad [redacted] and [redacted]");
  assert.deepEqual(calls.find(({ prompt }) => prompt.startsWith("ask ")).contextEnvironment, {
    PIPA_MESSAGE_CHANNEL: "slack",
    PIPA_CURRENT_SLACK_CHANNEL_ID: "C2",
    PIPA_CURRENT_SLACK_THREAD_TS: "2.0",
    PIPA_REQUESTER_SLACK_USER_ID: "U3",
  });
  assert.equal(restored.filter((item) => item === "subscribed").length, 1);
  await app.shutdown();
  assert.deepEqual(restored.slice(-2), ["stopped", "shutdown"]);
});

test("startup cleans up Chat when restored subscription setup fails", async () => {
  const events = [];
  const chat = {
    onNewMention() {},
    onSubscribedMessage() {},
    thread() { return { subscribe: async () => { throw new Error("restore failed"); } }; },
    async initialize() { events.push("initialized"); },
    async shutdown() { events.push("shutdown"); },
  };
  const executor = { runTurn: async () => undefined, stopAll: () => events.push("stopped") };
  await assert.rejects(startPipa({
    chat,
    executor,
    checkSlackToken: async () => ({ ok: true }),
    sessionStore: { keys: () => ["slack:C1:1"], get: () => "ses_1", set: async () => undefined },
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  }), /restore failed/u);
  assert.deepEqual(events, ["stopped", "shutdown"]);
});

test("startup timeout shuts Chat down", async () => {
  const events = [];
  const chat = {
    onNewMention() {},
    onSubscribedMessage() {},
    async initialize() { await new Promise(() => undefined); },
    async shutdown() { events.push("shutdown"); },
  };
  await assert.rejects(startPipa({
    chat,
    state: { connect: async () => undefined },
    startupTimeoutMs: 5,
    checkSlackToken: async () => ({ ok: true }),
    executor: { runTurn: async () => undefined, stopAll: () => events.push("stopped") },
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  }), /startup timed out/u);
  assert.deepEqual(events, ["stopped", "shutdown"]);
});

test("shutdown returns after its deadline when Chat does not disconnect", async () => {
  const chat = {
    onNewMention() {},
    onSubscribedMessage() {},
    async initialize() {},
    async shutdown() { await new Promise(() => undefined); },
  };
  const app = await startPipa({
    chat,
    state: { connect: async () => undefined },
    startupTimeoutMs: 50,
    shutdownTimeoutMs: 5,
    checkSlackToken: async () => ({ ok: true }),
    executor: { runTurn: async () => undefined, stopAll() {} },
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  });
  await assert.rejects(app.shutdown(), /shutdown timed out/u);
});
