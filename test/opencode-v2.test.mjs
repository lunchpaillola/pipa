import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createV2Adapter } from "../src/opencode-v2.mjs";
import { postResult } from "../src/app.mjs";

async function fixture(t, options = {}) {
  const messages = new Map();
  const requests = [];
  const entries = new Map();
  const globalStreams = new Set();
  const forms = [];
  const permissions = [];
  const sessions = new Map();
  let seq = 0;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks)) : undefined;
    requests.push({ path: url.pathname, method: req.method, body, after: url.searchParams.get("after") });
    const json = (data, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(data)); };
    const sessionId = url.pathname.split("/")[3];
    if (await options.onRequest?.({ req, res, url, body, json })) return;
    if (url.pathname === "/api/event") {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.flushHeaders();
      globalStreams.add(res);
      res.write(`data: ${JSON.stringify({ type: "server.connected", data: {} })}\n\n`);
      res.on("close", () => globalStreams.delete(res));
      return;
    }
    if (/\/instructions\/entries$/u.test(url.pathname)) return json({ data: [...(entries.get(url.pathname.split("/")[4]) ?? new Map())].map(([key, value]) => ({ key, value })) });
    if (/\/instructions\/entries\//u.test(url.pathname)) {
      const id = url.pathname.split("/")[4];
      const key = decodeURIComponent(url.pathname.split("/").at(-1));
      const values = entries.get(id) ?? new Map();
      entries.set(id, values);
      if (req.method === "PUT") values.set(key, body.value);
      if (req.method === "DELETE") values.delete(key);
      res.writeHead(204); res.end(); return;
    }
    if (/\/message\//u.test(url.pathname)) return json({ data: messages.get(url.pathname.split("/").at(-1)) });
    if (url.pathname.endsWith("/message")) return json({ data: [...messages.values()].filter((message) => message.sessionID === sessionId).reverse(), cursor: { next: null, previous: null } });
    if (url.pathname.endsWith("/prompt")) return json({ data: { id: body.id, sessionID: sessionId, time: { created: 1 }, type: "user", payload: { text: body.text }, delivery: "steer" } });
    if (url.pathname.endsWith("/interrupt")) return json({});
    if (url.pathname === "/api/form") return json({ location: { directory: process.cwd() }, data: forms });
    if (url.pathname === "/api/permission/request") return json({ location: { directory: process.cwd() }, data: permissions });
    if (url.pathname.endsWith("/permission")) return json({ data: permissions.filter((item) => item.sessionID === sessionId) });
    if (/\/permission\/[^/]+\/reply$/u.test(url.pathname)) {
      const id = url.pathname.split("/").at(-2);
      const index = permissions.findIndex((item) => item.id === id);
      if (index >= 0) permissions.splice(index, 1);
      res.writeHead(204); res.end();
      globalEvent("permission.replied", { sessionID: sessionId, requestID: id, reply: body.decision });
      return;
    }
    if (/\/form\/[^/]+(?:\/reply)?$/u.test(url.pathname)) {
      const id = url.pathname.split("/")[5];
      const index = forms.findIndex((form) => form.id === id);
      if (req.method === "GET") return json({ data: { ...forms[index], state: { status: "pending" } } });
      if (index >= 0) forms.splice(index, 1);
      res.writeHead(204); res.end();
      globalEvent(req.method === "DELETE" ? "form.cancelled" : "form.replied", { sessionID: sessionId, id, ...(body ?? {}) });
      return;
    }
    if (/^\/api\/session\/[^/]+$/u.test(url.pathname)) return json({ data: { id: sessionId, projectID: "proj_native", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: 1, updated: 2 }, location: { directory: process.cwd() }, model: { providerID: "native", id: "existing" }, ...sessions.get(sessionId) } });
    json({ error: `Unexpected ${req.method} ${url.pathname}` }, 404);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const adapter = createV2Adapter({ baseUrl: `http://127.0.0.1:${server.address().port}`, fetch, environment: {}, pollIntervalMs: 1, ...options });
  t.after(async () => { adapter.stopAll?.(); await adapter.drain?.(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  function globalEvent(type, data, location = { directory: process.cwd() }) {
    for (const stream of globalStreams) stream.write(`data: ${JSON.stringify({ id: `evt_global_${++seq}`, created: Date.now(), type, location, data })}\n\n`);
  }
  function emit(id, type, data) {
    const event = { id: `evt_${++seq}`, created: Date.now(), type, durable: { aggregateID: id, seq, version: 1 }, data: { sessionID: id, ...data } };
    for (const stream of globalStreams) if (!stream.writableEnded) stream.write(`data: ${JSON.stringify(event)}\n\n`);
    return event;
  }
  function reply(id, messageId, text) {
    messages.set(messageId, { id: messageId, sessionID: id, type: "assistant", agent: "build", model: { providerID: "native", id: "existing" }, time: { created: 1, completed: 2 }, content: [{ type: "reasoning", text: "private" }, { type: "text", text }], finish: "stop" });
    return emit(id, "session.step.ended", { assistantMessageID: messageId, finish: "stop", cost: 0, tokens: { input: 1, output: 1, reasoning: 0, cache: { read: 0, write: 0 } } });
  }
  const input = (id, extra = {}) => ({ sessionId: id, workingDirectory: process.cwd(), instructions: "Stable Slack context", controller: new AbortController(), prompt: "exact prompt", files: [], ...extra });
  return { adapter, requests, entries, emit, reply, input, globalStreams, globalEvent, forms, permissions, sessions, messages };
}

async function until(predicate) {
  for (let count = 0; count < 500; count++) { if (predicate()) return; await delay(2); }
  assert.fail("Timed out waiting for native event delivery");
}

test("native events deliver initial and later background responses after admission", async (t) => {
  const f = await fixture(t);
  const responses = [];
  assert.equal(typeof f.adapter.followSession, "function");
  assert.deepEqual(await f.adapter.execute(f.input("ses_one", { onResponse: async (...args) => responses.push(args.slice(0, 2)) })), { pending: true });
  f.reply("ses_one", "msg_first", "First reply");
  await until(() => responses.length === 1);
  f.emit("ses_one", "session.inbox.enqueued", { inboxID: "native_steering", item: { id: "native_steering", sessionID: "ses_one", type: "user", time: { created: 1 }, payload: { text: "Native steering" }, delivery: "steer" } });
  f.reply("ses_one", "msg_background", "Background finished");
  await until(() => responses.length === 2);
  assert.deepEqual(responses, [["First reply", "msg_first"], ["Background finished", "msg_background"]]);
  assert.equal(f.requests.filter((r) => r.path.endsWith("/prompt")).length, 1);
  assert.equal(f.requests.find((r) => r.path.endsWith("/prompt")).body.text, "exact prompt");
});

test("unavailable response observation fails before admitting unobservable work", async (t) => {
  const f = await fixture(t, { connectionRecoveryTimeoutMs: 25, onRequest: ({ url, json }) => {
    if (url.pathname === "/api/event") { json({}, 503); return true; }
  } });
  await assert.rejects(f.adapter.execute(f.input("ses_one", { onResponse: async () => {} })), /event attachment timed out/u);
  assert.equal(f.requests.some((request) => request.path.endsWith("/prompt")), false);
});

test("attachment and reconnect forward live replies without reading or replaying history", async (t) => {
  const f = await fixture(t);
  f.reply("ses_one", "msg_old", "Do not replay");
  const responses = [];
  await f.adapter.followSession(f.input("ses_one", { onResponse: async (text) => responses.push(text) }));
  f.reply("ses_one", "msg_one", "One");
  await until(() => responses.length === 1);
  for (const stream of f.globalStreams) stream.end();
  f.reply("ses_one", "msg_gap", "Missed while disconnected");
  await until(() => f.requests.filter((r) => r.path === "/api/event").length === 2);
  await f.adapter.followSession(f.input("ses_one", { onResponse: async (text) => responses.push(`updated ${text}`) }));
  f.reply("ses_one", "msg_two", "Two");
  await until(() => responses.length === 2);
  assert.deepEqual(responses, ["One", "updated Two"]);
  assert.equal(f.requests.some((r) => r.path.endsWith("/message")), false);
  assert.equal(f.requests.filter((r) => r.method === "PUT").length, 1);
});

test("two admissions before either completion forward each live message once", async (t) => {
  const f = await fixture(t);
  const responses = [];
  const onResponse = async (text, id) => responses.push([text, id]);
  await f.adapter.execute(f.input("ses_one", { onResponse }));
  await f.adapter.execute(f.input("ses_one", { onResponse }));
  f.reply("ses_one", "msg_second", "Second");
  f.reply("ses_one", "msg_first", "First");
  f.reply("ses_one", "msg_first", "First");
  await until(() => responses.length === 2);
  await delay(10);
  assert.deepEqual(responses, [["Second", "msg_second"], ["First", "msg_first"]]);
  assert.equal(f.requests.filter((r) => r.path.endsWith("/prompt")).length, 2);
});

test("slow interaction lookup does not block another session's live response", async (t) => {
  const reading = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, { onRequest: async ({ url }) => {
    if (url.pathname === "/api/session/ses_child") { reading.resolve(); await release.promise; }
  } });
  f.sessions.set("ses_child", { parentID: "ses_one" });
  const responses = [];
  await f.adapter.followSession(f.input("ses_one", { onInteraction: async () => ({ type: "cancelled" }) }));
  await f.adapter.followSession(f.input("ses_two", { onResponse: async (text) => responses.push(text) }));
  f.globalEvent("permission.asked", { id: "per_slow", sessionID: "ses_child", action: "bash", resources: ["pwd"] });
  await reading.promise;
  f.reply("ses_two", "msg_independent", "Independent reply");
  try {
    await until(() => responses.length === 1);
    assert.deepEqual(responses, ["Independent reply"]);
  } finally { release.resolve(); }
});

test("native active session lookup is allowed and failures stay session-local and sanitized", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.adapter.resolveSession("ses_one", process.cwd(), new AbortController()), { sessionId: "ses_one", defaultEligible: false });
  const errors = [];
  const responses = [];
  await f.adapter.followSession(f.input("ses_one", { onError: async (error) => errors.push(error) }));
  await f.adapter.followSession(f.input("ses_two", { onResponse: async (text) => responses.push(text) }));
  f.emit("ses_one", "session.execution.failed", { error: { type: "provider.auth", status: 401, message: "secret-token" } });
  f.reply("ses_two", "msg_ok", "Other session works");
  await until(() => errors.length === 1 && responses.length === 1);
  assert.match(errors[0].message, /authentication failed/u);
  assert.doesNotMatch(errors[0].message, /secret-token/u);
});

test("reconnect detaches a session moved outside the configured workspace", async (t) => {
  const f = await fixture(t);
  const responses = [], errors = [];
  await f.adapter.followSession(f.input("ses_one", { onResponse: async (text) => responses.push(text), onError: async (error) => errors.push(error) }));
  f.sessions.set("ses_one", { location: { directory: "/outside" } });
  for (const stream of f.globalStreams) stream.end();
  f.reply("ses_one", "msg_outside", "Must not be forwarded");
  await until(() => errors.length === 1);
  assert.deepEqual(responses, []);
  assert.match(errors[0].message, /session responses are unavailable/u);
});

test("failed consumer delivery is not replayed and later responses still deliver", async (t) => {
  const f = await fixture(t);
  const delivered = [];
  const errors = [];
  const firstChunk = "a".repeat(3500);
  const thread = { post: async ({ markdown }) => {
    if (markdown === "last chunk") throw new Error("Slack unavailable");
    delivered.push(markdown);
  } };
  await f.adapter.followSession(f.input("ses_one", {
    onResponse: (text, _id, signal) => postResult(thread, { text }, signal),
    onError: async (error) => errors.push(error),
  }));
  f.reply("ses_one", "msg_retry", `${firstChunk}\nlast chunk`);
  await until(() => errors.length === 1);
  f.reply("ses_one", "msg_retry", `${firstChunk}\nlast chunk`);
  f.reply("ses_one", "msg_next", "Next response");
  await until(() => delivered.length === 2);
  for (const stream of f.globalStreams) stream.end();
  await until(() => f.requests.filter((r) => r.path === "/api/event").length === 2);
  await delay(10);
  assert.deepEqual(delivered, [firstChunk, "Next response"]);
  assert.equal(errors.length, 1);
});

test("a failed instruction update does not detach an existing background observer", async (t) => {
  let fail = false;
  const f = await fixture(t, { onRequest: ({ req, url, json }) => {
    if (fail && req.method === "PUT" && url.pathname.includes("/instructions/entries/")) { json({}, 500); return true; }
  } });
  const responses = [];
  const onResponse = async (text) => responses.push(text);
  await f.adapter.followSession(f.input("ses_one", { onResponse }));
  fail = true;
  await assert.rejects(f.adapter.execute(f.input("ses_one", { instructions: "Changed context", onResponse })));
  f.reply("ses_one", "msg_still_watched", "Still followed");
  await until(() => responses.length === 1);
  assert.deepEqual(responses, ["Still followed"]);
});

test("headless execution returns native text and detaches; explicit stop settles without idle", async (t) => {
  const f = await fixture(t);
  const turn = f.adapter.execute(f.input("ses_one"));
  await until(() => f.requests.some((r) => r.path.endsWith("/prompt")));
  f.reply("ses_one", "msg_headless", "Routine result");
  assert.equal(await turn, "Routine result");
  await until(() => f.globalStreams.size === 0);
  const second = f.adapter.execute(f.input("ses_two"));
  await until(() => f.requests.filter((r) => r.path.endsWith("/prompt")).length === 2);
  await f.adapter.abortTurn("ses_two");
  assert.equal(await second, "");
  assert.equal(f.requests.filter((r) => r.path.endsWith("/interrupt")).length, 1);
});

test("consecutive headless requests reattach to the same native session", async (t) => {
  const f = await fixture(t, { connectionRecoveryTimeoutMs: 100 });
  for (let i = 0; i < 2; i++) {
    const turn = f.adapter.execute(f.input("ses_one"));
    await until(() => f.requests.filter((r) => r.path.endsWith("/prompt")).length === i + 1);
    f.reply("ses_one", `msg_${i}`, `Reply ${i}`);
    assert.equal(await turn, `Reply ${i}`);
  }
});

test("empty native stop text completes headless callers without posting an empty reply", async (t) => {
  const f = await fixture(t);
  const turn = f.adapter.execute(f.input("ses_one"));
  await until(() => f.requests.some((r) => r.path.endsWith("/prompt")));
  f.reply("ses_one", "msg_empty_headless", "  ");
  assert.equal(await turn, "");
});

test("stopAll detaches local observers without interrupting independently submitted server work", async (t) => {
  const f = await fixture(t);
  await f.adapter.execute(f.input("ses_one", { onResponse: async () => {} }));
  f.adapter.stopAll(new Error("shutdown"));
  await f.adapter.drain();
  await until(() => f.globalStreams.size === 0);
  assert.equal(f.requests.filter((r) => r.path.endsWith("/interrupt")).length, 0);
});

test("long-lived event bodies have no ordinary HTTP body deadline", async (t) => {
  const f = await fixture(t, { connectionRequestTimeoutMs: 250 });
  const responses = [];
  await f.adapter.followSession(f.input("ses_one", { onResponse: async (text) => responses.push(text), onInteraction: async () => ({ type: "cancelled" }) }));
  await delay(350);
  f.reply("ses_one", "msg_later", "Still connected");
  await until(() => responses.length === 1);
  assert.equal(f.requests.some((r) => r.path.endsWith("/log")), false);
  assert.equal(f.requests.filter((r) => r.path === "/api/event").length, 1);
});

test("stable context migration is one-time, scoped, and never deletes pipa.slack", async (t) => {
  const f = await fixture(t);
  const old = "pipa-0123456789abcdef-01234567-0123-0123-0123-0123456789ab";
  f.entries.set("ses_one", new Map([[old, "old turn context"], ["native", "keep me"], ["pipa.slack", "Stable Slack context"]]));
  await f.adapter.followSession(f.input("ses_one"));
  await f.adapter.followSession(f.input("ses_one"));
  assert.deepEqual([...f.entries.get("ses_one")], [["native", "keep me"], ["pipa.slack", "Stable Slack context"]]);
  assert.equal(f.requests.filter((r) => r.method === "PUT").length, 0);
  await f.adapter.followSession(f.input("ses_one", { instructions: "Updated Slack context" }));
  assert.equal(f.requests.filter((r) => r.method === "PUT").length, 1);
  assert.equal(f.requests.filter((r) => r.method === "DELETE").length, 1);
});

test("questions preserve options, multiselect and custom answers after admission", async (t) => {
  const f = await fixture(t);
  const interactions = [];
  await f.adapter.execute(f.input("ses_one", { onResponse: async () => {}, onInteraction: async (interaction) => {
    interactions.push(interaction);
    return { type: "cancelled" };
  } }));
  const form = { id: "frm_choices", sessionID: "ses_one", title: "Choices", metadata: { kind: "question" }, fields: [
    { key: "q0", type: "string", title: "Pick one", required: true, options: [{ label: "Blue", value: "blue_value" }] },
    { key: "q1", type: "multiselect", title: "Pick several", required: true, custom: true, options: [{ label: "Red", value: "red_value" }] },
  ] };
  f.forms.push(form);
  f.globalEvent("form.created", { form });
  await until(() => interactions.length === 1);
  assert.equal(interactions[0].type, "question");
  assert.equal(interactions[0].request.questions[1].multiple, true);
  assert.equal(interactions[0].request.questions[1].custom, true);
  await interactions[0].submit({ type: "answer", answers: [["Blue"], ["Red", "custom text"]] });
  assert.deepEqual(f.requests.find((r) => r.path.endsWith("/frm_choices/reply")).body, { answer: { q0: "blue_value", q1: ["red_value", "custom text"] } });
});

test("child permissions, native settlement and reconnect reconciliation share one live source", async (t) => {
  const f = await fixture(t);
  f.sessions.set("ses_child", { parentID: "ses_one" });
  f.sessions.set("ses_outside", { parentID: "ses_one", location: { directory: "/outside" } });
  const interactions = [];
  const replies = [];
  const snapshots = [];
  await f.adapter.followSession(f.input("ses_one", {
    onInteraction: async (interaction) => { interactions.push(interaction); return { type: "cancelled" }; },
    onPermissionReplied: async (reply) => replies.push(reply),
    onPermissionsReconciled: async (snapshot) => snapshots.push(snapshot),
  }));
  await f.adapter.followSession(f.input("ses_two", { onInteraction: async () => ({ type: "cancelled" }) }));
  const permission = { id: "per_child", sessionID: "ses_child", action: "bash", resources: ["pwd"] };
  f.permissions.push(permission, { ...permission, id: "per_outside", sessionID: "ses_outside" });
  f.globalEvent("permission.asked", f.permissions[1]);
  f.globalEvent("permission.asked", permission);
  await until(() => interactions.length === 1);
  assert.equal(interactions[0].sessionId, "ses_child");
  await interactions[0].submit({ type: "reply", reply: "always" });
  await until(() => replies.length === 1);
  assert.deepEqual(replies[0], { sessionId: "ses_child", requestId: "per_child", reply: "always" });
  assert.equal(f.requests.filter((r) => r.path === "/api/event").length, 1);
  const pending = { ...permission, id: "per_reconnect" };
  f.permissions.push(pending);
  for (const stream of f.globalStreams) stream.end();
  await until(() => interactions.length === 2);
  const external = interactions[1];
  f.permissions.splice(f.permissions.findIndex((item) => item.id === pending.id), 1);
  f.globalEvent("permission.replied", { sessionID: "ses_child", requestID: pending.id, reply: "once" });
  await external.settled;
  await assert.rejects(external.submit({ type: "reply", reply: "once" }), /already settled/u);
  await until(() => snapshots.some((snapshot) => snapshot.sessionId === "ses_child" && snapshot.requestIds.size === 0));
});

test("explicit permission rejection completes headless caller without a native idle", async (t) => {
  const f = await fixture(t);
  f.permissions.push({ id: "per_reject", sessionID: "ses_one", action: "bash", resources: ["pwd"] });
  const result = await f.adapter.execute(f.input("ses_one", { onInteraction: async () => ({ type: "reject" }) }));
  assert.match(result, /rejected/u);
  assert.equal(f.requests.filter((r) => r.path.endsWith("/per_reject/reply")).length, 1);
});

test("question dismissal interrupts natively and settles without idle", async (t) => {
  const f = await fixture(t);
  f.forms.push({ id: "frm_stop", sessionID: "ses_one", title: "Continue?", metadata: { kind: "question" }, fields: [{ key: "q0", type: "string", title: "Answer", required: true }] });
  const result = await f.adapter.execute(f.input("ses_one", { onInteraction: async () => ({ type: "stop" }) }));
  assert.equal(result, "");
  assert.equal(f.requests.filter((r) => r.method === "DELETE").length, 1);
  assert.equal(f.requests.filter((r) => r.path.endsWith("/interrupt")).length, 1);
});

test("stopAll aborts local admission and initialization without submitting native interrupts", async (t) => {
  for (const endpoint of ["/api/event", "/prompt"]) {
    const f = await fixture(t, { onRequest: async ({ url }) => url.pathname.endsWith(endpoint) });
    const result = f.adapter.execute(f.input("ses_one", { onResponse: async () => {} }));
    const rejected = assert.rejects(result, /shutdown/u);
    await until(() => f.requests.some((request) => request.path.endsWith(endpoint)));
    f.adapter.stopAll(new Error("shutdown"));
    await rejected;
    await f.adapter.drain();
    assert.equal(f.requests.filter((r) => r.path.endsWith("/interrupt")).length, 0);
  }
});

test("drain waits for in-flight response and interaction callbacks", async (t) => {
  const f = await fixture(t);
  const responseStarted = Promise.withResolvers();
  const interactionStarted = Promise.withResolvers();
  const release = Promise.withResolvers();
  await f.adapter.followSession(f.input("ses_one", {
    onResponse: async () => { responseStarted.resolve(); await release.promise; },
    onInteraction: async () => { interactionStarted.resolve(); await release.promise; return { type: "cancelled" }; },
  }));
  f.reply("ses_one", "msg_drain", "Delivering");
  const form = { id: "frm_drain", sessionID: "ses_one", title: "Wait", metadata: { kind: "question" }, fields: [{ key: "q0", type: "string", title: "Answer", required: true }] };
  f.forms.push(form);
  f.globalEvent("form.created", { form });
  await Promise.all([responseStarted.promise, interactionStarted.promise]);
  f.adapter.stopAll();
  let drained = false;
  const drain = f.adapter.drain().then(() => { drained = true; });
  await delay(10);
  assert.equal(drained, false);
  release.resolve();
  await drain;
  assert.equal(drained, true);
});

test("failed legacy-context migration does not block this or unrelated native sessions", async (t) => {
  const f = await fixture(t, { onRequest: async ({ url, json }) => {
    if (url.pathname === "/api/experimental/session/ses_one/instructions/entries") { json({}, 500); return true; }
  } });
  await f.adapter.followSession(f.input("ses_one"));
  await f.adapter.followSession(f.input("ses_two"));
  assert.equal(f.globalStreams.size, 1);
  assert.equal(f.entries.get("ses_one").get("pipa.slack"), "Stable Slack context");
});

test("native model discovery is credential-free and switching precedes exact prompt admission", async (t) => {
  const f = await fixture(t, { onRequest: async ({ req, res, url, json }) => {
    if (url.pathname === "/api/model") {
      json({ location: { directory: process.cwd() }, data: [{ providerID: "native", id: "chosen", name: "Chosen model", enabled: true, variants: [{ id: "fast" }], headers: { authorization: "secret" } }] });
      return true;
    }
    if (url.pathname === "/api/model/default") {
      json({ location: { directory: process.cwd() }, data: { providerID: "native", id: "chosen" } });
      return true;
    }
    if (req.method === "POST" && url.pathname.endsWith("/model")) { res.writeHead(204); res.end(); return true; }
  } });
  const catalog = await f.adapter.listModels(process.cwd(), new AbortController().signal);
  assert.deepEqual(catalog, { models: [{ providerID: "native", id: "chosen", name: "Chosen model", variants: ["default", "fast"] }], defaultModel: { providerID: "native", id: "chosen", variant: "default" } });
  await f.adapter.switchModel("ses_one", null, process.cwd(), new AbortController().signal);
  await f.adapter.execute(f.input("ses_one", { model: { providerID: "native", modelID: "chosen" }, onResponse: async () => {} }));
  const switchIndex = f.requests.findLastIndex((request) => request.path.endsWith("/model") && request.method === "POST");
  const promptIndex = f.requests.findIndex((request) => request.path.endsWith("/prompt"));
  assert.ok(switchIndex < promptIndex);
  assert.deepEqual(f.requests[switchIndex].body, { model: { providerID: "native", id: "chosen", variant: "default" } });
});

test("only completed nonempty stop text is forwarded, not reasoning or intermediate steps", async (t) => {
  const f = await fixture(t);
  const responses = [];
  await f.adapter.followSession(f.input("ses_one", { onResponse: async (text) => responses.push(text) }));
  f.emit("ses_one", "session.step.ended", { assistantMessageID: "msg_tools", finish: "tool-calls", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
  f.reply("ses_one", "msg_empty", "  ");
  f.emit("ses_one", "session.step.ended", { assistantMessageID: "msg_length", finish: "length", cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } });
  f.reply("ses_one", "msg_final", "Final text");
  await until(() => responses.length === 1);
  assert.deepEqual(responses, ["Final text"]);
  assert.equal(f.requests.filter((request) => /\/message\//u.test(request.path)).length, 2);
});

test("empty existing sessions remain default-eligible with one bounded history sample", async (t) => {
  const f = await fixture(t, { onRequest: async ({ url, json }) => {
    if (url.pathname.endsWith("/message")) {
      assert.equal(url.searchParams.get("limit"), "1");
      json({ data: [], cursor: { next: null } });
      return true;
    }
  } });
  f.sessions.set("ses_empty", { model: undefined });
  assert.deepEqual(await f.adapter.resolveSession("ses_empty", process.cwd(), new AbortController()), { sessionId: "ses_empty", defaultEligible: true });
  assert.equal(f.requests.filter((request) => request.path.endsWith("/message")).length, 1);
  assert.equal(f.requests.some((request) => request.path.endsWith("/active") || request.path.endsWith("/inbox")), false);
});
