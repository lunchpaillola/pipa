import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { Chat } from "chat";
import { createMemoryState } from "@chat-adapter/state-memory";
import { createPipaSlackAdapter, startPipa } from "../src/app.mjs";
import { createModelPicker } from "../src/models.mjs";
import { createModelSetting, createSessionStore, loadConfig, pipaPaths, writePrivateJson } from "../src/state.mjs";

test("model search acknowledgments stay within the live-tested 12 KiB payload budget", async (t) => {
  const adapter = createPipaSlackAdapter({ signingSecret: "test", botToken: "xoxb-test", botUserId: "UPIPA", userName: "Piper" });
  const chat = new Chat({ adapters: { slack: adapter }, state: createMemoryState(), userName: "Piper", logger: "silent" });
  let view;
  adapter.webClient.views.open = async () => ({ view: { id: "V1" } });
  adapter.webClient.views.update = async (input) => { view = input.view; };
  const models = Array.from({ length: 150 }, (_, id) => ({ providerID: "provider-" + "漢".repeat(60), modelID: `model-${id}`, name: '漢"\\'.repeat(25) }));
  const picker = createModelPicker({ chat, botName: "Piper", commands: ["/piper"], loadConfig: async () => ({}),
    listModels: async () => models, setting: {} });
  await chat.initialize();
  t.after(async () => { picker.close(); await chat.shutdown(); });
  const waiting = [];
  await adapter.handleSlashCommand(new URLSearchParams({ command: "/piper", text: "model", user_id: "U1", channel_id: "C1", trigger_id: "trigger" }), { waitUntil: (p) => waiting.push(p) });
  await Promise.all(waiting);
  const responses = [];
  const sizes = [];
  const payloadSizes = [];
  const actionId = view.blocks[0].element.action_id;
  for (const query of ["", "model-149"]) {
    await adapter.routeSocketEvent({ type: "block_suggestion", action_id: actionId, value: query, user: { id: "U1" }, view: { id: "V1" } }, "interactive", async (payload) => {
      const frame = JSON.stringify({ envelope_id: "00000000-0000-0000-0000-000000000000", payload });
      sizes.push(Buffer.byteLength(frame));
      payloadSizes.push(Buffer.byteLength(JSON.stringify(payload)));
      responses.push(payload.options);
    });
  }
  assert.ok(payloadSizes.every((bytes) => bytes <= 12 * 1024), `larger search replies stall Slack delivery and break Save: ${payloadSizes}`);
  assert.ok(sizes.every((bytes) => bytes <= 13 * 1024), `search envelopes exceed the reserved 1 KiB: ${sizes}`);
  assert.ok(responses[0].length > 0 && responses[0].length < 100);
  assert.equal(responses[1].length, 1, "models omitted by the byte limit remain searchable");
});

for (const revoked of [false, true]) test(`native Save acknowledges before config I/O; ${revoked ? "revoked access prevents discovery and writes" : "authorized save persists afterward"}`, async (t) => {
  const adapter = createPipaSlackAdapter({ signingSecret: "test", botToken: "xoxb-test", botUserId: "UPIPA", userName: "Chopper" });
  const chat = new Chat({ adapters: { slack: adapter }, state: createMemoryState(), userName: "Chopper", logger: "silent" });
  const gate = Promise.withResolvers();
  const reading = Promise.withResolvers();
  let submitting = false;
  let discoveries = 0;
  let writes = 0;
  let view;
  const notices = [];
  adapter._client.users.info = async () => ({ user: { id: "U1", name: "User" } });
  adapter.webClient.views.open = async () => ({ view: { id: "V1" } });
  adapter.webClient.views.update = async (input) => { view = input.view; };
  adapter.postEphemeral = async (...args) => notices.push(args);
  const config = { allowedSlackUserIds: ["U1"], allowedSlackChannelIds: ["C1"] };
  const picker = createModelPicker({ chat, botName: "Chopper", commands: ["/chopper"],
    loadConfig: async () => { if (submitting) { reading.resolve(); await gate.promise; } return config; },
    listModels: async () => { discoveries++; return [{ providerID: "openai", modelID: "a" }]; },
    setting: { save: async (_model, authorize) => { authorize(config); writes++; } } });
  await chat.initialize();
  t.after(async () => { gate.resolve(); picker.close(); await picker.drain(); await chat.shutdown(); });
  const waiting = [];
  await adapter.handleSlashCommand(new URLSearchParams({ command: "/chopper", text: "model", user_id: "U1", channel_id: "C1", trigger_id: "trigger" }), { waitUntil: (p) => waiting.push(p) });
  await Promise.all(waiting);
  const input = view.blocks[0].element;
  const choices = (await (await adapter.handleBlockSuggestion({ action_id: input.action_id, value: "", user: { id: "U1" }, view: { id: "V1" } })).json()).options;
  const payload = { type: "view_submission", user: { id: "U1" }, view: { ...view, id: "V1",
    state: { values: { [input.action_id]: { [input.action_id]: { selected_option: choices[0] } } } } } };
  submitting = true;
  const acknowledgments = [];
  const routing = adapter.routeSocketEvent(payload, "interactive", async (response) => acknowledgments.push(response));
  try {
    await reading.promise;
    assert.equal(await Promise.race([routing.then(() => true), delay(100).then(() => false)]), true, "Slack acknowledgment must not wait for the config read");
    assert.deepEqual(acknowledgments, [{}]);
    await adapter.routeSocketEvent(payload, "interactive", async (response) => acknowledgments.push(response));
    assert.equal(discoveries, 1, "no save-time discovery before fresh authorization");
    assert.equal(writes, 0);
    assert.equal(notices.length, 0);
    if (revoked) config.allowedSlackUserIds = ["U2"];
  } finally {
    gate.resolve();
    await routing;
    await picker.drain();
  }
  assert.equal(discoveries, 1);
  assert.equal(writes, revoked ? 0 : 1);
  assert.equal(notices.length, revoked ? 0 : 1);
});

for (const command of ["/chopper", "/pipa"]) test(`${command} opens without waiting for cold SDK profile enrichment`, async (t) => {
  const adapter = createPipaSlackAdapter({ signingSecret: "test", botToken: "xoxb-test", botUserId: "UPIPA", userName: "Chopper" });
  const chat = new Chat({ adapters: { slack: adapter }, state: createMemoryState(), userName: "Chopper", logger: "silent" });
  const gate = Promise.withResolvers();
  const opened = Promise.withResolvers();
  let lookups = 0;
  const requests = [];
  adapter._client.users.info = async () => { lookups++; await gate.promise; return { user: { id: "U1", name: "User" } }; };
  adapter.webClient.views.open = async (input) => { requests.push(input); opened.resolve(); return { view: { id: "V1" } }; };
  adapter.webClient.views.update = async () => undefined;
  const picker = createModelPicker({ chat, botName: "Chopper", commands: ["/chopper", "/pipa"], loadConfig: async () => ({ allowedSlackUserIds: ["U1"], allowedSlackChannelIds: ["C1"] }),
    listModels: async () => [{ providerID: "openai", modelID: "a" }], setting: {} });
  await chat.initialize();
  t.after(async () => { gate.resolve(); picker.close(); await chat.shutdown(); });
  const waiting = [];
  const context = { waitUntil: (p) => waiting.push(p) };
  const params = new URLSearchParams({ command, text: "model", user_id: "U1", channel_id: "C1", trigger_id: "trigger" });
  const opening = adapter.handleSlashCommand(params, context);
  try {
    assert.equal(await Promise.race([opened.promise.then(() => true), delay(100).then(() => false)]), true, "modal trigger must be exchanged without waiting for users.info");
    await opening;
    await Promise.all(waiting);
    assert.equal(lookups, 0);
    assert.equal(requests[0].trigger_id, "trigger");
  } finally {
    gate.resolve();
    await opening;
    await Promise.all(waiting);
  }
  let unrelated = false;
  chat.onSlashCommand("/other", async () => { unrelated = true; });
  await adapter.handleSlashCommand(new URLSearchParams({ ...Object.fromEntries(params), command: "/other" }), context);
  await Promise.all(waiting);
  assert.equal(lookups, 1, "other commands keep the SDK's profile lookup");
  assert.equal(unrelated, true);
  assert.equal(requests.length, 1);
});

for (const shutdown of [false, true]) test(`Save acknowledges before slow work; ${shutdown ? "shutdown prevents stale writes and delivery" : "confirmation follows persistence"}`, async () => {
  const handlers = {};
  const gate = Promise.withResolvers();
  const writeGate = Promise.withResolvers();
  const writeStarted = Promise.withResolvers();
  let view;
  let loadingSave = false;
  let writes = 0;
  const notices = [];
  const adapter = { webClient: { views: {
    open: async () => ({ view: { id: "V1" } }),
    update: async (input) => { view = input.view; },
  } }, postEphemeral: async (...args) => notices.push(args) };
  const picker = createModelPicker({ botName: "Chopper", commands: ["/chopper"], loadConfig: async () => { if (loadingSave) await gate.promise; return {}; },
    chat: { onSlashCommand: (_id, fn) => { handlers.open = fn; }, onModalSubmit: (_id, fn) => { handlers.save = fn; }, onOptionsLoad: (fn) => { handlers.options = fn; } },
    listModels: async () => [{ providerID: "openai", modelID: "a", name: "Model A" }],
    setting: { save: async (_model, authorize) => { authorize({}); writes++; writeStarted.resolve(); await writeGate.promise; } } });
  await handlers.open({ text: "model", user: { userId: "U1" }, triggerId: "trigger", adapter,
    channel: { id: "slack:C1", postEphemeral: async () => undefined } });
  const input = view.blocks[0].element;
  const choices = await handlers.options({ actionId: input.action_id, user: { userId: "U1" }, raw: { view: { id: "V1" } }, query: "" });
  loadingSave = true;
  const submission = { user: { userId: "U1" }, viewId: "V1", adapter,
    privateMetadata: JSON.parse(view.private_metadata).m, values: { [input.action_id]: choices[0].value } };
  const saving = handlers.save(submission);
  try {
    assert.deepEqual(await Promise.race([saving, delay(100).then(() => null)]), { action: "close" });
    assert.equal(writes, 0);
    assert.equal(notices.length, 0);
    assert.deepEqual(await handlers.save(submission), { action: "close" }, "duplicate Save does not enqueue another write");
  } finally {
    if (shutdown) picker.close();
    gate.resolve();
    await saving;
    if (!shutdown) {
      await writeStarted.promise;
      assert.equal(notices.length, 0, "no confirmation while persistence is still pending");
    }
    writeGate.resolve();
    await picker.drain?.();
    picker.close();
  }
  assert.equal(writes, shutdown ? 0 : 1);
  assert.equal(notices.length, shutdown ? 0 : 1);
  if (!shutdown) assert.equal(notices[0][2], "New threads will use Model A.");
});

for (const outcome of ["populate", "cancel", "shutdown"]) test(`opens before slow discovery: ${outcome}`, async () => {
  const handlers = {};
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let loading;
  let discoverySignal;
  const updates = [];
  const picker = createModelPicker({ botName: "Chopper", commands: ["/chopper"], loadConfig: async () => ({}), setting: {},
    chat: { onSlashCommand: (_id, fn) => { handlers.open = fn; }, onModalClose: (_id, fn) => { handlers.close = fn; } },
    listModels: async (signal) => { discoverySignal = signal; started.resolve(Boolean(loading)); await gate.promise; signal?.throwIfAborted(); return [{ providerID: "openai", modelID: "a" }]; } });
  const opening = handlers.open({ text: "model", user: { userId: "U1" }, channel: { id: "slack:C1", postEphemeral: async () => undefined },
    adapter: { webClient: { views: {
      open: async ({ view }) => { loading = view; return { view: { id: "V1" } }; },
      update: async ({ view }) => updates.push(view),
    } } } });
  try {
    assert.equal(await started.promise, true, "catalog discovery starts only after the trigger has opened a window");
    assert.equal(loading.submit, undefined);
    if (outcome === "cancel") {
      handlers.close({ user: { userId: "U2" }, privateMetadata: JSON.parse(loading.private_metadata).m });
      assert.equal(discoverySignal?.aborted, false, "another user cannot cancel discovery");
      handlers.close({ user: { userId: "U1" }, privateMetadata: JSON.parse(loading.private_metadata).m });
    }
    if (outcome === "shutdown") picker.close();
    assert.equal(discoverySignal?.aborted, outcome !== "populate", "closed pickers abort discovery, not just the later UI update");
  } finally {
    gate.resolve();
    await opening;
    picker.close();
  }
  assert.equal(updates.length, outcome === "populate" ? 1 : 0);
  if (outcome === "populate") assert.equal(updates[0].blocks[0].element.type, "external_select");
});

test("Cancel during the post-discovery config read suppresses the populated view update", async () => {
  const handlers = {};
  const started = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let reads = 0;
  let loading;
  let updates = 0;
  const picker = createModelPicker({ botName: "Chopper", commands: ["/chopper"], setting: {},
    chat: { onSlashCommand: (_id, fn) => { handlers.open = fn; }, onModalClose: (_id, fn) => { handlers.close = fn; } },
    loadConfig: async () => { if (++reads === 2) { started.resolve(); await gate.promise; } return {}; },
    listModels: async () => [{ providerID: "openai", modelID: "a" }] });
  const opening = handlers.open({ text: "model", user: { userId: "U1" }, channel: { id: "slack:C1", postEphemeral: async () => undefined },
    adapter: { webClient: { views: {
      open: async ({ view }) => { loading = view; return { view: { id: "V1" } }; },
      update: async () => { updates++; },
    } } } });
  await started.promise;
  handlers.close({ user: { userId: "U1" }, privateMetadata: JSON.parse(loading.private_metadata).m });
  gate.resolve();
  await opening;
  picker.close();
  assert.equal(updates, 0);
});

for (const [botName, command] of [["Chopper", "/chopper"], ["Chopper", "/pipa"], ["Pipwick", "/pipwick"], ["Pipwick", "/pipa"], ["Pipa", "/pipa"]]) test(`native Slack adapter routes ${command} to ${botName} with options, Save, Cancel and same-session requests`, async (t) => {
  const paths = pipaPaths(await mkdtemp(path.join(os.tmpdir(), "pipa-native-model-")));
  const config = { botName, workingDirectory: "/work", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", allowedSlackUserIds: ["U1"], allowedSlackChannelIds: ["C1"] };
  await writePrivateJson(paths.config, config);
  const adapter = createPipaSlackAdapter({ signingSecret: "test", botToken: "xoxb-test", botUserId: "UPIPA", userName: botName });
  adapter._client.users.info = async () => ({ user: { id: "U1", name: "User" } });
  const views = [];
  const notices = [];
  adapter.postEphemeral = async (...args) => { notices.push(args); return { id: "private" }; };
  adapter.webClient.views.open = async ({ trigger_id, view }) => {
    assert.equal(trigger_id, "trigger");
    assert.equal(view.submit, undefined, "loading window cannot be submitted");
    assert.match(view.blocks[0].text.text, /Loading/u);
    views.push(view);
    return { ok: true, view: { id: `V${views.length}` } };
  };
  adapter.webClient.views.update = async ({ view_id, view }) => { views[Number(view_id.slice(1)) - 1] = view; return { ok: true, view: { id: view_id } }; };
  const posts = [];
  adapter.postMessage = async (threadId, text) => { posts.push(text); return { id: "reply", threadId, raw: {} }; };
  adapter.addReaction = adapter.removeReaction = adapter.startTyping = async () => undefined;
  const chat = new Chat({ adapters: { slack: adapter }, state: createMemoryState(), concurrency: "concurrent", userName: "Pipa", logger: "silent" });
  const models = [{ providerID: "openai", modelID: "a", name: "A" }, { providerID: "fireworks-ai", modelID: "b", name: "B" }];
  const calls = [];
  let discoveries = 0;
  const app = await startPipa({ paths, chat, routinesEnabled: false, checkSlackToken: async () => ({ ok: true }),
    executor: { listModels: async ({ workingDirectory, signal }) => {
      assert.equal(workingDirectory, config.workingDirectory);
      assert.ok(signal instanceof AbortSignal);
      discoveries++;
      return { models: models.map((model) => ({ providerID: model.providerID, id: model.modelID, name: model.name })) };
    }, runTurn: async (input) => { calls.push(input); return { text: "done", sessionId: "ses_same" }; }, stopAll() {} },
    sessionStore: await createSessionStore(paths.sessions) });
  t.after(() => app.shutdown());
  const open = async () => {
    const waiting = [];
    await adapter.handleSlashCommand(new URLSearchParams({ command, text: "model", user_id: "U1", channel_id: "C1", trigger_id: "trigger" }), { waitUntil: (p) => waiting.push(p) });
    await Promise.all(waiting);
    assert.ok(views.length, JSON.stringify(notices));
    return views.at(-1);
  };
  const ignored = [];
  await adapter.handleSlashCommand(new URLSearchParams({ command: "/another-installation", text: "model", user_id: "U1", channel_id: "C1", trigger_id: "trigger" }), { waitUntil: (p) => ignored.push(p) });
  await Promise.all(ignored);
  assert.equal(views.length, 0, "unrelated command names do not open this installation");
  const denied = [];
  await adapter.handleSlashCommand(new URLSearchParams({ command, text: "model", user_id: "U2", channel_id: "C1", trigger_id: "trigger" }), { waitUntil: (p) => denied.push(p) });
  await Promise.all(denied);
  assert.equal(views.length, 0, "both command forms enforce the user allowlist");
  assert.equal((await loadConfig(paths.config)).defaultModel, undefined);
  for (const [index, expected] of models.entries()) {
    const view = await open();
    assert.equal(view.blocks[0].type, "input");
    assert.ok(view.blocks[0].label.text.includes(botName));
    assert.equal(view.blocks[0].element.type, "external_select");
    const acknowledgments = [];
    const beforeSearch = discoveries;
    await adapter.routeSocketEvent({ type: "block_suggestion", action_id: view.blocks[0].element.action_id, value: "", user: { id: "U1" }, view: { id: `V${views.length}` } }, "interactive", async (response) => acknowledgments.push(response));
    const choices = acknowledgments[0].options;
    assert.equal(discoveries, beforeSearch, "Socket search acknowledgments do not wait for OpenCode");
    assert.equal(choices.length, models.length, "cached choices are returned by the search callback");
    const actionId = view.blocks[0].element.action_id;
    const noticeCount = notices.length;
    const saved = await adapter.handleViewSubmission({ user: { id: "U1" }, view: { ...view, id: `V${views.length}`, state: { values: { [actionId]: { [actionId]: { selected_option: choices[index] } } } } } });
    assert.deepEqual(await saved.json(), {}, "Save acknowledges by closing without waiting for persistence");
    for (let tries = 0; notices.length === noticeCount && tries < 100; tries++) await delay(10);
    assert.equal(notices.at(-1)[2], `New threads will use ${expected.name}.`);
    assert.deepEqual((await loadConfig(paths.config)).defaultModel, { providerID: expected.providerID, modelID: expected.modelID });
    const waiting = [];
    const message = adapter.parseMessage({ type: "message", channel: "C1", ts: `${index + 1}.0`, ...(index ? { thread_ts: "1.0" } : {}), text: index ? "follow up" : "<@UPIPA> begin", user: "U1" });
    chat.processMessage(adapter, message.threadId, message, { waitUntil: (p) => waiting.push(p) });
    await Promise.all(waiting);
    for (let tries = 0; posts.length <= index && tries < 100; tries++) await delay(10);
    assert.deepEqual(calls[index].defaultModel, { providerID: expected.providerID, modelID: expected.modelID });
    assert.equal(Object.hasOwn(calls[index], "model"), false, "the default must not force a model onto existing sessions");
  }
  assert.equal(calls[1].sessionId, "ses_same");
  assert.equal(posts.length, 2);
  const reopened = await open();
  assert.equal(reopened.blocks[0].element.initial_option.text.text, "B");
  const before = await readFile(paths.config, "utf8");
  const waiting = [];
  adapter.handleViewClosed({ user: { id: "U1" }, view: { ...reopened, id: `V${views.length}` } }, { waitUntil: (p) => waiting.push(p) });
  await Promise.all(waiting);
  const cancelledInput = reopened.blocks[0].element;
  const cancelledSave = await adapter.handleViewSubmission({ user: { id: "U1" }, view: { ...reopened, id: `V${views.length}`,
    state: { values: { [cancelledInput.action_id]: { [cancelledInput.action_id]: { selected_option: cancelledInput.initial_option } } } } } });
  assert.equal((await cancelledSave.json()).response_action, "errors", "Cancel invalidates the picker context");
  assert.equal(await readFile(paths.config, "utf8"), before);
  assert.equal(calls.length, 2);
});

for (const catalogChange of ["outage", "removal"]) test(`private picker searches/saves/reopens/cancels without inference and rechecks auth after catalog ${catalogChange}`, async () => {
  const paths = pipaPaths(await mkdtemp(path.join(os.tmpdir(), "pipa-picker-")));
  const config = { botName: "Pipa", workingDirectory: "/work", slackAppToken: "xapp-test", slackBotToken: "xoxb-test", allowedSlackUserIds: ["U1"], allowedSlackChannelIds: ["C1"] };
  await writePrivateJson(paths.config, config);
  const models = [{ providerID: "openai", modelID: "model/a.b", name: "Model A" }];
  const handlers = {};
  const chat = {
    onSlashCommand(id, fn) { handlers.slash = fn; },
    onModalSubmit(id, fn) { handlers.submit = fn; },
    onModalClose(id, fn) { handlers.close = fn; },
    onOptionsLoad(fn) { handlers.options = fn; },
  };
  let modal;
  let discoveries = 0;
  let unavailable = false;
  const picker = createModelPicker({ chat, botName: "Pipa", commands: ["/pipa"], loadConfig: () => loadConfig(paths.config), setting: createModelSetting(paths.config), listModels: async () => { discoveries++; if (unavailable) throw new Error("catalog unavailable"); return models; } });
  const user = { userId: "U1" };
  const messages = [];
  const opening = { user, text: "model", triggerId: "trigger", channel: { id: "slack:C1", postEphemeral: async (...args) => messages.push(args) },
    adapter: { webClient: { views: {
      open: async ({ view }) => { modal = view; return { view: { id: "V1" } }; },
      update: async ({ view }) => { modal = view; return { view: { id: "V1" } }; },
    } }, postEphemeral: async (...args) => messages.push(args) } };
  await handlers.slash(opening);
  assert.equal(discoveries, 1);
  const input = modal.blocks[0].element;
  assert.equal(input.placeholder.text, "Search models or providers");
  const options = await handlers.options({ actionId: input.action_id, user, raw: { view: { id: "V1" } }, query: "" });
  assert.equal(options.length, 1);
  assert.equal(options[0].label, "Model A");
  const submission = { user, adapter: opening.adapter, privateMetadata: JSON.parse(modal.private_metadata).m, viewId: "V1", values: { [input.action_id]: options[0].value } };
  const displayed = models[0];
  unavailable = catalogChange === "outage";
  if (catalogChange === "removal") models.length = 0;
  const saved = await handlers.submit(submission);
  assert.equal(saved.action, "close");
  await picker.drain();
  assert.equal(messages.at(-1)[2], "New threads will use Model A.");
  assert.deepEqual((await loadConfig(paths.config)).defaultModel, { providerID: "openai", modelID: "model/a.b" });
  assert.equal(discoveries, 1, "Save uses the displayed model without catalog rediscovery");
  unavailable = false;
  if (catalogChange === "removal") models.push(displayed);
  await handlers.slash(opening);
  assert.equal(modal.blocks[0].element.initial_option.value, options[0].value);
  assert.equal(modal.blocks[0].element.initial_option.text.text, "Model A");
  const before = await readFile(paths.config, "utf8");
  await handlers.close({ privateMetadata: JSON.parse(modal.private_metadata).m, user, viewId: "V1" });
  assert.equal(await readFile(paths.config, "utf8"), before);
  await handlers.slash(opening);
  await writePrivateJson(paths.config, { ...config, allowedSlackUserIds: ["U2"] });
  const denied = await handlers.submit({ ...submission, privateMetadata: JSON.parse(modal.private_metadata).m });
  assert.equal(denied.action, "close", "fresh access checks run after acknowledgment");
  await picker.drain();
  assert.equal((await loadConfig(paths.config)).defaultModel, undefined);
  picker.close();
});

test("picker failure paths never persist and search results respect Slack bounds", async () => {
  const handlers = {};
  const chat = { onSlashCommand: (_id, fn) => { handlers.open = fn; }, onModalSubmit: (_id, fn) => { handlers.save = fn; }, onModalClose: (_id, fn) => { handlers.cancel = fn; }, onOptionsLoad: (fn) => { handlers.options = fn; } };
  const config = { botName: "Pipa Test!", allowedSlackUserIds: ["U1"], allowedSlackChannelIds: ["C1"] };
  const models = Array.from({ length: 120 }, (_, id) => ({ providerID: "provider", modelID: String(id), name: "n".repeat(200) }));
  let clock = 0;
  let failed = false;
  let writes = 0;
  const picker = createModelPicker({ chat, botName: "Pipa Test!", commands: ["/pipa-test", "/pipa"], now: () => clock, loadConfig: async () => config,
    listModels: async () => { if (failed) throw new Error("private upstream details"); return models; },
    setting: { save: async (_model, authorize) => { authorize(config); writes++; throw new Error("disk unavailable"); } } });
  let modal;
  const user = { userId: "U1" };
  const privateReplies = [];
  const saveResults = [];
  const event = { user, text: "model", triggerId: "trigger", channel: { id: "slack:C1", postEphemeral: async (...args) => privateReplies.push(args) },
    adapter: { webClient: { views: {
      open: async ({ view }) => { modal = view; return { view: { id: "V1" } }; },
      update: async ({ view }) => { modal = view; return { view: { id: "V1" } }; },
    } }, postEphemeral: async (_channel, _user, text) => saveResults.push(text) } };
  for (const text of ["", "unknown"]) await handlers.open({ ...event, text });
  assert.equal(privateReplies.length, 2);
  assert.ok(privateReplies.every((args) => args[1].includes("/pipa-test model") && !args[1].includes("/pipa model")));
  assert.ok(privateReplies.every((args) => args[2].fallbackToDM === false));
  await handlers.open(event);
  const id = modal.blocks[0].element.action_id;
  const choices = await handlers.options({ actionId: id, user, raw: { view: { id: "V1" } }, query: "" });
  assert.equal(choices.length, 100);
  assert.ok(choices.every((choice) => choice.label.length <= 75 && choice.value.length <= 150 && choice.description.length <= 75));
  const submission = () => {
    const input = modal.blocks[0].element;
    return { user, adapter: event.adapter, viewId: "V1", privateMetadata: JSON.parse(modal.private_metadata).m,
      values: { [input.action_id]: choices.at(-1).value } };
  };
  let save = submission();
  for (const bad of [{ ...save, user: { userId: "U2" } }, { ...save, viewId: "other" }, { ...save, privateMetadata: "forged" }]) {
    assert.equal((await handlers.save(bad)).action, "errors");
  }
  assert.equal(writes, 0);
  assert.equal((await handlers.save({ ...save, values: { [id]: "missing" } })).action, "close");
  await picker.drain();
  assert.match(saveResults.at(-1), /not in this picker/u);
  assert.equal(writes, 0);
  failed = true;
  await handlers.open(event);
  assert.equal(modal.submit, undefined, "catalog failure never offers an empty picker for submission");
  assert.equal(modal.blocks[0].text.text, "private upstream details");
  assert.equal((await handlers.save(save)).action, "errors");
  assert.equal(writes, 0);
  failed = false;
  await handlers.open(event);
  save = submission();
  const [removed] = models.splice(99, 1);
  assert.equal((await handlers.save(save)).action, "close");
  await picker.drain();
  assert.equal(saveResults.at(-1), "disk unavailable", "Save attempts persistence using the cached model even after catalog removal");
  assert.equal(writes, 1);
  models.push(removed);
  await handlers.open(event);
  save = submission();
  const failedWrite = await handlers.save(save);
  assert.equal(failedWrite.action, "close");
  await picker.drain();
  assert.equal(saveResults.at(-1), "disk unavailable");
  assert.equal(writes, 2);
  await handlers.open(event);
  save = submission();
  config.allowedSlackChannelIds = ["C2"];
  assert.equal((await handlers.save(save)).action, "close");
  await picker.drain();
  assert.equal(writes, 2);
  config.allowedSlackChannelIds = ["C1"];
  clock = 31 * 60_000;
  assert.equal((await handlers.save(save)).action, "errors");
  assert.equal(writes, 2);
  const beforeClose = modal;
  picker.close();
  await handlers.open(event);
  assert.equal(modal, beforeClose);
});

test("large interleaved catalogs are searched locally with bounded results and authorized contexts", async () => {
  const handlers = {};
  const config = { allowedSlackUserIds: ["U1"], allowedSlackChannelIds: ["C1"], defaultModel: { providerID: "provider-a", modelID: "model-10000" } };
  let view;
  let discoveries = 0;
  let clock = 0;
  const models = Array.from({ length: 10_001 }, (_, id) => ({ providerID: id % 2 ? "provider-b" : "provider-a", modelID: `model-${id}`, name: `Model ${id}` }));
  const picker = createModelPicker({
    chat: { onSlashCommand: (_ids, fn) => { handlers.open = fn; }, onOptionsLoad: (fn) => { handlers.options = fn; }, onModalClose: (_id, fn) => { handlers.close = fn; } },
    botName: "Pipa", commands: ["/pipa"], now: () => clock, loadConfig: async () => config, setting: {},
    listModels: async () => { discoveries++; return models; },
  });
  await handlers.open({ user: { userId: "U1" }, text: "model", channel: { id: "slack:C1", postEphemeral: async () => undefined },
    adapter: { webClient: { views: { open: async () => ({ view: { id: "V1" } }), update: async (input) => { view = input.view; } } } } });
  try {
    const input = view.blocks[0].element;
    assert.equal(input.type, "external_select");
    assert.equal(input.min_query_length, 0);
    assert.equal(input.option_groups, undefined);
    assert.equal(input.initial_option.text.text, "Model 10000", "saved models outside the first page remain selected");
    const event = { actionId: input.action_id, user: { userId: "U1" }, raw: { view: { id: "V1" } }, query: "" };
    assert.equal((await handlers.options(event)).length, 100);
    const results = await handlers.options({ ...event, query: "PROVIDER-A 10000" });
    assert.equal(results.length, 1);
    assert.equal(results[0].label, "Model 10000");
    assert.match(results[0].description, /provider-a/u);
    assert.deepEqual((await handlers.options({ ...event, query: "model-10000" })).map((result) => result.label), ["Model 10000"]);
    assert.deepEqual(await handlers.options({ ...event, query: "not-a-model" }), []);
    for (const bad of [{ user: { userId: "U2" } }, { raw: { view: { id: "other" } } }, { actionId: "pipa_model_forged" }]) {
      assert.deepEqual(await handlers.options({ ...event, ...bad }), []);
    }
    config.allowedSlackChannelIds = ["C2"];
    assert.deepEqual(await handlers.options(event), []);
    config.allowedSlackChannelIds = ["C1"];
    clock = 31 * 60_000;
    assert.deepEqual(await handlers.options(event), []);
    clock = 0;
    handlers.close({ user: event.user, privateMetadata: JSON.parse(view.private_metadata).m });
    assert.deepEqual(await handlers.options(event), []);
    assert.equal(discoveries, 1, "searches never call OpenCode again");
  } finally { picker.close(); }
});

test("Cancel during search authorization prevents returning cached choices", async () => {
  const handlers = {};
  const reading = Promise.withResolvers();
  const gate = Promise.withResolvers();
  let searching = false;
  let view;
  const picker = createModelPicker({
    chat: { onSlashCommand: (_ids, fn) => { handlers.open = fn; }, onOptionsLoad: (fn) => { handlers.options = fn; }, onModalClose: (_id, fn) => { handlers.close = fn; } },
    botName: "Pipa", commands: ["/pipa"], setting: {}, listModels: async () => [{ providerID: "openai", modelID: "a" }],
    loadConfig: async () => { if (searching) { reading.resolve(); await gate.promise; } return {}; },
  });
  await handlers.open({ user: { userId: "U1" }, text: "model", channel: { id: "slack:C1", postEphemeral: async () => undefined },
    adapter: { webClient: { views: { open: async () => ({ view: { id: "V1" } }), update: async (input) => { view = input.view; } } } } });
  searching = true;
  const results = handlers.options({ actionId: view.blocks[0].element.action_id, query: "", user: { userId: "U1" }, raw: { view: { id: "V1" } } });
  try {
    await reading.promise;
    handlers.close({ user: { userId: "U1" }, privateMetadata: JSON.parse(view.private_metadata).m });
  } finally { gate.resolve(); }
  try { assert.deepEqual(await results, []); } finally { picker.close(); }
});

test("an empty catalog gives a private explanation instead of an empty modal", async () => {
  let open;
  let opened = false;
  const replies = [];
  let notice;
  const picker = createModelPicker({
    chat: { onSlashCommand: (_id, fn) => { open = fn; } }, botName: "Pipa", commands: ["/pipa"],
    loadConfig: async () => ({}), setting: {},
    listModels: async () => [],
  });
  await open({ user: { userId: "U1" }, text: "model", triggerId: "trigger",
    channel: { id: "slack:C1", postEphemeral: async (...args) => replies.push(args) },
    adapter: { webClient: { views: {
      open: async () => { opened = true; return { view: { id: "V1" } }; },
      update: async ({ view }) => { notice = view; },
    } } } });
  assert.equal(opened, true, "trigger is exchanged before catalog discovery");
  assert.equal(replies.length, 0);
  assert.equal(notice.submit, undefined);
  assert.match(notice.blocks[0].text.text, /No configured models/u);
  picker.close();
});

for (const [failure, expected] of [
  ["configuration", "Settings file could not be read"],
  ["access", "This picker is unavailable or you are not authorized. Reopen /chopper model."],
  ["models", "Native catalog read failed"],
  ["expired_trigger_id", "Slack API error: expired_trigger_id"],
  ["invalid_trigger_id", "Slack API error: invalid_trigger_id"],
  ["invalid_arguments", "Slack API error: invalid_arguments"],
  ["unknown_slack_error", "Slack API error: unknown_slack_error"],
  ["token", "Native catalog failed for [redacted] [redacted]"],
]) test(`picker opening passes through ${failure} message without bodies, stacks or Slack tokens`, async () => {
  let open;
  const replies = [];
  const notices = [];
  const picker = createModelPicker({ chat: { onSlashCommand: (_id, fn) => { open = fn; } }, botName: "Chopper", commands: ["/chopper"], setting: {},
    loadConfig: async () => {
      if (failure === "configuration") throw new Error("Settings file could not be read");
      return failure === "access" ? { allowedSlackUserIds: ["U2"] } : {};
    },
    listModels: async () => {
      if (failure === "models" || failure === "token") throw Object.assign(new Error(failure === "token" ? "Native catalog failed for xoxb-test-token xapp-test-token" : "Native catalog read failed"), { body: "private-body" });
      return [{ providerID: "openai", modelID: "a" }];
    } });
  await open({ text: "model", user: { userId: "U1" }, channel: { id: "slack:C1", postEphemeral: async (...args) => replies.push(args) },
    adapter: { webClient: { views: {
      open: async () => { if (failure === "models" || failure === "token") return { view: { id: "V1" } }; throw Object.assign(new Error(`Slack API error: ${failure}`), { data: { error: failure, body: "private-body" } }); },
      update: async ({ view }) => { notices.push(view.blocks[0].text.text); },
    } } } });
  assert.equal(replies.length + notices.length, 1);
  const message = replies[0]?.[1] ?? notices[0];
  assert.equal(message, expected);
  assert.doesNotMatch(message, /private-body|xoxb-|xapp-|\n\s+at /u);
  if (replies.length) assert.equal(replies[0][2].fallbackToDM, false);
  picker.close();
});
