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
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  });
  assert.deepEqual(restored, ["slack:C1:1.0", "initialized"]);

  const human = { id: "U3", userId: "U3", isMe: false, isBot: false };
  const restoredPosts = [];
  const restoredThread = { id: "slack:C1:1.0", channel: { isDM: false, channelVisibility: "private" }, post: async (text) => restoredPosts.push(text) };
  await handlers.subscribed(restoredThread, { text: "continue", author: human, raw: {} });
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
  assert.equal(calls.length, beforeIgnored);
  await handlers.mention(thread, { id: "too-large", text: "@U1 summarize", attachments: [{ ...attachment, size: 100 * 1024 * 1024 + 1 }], author: human, raw: {} });
  assert.equal(calls.length, beforeIgnored);
  await handlers.subscribed(thread, { id: "missing-size", text: "no declared size", attachments: [{ ...attachment, size: undefined }], author: human, raw: { subtype: "file_share" } });
  assert.equal(calls.length, beforeIgnored + 1);
  await handlers.subscribed(thread, { id: "broken", text: "broken attachment", attachments: [attachment], author: human, raw: { subtype: "file_share" } });
  await handlers.subscribed(thread, { id: "3", text: "long", author: human, raw: {} });
  await handlers.subscribed(thread, { id: "4", text: "secret failure", author: human, raw: {} });
  await handlers.subscribed(thread, { id: "5", text: "markdown", author: human, raw: {} });
  assert.deepEqual(posts.slice(0, 2), [
    { markdown: "ask <@U2> for help:new" },
    { markdown: "<@U2> follow up:ses_1" },
  ]);
  assert.deepEqual(posts.slice(2, 4), [{ markdown: "summarize:ses_1" }, { markdown: "compare this:ses_1" }]);
  assert.equal(posts[4], "Pipa can read files up to 100 MB each.");
  assert.deepEqual(posts[5], { markdown: "no declared size:ses_1" });
  assert.equal(posts[6], "Pipa failed: Could not read one of the attached files. Please try uploading it again.");
  assert.deepEqual(posts.slice(7, 10).map((part) => part.markdown.length), [3500, 3500, 1]);
  assert.equal(posts.at(-2), "Pipa failed: bad [redacted] and [redacted]");
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
  assert.deepEqual(reactions, [
    "add:1:eyes", "remove:1:eyes", "add:1:white_check_mark",
    "add:2:eyes", "remove:2:eyes", "add:2:white_check_mark",
    "add:file-1:eyes", "remove:file-1:eyes", "add:file-1:white_check_mark",
    "add:file-2:eyes", "remove:file-2:eyes", "add:file-2:white_check_mark",
    "add:missing-size:eyes", "remove:missing-size:eyes", "add:missing-size:white_check_mark",
    "add:broken:eyes", "remove:broken:eyes", "add:broken:warning",
    "add:3:eyes", "remove:3:eyes", "add:3:white_check_mark",
    "add:4:eyes", "remove:4:eyes", "add:4:warning",
    "add:5:eyes", "remove:5:eyes", "add:5:white_check_mark",
  ]);
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

test("surfaces an unexpected owned-server exit and still shuts Slack down", async () => {
  let failServer;
  let serverStopped = false;
  const serverWait = new Promise((_, reject) => failServer = reject);
  const events = [];
  const app = await startPipa({
    chat: {
      onNewMention() {},
      onSubscribedMessage() {},
      async initialize() {},
      async shutdown() { events.push("slack:stop"); },
    },
    state: { connect: async () => undefined },
    checkSlackToken: async () => ({ ok: true }),
    executor: { runTurn: async () => undefined, stopAll: () => events.push("executor:stop") },
    server: {
      baseUrl: "http://127.0.0.1:54321",
      owned: true,
      wait: () => serverWait,
      stop() { if (!serverStopped) { serverStopped = true; events.push("server:stop"); } },
    },
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  });
  failServer(new Error("server exited"));
  await assert.rejects(app.wait(), /server exited/u);
  await assert.rejects(app.shutdown(), /server exited/u);
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

test("interaction registry renders question card and resolves on button click", async () => {
  const posts = [];
  const edits = [];
  const thread = {
    id: "slack:C1:1.0",
    channel: { isDM: false, channelVisibility: "private" },
    subscribe: async () => undefined,
    post: async (content) => {
      posts.push(content);
      return {
        id: "msg_1",
        edit: async (newContent) => { edits.push(newContent); return { id: "msg_1" }; },
      };
    },
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
  (async () => {
    const executor = {
      runTurn: async ({ onInteraction, onSession }) => {
        await onSession("ses_1");
        const decision = await onInteraction({
          type: "question",
          sessionId: "ses_1",
          request: { id: "req_1", questions: [{ header: "Pick", question: "Choose one", options: [{ label: "A" }, { label: "B" }] }] },
          signal: AbortSignal.timeout(5000),
        });
        return { text: `answered:${decision.answers[0][0]}`, sessionId: "ses_1" };
      },
      stopAll() {},
    };
    const app = await startPipa({
      chat,
      executor,
      checkSlackToken: async () => ({ ok: true }),
      config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
      sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    });
    await mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} });
    return app;
  })();

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posts.length, 1, "should post one interaction card");
  assert.equal(posts[0].title, "Pick");
  assert.equal(new Set(posts[0].children.flatMap((child) => child.children ?? []).map((button) => button.id)).size, 3);

  await actionHandler({ actionId: actionId(posts[0], "pipa_option_"), value: actionValue(posts[0], "pipa_option_"), user: { userId: "U1" }, thread, messageId: "msg_1" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(edits.length, 1, "should edit card after decision");
  assert.equal(edits[0].title, "Pick");
  assert.equal(edits[0].children[0].content, "Selected: “A”.");
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
  void startPipa({
    chat,
    executor: {
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
    },
    checkSlackToken: async () => ({ ok: true }),
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
  }).then(() => mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", fullName: "Lola", isMe: false, isBot: false }, raw: {} }));

  await new Promise((resolve) => setTimeout(resolve, 20));
  const radio = posted[0].blocks.find((block) => block.type === "actions").elements[0];
  assert.equal(radio.type, "radio_buttons");
  await actionHandler({ actionId: radio.action_id, value: radio.options[0].value, user: { fullName: "Lola" }, thread });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const checkbox = updated[0].blocks.find((block) => block.type === "actions" && block.elements[0].type === "checkboxes").elements[0];
  assert.equal(checkbox.type, "checkboxes");
  await actionHandler({ actionId: checkbox.action_id, value: `${checkbox.options[0].value}`, raw: { actions: [{ action_id: checkbox.action_id, selected_options: checkbox.options }] }, user: { fullName: "Lola" }, thread });
  const continueButton = updated[0].blocks.at(-1).elements.find((element) => element.action_id.startsWith("pipa_continue_"));
  await actionHandler({ actionId: continueButton.action_id, value: continueButton.value, user: { fullName: "Lola" }, thread });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(updated[1].blocks[1].text.text, "Lola selected: “A”, “C”, “D”.");
});

test("interaction registry renders permission card and resolves with reply value", async () => {
  const posts = [];
  const thread = {
    id: "slack:C1:1.0",
    channel: { isDM: false, channelVisibility: "private" },
    subscribe: async () => undefined,
    post: async (content) => {
      posts.push(content);
      return { id: "msg_1", edit: async (c) => ({ id: "msg_1" }) };
    },
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
  let resolvedDecision;
  (async () => {
    const executor = {
      runTurn: async ({ onInteraction, onSession }) => {
        await onSession("ses_1");
        const decision = await onInteraction({
          type: "permission",
          sessionId: "ses_1",
          request: { id: "perm_1", permission: "shell", patterns: ["rm *"] },
          signal: AbortSignal.timeout(5000),
        });
        resolvedDecision = decision;
        return { text: "done", sessionId: "ses_1" };
      },
      stopAll() {},
    };
    await startPipa({
      chat,
      executor,
      checkSlackToken: async () => ({ ok: true }),
      config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
      sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    });
    await mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} });
  })();

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, "Permission requested");

  await actionHandler({ actionId: actionId(posts[0], "pipa_permission_"), value: actionValue(posts[0], "pipa_permission_"), user: { userId: "U1" }, thread, messageId: "msg_1" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(resolvedDecision, { type: "reply", reply: "once" });
});

test("dismiss action resolves with stop type", async () => {
  const posts = [];
  const thread = {
    id: "slack:C1:1.0",
    channel: { isDM: false, channelVisibility: "private" },
    subscribe: async () => undefined,
    post: async (content) => {
      posts.push(content);
      return { id: "msg_1", edit: async () => ({ id: "msg_1" }) };
    },
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
  let resolvedDecision;
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
    await startPipa({
      chat,
      executor,
      checkSlackToken: async () => ({ ok: true }),
      config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
      sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    });
    await mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} });
  })();

  await new Promise((resolve) => setTimeout(resolve, 20));
  await actionHandler({ actionId: actionId(posts[0], "pipa_dismiss_"), value: actionValue(posts[0], "pipa_dismiss_"), user: { userId: "U1" }, thread, messageId: "msg_1" });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(resolvedDecision, { type: "stop" });
});

test("another user can answer an active question", async () => {
  const posts = [];
  const thread = {
    id: "slack:C1:1.0",
    channel: { isDM: false, channelVisibility: "private" },
    subscribe: async () => undefined,
    post: async (content) => {
      posts.push(content);
      return { id: "msg_1", edit: async () => ({ id: "msg_1" }) };
    },
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
    await startPipa({
      chat,
      executor,
      checkSlackToken: async () => ({ ok: true }),
      config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
      sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    });
    await mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} });
  })();

  await new Promise((resolve) => setTimeout(resolve, 20));
  await actionHandler({
    actionId: actionId(posts[0], "pipa_option_"),
    value: actionValue(posts[0], "pipa_option_"),
    user: { userId: "U2" },
    thread,
    messageId: "msg_1",
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(resolvedDecision, { type: "answer", answers: [["X"]] });
});

function actionValue(card, actionId) {
  return card.children.flatMap((child) => child.children ?? []).find((button) => button.id.startsWith(actionId))?.value;
}

function actionId(card, prefix) {
  return card.children.flatMap((child) => child.children ?? []).find((button) => button.id.startsWith(prefix))?.id;
}
