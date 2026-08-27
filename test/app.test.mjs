import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkSlackAppToken, checkSlackToken, createConversationRunner, initializePipa, postInStreams, startPipa } from "../src/app.mjs";
import { PipaStoppedError } from "../src/opencode.mjs";
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

test("starts and health-checks OpenCode before Slack, then stops only the owned server", async () => {
  const events = [];
  let stopServer;
  let failServer;
  let serverStopped = false;
  const serverWait = new Promise((resolve, reject) => {
    stopServer = resolve;
    failServer = reject;
  });
  const server = {
    baseUrl: "http://127.0.0.1:54321",
    owned: true,
    wait: () => serverWait,
    fail: failServer,
    stop() { if (!serverStopped) { serverStopped = true; events.push("server:stop"); stopServer(); } },
  };
  const chat = {
    onNewMention() {},
    onSubscribedMessage() {},
    async initialize() { events.push("slack:init"); },
    async shutdown() { events.push("slack:stop"); },
  };
  const app = await startPipa({
    chat,
    state: { connect: async () => undefined },
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    checkSlackToken: async () => ({ ok: true }),
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
    startServer: async () => { events.push("server:ready"); return server; },
    createExecutor: ({ baseUrl, onFatal }) => {
      events.push(`executor:${baseUrl}`);
      assert.equal(onFatal, server.fail);
      return { runTurn: async () => undefined, stopAll: () => events.push("executor:stop") };
    },
  });

  assert.deepEqual(events.slice(0, 3), ["server:ready", "executor:http://127.0.0.1:54321", "slack:init"]);
  assert.deepEqual(app.server, { baseUrl: server.baseUrl, owned: true });
  await app.shutdown();
  assert.deepEqual(events.slice(-3), ["executor:stop", "slack:stop", "server:stop"]);
});

test("stops an owned server when executor construction fails", async () => {
  let stopped = false;
  let finish;
  const wait = new Promise((resolve) => finish = resolve);
  await assert.rejects(startPipa({
    chat: {},
    sessionStore: {},
    checkSlackToken: async () => ({ ok: true }),
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
    startServer: async () => ({
      baseUrl: "http://127.0.0.1:54321",
      owned: true,
      wait: () => wait,
      stop() { stopped = true; finish(); },
    }),
    createExecutor: () => { throw new Error("executor setup failed"); },
  }), /executor setup failed/u);
  assert.equal(stopped, true);
});

test("bounds executor-setup cleanup when an owned server never reports exit", async () => {
  const startedAt = Date.now();
  await assert.rejects(startPipa({
    chat: {},
    sessionStore: {},
    shutdownTimeoutMs: 5,
    checkSlackToken: async () => ({ ok: true }),
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
    startServer: async () => ({
      baseUrl: "http://127.0.0.1:54321",
      owned: true,
      wait: async () => new Promise(() => undefined),
      stop() {},
    }),
    createExecutor: () => { throw new Error("executor setup failed"); },
  }), /executor setup failed/u);
  assert.ok(Date.now() - startedAt < 100);
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

test("failed replacement turns do not overwrite the persisted session", async () => {
  let saved;
  const runner = createConversationRunner({
    sessionStore: { get: () => "ses_old", set: async (_, sessionId) => saved = sessionId },
    runTurn: async ({ sessionId }) => {
      assert.equal(sessionId, "ses_old");
      throw new Error("replacement failed");
    },
  });
  await assert.rejects(runner.enqueue("A", { prompt: "continue" }), /replacement failed/u);
  assert.equal(saved, undefined);
});

test("closing the runner prevents queued turns from starting", async () => {
  let release;
  const prompts = [];
  const failures = [];
  const runner = createConversationRunner({
    sessionStore: { get: () => null, set: async () => undefined },
    runTurn: async ({ prompt }) => {
      prompts.push(prompt);
      await new Promise((resolve) => release = resolve);
      return { text: prompt, sessionId: "ses_1" };
    },
  });
  const active = runner.enqueue("A", { prompt: "active" });
  const queued = runner.enqueue("A", { prompt: "queued", deliverFailure: async (error) => failures.push(error) });
  await new Promise((resolve) => setImmediate(resolve));
  runner.close();
  release();
  await active;
  const result = await queued;
  assert.equal(result.error, failures[0]);
  assert.ok(result.error instanceof PipaStoppedError);
  const late = await runner.enqueue("B", { prompt: "late", deliverFailure: async (error) => failures.push(error) });
  assert.equal(late.error, failures[1]);
  assert.ok(late.error instanceof PipaStoppedError);
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

test("conversation runner streams before completion and persists despite delivery failure", async () => {
  const events = [];
  const output = {
    index: 0,
    [Symbol.asyncIterator]() { return this; },
    async next() {
      if (this.index === 0) { this.index += 1; events.push("output:first"); return { value: "first", done: false }; }
      if (this.index === 1) { this.index += 1; await new Promise((resolve) => setImmediate(resolve)); events.push("output:second"); return { value: "second", done: false }; }
      return { done: true };
    },
  };
  const runner = createConversationRunner({
    sessionStore: { get: () => null, async set(_, sessionId) { events.push(`save:${sessionId}`); } },
    runTurn: () => ({
      output,
      completion: new Promise((resolve) => setTimeout(() => resolve({ text: "firstsecond", sessionId: "ses_1" }), 5)),
    }),
  });

  const turn = runner.enqueue("A", {
    prompt: "one",
    deliver: async (stream) => {
      for await (const text of stream) {
        events.push(`deliver:${text}`);
        throw new Error("Slack failed");
      }
    },
  });
  await waitFor(() => events.includes("deliver:first"));
  const result = await turn;
  assert.equal(result.sessionId, "ses_1");
  assert.match(result.error.message, /Slack failed/u);
  assert.ok(events.indexOf("deliver:first") < events.indexOf("save:ses_1"));
  assert.ok(events.includes("output:second"), "remaining output should be drained");
});

test("conversation runner drains delivery before releasing a tail when persistence fails", async () => {
  const events = [];
  let releaseDelivery;
  const runner = createConversationRunner({
    sessionStore: {
      get: () => null,
      async set(_, sessionId) {
        events.push(`save:${sessionId}`);
        if (sessionId === "ses_one") throw new Error("save failed");
      },
    },
    runTurn: ({ prompt }) => prompt === "one" ? {
      output: (async function* () { yield "partial"; })(),
      completion: Promise.resolve({ text: "partial", sessionId: "ses_one" }),
    } : Promise.resolve({ text: "two" }),
  });

  const first = runner.enqueue("A", {
    prompt: "one",
    deliver: async (stream) => {
      for await (const text of stream) events.push(`deliver:${text}`);
      await new Promise((resolve) => releaseDelivery = resolve);
      events.push("delivery:settled");
    },
    deliverFailure: async () => {
      events.push("failure:attempted");
      throw new Error("notification failed");
    },
    deliverIncomplete: async () => events.push("incomplete:attempted"),
  });
  const second = runner.enqueue("A", { prompt: "two", deliver: async () => events.push("deliver:two") });

  await waitFor(() => events.includes("save:ses_one") && releaseDelivery);
  assert.equal(events.includes("failure:attempted"), false);
  assert.equal(events.includes("deliver:two"), false);
  releaseDelivery();
  assert.match((await first).error.message, /save failed/u);
  await second;
  assert.equal(events.filter((event) => event === "failure:attempted").length, 1);
  assert.equal(events.includes("incomplete:attempted"), false);
  assert.ok(events.indexOf("delivery:settled") < events.indexOf("failure:attempted"));
  assert.ok(events.indexOf("failure:attempted") < events.indexOf("deliver:two"));
});

test("conversation runner distinguishes failures before and after streamed output", async () => {
  const failures = [];
  const incomplete = [];
  let calls = 0;
  const runner = createConversationRunner({
    sessionStore: { get: () => null, set: async () => undefined },
    runTurn: () => {
      calls += 1;
      if (calls === 1) return {
        output: (async function* () {})(),
        completion: Promise.reject(new Error("before")),
      };
      return {
        output: (async function* () { yield "partial"; throw new Error("after"); })(),
        completion: Promise.reject(new Error("after")),
      };
    },
  });
  const input = {
    deliver: async (stream) => { for await (const _ of stream) { /* consume */ } },
    deliverFailure: async (error) => { failures.push(error.message); throw new Error("failure notification rejected"); },
    deliverIncomplete: async () => { incomplete.push("incomplete"); throw new Error("incomplete notification rejected"); },
  };

  assert.equal((await runner.enqueue("A", { ...input, prompt: "before" })).error.message, "before");
  assert.equal((await runner.enqueue("A", { ...input, prompt: "after" })).error.message, "after");
  assert.deepEqual(failures, ["before"]);
  assert.deepEqual(incomplete, ["incomplete"]);
});

test("streaming delivery creates ordered messages bounded to 3500 characters", async () => {
  const posts = [];
  await postInStreams({
    async post(stream) {
      let text = "";
      for await (const chunk of stream) text += chunk;
      posts.push(text);
    },
  }, (async function* () {
    yield "a".repeat(3499);
    yield "b".repeat(3502);
  })());
  assert.deepEqual(posts.map((text) => text.length), [3500, 3500, 1]);
  assert.equal(posts.join(""), "a".repeat(3499) + "b".repeat(3502));
});

test("streaming delivery releases native streams after a failed post", async () => {
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue("first");
      controller.enqueue("remaining");
      controller.close();
    },
  });
  const output = { [Symbol.asyncIterator]: () => stream.values({ preventCancel: true }) };

  await assert.rejects(postInStreams({
    async post(segment) {
      for await (const _ of segment) throw new Error("Slack failed");
    },
  }, output), /Slack failed/u);

  let remaining = "";
  for await (const chunk of output) remaining += chunk;
  assert.equal(remaining, "remaining");
});

test("Slack composition subscribes mentions, restores sessions, and ignores unsupported traffic", async () => {
  const handlers = {};
  const restored = [];
  const posts = [];
  const reactions = [];
  const chat = {
    onNewMention(handler) { handlers.mention = handler; },
    onSubscribedMessage(handler) { handlers.subscribed = handler; },
    async initialize() { restored.push("initialized"); },
    thread(id) { return { subscribe: async () => restored.push(id) }; },
    async shutdown() { restored.push("shutdown"); },
  };
  const calls = [];
  const executor = {
    runTurn: async ({ prompt, sessionId, contextEnvironment, attachments }) => {
      calls.push({ prompt, sessionId, contextEnvironment, attachments });
      if (prompt === "secret failure") throw new Error("bad xoxb-secret and xapp-secret");
      if (prompt === "broken attachment") throw new Error("Could not read one of the attached files. Please try uploading it again.");
      const text = prompt === "long"
        ? "x".repeat(7001)
        : prompt === "markdown"
          ? "Try **[Inventing on Principle](<https://example.com>)**."
          : `${prompt}:${sessionId ?? "new"}`;
      return { text, sessionId: sessionId ?? "ses_1" };
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
    config: { botName: "Piper", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  });
  assert.deepEqual(restored, ["slack:C1:1.0", "initialized"]);

  const human = { id: "U3", userId: "U3", isMe: false, isBot: false };
  const restoredPosts = [];
  const restoredThread = { id: "slack:C1:1.0", channel: { isDM: false, channelVisibility: "private" }, post: async (text) => restoredPosts.push(text) };
  await handlers.subscribed(restoredThread, { text: "continue", author: human, raw: {} });
  await waitFor(() => restoredPosts.length === 1);
  assert.deepEqual(restoredPosts, [{ markdown: "continue:ses_old" }]);
  assert.equal(calls[0].sessionId, "ses_old");

  const adapter = {
    addReaction: async (_, messageId, emoji) => reactions.push(`add:${messageId}:${emoji}`),
    removeReaction: async (_, messageId, emoji) => reactions.push(`remove:${messageId}:${emoji}`),
  };
  const thread = { id: "slack:C2:2.0", adapter, channel: { isDM: false, channelVisibility: "private" }, subscribe: async () => restored.push("subscribed"), post: async (text) => posts.push(text) };
  await handlers.mention(thread, { id: "1", text: "@U1 ask <@U2> for help", author: human, raw: {} });
  await handlers.subscribed(thread, { id: "2", text: "<@U2> follow up", author: human, raw: {} });
  const attachment = { name: "notes.txt", size: 100 * 1024 * 1024, fetchData: async () => Buffer.from("notes") };
  await handlers.mention(thread, { id: "file-1", text: "@U1 summarize", attachments: [attachment], author: human, raw: {} });
  await handlers.subscribed(thread, { id: "file-2", text: "compare this", attachments: [attachment], author: human, raw: { subtype: "file_share" } });
  await waitFor(() => posts.length === 4);
  const beforeIgnored = calls.length;
  for (const [threadOverride, messageOverride] of [
    [{ channel: { isDM: true } }, {}],
    [{ channel: { isDM: false, channelVisibility: "external" } }, {}],
    [{}, { author: { ...human, isMe: true } }],
    [{}, { author: { ...human, isBot: true } }],
    [{}, { raw: { subtype: "message_changed" } }],
    [{}, { text: "  ", attachments: [attachment] }],
  ]) {
    await handlers.subscribed({ ...thread, ...threadOverride }, { text: "ignored", author: human, raw: {}, ...messageOverride });
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, beforeIgnored);
  await handlers.mention(thread, { id: "too-large", text: "@U1 summarize", attachments: [{ ...attachment, size: 100 * 1024 * 1024 + 1 }], author: human, raw: {} });
  await waitFor(() => posts.includes("Pipa can read files up to 100 MB each."));
  assert.equal(calls.length, beforeIgnored);
  await handlers.subscribed(thread, { id: "missing-size", text: "no declared size", attachments: [{ ...attachment, size: undefined }], author: human, raw: { subtype: "file_share" } });
  await waitFor(() => calls.length === beforeIgnored + 1);
  assert.equal(calls.length, beforeIgnored + 1);
  await handlers.subscribed(thread, { id: "broken", text: "broken attachment", attachments: [attachment], author: human, raw: { subtype: "file_share" } });
  await handlers.subscribed(thread, { id: "3", text: "long", author: human, raw: {} });
  await handlers.subscribed(thread, { id: "4", text: "secret failure", author: human, raw: {} });
  await handlers.subscribed(thread, { id: "5", text: "markdown", author: human, raw: {} });
  await waitFor(() => posts.length === 12);
  assert.deepEqual(posts.slice(0, 2), [
    { markdown: "ask <@U2> for help:new" },
    { markdown: "<@U2> follow up:ses_1" },
  ]);
  assert.deepEqual(posts.slice(2, 4), [{ markdown: "summarize:ses_1" }, { markdown: "compare this:ses_1" }]);
  assert.equal(posts[4], "Pipa can read files up to 100 MB each.");
  assert.deepEqual(posts[5], { markdown: "no declared size:ses_1" });
  assert.equal(posts[6], "Piper failed: Could not read one of the attached files. Please try uploading it again.");
  assert.deepEqual(posts.slice(7, 10).map((part) => part.markdown.length), [3500, 3500, 1]);
  assert.equal(posts.at(-2), "Piper failed: bad [redacted] and [redacted]");
  assert.deepEqual(posts.at(-1), { markdown: "Try **[Inventing on Principle](<https://example.com>)**." });
  assert.deepEqual(calls.find(({ prompt }) => prompt.startsWith("ask ")).contextEnvironment, {
    PIPA_MESSAGE_CHANNEL: "slack",
    PIPA_CURRENT_SLACK_CHANNEL_ID: "C2",
    PIPA_CURRENT_SLACK_THREAD_TS: "2.0",
    PIPA_REQUESTER_SLACK_USER_ID: "U3",
  });
  assert.deepEqual(calls.find(({ prompt }) => prompt === "summarize").attachments, [attachment]);
  assert.deepEqual(calls.find(({ prompt }) => prompt === "compare this").attachments, [attachment]);
  assert.equal(calls.find(({ prompt }) => prompt === "no declared size").attachments[0].size, undefined);
  assert.equal(restored.filter((item) => item === "subscribed").length, 3);
  assert.deepEqual([...reactions].sort(), [
    "add:1:eyes", "remove:1:eyes", "add:1:white_check_mark",
    "add:2:eyes", "remove:2:eyes", "add:2:white_check_mark",
    "add:file-1:eyes", "remove:file-1:eyes", "add:file-1:white_check_mark",
    "add:file-2:eyes", "remove:file-2:eyes", "add:file-2:white_check_mark",
    "add:missing-size:eyes", "remove:missing-size:eyes", "add:missing-size:white_check_mark",
    "add:broken:eyes", "remove:broken:eyes", "add:broken:warning",
    "add:3:eyes", "remove:3:eyes", "add:3:white_check_mark",
    "add:4:eyes", "remove:4:eyes", "add:4:warning",
    "add:5:eyes", "remove:5:eyes", "add:5:white_check_mark",
  ].sort());
  await app.shutdown();
  assert.deepEqual(restored.slice(-2), ["stopped", "shutdown"]);
});

test("reports an intentional stop for an active Slack turn", async () => {
  const handlers = {};
  const posts = [];
  const reactions = [];
  let rejectTurn;
  const app = await startPipa({
    chat: {
      onNewMention(handler) { handlers.mention = handler; },
      onSubscribedMessage() {},
      async initialize() {},
      async shutdown() {},
    },
    executor: {
      runTurn: async () => new Promise((_, reject) => rejectTurn = reject),
      stopAll(reason) { rejectTurn?.(reason); },
    },
    checkSlackToken: async () => ({ ok: true }),
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    config: { botName: "Piper", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  });
  const thread = {
    id: "slack:C1:1.0",
    adapter: {
      addReaction: async (_, __, emoji) => reactions.push(`add:${emoji}`),
      removeReaction: async (_, __, emoji) => reactions.push(`remove:${emoji}`),
    },
    channel: { isDM: false, channelVisibility: "private" },
    subscribe: async () => undefined,
    post: async (text) => posts.push(text),
  };

  await handlers.mention(thread, { id: "1", text: "@U1 keep working", author: { userId: "U1" }, raw: {} });
  await waitFor(() => rejectTurn);
  app.stop();
  await app.shutdown();

  assert.deepEqual(posts, ["Piper stopped before finishing this request."]);
  assert.deepEqual(reactions, ["add:eyes", "remove:eyes"]);
});

test("ignores mentions from unauthorized users or channels", async () => {
  const handlers = {};
  const posts = [];
  const chat = {
    onNewMention(handler) { handlers.mention = handler; },
    onSubscribedMessage(handler) { handlers.subscribed = handler; },
    async initialize() {},
    async shutdown() {},
  };
  const calls = [];
  const executor = {
    runTurn: async ({ prompt }) => { calls.push(prompt); return { text: prompt, sessionId: "ses_1" }; },
    stopAll() {},
  };
  const config = {
    botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work",
    allowedSlackChannelIds: ["C1"], allowedSlackUserIds: ["U1"],
  };
  const app = await startPipa({
    chat, executor,
    checkSlackToken: async () => ({ ok: true }),
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    config,
  });

  const human = { id: "U1", userId: "U1", isMe: false, isBot: false };
  const stranger = { id: "U2", userId: "U2", isMe: false, isBot: false };
  const thread = (id) => ({ id, channel: { isDM: false, channelVisibility: "private" }, subscribe: async () => undefined, adapter: { addReaction: async () => undefined, removeReaction: async () => undefined }, post: async (text) => posts.push(text) });

  await handlers.mention(thread("slack:C1:1"), { id: "1", text: "@U1 hi", author: human, raw: {} });
  await handlers.mention(thread("slack:C2:2"), { id: "2", text: "@U1 hi", author: human, raw: {} });
  await handlers.mention(thread("slack:C1:3"), { id: "3", text: "@U1 hi", author: stranger, raw: {} });
  await handlers.mention(thread("slack:C2:4"), { id: "4", text: "@U1 hi", author: stranger, raw: {} });

  await waitFor(() => posts.length === 1);
  assert.deepEqual(calls, ["hi"]);
  assert.deepEqual(posts, [{ markdown: "hi" }]);
  await app.shutdown();
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

test("surfaces an unexpected owned-server exit and still shuts Slack down", async () => {
  let failServer;
  let serverStopped = false;
  const serverWait = new Promise((_, reject) => failServer = reject);
  const events = [];
  let stopReason;
  const failure = new Error("server exited");
  const app = await startPipa({
    chat: {
      onNewMention() {},
      onSubscribedMessage() {},
      async initialize() {},
      async shutdown() { events.push("slack:stop"); },
    },
    state: { connect: async () => undefined },
    checkSlackToken: async () => ({ ok: true }),
    executor: { runTurn: async () => undefined, stopAll: (reason) => { stopReason = reason; events.push("executor:stop"); } },
    server: {
      baseUrl: "http://127.0.0.1:54321",
      owned: true,
      wait: () => serverWait,
      stop() { if (!serverStopped) { serverStopped = true; events.push("server:stop"); } },
    },
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  });
  failServer(failure);
  await assert.rejects(app.wait(), /server exited/u);
  await assert.rejects(app.shutdown(), (error) => error === failure);
  assert.equal(stopReason, failure);
  assert.deepEqual(events, ["executor:stop", "slack:stop", "server:stop"]);
});

test("shutdown returns after its deadline when Chat does not disconnect", async () => {
  let serverStopped = false;
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
    server: {
      baseUrl: "http://127.0.0.1:54321",
      owned: true,
      wait: async () => undefined,
      stop() { serverStopped = true; },
    },
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  });
  await assert.rejects(app.shutdown(), /shutdown timed out/u);
  assert.equal(serverStopped, true);
});

test("permission cards disappear when OpenCode no longer lists the request", async () => {
  const posts = [];
  const deleted = [];
  const thread = slackInteractionThread({ posted: posts, deleted });
  let mention;
  let actionHandler;
  const chat = {
    onNewMention(handler) { mention = handler; },
    onSubscribedMessage() {},
    onAction(ids, handler) { actionHandler = handler ?? ids; },
    async initialize() {},
    async shutdown() {},
  };
  await startInteractionPipa(chat, {
    runTurn: async ({ onInteraction, onPermissionsReconciled }) => {
      const decision = onInteraction({
        type: "permission",
        sessionId: "ses_1",
        request: { id: "per_1", permission: "external_directory", patterns: ["/outside"] },
        signal: AbortSignal.timeout(5000),
      });
      await new Promise((resolve) => setImmediate(resolve));
      onPermissionsReconciled({ sessionId: "ses_1", requestIds: new Set() });
      return { text: (await decision).type, sessionId: "ses_1" };
    },
    stopAll() {},
  });
  await mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posts.filter((post) => post.blocks?.[0]?.text?.text === "Permission requested").length, 1);
  assert.deepEqual(deleted, [{ channel: "C1", ts: "1.0" }]);
  const ephemeral = [];
  const action = slackAction(posts[0], "pipa_permission_");
  await actionHandler({
    actionId: action.action_id,
    value: action.value,
    user: { userId: "U1" },
    thread: { ...thread, postEphemeral: async (...args) => ephemeral.push(args) },
  });
  assert.deepEqual(ephemeral, []);
});

test("shutdown expires active interaction cards", async () => {
  const posts = [];
  const deleted = [];
  const thread = slackInteractionThread({ posted: posts, deleted });
  let mention;
  const chat = {
    onNewMention(handler) { mention = handler; },
    onSubscribedMessage() {},
    onAction() {},
    async initialize() {},
    async shutdown() {},
  };
  const app = await startInteractionPipa(chat, {
    runTurn: async ({ onInteraction }) => {
      await onInteraction({
        type: "permission",
        sessionId: "ses_1",
        request: { id: "per_1", permission: "external_directory", patterns: ["/outside"] },
        signal: AbortSignal.timeout(5000),
      });
      return { text: "done", sessionId: "ses_1" };
    },
    stopAll() {},
  });
  await mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} });
  await waitFor(() => posts.length === 1);
  await app.shutdown();
  assert.deepEqual(deleted, [{ channel: "C1", ts: "1.0" }]);
});

test("interaction registry uses Block Kit selectors in Slack", async () => {
  const posted = [];
  const updated = [];
  const thread = {
    id: "slack:C1:1.0",
    adapter: { webClient: { chat: {
      postMessage: async (message) => { posted.push(message); return { ts: "2.0" }; },
      update: async (message) => { updated.push(message); },
    } } },
    channel: { isDM: false, channelVisibility: "private" },
    subscribe: async () => undefined,
    post: async () => undefined,
  };
  let actionHandler;
  let mention;
  const chat = {
    onNewMention(handler) { mention = handler; },
    onSubscribedMessage() {},
    onAction(ids, handler) { actionHandler = handler ?? ids; },
    async initialize() {},
    async shutdown() {},
  };
  void startInteractionPipa(chat, {
    runTurn: async ({ onInteraction }) => {
      const decision = await onInteraction({
        type: "question",
        request: { questions: [
          { header: "First", question: "Choose one", options: [{ label: "A" }, { label: "B" }] },
          { header: "Second", question: "Choose many", multiple: true, options: [{ label: "C" }, { label: "D" }] },
        ] },
        signal: AbortSignal.timeout(5000),
      });
      return { text: decision.answers[0].join(","), sessionId: "ses_1" };
    },
    stopAll() {},
  }).then(() => mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", fullName: "Lola", isMe: false, isBot: false }, raw: {} }));

  await new Promise((resolve) => setTimeout(resolve, 20));
  const radio = posted[0].blocks.find((block) => block.type === "actions").elements[0];
  assert.equal(radio.type, "radio_buttons");
  await actionHandler({ actionId: radio.action_id, value: radio.options[0].value, user: { fullName: "lola" }, thread });
  assert.equal(updated.length, 0);
  const firstSubmit = slackAction(posted[0], "pipa_submit_");
  await actionHandler({ actionId: firstSubmit.action_id, value: firstSubmit.value, user: { fullName: "lola" }, thread });
  await waitFor(() => updated.length === 1);
  const checkbox = updated[0].blocks.find((block) => block.type === "actions" && block.elements[0].type === "checkboxes").elements[0];
  assert.equal(checkbox.type, "checkboxes");
  await actionHandler({ actionId: checkbox.action_id, raw: { actions: [{ action_id: checkbox.action_id, selected_options: checkbox.options }] }, user: { fullName: "lola" }, thread });
  const submitButton = updated[0].blocks.at(-1).elements.find((element) => element.action_id.startsWith("pipa_submit_"));
  await actionHandler({ actionId: submitButton.action_id, value: submitButton.value, user: { fullName: "lola" }, thread });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(updated[1].blocks[1].text.text, "Lola selected: “A”, “C”, “D”.");
});

test("interaction registry uses custom answer instead of an empty Slack selector", async () => {
  const posted = [];
  const updated = [];
  const thread = {
    id: "slack:C1:1.0",
    adapter: { webClient: { chat: {
      postMessage: async (message) => { posted.push(message); return { ts: "2.0" }; },
      update: async (message) => { updated.push(message); },
    } } },
    channel: { isDM: false, channelVisibility: "private" },
    subscribe: async () => undefined,
    post: async () => undefined,
  };
  let actionHandler;
  let customAnswerHandler;
  let mention;
  const chat = {
    onNewMention(handler) { mention = handler; },
    onSubscribedMessage() {},
    onAction(ids, handler) { actionHandler = handler ?? ids; },
    onModalSubmit(_, handler) { customAnswerHandler = handler; },
    async initialize() {},
    async shutdown() {},
  };
  let decision;
  void startInteractionPipa(chat, {
    runTurn: async ({ onInteraction }) => {
      decision = await onInteraction({
        type: "question",
        request: { header: "Project name", question: "What should we call it?", custom: true, options: [] },
        signal: AbortSignal.timeout(5000),
      });
      return { text: "done", sessionId: "ses_1" };
    },
    stopAll() {},
  }).then(() => mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} }));

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posted[0].blocks.some((block) => block.elements?.some((element) => ["radio_buttons", "checkboxes"].includes(element.type))), false);
  const custom = posted[0].blocks.at(-1).elements.find((element) => element.action_id.startsWith("pipa_custom_"));
  await actionHandler({ actionId: custom.action_id, value: custom.value, thread, openModal: async () => undefined });
  await customAnswerHandler({ privateMetadata: custom.value, values: { answer: "Orbit" }, user: { fullName: "lola" } });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(decision, { type: "answer", answers: [["Orbit"]], selectedBy: "Lola" });
  assert.equal(updated[0].blocks[1].text.text, "Lola selected: “Orbit”.");
});

test("interaction registry renders permission card and resolves with reply value", async () => {
  const posts = [];
  const thread = slackInteractionThread({ posted: posts });
  let actionHandler;
  let mention;
  const chat = {
    onNewMention(handler) { mention = handler; },
    onSubscribedMessage() {},
    onAction(ids, handler) { actionHandler = handler ?? ids; },
    async initialize() {},
    async shutdown() {},
  };
  let resolvedDecision;
  (async () => {
    const executor = {
      runTurn: async ({ onInteraction, onSession }) => {
        await onSession("ses_1");
        const decision = await onInteraction({
          type: "permission",
          sessionId: "ses_1",
          request: { id: "perm_1", permission: "external_directory", patterns: ["/outside"], tool: { name: "glob", input: { pattern: "agents/**/*" } } },
          signal: AbortSignal.timeout(5000),
        });
        resolvedDecision = decision;
        return { text: "done", sessionId: "ses_1" };
      },
      stopAll() {},
    };
    await startInteractionPipa(chat, executor);
    await mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} });
  })();

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].blocks[0].text.text, "Permission requested");
  assert.match(posts[0].blocks[1].text.text, /Tool: glob\nPattern: agents\/\*\*\/*/u);

  const action = slackAction(posts[0], "pipa_permission_");
  await actionHandler({ actionId: action.action_id, value: action.value, user: { userId: "U1" }, thread, messageId: "msg_1" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(resolvedDecision, { type: "reply", reply: "once" });
});

test("permission decisions explain the selected scope", async () => {
  const posts = [];
  const edits = [];
  const thread = slackInteractionThread({ posted: posts, updated: edits });
  let actionHandler;
  let mention;
  const chat = {
    onNewMention(handler) { mention = handler; },
    onSubscribedMessage() {},
    onAction(ids, handler) { actionHandler = handler ?? ids; },
    async initialize() {},
    async shutdown() {},
  };
  void startInteractionPipa(chat, {
    runTurn: async ({ onInteraction }) => {
      await onInteraction({
        type: "permission",
        sessionId: "ses_1",
        request: { id: "perm_1", permission: "external_directory", patterns: ["/outside"], tool: { name: "glob", input: { pattern: "agents/**/*" } } },
        signal: AbortSignal.timeout(5000),
      });
      return { text: "done", sessionId: "ses_1" };
    },
    stopAll() {},
  }).then(() => mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} }));

  await waitFor(() => posts.length === 1);
  const action = slackAction(posts[0], "pipa_permission_reject_");
  await actionHandler({ actionId: action.action_id, value: action.value, user: { fullName: "lola" }, thread });
  await waitFor(() => edits.length === 1);
  assert.equal(edits[0].blocks[0].text.text, "Permission rejected");
  assert.match(edits[0].blocks[1].text.text, /Rejected by Lola\. Blocked `glob agents\/\*\*\/\*`\. OpenCode may cancel related requests from the same batch\./u);
});

test("permission cards in separate Slack threads do not block one another", async () => {
  const posts = [];
  let request = 0;
  const threads = ["slack:C1:1.0", "slack:C1:2.0"].map((id) => slackInteractionThread({ id, posted: posts }));
  let mention;
  const chat = {
    onNewMention(handler) { mention = handler; },
    onSubscribedMessage() {},
    onAction() {},
    async initialize() {},
    async shutdown() {},
  };
  void startInteractionPipa(chat, {
    runTurn: ({ onInteraction }) => onInteraction({
      type: "permission",
      sessionId: "ses_1",
      request: { id: `perm_${++request}`, permission: "external_directory", patterns: ["/outside"] },
      signal: AbortSignal.timeout(5000),
    }).then(() => ({ text: "done", sessionId: "ses_1" })),
    stopAll() {},
  }).then(() => Promise.all(threads.map((thread) => mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} }))));

  await waitFor(() => posts.length === 2);
  assert.deepEqual(posts.map((post) => post.thread_ts).sort(), ["1.0", "2.0"]);
});

test("interaction registry queues concurrent permission cards", async () => {
  const posts = [];
  const thread = slackInteractionThread({ posted: posts });
  let actionHandler;
  let mention;
  const chat = {
    onNewMention(handler) { mention = handler; },
    onSubscribedMessage() {},
    onAction(ids, handler) { actionHandler = handler ?? ids; },
    async initialize() {},
    async shutdown() {},
  };
  void startInteractionPipa(chat, {
    runTurn: ({ onInteraction }) => Promise.all([
      onInteraction({ type: "permission", sessionId: "ses_1", request: { id: "perm_1", permission: "read", patterns: ["one"] }, signal: AbortSignal.timeout(5000) }),
      onInteraction({ type: "permission", sessionId: "ses_1", request: { id: "perm_2", permission: "read", patterns: ["two"] }, signal: AbortSignal.timeout(5000) }),
    ]).then(() => ({ text: "done", sessionId: "ses_1" })),
    stopAll() {},
  }).then(() => mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} }));

  await waitFor(() => posts.length === 1);
  let action = slackAction(posts[0], "pipa_permission_once_");
  await actionHandler({ actionId: action.action_id, value: action.value, thread });
  await waitFor(() => posts.length === 2);
  action = slackAction(posts[1], "pipa_permission_once_");
  await actionHandler({ actionId: action.action_id, value: action.value, thread });
});

test("another user can answer an active question", async () => {
  const posts = [];
  const thread = slackInteractionThread({ posted: posts });
  let actionHandler;
  let mention;
  const chat = {
    onNewMention(handler) { mention = handler; },
    onSubscribedMessage() {},
    onAction(ids, handler) { actionHandler = handler ?? ids; },
    async initialize() {},
    async shutdown() {},
  };
  let resolvedDecision = null;
  (async () => {
    const executor = {
      runTurn: async ({ onInteraction, onSession }) => {
        await onSession("ses_1");
        const decision = await onInteraction({
          type: "question",
          sessionId: "ses_1",
          request: { id: "req_1", questions: [{ header: "Q", question: "Pick", options: [{ label: "X" }] }] },
          signal: AbortSignal.timeout(5000),
        });
        resolvedDecision = decision;
        return { text: "done", sessionId: "ses_1" };
      },
      stopAll() {},
    };
    await startInteractionPipa(chat, executor);
    await mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} });
  })();

  await new Promise((resolve) => setTimeout(resolve, 20));
  const radio = posts[0].blocks.find((block) => block.type === "actions").elements[0];
  await actionHandler({
    actionId: radio.action_id,
    value: radio.options[0].value,
    user: { userId: "U2" },
    thread,
    messageId: "msg_1",
  });
  assert.equal(resolvedDecision, null);
  const submit = slackAction(posts[0], "pipa_submit_");
  await actionHandler({ actionId: submit.action_id, value: submit.value, user: { userId: "U2" }, thread, messageId: "msg_1" });
  await waitFor(() => resolvedDecision);
  assert.deepEqual(resolvedDecision, { type: "answer", answers: [["X"]] });
});

function slackInteractionThread({ id = "slack:C1:1.0", posted = [], updated = [], deleted = [] } = {}) {
  return {
    id,
    adapter: { webClient: { chat: {
      postMessage: async (message) => { posted.push(message); return { ts: `${posted.length}.0` }; },
      update: async (message) => { updated.push(message); },
      delete: async (message) => { deleted.push(message); },
    } } },
    channel: { isDM: false, channelVisibility: "private" },
    subscribe: async () => undefined,
    post: async () => undefined,
  };
}

function slackAction(message, prefix) {
  return message.blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id?.startsWith(prefix));
}

function startInteractionPipa(chat, executor) {
  return startPipa({
    chat,
    executor,
    checkSlackToken: async () => ({ ok: true }),
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for test condition.");
}
