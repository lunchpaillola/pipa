import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { checkSlackAppToken, checkSlackToken, createConversationRunner, createPendingInteractions, initializePipa, postResult, slackDestinationId, startPipa as startPipaRuntime } from "../src/app.mjs";
import { PipaStoppedError } from "../src/opencode.mjs";
import { createRoutineScheduler, normalizeRoutine } from "../src/routines.mjs";
import { createSessionStore, pipaPaths, writePrivateJson } from "../src/state.mjs";

const startPipa = (options) => startPipaRuntime({ routinesEnabled: false, ...options });

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

test("Slack bot checks normalize granted scopes from headers and response metadata", async () => {
  const fromHeader = await checkSlackToken("xoxb-test", async () => ({
    ok: true,
    headers: { get: (name) => name === "x-oauth-scopes" ? " channels:read,assistant:write, channels:read " : null },
    json: async () => ({ ok: true }),
  }));
  assert.deepEqual(fromHeader.grantedScopes, ["channels:read", "assistant:write"]);

  const fromMetadata = await checkSlackToken("xoxb-test", async () => ({
    ok: true,
    headers: { get: () => null },
    json: async () => ({ ok: true, response_metadata: { scopes: ["assistant:write", " channels:read "] } }),
  }));
  assert.deepEqual(fromMetadata.grantedScopes, ["assistant:write", "channels:read"]);

  for (const responseMetadata of [undefined, { scopes: "not-a-list" }, { scopes: ["channels:read", 42] }]) {
    const result = await checkSlackToken("xoxb-test", async () => ({
      ok: true,
      headers: { get: () => null },
      json: async () => ({ ok: true, response_metadata: responseMetadata }),
    }));
    assert.equal(result.grantedScopes, undefined);
  }
});

test("init and start warn about known missing Slack scopes without blocking", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-scopes-"));
  const paths = pipaPaths(home);
  const warnings = [];
  let checks = 0;
  const checkSlackToken = async () => ({ ok: true, grantedScopes: checks++ === 0 ? ["assistant:write"] : ["channels:read"] });
  await initializePipa({
    botName: "Pipa",
    slackAppToken: "xapp-test",
    slackBotToken: "xoxb-test",
    workingDirectory: home,
  }, {
    paths,
    checkOpenCode: async () => "1.0.0",
    checkSlackAppToken: async () => ({ ok: true }),
    checkSlackToken,
    warn: (message) => warnings.push(message),
  });
  assert.equal(JSON.parse(await readFile(paths.config, "utf8")).botName, "Pipa");

  const app = await startPipa({
    chat: { onNewMention() {}, onSubscribedMessage() {}, async initialize() {}, async shutdown() {} },
    executor: { runTurn: async () => undefined, stopAll() {} },
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    checkSlackToken,
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: home },
    warn: (message) => warnings.push(message),
  });
  await app.shutdown();

  assert.equal(warnings.length, 2);
  assert.match(warnings[0], /channels:read/u);
  assert.match(warnings[1], /assistant:write/u);
  for (const warning of warnings) {
    assert.match(warning, /Add it/u);
    assert.match(warning, /reinstall or reauthorize/u);
  }
});

test("complete or unknown Slack scope metadata does not warn", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-scopes-"));
  for (const grantedScopes of [["channels:read", "assistant:write"], undefined]) {
    const warnings = [];
    await initializePipa({
      botName: "Pipa",
      slackAppToken: "xapp-test",
      slackBotToken: "xoxb-test",
      workingDirectory: home,
    }, {
      paths: pipaPaths(home),
      checkOpenCode: async () => "1.0.0",
      checkSlackAppToken: async () => ({ ok: true }),
      checkSlackToken: async () => ({ ok: true, grantedScopes }),
      warn: (message) => warnings.push(message),
    });
    assert.deepEqual(warnings, []);
  }
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
    createExecutor: ({ artifactRoot, baseUrl, onFatal }) => {
      events.push(`executor:${baseUrl}`);
      assert.equal(artifactRoot, path.join("/work", ".pipa", "artifacts"));
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

test("conversation runner interrupts one thread, reuses its session, and overlaps other threads", async () => {
  const events = [];
  const sessions = new Map();
  const active = new Map();
  const sessionStore = {
    get: (key) => sessions.get(key) ?? null,
    async set(key, value) { events.push(`save:${key}:${value}`); sessions.set(key, value); },
  };
  const runner = createConversationRunner({
    sessionStore,
    abortTurn: async (sessionId) => events.push(`abort:${sessionId}`),
    runTurn: async ({ prompt, sessionId, onSession, signal }) => {
      const selectedSessionId = sessionId ?? `ses_${prompt === "other" ? "other" : "A"}`;
      events.push(`start:${prompt}:${sessionId}`);
      await onSession(selectedSessionId);
      if (prompt === "one" || prompt === "other") {
        await new Promise((resolve, reject) => {
          active.set(selectedSessionId, { resolve, reject });
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
      events.push(`end:${prompt}`);
      return { text: prompt, sessionId: selectedSessionId };
    },
  });

  const delivered = [];
  const failed = [];
  const first = runner.enqueue("A", { prompt: "one", deliver: (result) => delivered.push(result.text), deliverFailure: (error) => failed.push(error) });
  const other = runner.enqueue("B", { prompt: "other" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["start:one:null", "start:other:null"]);
  const second = runner.enqueue("A", { prompt: "two", deliver: (result) => delivered.push(result.text) });
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(events.join("|"), /abort:ses_A\|start:two:ses_A/u);
  active.get("ses_other").resolve();
  await other;
  assert.equal((await first).superseded, true);
  assert.equal((await second).text, "two");
  assert.deepEqual(delivered, ["two"]);
  assert.deepEqual(failed, []);
});

test("conversation runner interrupts before OpenCode selects a session", async () => {
  const runner = createConversationRunner({
    sessionStore: { get: () => null, set: async () => undefined },
    runTurn: async ({ prompt, signal }) => {
      if (prompt === "one") await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return { text: prompt, sessionId: "ses_1" };
    },
  });
  const first = runner.enqueue("A", { prompt: "one" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = runner.enqueue("A", { prompt: "two" });
  assert.equal((await first).superseded, true);
  assert.equal((await second).text, "two");
});

test("conversation runner skips an intermediate turn when aborts finish out of order", async () => {
  let finishFirstAbort;
  let aborts = 0;
  const prompts = [];
  const runner = createConversationRunner({
    sessionStore: { get: () => null, set: async () => undefined },
    abortTurn: async () => {
      aborts += 1;
      if (aborts === 1) await new Promise((resolve) => finishFirstAbort = resolve);
    },
    runTurn: async ({ prompt, signal, onSession }) => {
      prompts.push(prompt);
      await onSession("ses_1");
      if (prompt === "A") await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
      return { text: prompt, sessionId: "ses_1" };
    },
  });

  const first = runner.enqueue("thread", { prompt: "A" });
  await new Promise((resolve) => setImmediate(resolve));
  const second = runner.enqueue("thread", { prompt: "B" });
  const third = runner.enqueue("thread", { prompt: "C" });
  finishFirstAbort();

  assert.equal((await first).superseded, true);
  assert.equal((await second).superseded, true);
  assert.equal((await third).text, "C");
  assert.deepEqual(prompts, ["A", "C"]);
});

test("conversation runner starts typing once for active turns and ignores typing failures", async () => {
  const typing = [];
  const runner = createConversationRunner({
    sessionStore: { get: () => null, set: async () => undefined },
    runTurn: async ({ prompt }) => ({ text: prompt, sessionId: `ses_${prompt}` }),
  });
  await runner.enqueue("A", { prompt: "one", startTyping: () => typing.push("one") });
  await runner.enqueue("A", { prompt: "two", startTyping: () => { throw new Error("typing unavailable"); } });
  await runner.enqueue("B", { prompt: "three", startTyping: async () => { throw new Error("typing unavailable"); } });
  assert.deepEqual(typing, ["one"]);
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

test("failed delivery releases the conversation tail", async () => {
  let signalDeliveryStarted;
  const deliveryStarted = new Promise((resolve) => signalDeliveryStarted = resolve);
  const runner = createConversationRunner({
    sessionStore: { get: () => null, set: async () => undefined },
    runTurn: async ({ prompt }) => ({ text: prompt, sessionId: `ses_${prompt}` }),
  });
  const first = runner.enqueue("A", {
    prompt: "one",
    deliver: async () => {
      signalDeliveryStarted();
      throw new Error("delivery failed");
    },
  });
  await deliveryStarted;
  const second = runner.enqueue("A", { prompt: "two" });
  await assert.rejects(first, /delivery failed/u);
  await second;
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

test("replacement during session persistence suppresses stale delivery", async () => {
  let finishSave;
  let saveStarted;
  let saves = 0;
  const saving = new Promise((resolve) => saveStarted = resolve);
  const delivered = [];
  const runner = createConversationRunner({
    sessionStore: {
      get: () => null,
      set: async () => {
        saves += 1;
        if (saves > 1) return;
        saveStarted();
        await new Promise((resolve) => finishSave = resolve);
      },
    },
    runTurn: async ({ prompt }) => ({ text: prompt, sessionId: "ses_1" }),
  });
  const first = runner.enqueue("A", { prompt: "one", deliver: ({ text }) => delivered.push(text) });
  await saving;
  const second = runner.enqueue("A", { prompt: "two", deliver: ({ text }) => delivered.push(text) });
  finishSave();

  assert.equal((await first).superseded, true);
  await second;
  assert.deepEqual(delivered, ["two"]);
});

test("shutdown during session persistence reports the turn as stopped", async () => {
  let finishSave;
  let saveStarted;
  const saving = new Promise((resolve) => saveStarted = resolve);
  const failures = [];
  const runner = createConversationRunner({
    sessionStore: {
      get: () => null,
      set: async () => {
        saveStarted();
        await new Promise((resolve) => finishSave = resolve);
      },
    },
    runTurn: async () => ({ text: "done", sessionId: "ses_1" }),
  });
  const active = runner.enqueue("A", { prompt: "one", deliverFailure: (error) => failures.push(error) });
  await saving;
  runner.close();
  finishSave();

  const result = await active;
  assert.ok(result.error instanceof PipaStoppedError);
  assert.deepEqual(failures, [result.error]);
});

test("closing the runner prevents queued turns from starting", async () => {
  let release;
  const prompts = [];
  const failures = [];
  const typing = [];
  const runner = createConversationRunner({
    sessionStore: { get: () => null, set: async () => undefined },
    runTurn: async ({ prompt }) => {
      prompts.push(prompt);
      await new Promise((resolve) => release = resolve);
      return { text: prompt, sessionId: "ses_1" };
    },
  });
  const active = runner.enqueue("A", { prompt: "active" });
  const queued = runner.enqueue("A", { prompt: "queued", startTyping: (status) => typing.push(status), deliverFailure: async (error) => failures.push(error) });
  await new Promise((resolve) => setImmediate(resolve));
  runner.close();
  release();
  await active;
  const result = await queued;
  assert.equal(result.error, failures[0]);
  assert.ok(result.error instanceof PipaStoppedError);
  const late = await runner.enqueue("B", { prompt: "late", startTyping: (status) => typing.push(status), deliverFailure: async (error) => failures.push(error) });
  assert.equal(late.error, failures[1]);
  assert.ok(late.error instanceof PipaStoppedError);
  assert.deepEqual(prompts, ["active"]);
  assert.deepEqual(typing, []);
});

test("closing the runner aborts its active OpenCode session before draining", async () => {
  const aborted = [];
  const runner = createConversationRunner({
    sessionStore: { get: () => "ses_1", set: async () => undefined },
    abortTurn: async (sessionId) => aborted.push(sessionId),
    runTurn: async ({ signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true })),
  });
  const active = runner.enqueue("A", { prompt: "active", deliverFailure: () => undefined });
  await new Promise((resolve) => setImmediate(resolve));
  runner.close();

  assert.deepEqual(aborted, ["ses_1"]);
  await runner.drain();
  assert.ok((await active).error instanceof PipaStoppedError);
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
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["run:one", "deliver:one"]);
  const second = runner.enqueue("A", { prompt: "two", deliver: async () => events.push("deliver:two") });
  releaseDelivery();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["run:one", "deliver:one", "run:two", "deliver:two"]);
});

test("replacement stops remaining delivery work", async () => {
  let releaseDelivery;
  const events = [];
  const runner = createConversationRunner({
    sessionStore: { get: () => null, set: async () => undefined },
    runTurn: async ({ prompt }) => ({ text: prompt, sessionId: "ses_1" }),
  });
  const first = runner.enqueue("A", {
    prompt: "one",
    deliver: async (_, signal) => {
      events.push("first chunk");
      await new Promise((resolve) => releaseDelivery = resolve);
      if (!signal.aborted) events.push("second chunk");
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  const second = runner.enqueue("A", { prompt: "two" });
  releaseDelivery();

  assert.equal((await first).superseded, true);
  await second;
  assert.deepEqual(events, ["first chunk"]);
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
  await waitFor(() => posts.length === 1);
  await handlers.subscribed(thread, { id: "2", text: "<@U2> follow up", author: human, raw: {} });
  await waitFor(() => posts.length === 2);
  const attachment = { name: "notes.txt", size: 100 * 1024 * 1024, fetchData: async () => Buffer.from("notes") };
  await handlers.mention(thread, { id: "file-1", text: "@U1 summarize", attachments: [attachment], author: human, raw: {} });
  await waitFor(() => posts.length === 3);
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
  await waitFor(() => posts.length === 6);
  assert.equal(calls.length, beforeIgnored + 1);
  await handlers.subscribed(thread, { id: "broken", text: "broken attachment", attachments: [attachment], author: human, raw: { subtype: "file_share" } });
  await waitFor(() => posts.length === 7);
  await handlers.subscribed(thread, { id: "3", text: "long", author: human, raw: {} });
  await waitFor(() => posts.length === 10);
  await handlers.subscribed(thread, { id: "4", text: "secret failure", author: human, raw: {} });
  await waitFor(() => posts.length === 11);
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

test("Slack prompts include full and prefix rich-text link URLs", async () => {
  const handlers = {};
  const calls = [];
  const chat = {
    onNewMention(handler) { handlers.mention = handler; },
    onSubscribedMessage() {},
    async initialize() {},
    async shutdown() {},
  };
  const app = await startPipa({
    chat,
    executor: { runTurn: async ({ prompt }) => { calls.push(prompt); return { text: "ok", sessionId: "ses_1" }; }, stopAll() {} },
    checkSlackToken: async () => ({ ok: true }),
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  });
  const thread = {
    id: "slack:C1:1.0",
    adapter: { addReaction: async () => undefined, removeReaction: async () => undefined },
    channel: { isDM: false, channelVisibility: "private" },
    subscribe: async () => undefined,
    post: async () => undefined,
  };
  const url = "https://app.notion.com/p/lunchpaillabs/full-page-id?v=full-view-id";
  const prefixUrl = "https://example.com";

  await handlers.mention(thread, {
    id: "1",
    text: "<@U1> review app.notion.com/p/lunchpaillabs/…?v=… and https://example.com/docs",
    links: [{ url }, { url: prefixUrl }],
    author: { userId: "U1" },
    raw: {},
  });
  await waitFor(() => calls.length === 1);

  assert.equal(calls[0], `review app.notion.com/p/lunchpaillabs/…?v=… and https://example.com/docs\n\nFull links:\n${url}\n${prefixUrl}`);
  await app.shutdown();
});

test("Slack posts short text and artifacts once", async () => {
  const files = [
    { filename: "report.csv", data: Buffer.from("a,b\n1,2\n") },
    { filename: "brief.pdf", data: Buffer.from([0x25, 0x50, 0x44, 0x46]) },
  ];
  const { app, mention, posts, reactions } = await deliveryApp({ text: "Executive summary.", files });
  await mention();
  await waitFor(() => posts.length === 1);
  assert.deepEqual(posts, [{ markdown: "Executive summary.", files }]);
  assert.deepEqual(reactions, ["add:eyes", "remove:eyes", "add:white_check_mark"]);
  await app.shutdown();

  const inline = await deliveryApp({ text: "Short answer.", files: [] });
  await inline.mention();
  await waitFor(() => inline.posts.length === 1);
  assert.deepEqual(inline.posts, [{ markdown: "Short answer." }]);
  await inline.app.shutdown();

  const empty = await deliveryApp({ text: "", files: [] });
  await empty.mention();
  await waitFor(() => empty.reactions.includes("add:white_check_mark"));
  assert.deepEqual(empty.posts, []);
  await empty.app.shutdown();
});

test("failed artifact post retries declaration-free text once without files", async () => {
  const files = [{ filename: "image.png", data: Buffer.from([1, 2, 3]) }];
  const delivery = await deliveryApp({ text: "Summary.", files }, { failFiles: true });
  await delivery.mention();
  await waitFor(() => delivery.posts.length === 2);
  assert.deepEqual(delivery.posts, [
    { markdown: "Summary.", files },
    { markdown: "Summary." },
  ]);
  assert.deepEqual(delivery.reactions, ["add:eyes", "remove:eyes", "add:white_check_mark"]);
  await delivery.app.shutdown();
});

test("interrupted Slack messages keep their eyes until the latest turn succeeds", async () => {
  const handlers = {};
  const reactions = [];
  const posts = [];
  let firstStarted = false;
  let secondStarted = false;
  let finishSecond;
  const app = await startPipa({
    chat: {
      onNewMention(handler) { handlers.mention = handler; },
      onSubscribedMessage(handler) { handlers.subscribed = handler; },
      async initialize() {},
      async shutdown() {},
    },
    executor: {
      async runTurn({ prompt, signal, onSession }) {
        await onSession("ses_1");
        if (prompt === "first") {
          firstStarted = true;
          await new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        }
        secondStarted = true;
        await new Promise((resolve) => finishSecond = resolve);
        return { text: "second complete", sessionId: "ses_1" };
      },
      async abortTurn() {},
      stopAll() {},
    },
    checkSlackToken: async () => ({ ok: true }),
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  });
  const thread = {
    id: "slack:C1:1.0",
    adapter: {
      addReaction: async (_, messageId, emoji) => reactions.push(`add:${messageId}:${emoji}`),
      removeReaction: async (_, messageId, emoji) => reactions.push(`remove:${messageId}:${emoji}`),
    },
    channel: { isDM: false, channelVisibility: "private" },
    subscribe: async () => undefined,
    post: async (payload) => posts.push(payload),
  };
  const author = { userId: "U1" };

  await handlers.mention(thread, { id: "1", text: "@U1 first", author, raw: {} });
  await waitFor(() => firstStarted);
  await handlers.subscribed(thread, { id: "2", text: "second", author, raw: {} });
  await waitFor(() => secondStarted);
  assert.deepEqual(reactions, ["add:1:eyes", "add:2:eyes"]);

  finishSecond();
  await waitFor(() => reactions.length === 6);
  assert.deepEqual(reactions, [
    "add:1:eyes", "add:2:eyes",
    "remove:1:eyes", "add:1:white_check_mark",
    "remove:2:eyes", "add:2:white_check_mark",
  ]);
  assert.deepEqual(posts, [{ markdown: "second complete" }]);
  await app.shutdown();
});

test("inline fallback prefers paragraphs and lines and preserves fenced code across chunks", async () => {
  const paragraph = "ordinary words ".repeat(240).trim();
  const codeLine = `const value = "${"x".repeat(3400)}";`;
  const text = `${paragraph}\n\n\`\`\`js\n${codeLine}\nconsole.log(value);\n\`\`\`\n\n   ~~~js\n${"y".repeat(3490)}\n   ~~~\n\nFinal paragraph.`;
  const delivery = await deliveryApp({ text, files: [] });
  await delivery.mention();
  await waitFor(() => delivery.posts.length > 1);
  const chunks = delivery.posts.map((post) => post.markdown);
  assert.ok(chunks.every((chunk) => chunk.length <= 3500));
  assert.equal(chunks.join(" ").split("```js")[0].replace(/\s+/gu, " ").trim(), paragraph);
  for (const chunk of chunks) assert.equal((chunk.match(/^ {0,3}(?:```|~~~)/gmu) ?? []).length % 2, 0, `unbalanced fence: ${chunk}`);
  assert.match(chunks.join("\n"), /Final paragraph\./u);
  await delivery.app.shutdown();
});

async function deliveryApp(result, { failFiles = false } = {}) {
  const handlers = {};
  const posts = [];
  const reactions = [];
  const chat = {
    onNewMention(handler) { handlers.mention = handler; },
    onSubscribedMessage() {},
    async initialize() {},
    async shutdown() {},
  };
  const app = await startPipa({
    chat,
    executor: { runTurn: async () => ({ ...result, sessionId: "ses_1" }), stopAll() {} },
    checkSlackToken: async () => ({ ok: true }),
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work" },
  });
  const thread = {
    id: "slack:C1:1.0",
    adapter: {
      addReaction: async (_, __, emoji) => reactions.push(`add:${emoji}`),
      removeReaction: async (_, __, emoji) => reactions.push(`remove:${emoji}`),
    },
    channel: { isDM: false, channelVisibility: "private" },
    subscribe: async () => undefined,
    post: async (payload) => {
      posts.push(payload);
      if (failFiles && payload.files) throw new Error("adapter rejected files");
    },
  };
  return {
    app,
    posts,
    reactions,
    mention: () => handlers.mention(thread, { id: "1", text: "@Pipa work", author: { userId: "U1" }, raw: {} }),
  };
}

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

test("routine scheduler uses an exact destination and binds replies to its fresh session", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routine-app-"));
  const paths = pipaPaths(home);
  let now = "2026-08-29T12:00:00.000Z";
  const config = {
    botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: home,
    allowedSlackChannelIds: ["C123"], allowedSlackUserIds: ["U1"],
  };
  await writePrivateJson(paths.config, config);
  const routine = normalizeRoutine({
    id: "scheduled",
    prompt: "  exact $(prompt)\n",
    schedule: { type: "once", at: "2026-08-29T13:00:00Z" },
    timezone: "UTC",
    destination: { channelId: "C123", threadTs: null },
  }, now);
  await writePrivateJson(paths.routines, { version: 1, routines: [routine] });
  let intervalTick;
  let scheduler;
  let schedulerError;
  const handlers = {};
  const sessions = new Map();
  const subscriptions = [];
  const posts = [];
  const calls = [];
  const chat = {
    onNewMention() {},
    onSubscribedMessage(handler) { handlers.subscribed = handler; },
    thread(id) {
      return {
        id,
        channel: { isDM: false, channelVisibility: "private" },
        adapter: { addReaction: async () => undefined, removeReaction: async () => undefined },
        subscribe: async () => subscriptions.push(id),
        post: async (payload) => {
          posts.push({ id, payload });
          return { id: id === "slack:C123:" ? "456.789" : "reply" };
        },
      };
    },
    async initialize() {},
    async shutdown() {},
  };
  const app = await startPipa({
    paths,
    config,
    routinesEnabled: true,
    routineNow: () => now,
    setRoutineInterval(callback) { intervalTick = callback; return { unref() {} }; },
    clearRoutineInterval() {},
    createRoutineScheduler: (options) => {
      scheduler = createRoutineScheduler({ ...options, onError: (error) => { schedulerError = error; } });
      return scheduler;
    },
    chat,
    executor: {
      async runTurn(input) {
        calls.push(input);
        input.onSession("ses_routine");
        return { text: calls.length === 1 ? "finished" : "continued", sessionId: "ses_routine" };
      },
      async abortTurn() {},
      stopAll() {},
    },
    checkSlackToken: async () => ({ ok: true }),
    sessionStore: {
      keys: () => [...sessions.keys()],
      get: (key) => sessions.get(key) ?? null,
      async set(key, value) { sessions.set(key, value); },
    },
  });
  const replacementWorkspace = await mkdtemp(path.join(os.tmpdir(), "pipa-routine-reconfigured-"));
  await writePrivateJson(paths.config, { ...config, workingDirectory: replacementWorkspace });
  now = "2026-08-29T13:00:00.000Z";
  intervalTick();
  await scheduler.drain();
  assert.ifError(schedulerError);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].prompt, routine.prompt);
  assert.equal(calls[0].sessionId, null);
  assert.equal(calls[0].workingDirectory, home);
  assert.equal(calls[0].contextEnvironment.PIPA_CURRENT_SLACK_CHANNEL_ID, "C123");
  assert.equal(calls[0].contextEnvironment.PIPA_CURRENT_SLACK_THREAD_TS, "");
  const conversationKey = "slack:C123:456.789";
  assert.equal(sessions.get(conversationKey), "ses_routine");
  assert.deepEqual(subscriptions, [conversationKey]);
  assert.ok((await readFile(paths.routines, "utf8")).includes('"completed"'));

  const replyThread = chat.thread(conversationKey);
  await handlers.subscribed(replyThread, {
    id: "456.790", text: "How many items?", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {},
  });
  await waitFor(() => calls.length === 2);
  assert.equal(calls[1].prompt, "How many items?");
  assert.equal(calls[1].sessionId, "ses_routine");
  assert.deepEqual(posts, [
    { id: "slack:C123:", payload: { markdown: "finished" } },
    { id: conversationKey, payload: { markdown: "continued" } },
  ]);
  await app.shutdown();
});

test("routine scheduler distinguishes unavailable config from a disallowed destination", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routine-app-"));
  const paths = pipaPaths(home);
  let now = "2026-08-29T12:00:00.000Z";
  const config = {
    botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: home,
    allowedSlackChannelIds: ["C123"], allowedSlackUserIds: [],
  };
  await writePrivateJson(paths.config, config);
  const routine = normalizeRoutine({
    id: "denied",
    prompt: "do work",
    schedule: { type: "recurring", frequency: "hours", interval: 1, times: [], weekdays: [], until: null },
    timezone: "UTC",
    destination: { channelId: "C123", threadTs: null },
  }, now);
  await writePrivateJson(paths.routines, { version: 1, routines: [routine] });
  let intervalTick;
  let scheduler;
  let calls = 0;
  const app = await startPipa({
    paths,
    config,
    routinesEnabled: true,
    routineNow: () => now,
    setRoutineInterval(callback) { intervalTick = callback; return { unref() {} }; },
    clearRoutineInterval() {},
    createRoutineScheduler: (options) => {
      scheduler = createRoutineScheduler(options);
      return scheduler;
    },
    chat: { onNewMention() {}, onSubscribedMessage() {}, thread() { throw new Error("must not deliver"); }, async initialize() {}, async shutdown() {} },
    executor: { async runTurn() { calls += 1; }, async abortTurn() {}, stopAll() {} },
    checkSlackToken: async () => ({ ok: true }),
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
  });
  await writeFile(paths.config, "{");
  now = "2026-08-29T13:00:00.000Z";
  intervalTick();
  await scheduler.drain();
  const failed = JSON.parse(await readFile(paths.routines, "utf8")).routines[0];
  assert.equal(failed.status, "active");
  assert.equal(failed.lastRun.status, "failed");
  assert.equal(failed.lastRun.errorCode, "executor_failed");

  await writePrivateJson(paths.config, { ...config, allowedSlackChannelIds: ["C999"] });
  now = "2026-08-29T14:00:00.000Z";
  intervalTick();
  await scheduler.drain();
  const denied = JSON.parse(await readFile(paths.routines, "utf8")).routines[0];
  assert.equal(calls, 0);
  assert.equal(denied.lastRun.status, "denied");
  assert.equal(denied.lastRun.errorCode, "destination_denied");
  await app.shutdown();
});

test("routine deactivation after execution suppresses final delivery", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pipa-routine-app-"));
  const paths = pipaPaths(home);
  let now = "2026-08-29T12:00:00.000Z";
  const config = {
    botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: home,
    allowedSlackChannelIds: ["C123"], allowedSlackUserIds: [],
  };
  await writePrivateJson(paths.config, config);
  const routine = normalizeRoutine({
    id: "cancelled",
    prompt: "do work",
    schedule: { type: "once", at: "2026-08-29T13:00:00Z" },
    timezone: "UTC",
    destination: { channelId: "C123", threadTs: null },
  }, now);
  await writePrivateJson(paths.routines, { version: 1, routines: [routine] });
  let intervalTick;
  let finish;
  let started = false;
  const posts = [];
  const app = await startPipa({
    paths,
    config,
    routinesEnabled: true,
    routineNow: () => now,
    setRoutineInterval(callback) { intervalTick = callback; return { unref() {} }; },
    clearRoutineInterval() {},
    chat: {
      onNewMention() {}, onSubscribedMessage() {},
      thread(id) { return { id, post: async (payload) => posts.push(payload) }; },
      async initialize() {}, async shutdown() {},
    },
    executor: {
      async runTurn() {
        started = true;
        await new Promise((resolve) => finish = resolve);
        return { text: "must not post", sessionId: "ses_cancelled" };
      },
      async abortTurn() {},
      stopAll() {},
    },
    checkSlackToken: async () => ({ ok: true }),
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
  });
  now = "2026-08-29T13:00:00.000Z";
  intervalTick();
  await waitFor(() => started);
  const state = JSON.parse(await readFile(paths.routines, "utf8"));
  state.routines[0].status = "inactive";
  state.routines[0].nextRunAt = null;
  await writePrivateJson(paths.routines, state);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(posts, []);
  assert.equal(JSON.parse(await readFile(paths.routines, "utf8")).routines[0].lastRun, null);
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

test("interaction registry restricts custom answers to allowed users", async () => {
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
  }, { allowedSlackUserIds: ["U1"] }).then(() => mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} }));

  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(posted[0].blocks.some((block) => block.elements?.some((element) => ["radio_buttons", "checkboxes"].includes(element.type))), false);
  const custom = posted[0].blocks.at(-1).elements.find((element) => element.action_id.startsWith("pipa_custom_"));
  await actionHandler({ actionId: custom.action_id, value: custom.value, user: { userId: "U1" }, thread, openModal: async () => undefined });
  await customAnswerHandler({ privateMetadata: custom.value, values: { answer: "Wrong" }, user: { userId: "U2", fullName: "other" }, relatedThread: thread });
  assert.equal(decision, undefined);
  await customAnswerHandler({ privateMetadata: custom.value, values: { answer: "Orbit" }, user: { userId: "U1", fullName: "lola" }, relatedThread: thread });
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

test("another user can answer an active question when the allowlist is empty", async () => {
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

test("only allowed users can answer an active question", async () => {
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
  void startInteractionPipa(chat, {
    runTurn: async ({ onInteraction }) => {
      resolvedDecision = await onInteraction({
        type: "question",
        request: { questions: [{ header: "Q", question: "Pick", options: [{ label: "X" }] }] },
        signal: AbortSignal.timeout(5000),
      });
      return { text: "done", sessionId: "ses_1" };
    },
    stopAll() {},
  }, { allowedSlackUserIds: ["U1"] }).then(() => mention(thread, { text: "@Pipa go", author: { id: "U1", userId: "U1", isMe: false, isBot: false }, raw: {} }));

  await waitFor(() => posts.length === 1);
  const radio = posts[0].blocks.find((block) => block.type === "actions").elements[0];
  const submit = slackAction(posts[0], "pipa_submit_");
  await actionHandler({ actionId: radio.action_id, value: radio.options[0].value, user: { userId: "U2" }, thread });
  await actionHandler({ actionId: submit.action_id, value: submit.value, user: { userId: "U2" }, thread });
  assert.equal(resolvedDecision, null);

  await actionHandler({ actionId: radio.action_id, value: radio.options[0].value, user: { userId: "U1" }, thread });
  await actionHandler({ actionId: submit.action_id, value: submit.value, user: { userId: "U1" }, thread });
  await waitFor(() => resolvedDecision);
  assert.deepEqual(resolvedDecision, { type: "answer", answers: [["X"]] });
});

test("routine interactions and results target an exact channel or existing thread", async () => {
  for (const destination of [
    { channelId: "C1" },
    { channelId: "C1", threadTs: "123.456" },
  ]) {
    const posted = [];
    const results = [];
    const target = slackInteractionThread({ id: slackDestinationId(destination), posted });
    target.post = async (payload) => results.push({ id: target.id, payload });
    const interactions = createPendingInteractions();

    const question = interactions.onInteraction({ thread: target }, {
      type: "question",
      sessionId: "ses_question",
      request: { id: "req_1", questions: [{ header: "Q", question: "Pick", options: [{ label: "X" }] }] },
      signal: AbortSignal.timeout(5000),
    });
    await waitFor(() => posted.length === 1);
    const actionThreadId = destination.threadTs ? target.id : `${target.id}1.0`;
    const radio = posted[0].blocks.find((block) => block.type === "actions").elements[0];
    await interactions.onAction({ actionId: radio.action_id, value: radio.options[0].value, user: { userId: "U1" }, threadId: actionThreadId });
    const submit = slackAction(posted[0], "pipa_submit_");
    await interactions.onAction({ actionId: submit.action_id, value: submit.value, user: { userId: "U1" }, threadId: actionThreadId });
    assert.deepEqual(await question, { type: "answer", answers: [["X"]] });

    const permission = interactions.onInteraction({ thread: target }, {
      type: "permission",
      sessionId: "ses_permission",
      request: { id: "perm_1", permission: "read", patterns: ["file.txt"] },
      signal: AbortSignal.timeout(5000),
    });
    await waitFor(() => posted.length === 2);
    const permissionThreadId = destination.threadTs ? target.id : `${target.id}2.0`;
    const allow = slackAction(posted[1], "pipa_permission_once_");
    await interactions.onAction({ actionId: allow.action_id, value: allow.value, user: { userId: "U1" }, threadId: permissionThreadId });
    assert.deepEqual(await permission, { type: "reply", reply: "once" });

    await postResult(target, { text: "complete" });
    assert.deepEqual(posted.map(({ channel, thread_ts }) => ({ channel, thread_ts })), [
      { channel: "C1", thread_ts: destination.threadTs },
      { channel: "C1", thread_ts: destination.threadTs },
    ]);
    assert.deepEqual(results, [{ id: slackDestinationId(destination), payload: { markdown: "complete" } }]);
  }
});

test("routine interaction callbacks reload responder authorization", async () => {
  const posted = [];
  const target = slackInteractionThread({ id: "slack:C1:", posted });
  let allowedUserIds = ["U1"];
  const interactions = createPendingInteractions();
  const loadAllowedUserIds = async () => allowedUserIds;

  let permissionDecision;
  const permission = interactions.onInteraction({ thread: target, loadAllowedUserIds }, {
    type: "permission",
    sessionId: "ses_permission",
    request: { id: "perm_1", permission: "read", patterns: ["file.txt"] },
    signal: AbortSignal.timeout(5000),
  }).then((value) => permissionDecision = value);
  await waitFor(() => posted.length === 1);
  const allow = slackAction(posted[0], "pipa_permission_once_");
  allowedUserIds = ["U2"];
  await interactions.onAction({ actionId: allow.action_id, value: allow.value, user: { userId: "U1" }, threadId: "slack:C1:1.0" });
  assert.equal(permissionDecision, undefined);
  await interactions.onAction({ actionId: allow.action_id, value: allow.value, user: { userId: "U2" }, threadId: "slack:C1:1.0" });
  await permission;

  let answerDecision;
  const answer = interactions.onInteraction({ thread: target, loadAllowedUserIds }, {
    type: "question",
    sessionId: "ses_question",
    request: { id: "req_1", header: "Name", question: "Name?", custom: true },
    signal: AbortSignal.timeout(5000),
  }).then((value) => answerDecision = value);
  await waitFor(() => posted.length === 2);
  const custom = slackAction(posted[1], "pipa_custom_");
  allowedUserIds = ["U1"];
  const relatedThread = { id: "slack:C1:2.0" };
  await interactions.onCustomAnswer({ privateMetadata: custom.value, values: { answer: "Wrong" }, user: { userId: "U2" }, relatedThread });
  assert.equal(answerDecision, undefined);
  await interactions.onCustomAnswer({ privateMetadata: custom.value, values: { answer: "Orbit" }, user: { userId: "U1" }, relatedThread });
  await answer;
  assert.deepEqual(answerDecision, { type: "answer", answers: [["Orbit"]] });
});

test("routine interactions reauthorize before posting and accepting responses", async () => {
  const posted = [];
  const deleted = [];
  const target = slackInteractionThread({ posted, deleted });
  const interactions = createPendingInteractions();
  const request = {
    type: "permission",
    sessionId: "ses_permission",
    request: { id: "perm_1", permission: "read", patterns: ["file.txt"] },
    signal: AbortSignal.timeout(5000),
  };
  await assert.rejects(interactions.onInteraction({ thread: target, authorize: async () => { throw new Error("denied"); } }, request), /denied/u);
  assert.deepEqual(posted, []);

  let authorized = true;
  let decision;
  const pending = interactions.onInteraction({
    thread: target,
    authorize: async () => { if (!authorized) throw new Error("denied"); },
  }, request).then((value) => decision = value);
  await waitFor(() => posted.length === 1);
  authorized = false;
  const allow = slackAction(posted[0], "pipa_permission_once_");
  await interactions.onAction({ actionId: allow.action_id, value: allow.value, user: { userId: "U1" }, thread: { id: "slack:C999:9.0" } });
  assert.equal(decision, undefined);
  await interactions.onAction({ actionId: allow.action_id, value: allow.value, user: { userId: "U1" }, thread: target });
  assert.equal(decision, undefined);
  await interactions.close();
  await pending;
  assert.equal(deleted.length, 1);
});

test("aborting an interaction removes its Slack card", async () => {
  const posted = [];
  const deleted = [];
  const target = slackInteractionThread({ posted, deleted });
  const interactions = createPendingInteractions();
  const controller = new AbortController();
  const pending = interactions.onInteraction({ thread: target }, {
    type: "question",
    sessionId: "ses_question",
    request: { id: "req_1", header: "Name", question: "Name?", custom: true },
    signal: controller.signal,
  });
  await waitFor(() => posted.length === 1);
  controller.abort(new Error("stopped"));
  await assert.rejects(pending, /stopped/u);
  assert.equal(deleted.length, 1);
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

function startInteractionPipa(chat, executor, config = {}) {
  return startPipa({
    chat,
    executor,
    checkSlackToken: async () => ({ ok: true }),
    config: { botName: "Pipa", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", workingDirectory: "/work", ...config },
    sessionStore: { keys: () => [], get: () => null, set: async () => undefined },
  });
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for test condition.");
}
