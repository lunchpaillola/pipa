import assert from "node:assert/strict";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { createV2Adapter } from "../src/opencode-v2.mjs";
import { createPendingInteractions, postResult } from "../src/app.mjs";

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
    requests.push({ path: url.pathname, method: req.method, body, after: url.searchParams.get("after"), parentID: url.searchParams.get("parentID"), cursor: url.searchParams.get("cursor") });
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
    if (url.pathname === "/api/form") return json({ location: { directory: process.cwd() }, data: forms.filter((item) => !sessions.get(item.sessionID)?.location || sessions.get(item.sessionID).location.directory === process.cwd()) });
    if (url.pathname === "/api/permission/request") return json({ location: { directory: process.cwd() }, data: permissions.filter((item) => !sessions.get(item.sessionID)?.location || sessions.get(item.sessionID).location.directory === process.cwd()) });
    if (url.pathname === "/api/session") {
      const children = [...sessions].filter(([, session]) => session.parentID === url.searchParams.get("parentID"));
      const offset = Number(url.searchParams.get("cursor") ?? 0);
      const pageSize = options.childPageSize ?? 100;
      return json({ data: children.slice(offset, offset + pageSize).map(([id, session]) => ({ id, ...session })), cursor: { next: offset + pageSize < children.length ? String(offset + pageSize) : undefined } });
    }
    if (url.pathname.endsWith("/form")) return json({ data: forms.filter((item) => item.sessionID === sessionId) });
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

test("native session creation accepts returned identity without a directory-spelling veto", async (t) => {
  const f = await fixture(t, { onRequest: ({ req, url, json }) => {
    if (url.pathname !== "/api/session" || req.method !== "POST") return;
    json({ data: { id: "ses_created", location: { directory: "/native/canonical/location" } } });
    return true;
  } });
  assert.deepEqual(await f.adapter.resolveSession(null, process.cwd(), new AbortController()), { sessionId: "ses_created", defaultEligible: true });
  assert.equal(f.requests.filter((request) => request.path === "/api/session" && request.method === "POST").length, 1);
  assert.deepEqual(await f.adapter.execute(f.input("ses_created", { onResponse: async () => {} })), { pending: true });
  assert.equal(f.requests.find((request) => request.path.endsWith("/prompt")).path, "/api/session/ses_created/prompt");
});

for (const id of [undefined, ""]) test(`native session creation requires usable identity (${String(id)})`, async (t) => {
  const f = await fixture(t, { onRequest: ({ req, url, json }) => {
    if (url.pathname !== "/api/session" || req.method !== "POST") return;
    json({ data: { id } });
    return true;
  } });
  await assert.rejects(f.adapter.resolveSession(null, process.cwd(), new AbortController()), /session identity/u);
});

test("successful native admission is not vetoed by a changed prompt echo", async (t) => {
  const f = await fixture(t, { onRequest: ({ url, body, json }) => {
    if (!url.pathname.endsWith("/prompt")) return;
    json({ data: { id: body.id, sessionID: "ses_one", time: { created: 1 }, type: "user", payload: { text: "native representation" }, delivery: "steer" } });
    return true;
  } });
  const responses = [];
  assert.deepEqual(await f.adapter.execute(f.input("ses_one", { onResponse: async (text) => responses.push(text) })), { pending: true });
  f.reply("ses_one", "msg_admitted", "Native work completed");
  await until(() => responses.length === 1);
  assert.deepEqual(responses, ["Native work completed"]);
  const admissions = f.requests.filter((request) => request.path.endsWith("/prompt"));
  assert.equal(admissions.length, 1);
  assert.equal(admissions[0].body.text, "exact prompt");
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

test("native active session failures retain native messages and later replies stay session-local", async (t) => {
  const f = await fixture(t);
  assert.deepEqual(await f.adapter.resolveSession("ses_one", process.cwd(), new AbortController()), { sessionId: "ses_one", defaultEligible: false });
  const errors = [];
  const responses = [];
  await f.adapter.followSession(f.input("ses_one", { onError: async (error) => errors.push(error), onResponse: async (text) => responses.push(text) }));
  await f.adapter.followSession(f.input("ses_two", { onResponse: async (text) => responses.push(text) }));
  f.emit("ses_one", "session.execution.failed", { error: { type: "provider.auth", status: 401, message: "Native provider rejected authentication.", response: { body: "not message text" } } });
  f.reply("ses_two", "msg_ok", "Other session works");
  await until(() => errors.length === 1 && responses.length === 1);
  assert.equal(errors[0].message, "Native provider rejected authentication.");
  assert.equal(errors[0].status, 401);
  f.reply("ses_one", "msg_recovered", "Same session continues");
  await until(() => responses.length === 2);
  assert.deepEqual(responses, ["Other session works", "Same session continues"]);
});

test("live moves, follow-ups and reconnect retain the original session and response deduplication", async (t) => {
  const f = await fixture(t);
  const responses = [], errors = [];
  await f.adapter.followSession(f.input("ses_one", { onResponse: async (text) => responses.push(text), onError: async (error) => errors.push(error) }));
  f.sessions.set("ses_one", { location: { directory: "/outside/worktree" } });
  f.messages.set("msg_moved", { id: "msg_moved", sessionID: "ses_one", type: "assistant", time: { completed: 2 }, content: [{ type: "text", text: "Moved reply" }], finish: "stop" });
  f.globalEvent("session.step.ended", { sessionID: "ses_one", assistantMessageID: "msg_moved", finish: "stop" }, { directory: "/outside/worktree" });
  await until(() => responses.length === 1);
  await f.adapter.execute(f.input("ses_one", { workingDirectory: "/outside/worktree", onResponse: async (text) => responses.push(text) }));
  for (const stream of f.globalStreams) stream.end();
  await until(() => f.requests.filter((r) => r.path === "/api/event").length === 2 && f.globalStreams.size === 1);
  f.globalEvent("session.step.ended", { sessionID: "ses_one", assistantMessageID: "msg_moved", finish: "stop" }, { directory: "/outside/worktree" });
  f.reply("ses_other", "msg_unrelated", "Unrelated reply");
  f.reply("ses_one", "msg_outside", "Reconnected reply");
  await until(() => responses.length === 2);
  assert.deepEqual(responses, ["Moved reply", "Reconnected reply"]);
  assert.deepEqual(errors, []);
  assert.equal(f.requests.filter((r) => r.path.endsWith("/prompt")).every((r) => r.path === "/api/session/ses_one/prompt"), true);
});

test("sessions moved before attachment resolve and continue without replacement", async (t) => {
  const f = await fixture(t);
  f.sessions.set("ses_one", { location: { directory: "/outside/worktree" } });
  assert.deepEqual(await f.adapter.resolveSession("ses_one", process.cwd(), new AbortController()), { sessionId: "ses_one", defaultEligible: false });
  const responses = [];
  await f.adapter.execute(f.input("ses_one", { onResponse: async (text) => responses.push(text) }));
  f.reply("ses_one", "msg_attached", "Same session");
  await until(() => responses.length === 1);
  assert.deepEqual(responses, ["Same session"]);
  assert.equal(f.requests.some((r) => r.method === "POST" && r.path === "/api/session"), false);
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
  assert.equal(errors[0].message, "Slack unavailable");
});

test("native response reads fail once with their original message and later responses still deliver", async (t) => {
  const f = await fixture(t, { onRequest: ({ url, json }) => {
    if (url.pathname.endsWith("/message/msg_failed")) {
      json({ _tag: "ServiceUnavailableError", message: "Native response storage unavailable" }, 503);
      return true;
    }
  } });
  const errors = [], responses = [];
  await f.adapter.followSession(f.input("ses_one", { onError: async (error) => errors.push(error), onResponse: async (text) => responses.push(text) }));
  f.reply("ses_one", "msg_failed", "Unreadable");
  await until(() => errors.length === 1);
  assert.equal(errors[0].message, "UnexpectedStatus: 503");
  assert.equal(errors[0].reason, "UnexpectedStatus");
  assert.equal(errors[0].cause.status, 503);
  assert.equal(f.requests.filter((request) => request.path.endsWith("/message/msg_failed")).length, 1);
  f.reply("ses_one", "msg_after_failure", "Still followed");
  await until(() => responses.length === 1);
  assert.deepEqual(responses, ["Still followed"]);
});

test("native catalog requests preserve the caller's cancellation signal without an added deadline", async () => {
  const controller = new AbortController();
  let requestSignal;
  const adapter = createV2Adapter({ baseUrl: "http://native.test", fetch: async (_url, init) => {
    requestSignal = init.signal;
    return Response.json({ data: [{ providerID: "native", id: "model", enabled: true }] });
  } });
  assert.deepEqual(await adapter.listModels(process.cwd(), controller.signal), { models: [{ providerID: "native", id: "model", name: undefined }] });
  assert.equal(requestSignal, controller.signal);
});

test("shutdown cancels an unfinished native response body and drains without delivery", async (t) => {
  const reached = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const f = await fixture(t, { onRequest: ({ url, res }) => {
    if (!url.pathname.endsWith("/message/msg_stalled")) return;
    res.writeHead(200, { "content-type": "application/json" });
    res.write('{"data":');
    res.on("close", () => disconnected.resolve());
    reached.resolve();
    return true;
  } });
  const responses = [], errors = [];
  await f.adapter.followSession(f.input("ses_one", { onResponse: async (text) => responses.push(text), onError: async (error) => errors.push(error) }));
  f.reply("ses_one", "msg_stalled", "Must not deliver");
  await reached.promise;
  f.adapter.stopAll(new Error("shutdown"));
  await f.adapter.drain();
  await disconnected.promise;
  assert.deepEqual(responses, []);
  assert.deepEqual(errors, []);
});

test("shutdown cancels a stalled explicit interrupt without a deadline or another submission", async (t) => {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  const f = await fixture(t, { onRequest: async ({ url }) => {
    if (url.pathname.endsWith("/interrupt")) { reached.resolve(); await release.promise; }
  } });
  let settled = false;
  const outcome = f.adapter.abortTurn("ses_one").then(() => null, (error) => error).then((result) => { settled = true; return result; });
  await reached.promise;
  f.adapter.stopAll(new Error("shutdown"));
  try {
    await until(() => settled);
    assert.match((await outcome).message, /shutdown/u);
    await f.adapter.drain();
    await assert.rejects(f.adapter.abortTurn("ses_one"), /shutdown/u);
    assert.equal(f.requests.filter((request) => request.path.endsWith("/interrupt")).length, 1);
  } finally { release.resolve(); await outcome; }
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
  const f = await fixture(t);
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
  const f = await fixture(t);
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

test("web-search setup and provider selection round-trip through Slack controls", async (t) => {
  for (const choice of ["allow", "choose", "disable"]) {
    const interactions = createPendingInteractions(["U1"]);
    t.after(() => interactions.close());
    const f = await fixture(t);
    const posted = [];
    const updated = [];
    const deleted = [];
    const thread = { id: "slack:C1:1.0", adapter: { webClient: { chat: {
      postMessage: async (message) => { posted.push(message); return { ts: `${posted.length}.0` }; },
      update: async (message) => updated.push(message),
      delete: async (message) => deleted.push(message),
    } } } };
    await f.adapter.followSession(f.input("ses_one", { onInteraction: (interaction) => interactions.onInteraction({ thread }, interaction) }));
    const form = { id: "frm_websearch", sessionID: "ses_one", title: "Web Search", metadata: { kind: "websearch.provider" }, fields: [{
      key: "choice", description: "Allow OpenCode to search the web for up-to-date information?", type: "string", required: true, custom: false,
      options: [
        { value: "allow", label: "Allow search via Exa, Firecrawl, Parallel, Tavily, TinyFish" },
        { value: "choose", label: "Choose another provider" },
        { value: "disable", label: "Disable web search" },
      ],
    }] };
    f.forms.push(form);
    f.globalEvent("form.created", { form });
    await until(() => posted.length === 1);
    const answer = async (card, label) => {
      assert.equal(card.channel, "C1");
      assert.equal(card.thread_ts, "1.0");
      assert.match(JSON.stringify(card), /Choose a provider|Allow OpenCode to search/u);
      assert.doesNotMatch(JSON.stringify(card), /requires an OpenCode client|Custom answer/u);
      const block = card.blocks.find((item) => item.elements?.[0]?.type === "radio_buttons");
      const select = block.elements[0];
      const submit = card.blocks.flatMap((item) => item.elements ?? []).find((item) => item.action_id?.startsWith("pipa_submit_"));
      await interactions.onAction({ actionId: submit.action_id, value: submit.value, threadId: thread.id, user: { userId: "U1" },
        raw: { state: { values: { [block.block_id]: { [select.action_id]: { type: "radio_buttons", selected_option: select.options.find((item) => item.text.text === label) } } } } },
      });
    };
    assert.equal(f.requests.some((request) => request.path.endsWith("/frm_websearch/reply")), false);
    await answer(posted[0], form.fields[0].options.find((option) => option.value === choice).label);
    assert.deepEqual(f.requests.find((request) => request.path.endsWith("/frm_websearch/reply")).body, { answer: { choice } });
    await until(() => updated.length === 1);
    if (choice === "choose") {
      const provider = { id: "frm_provider", sessionID: "ses_one", title: "Choose a web search provider", metadata: { kind: "websearch.provider" }, fields: [{
        key: "provider", description: "Choose a provider for web search.", type: "string", required: true, custom: false,
        options: [{ value: "exa", label: "Exa" }, { value: "tavily", label: "Tavily" }],
      }] };
      f.forms.push(provider);
      f.globalEvent("form.created", { form: provider });
      await until(() => posted.length === 2);
      await answer(posted[1], "Tavily");
      assert.deepEqual(f.requests.find((request) => request.path.endsWith("/frm_provider/reply")).body, { answer: { provider: "tavily" } });
      await until(() => updated.length === 2);
    }
    assert.deepEqual(deleted, []);
    assert.equal(f.requests.some((request) => request.path.endsWith("/interrupt") || request.method === "DELETE" && request.path.includes("/form/")), false);
  }
});

test("simple forms use field shapes rather than a closed list of metadata kinds or keys", async (t) => {
  for (const metadata of [undefined, { kind: "plugin.choice" }]) {
    const f = await fixture(t);
    const interactions = [];
    f.forms.push({ id: "frm_plugin", sessionID: "ses_one", title: "Project", metadata, fields: [
      { key: "project", type: "string", title: "Name", custom: true },
      { key: "colors", type: "multiselect", title: "Colors", options: [{ label: "Blue", value: "blue" }] },
    ] });
    await f.adapter.followSession(f.input("ses_one", { onInteraction: async (interaction) => { interactions.push(interaction); return { type: "cancelled" }; } }));
    await until(() => interactions.length === 1);
    assert.equal(interactions[0].type, "question");
    await interactions[0].submit({ type: "answer", answers: [["Pipa"], ["Blue"]] });
    assert.deepEqual(f.requests.find((request) => request.path.endsWith("/frm_plugin/reply")).body, { answer: { project: "Pipa", colors: ["blue"] } });
  }
});

test("native form validation rejection allows correcting the same pending form", async (t) => {
  let attempts = 0;
  const f = await fixture(t, { onRequest: ({ req, url, json }) => {
    if (req.method === "POST" && url.pathname.endsWith("/frm_validated/reply") && ++attempts === 1) {
      json({ _tag: "FormInvalidAnswerError", id: "frm_validated", message: "Enter a valid email." }, 400);
      return true;
    }
  } });
  const interactions = [];
  f.forms.push({ id: "frm_validated", sessionID: "ses_one", title: "Contact", fields: [
    { key: "email", type: "string", format: "email", required: true },
  ] });
  await f.adapter.followSession(f.input("ses_one", { onInteraction: async (interaction) => { interactions.push(interaction); return { type: "cancelled" }; } }));
  await until(() => interactions.length === 1);
  const interaction = interactions[0];
  assert.equal(interaction.type, "question");
  await assert.rejects(interaction.submit({ type: "answer", answers: [["not an email"]] }), { _tag: "FormInvalidAnswerError" });
  assert.equal(f.forms.length, 1, "native rejection must leave the form pending");
  await interaction.submit({ type: "answer", answers: [["person@example.com"]] });
  assert.equal(attempts, 2);
  assert.deepEqual(f.requests.filter((request) => request.path.endsWith("/frm_validated/reply")).map((request) => request.body), [
    { answer: { email: "not an email" } }, { answer: { email: "person@example.com" } },
  ]);
  assert.equal(f.forms.length, 0);
  assert.equal(interactions.length, 1, "correction must reuse the existing interaction");
});

test("richer or partially supported forms still require a native client", async (t) => {
  for (const field of [
    { type: "number" }, { type: "integer" }, { type: "boolean" }, { type: "external", url: "https://example.com/connect" },
    { type: "string", hidden: true }, { type: "string", when: [{ key: "q0", op: "eq", value: "allow" }] },
  ]) {
    const f = await fixture(t);
    const interactions = [];
    f.forms.push({ id: "frm_rich", sessionID: "ses_one", title: "Setup", metadata: { kind: "question" }, fields: [
      { key: "q0", type: "string", title: "Continue?" }, { key: "q1", ...field },
    ] });
    await f.adapter.followSession(f.input("ses_one", { onInteraction: async (interaction) => { interactions.push(interaction); return { type: "cancelled" }; } }));
    await until(() => interactions.length === 1);
    assert.equal(interactions[0].type, "form");
    await assert.rejects(interactions[0].submit({ type: "answer", answers: [["allow"], ["anything"]] }), /requires an OpenCode client/u);
    assert.equal(f.requests.some((request) => request.path.endsWith("/frm_rich/reply")), false);
  }
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
  f.permissions.push(permission, { ...permission, id: "per_outside", sessionID: "ses_outside" }, { ...permission, id: "per_unrelated", sessionID: "ses_two" });
  f.globalEvent("permission.asked", f.permissions[1], { directory: "/outside" });
  f.globalEvent("permission.asked", permission);
  f.globalEvent("permission.asked", f.permissions[2]);
  await until(() => interactions.length === 2);
  assert.deepEqual(new Set(interactions.map((item) => item.sessionId)), new Set(["ses_child", "ses_outside"]));
  await interactions.find((item) => item.sessionId === "ses_child").submit({ type: "reply", reply: "always" });
  await until(() => replies.length === 1);
  assert.deepEqual(replies[0], { sessionId: "ses_child", requestId: "per_child", reply: "always" });
  assert.equal(f.requests.filter((r) => r.path === "/api/event").length, 1);
  const pending = { ...permission, id: "per_reconnect" };
  f.permissions.push(pending);
  for (const stream of f.globalStreams) stream.end();
  await until(() => interactions.length === 3);
  const external = interactions.find((item) => item.request.id === pending.id);
  f.permissions.splice(f.permissions.findIndex((item) => item.id === pending.id), 1);
  f.globalEvent("permission.replied", { sessionID: "ses_child", requestID: pending.id, reply: "once" });
  await external.settled;
  await assert.rejects(external.submit({ type: "reply", reply: "once" }), /already settled/u);
  await until(() => snapshots.some((snapshot) => snapshot.sessionId === "ses_child" && snapshot.requestIds.size === 0));
});

test("attachment and reconnect discover pending requests in paginated independently moved descendants", async (t) => {
  const f = await fixture(t, { childPageSize: 1 });
  f.sessions.set("ses_one", { location: { directory: "/outside/root" } });
  f.sessions.set("ses_child", { parentID: "ses_one", location: { directory: "/outside/child" } });
  f.sessions.set("ses_second", { parentID: "ses_one", location: { directory: "/outside/second" } });
  f.sessions.set("ses_grandchild", { parentID: "ses_second", location: { directory: "/outside/grandchild" } });
  f.sessions.set("ses_unrelated", { location: { directory: "/outside/grandchild" } });
  const form = (sessionID) => ({ id: `frm_${sessionID}`, sessionID, title: "Continue?", fields: [{ key: "answer", type: "string" }] });
  const permission = (sessionID) => ({ id: `per_${sessionID}`, sessionID, action: "bash", resources: ["pwd"] });
  f.forms.push(form("ses_one"), form("ses_grandchild"), form("ses_unrelated"));
  f.permissions.push(permission("ses_child"), permission("ses_second"), permission("ses_unrelated"));
  const interactions = [];
  await f.adapter.followSession(f.input("ses_one", { onInteraction: async (item) => { interactions.push(item); return { type: "cancelled" }; } }));
  await until(() => interactions.length === 4);
  assert.deepEqual(new Set(interactions.map((item) => item.request.id)), new Set(["frm_ses_one", "frm_ses_grandchild", "per_ses_child", "per_ses_second"]));
  assert.ok(f.requests.some((r) => r.path === "/api/session" && r.parentID === "ses_one" && r.cursor === "1"));
  f.sessions.set("ses_new", { parentID: "ses_grandchild", location: { directory: "/outside/new" } });
  f.forms.push(form("ses_new"));
  for (const stream of f.globalStreams) stream.end();
  await until(() => interactions.length === 5);
  assert.equal(interactions[4].sessionId, "ses_new");
  assert.equal(f.requests.some((r) => r.path === "/api/session/ses_unrelated/form" || r.path === "/api/session/ses_unrelated/permission"), false);
  assert.equal(f.requests.some((r) => r.path === "/api/form" || r.path === "/api/permission/request"), false);
});

test("native child creation and location changes refresh pending controls without reconnect", async (t) => {
  const f = await fixture(t);
  const interactions = [];
  await f.adapter.followSession(f.input("ses_one", { onInteraction: async (item) => { interactions.push(item); return { type: "cancelled" }; } }));
  f.sessions.set("ses_child", { parentID: "ses_one", location: { directory: "/outside/child" } });
  f.permissions.push({ id: "per_created", sessionID: "ses_child", action: "bash", resources: ["pwd"] });
  f.globalEvent("session.created", { sessionID: "ses_child", parentID: "ses_one", location: { directory: "/outside/child" } }, { directory: "/outside/child" });
  await until(() => interactions.length === 1);
  f.forms.push({ id: "frm_moved", sessionID: "ses_child", title: "Continue?", fields: [{ key: "answer", type: "string" }] });
  f.sessions.set("ses_child", { parentID: "ses_one", location: { directory: "/outside/moved" } });
  f.globalEvent("session.moved", { sessionID: "ses_child", location: { directory: "/outside/moved" }, projectID: "proj_native" }, { directory: "/outside/moved" });
  await until(() => interactions.length === 2);
  assert.deepEqual(interactions.map((item) => item.request.id), ["per_created", "frm_moved"]);
});

test("reconciliation coalesces event bursts into one running scan and one follow-up", async (t) => {
  const release = Promise.withResolvers();
  let blocked = false;
  let scans = 0;
  const f = await fixture(t, { onRequest: async ({ url }) => {
    if (url.pathname === "/api/session" && url.searchParams.get("parentID") === "ses_one") {
      scans++;
      if (blocked) await release.promise;
    }
  } });
  t.after(() => release.resolve());
  const interactions = [];
  await f.adapter.followSession(f.input("ses_one", { onInteraction: async (item) => { interactions.push(item); return { type: "cancelled" }; } }));
  const baseline = scans;
  blocked = true;
  f.emit("ses_one", "session.tool.called", {});
  await until(() => scans === baseline + 1);
  for (let index = 0; index < 20; index++) {
    f.emit("ses_one", "session.tool.called", {});
    f.globalEvent("session.moved", { sessionID: "ses_one", location: { directory: process.cwd() }, projectID: "proj_native" });
  }
  // Drain the event queue while the descendant fetch is held, not by timing scan completion.
  f.globalEvent("permission.asked", { id: "per_barrier", sessionID: "ses_one", action: "bash", resources: ["pwd"] });
  await until(() => interactions.length === 1);
  assert.equal(scans, baseline + 1);
  release.resolve();
  await until(() => scans >= baseline + 2);
  await delay(100);
  assert.equal(scans, baseline + 2);
});

test("root approvals survive failing descendant reads and discovery", async (t) => {
  for (const failure of ["read", "discovery"]) {
    const f = await fixture(t, { onRequest: ({ url, json }) => {
      if (failure === "read" && url.pathname === "/api/session/ses_child/permission"
        || failure === "discovery" && url.pathname === "/api/session") { json({ secret: "never-log-this" }, 500); return true; }
    } });
    f.sessions.set("ses_child", { parentID: "ses_one" });
    f.permissions.push({ id: "per_root", sessionID: "ses_one", action: "bash", resources: ["pwd"] });
    const interactions = [];
    await f.adapter.followSession(f.input("ses_one", { onInteraction: async (item) => { interactions.push(item); return { type: "cancelled" }; } }));
    assert.deepEqual(interactions.map((item) => item.request.id), ["per_root"]);
  }
});

test("a failed scan still runs an already-requested reconciliation follow-up", async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let block = false;
  const f = await fixture(t);
  t.after(() => release.resolve());
  const seen = [];
  await f.adapter.followSession(f.input("ses_one", {
    onInteraction: async (item) => { seen.push(item.request.id); return { type: "cancelled" }; },
    onPermissionsReconciled: async () => {
      if (!block) return;
      block = false;
      started.resolve();
      await release.promise;
      throw new Error("callback failed");
    },
  }));
  block = true;
  f.emit("ses_one", "session.tool.called", {});
  await started.promise;
  f.permissions.push({ id: "per_pending", sessionID: "ses_one", action: "bash", resources: ["pwd"] });
  f.emit("ses_one", "session.tool.called", {});
  f.globalEvent("permission.asked", { id: "per_barrier", sessionID: "ses_one", action: "bash", resources: ["pwd"] });
  await until(() => seen.includes("per_barrier"));
  release.resolve();
  await until(() => seen.includes("per_pending"));
});

test("a successful permission snapshot dispatches before a stalled same-session form read", async (t) => {
  const release = Promise.withResolvers();
  const f = await fixture(t, { onRequest: async ({ url }) => {
    if (url.pathname === "/api/session/ses_one/form") await release.promise;
  } });
  const interactions = [];
  f.permissions.push({ id: "per_root", sessionID: "ses_one", action: "bash", resources: ["pwd"] });
  const following = f.adapter.followSession(f.input("ses_one", { onInteraction: async (item) => { interactions.push(item); return { type: "cancelled" }; } }));
  try {
    await until(() => interactions.length === 1);
    assert.equal(interactions[0].request.id, "per_root");
  } finally { release.resolve(); await following; }
});

test("failed descendant kinds stay editable while successful root and sibling kinds settle", async (t) => {
  let fail = false;
  const f = await fixture(t, { onRequest: ({ url, json }) => {
    if (fail && url.pathname === "/api/session/ses_child/permission"
      || fail && url.pathname === "/api/session/ses_one/form") { json({}, 500); return true; }
  } });
  f.sessions.set("ses_child", { parentID: "ses_one", location: { directory: "/outside/child" } });
  f.permissions.push(...["ses_one", "ses_child"].map((sessionID) => ({ id: `per_${sessionID}`, sessionID, action: "bash", resources: ["pwd"] })));
  f.forms.push(...["ses_one", "ses_child"].map((sessionID) => ({ id: `frm_${sessionID}`, sessionID, title: "Continue?", fields: [{ key: "answer", type: "string" }] })));
  const interactions = [];
  const snapshots = [];
  await f.adapter.followSession(f.input("ses_one", {
    onInteraction: async (item) => { interactions.push(item); return { type: "cancelled" }; },
    onPermissionsReconciled: async (item) => snapshots.push(item),
  }));
  await until(() => interactions.length === 4);
  const settled = new Set();
  for (const item of interactions) void item.settled.then(() => settled.add(item.request.id));
  snapshots.length = 0;
  f.permissions.splice(0, 1);
  f.forms.splice(1, 1);
  fail = true;
  await f.adapter.followSession(f.input("ses_one"));
  assert.deepEqual(settled, new Set(["per_ses_one", "frm_ses_child"]));
  assert.ok(snapshots.some((item) => item.sessionId === "ses_one" && item.requestIds.size === 0));
  assert.equal(snapshots.some((item) => item.sessionId === "ses_child"), false);
  fail = false;
  await interactions.find((item) => item.request.id === "per_ses_child").submit({ type: "reply", reply: "once" });
  await interactions.find((item) => item.request.id === "frm_ses_one").submit({ type: "answer", answers: [["yes"]] });
  await assert.rejects(interactions.find((item) => item.request.id === "per_ses_one").submit({ type: "reply", reply: "once" }), /already settled/u);
});

test("drain waits for a coalesced reconciliation callback", async (t) => {
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  let block = false;
  const f = await fixture(t);
  await f.adapter.followSession(f.input("ses_one", { onPermissionsReconciled: async () => {
    if (block) { started.resolve(); await release.promise; }
  } }));
  block = true;
  f.emit("ses_one", "session.tool.called", {});
  await started.promise;
  f.emit("ses_one", "session.tool.called", {});
  f.adapter.stopAll();
  let drained = false;
  const drain = f.adapter.drain().then(() => { drained = true; });
  try {
    await delay(10);
    assert.equal(drained, false);
  } finally { release.resolve(); await drain; }
  assert.equal(drained, true);
});

test("existing session lookup and native ancestry retain session ID validation", async (t) => {
  const f = await fixture(t);
  f.sessions.set("ses_wrong", { id: "ses_other" });
  await assert.rejects(f.adapter.resolveSession("ses_wrong", process.cwd(), new AbortController()), /session identity mismatch/u);
  const interactions = [];
  await f.adapter.followSession(f.input("ses_one", { onInteraction: async (item) => { interactions.push(item); return { type: "cancelled" }; } }));
  f.sessions.set("ses_child", { id: "ses_other", parentID: "ses_one", location: { directory: "/outside/child" } });
  f.permissions.push({ id: "per_wrong_identity", sessionID: "ses_child", action: "bash", resources: ["pwd"] });
  f.globalEvent("permission.asked", f.permissions[0], { directory: "/outside/child" });
  const form = { id: "frm_root", sessionID: "ses_one", title: "Continue?", fields: [{ key: "answer", type: "string" }] };
  f.forms.push(form);
  f.globalEvent("form.created", { form });
  await until(() => interactions.length === 1);
  assert.equal(interactions[0].request.id, "frm_root");
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

test("native model discovery accepts missing display names", async (t) => {
  const f = await fixture(t, { onRequest: ({ url, json }) => {
    if (url.pathname !== "/api/model") return;
    json({ data: [{ providerID: "native", id: "unnamed", enabled: true }] });
    return true;
  } });
  const catalog = await f.adapter.listModels(process.cwd(), new AbortController().signal);
  assert.deepEqual(catalog.models, [{ providerID: "native", id: "unnamed", name: undefined }]);
});

test("native model discovery is credential-free and switching precedes exact prompt admission", async (t) => {
  let defaultUnavailable = true;
  const f = await fixture(t, { onRequest: async ({ req, res, url, json }) => {
    if (url.pathname === "/api/model") {
      json({ location: { directory: "unused-catalog-location" }, data: [{ providerID: "native", id: "chosen", name: "Chosen model", enabled: true, variants: [{ id: null }], headers: { authorization: "secret" } }, { enabled: false, variants: null }] });
      return true;
    }
    if (url.pathname === "/api/model/default") {
      if (defaultUnavailable) { res.writeHead(503); res.end(); return true; }
      json({ location: { directory: process.cwd() }, data: { providerID: "native", id: "chosen" } });
      return true;
    }
    if (req.method === "POST" && url.pathname.endsWith("/model")) { res.writeHead(204); res.end(); return true; }
  } });
  const catalog = await f.adapter.listModels(process.cwd(), new AbortController().signal);
  assert.deepEqual(catalog, { models: [{ providerID: "native", id: "chosen", name: "Chosen model" }] });
  assert.equal(f.requests.some((request) => request.path === "/api/model/default"), false);
  defaultUnavailable = false;
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
