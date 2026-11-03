import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createConversationRunner, createPendingInteractions, startPipa } from "../src/app.mjs";
import { cleanChildEnvironment, createOpenCodeExecutor, startSocketOpenCodeServer } from "../src/opencode.mjs";
import { acquireInstanceLock, createSessionStore, pipaPaths } from "../src/state.mjs";
import { bounded, createRuntimeFixture, waitFor } from "./helpers/runtime-fixture.mjs";
import { assertPromptReceipt, assertSupersessionOutcome, assertTurnOutcome, createWireFixture, loadWireFixture, runTurnContract, validateEventStream } from "./helpers/opencode-contract.mjs";
import { abruptTurnProbe, assertNativeAdmissionCount, isNativeAdmission, releaseCases } from "../scripts/verification/opencode-release-cases.mjs";

test("release admission self-check: forbidden native v2 text and duplicate v1/v2 admissions fail", () => {
  const prompt = "exact café\n";
  const v1 = { path: "/session/ses_native/prompt_async", body: { parts: [{ type: "file" }, { type: "text", text: prompt }] } };
  const v2 = { path: "/api/session/ses_native/prompt", body: { text: prompt } };
  const unrelated = [{ path: "/api/session/ses_native/instruction", body: { text: prompt } }, { ...v2, body: { text: prompt.trim() } }];
  assertNativeAdmissionCount(unrelated, prompt, 0);
  for (const admission of [v1, v2]) {
    assert.equal(isNativeAdmission(admission, prompt), true);
    assertNativeAdmissionCount([admission, ...unrelated], prompt, 1);
    assert.throws(() => assertNativeAdmissionCount([admission], prompt, 0), /Native admission count/u);
    assert.throws(() => assertNativeAdmissionCount([admission, admission], prompt, 1), /Native admission count/u);
  }
  assert.throws(() => assertNativeAdmissionCount([v1, v2], prompt, 1), /Native admission count/u);
});

test("release catalog keeps native crash boundaries and separate unqualified model/Slack proofs", async () => {
  const ids = releaseCases.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["crash-after-admission", "crash-during-approval", "crash-after-completion"]) {
    assert.equal(releaseCases.find((row) => row.id === id)?.owner, "U2/U6");
  }
  assert.ok(releaseCases.find((row) => row.id === "slack-editable-retry-controls")?.blocked);
  assert.match(releaseCases.find(row => row.id === "plugin-reload-contract").expected, /v1 full native-process restart/u);
  for (const id of ["supersession-concurrency", "supersession-reaction-contract"]) {
    const definition = releaseCases.find((row) => row.id === id);
    assert.equal(definition.native, true, "Generation gating must be enforced by runCell");
    assert.deepEqual(definition.generations, ["1"]);
    assert.deepEqual(definition.modes, ["socket-owned", "attached"]);
  }
  for (const id of ["models-switch", "models-variants", "models-default", "models-reset"]) {
    const definition = releaseCases.find((row) => row.id === id);
    assert.deepEqual(definition.generations, ["2"]);
    assert.equal(definition.native, true);
    assert.equal(definition.blocked, undefined);
  }
  const workflow = await readFile(new URL("../.github/workflows/opencode-compatibility.yml", import.meta.url), "utf8");
  assert.match(workflow, /^  workflow_dispatch:/mu);
  assert.doesNotMatch(workflow, /^  (?:pull_request|push|schedule):/mu);
  assert.ok(workflow.includes("npm run test:engines -- --migration --gate=deterministic"));
});

for (const [generation, boundary, replacement] of [["v1", "admission"], ["v1", "approval"], ["v1", "completion"], ["v1", "completion", true]]) test(`release crash self-check: ${generation} SIGKILL at ${boundary}${replacement ? " with replacement" : ""} through production runner/native HTTP fixture (not engine recovery proof)`, async (t) => {
  const runtime = await createRuntimeFixture({ timeoutMs: 25000 });
  t.after(() => runtime.teardown());
  const document = await loadWireFixture(generation, runtime);
  const sessionFile = path.join(runtime.state, "crash-sessions.json");
  if (replacement) for (const route of document.routes.filter(route => ["/global/health", "/path"].includes(route.path))) route.repeatLast = true;
  const admission = Promise.withResolvers();
  if (boundary === "approval") {
    document.routes.find((route) => route.path === "/session/status").responses = [{ json: { ses_contract: { type: "busy" } } }];
    const messages = document.routes.find((route) => route.path.endsWith("/message"));
    messages.responses = [messages.responses[0]];
  }
  if (boundary === "completion") document.routes.find((route) => route.path.endsWith("/message")).responses.shift();
  const wire = createWireFixture(document);
  const serverErrors = [];
  const server = createServer(async (request, response) => {
    try {
      if (request.url.startsWith("/api/form?") || request.url.startsWith("/api/permission/request?")) {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ location: { directory: runtime.workspace }, data: [] }));
        return;
      }
      if (request.url.startsWith("/event?") || request.url === "/api/event") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.flushHeaders();
        await admission.promise;
        // A pending approval can only appear after actual prompt acceptance.
        if (boundary === "approval") response.write(document.routes.find((route) => route.path === "/event").responses[0].sse.split("\n\n")[0] + "\n\n");
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const result = await wire.fetch(`http://127.0.0.1${request.url}`, { method: request.method, ...(body ? { body } : {}) });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(await result.text());
      if (request.url.includes("/prompt_async?")) admission.resolve();
    } catch (error) { serverErrors.push(error); response.writeHead(500); response.end(); }
  });
  const baseUrl = await runtime.listen(server);
  const followup = "explicit replacement follow-up";
  const evidence = await abruptTurnProbe({ runtime, candidate: fileURLToPath(new URL("..", import.meta.url)), baseUrl, boundary, prompt: document.prompt, sessionFile, ...(replacement ? { followup } : {}) });
  assert.equal(evidence.boundary, boundary);
  assert.equal(evidence.sessionId, document.expected.sessionId);
  assert.equal(evidence.deliveryObserved, false);
  if (boundary === "completion") assertTurnOutcome(evidence.result, document.expected);
  if (replacement) {
    assertTurnOutcome(evidence.recovery.result, document.continuation);
    assert.equal(evidence.recovery.noReplay, true);
    assertNativeAdmissionCount(wire.calls, followup, 1);
  }
  if (boundary === "approval") assert.equal(evidence.requestId, "que_contract");
  assertNativeAdmissionCount(wire.calls, document.prompt, 1);
  assert.deepEqual(serverErrors, []);
  wire.assertComplete();
});

async function fixture(t, generation = "v1", options = {}) {
  const runtime = await createRuntimeFixture({ timeoutMs: 10_000 });
  t.after(() => runtime.teardown());
  const document = await loadWireFixture(generation, runtime);
  if (generation === "v2") {
    const projected = document.routes.find((route) => route.path.endsWith("/message"));
    projected.responses.unshift(...[0, 1].map(() => ({ json: { data: [], cursor: { previous: null, next: null } } })));
    projected.repeatLast = true;
    projected.required = false;
    document.routes.find((route) => route.path === "/api/session/active").required = false;
    document.routes.find((route) => route.path === "/api/event").required = false;
  }
  const wire = createWireFixture(document, options);
  const eventStreams = new Set();
  let sequence = 0;
  let admitted = false;
  const emit = (data) => {
    const seq = ++sequence;
    const event = { id: `evt_step_${seq}`, durable: { aggregateID: document.expected.sessionId, seq, version: 1 }, ...data };
    for (const stream of eventStreams) stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
  };
  const nativeFetch = async (url, init) => {
    const parsed = new URL(url);
    if (generation === "v2" && parsed.pathname === "/api/event") {
      return new Response(new ReadableStream({ start(controller) {
        const send = (event) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
        send({ type: "server.connected", data: {} });
        eventStreams.add(controller);
        init.signal.addEventListener("abort", () => { eventStreams.delete(controller); controller.close(); }, { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
    }
    if (generation === "v2" && /\/message\/[^/]+$/u.test(parsed.pathname)) {
      if (document.routes.some((route) => route.path === parsed.pathname)) return wire.fetch(url, init);
      const messages = document.routes.find((route) => route.path.endsWith("/message")).responses.at(-1).json.data;
      return Response.json({ data: messages.find((message) => message.id === parsed.pathname.split("/").at(-1)) });
    }
    if (generation === "v2" && parsed.pathname.endsWith("/instructions/entries")) return Response.json({ data: [] });
    if (generation === "v2" && parsed.pathname.includes("/instructions/entries/")) {
      const key = parsed.pathname.split("/").at(-1);
      assert.equal(key, "pipa.slack");
      if (!document.routes.some((route) => route.path === parsed.pathname)) {
        document.routes.push({ method: "PUT", path: parsed.pathname, repeatLast: true, responses: [{ status: 204 }] });
      }
    }
    if (generation === "v2" && parsed.pathname.endsWith("/message") && parsed.searchParams.get("limit") === "1") {
      const data = document.routes.find((route) => route.path.endsWith("/message")).responses[0].json.data;
      return Response.json({ data: data.slice(-1), cursor: { previous: null, next: null } });
    }
    if (generation === "v2" && parsed.pathname.endsWith("/message") && parsed.searchParams.get("limit") === "100") {
      const responses = document.routes.find((route) => route.path.endsWith("/message")).responses;
      return Response.json({ data: (admitted ? responses.at(-1) : responses[0]).json.data.toReversed(), cursor: { next: null, previous: null } });
    }
    if (generation === "v2" && parsed.pathname === "/api/session" && (init.method ?? "GET") === "GET"
      && !document.routes.some((route) => route.path === parsed.pathname && route.method === "GET" && route.query?.parentID === parsed.searchParams.get("parentID"))) {
      const children = document.routes.filter((route) => /^\/api\/session\/[^/]+$/u.test(route.path))
        .map((route) => route.responses[0].json?.data).filter((session) => session?.parentID === parsed.searchParams.get("parentID"));
      document.routes.push({ method: "GET", path: parsed.pathname, query: { parentID: parsed.searchParams.get("parentID") }, repeatLast: true,
        responses: [{ json: { data: children, cursor: { next: null } } }] });
    }
    if (generation === "v2" && /^\/api\/session\/[^/]+\/(?:form|permission)$/u.test(parsed.pathname)
      && !document.routes.some((route) => route.path === parsed.pathname)) {
      document.routes.push({ method: "GET", path: parsed.pathname, repeatLast: true, responses: [{ json: { data: [] } }] });
    }
    const result = await wire.fetch(url, init);
    if (generation === "v2" && parsed.pathname.endsWith("/prompt") && result.ok) {
      admitted = true;
      const message = document.routes.find((route) => route.path.endsWith("/message")).responses.at(-1).json.data.findLast((message) => message.type === "assistant");
      if (message) emit({ type: message.error ? "session.execution.failed" : "session.step.ended",
        data: { sessionID: document.expected.sessionId, assistantMessageID: message.id, finish: message.finish, ...(message.error ? { error: message.error } : {}) } });
    }
    return result;
  };
  const selectedFetch = options.transport ? (url, init) => options.transport(url, init, nativeFetch) : nativeFetch;
  const executor = createOpenCodeExecutor({ baseUrl: "http://127.0.0.1:4096", connection: { major: generation === "v1" ? 1 : 2, headers: {} }, fetch: selectedFetch, environment: runtime.env, artifactRoot: runtime.artifactRoot, pollIntervalMs: 1, inputId: () => "msg_input", ...options.executorOptions });
  runtime.defer(() => executor.stopAll(), "executor");
  const input = { prompt: document.prompt, sessionId: document.expected.sessionId, workingDirectory: runtime.workspace, signal: runtime.signal };
  return { runtime, document, wire, executor, input, fetch: selectedFetch, emit };
}

test("v2 background responses keep attachment context after initial admission and reply", async (t) => {
  const { executor, input, document, runtime, wire, emit } = await fixture(t, "v2");
  const legacyJournal = path.join(pipaPaths(runtime.home).directory, "opencode-recovery.json");
  await mkdir(path.dirname(legacyJournal), { recursive: true });
  await writeFile(legacyJournal, "legacy journal retained untouched");
  document.routes.find((route) => route.path.endsWith("/prompt")).body.files = [{ uri: `data:text/plain;base64,${Buffer.from("native background input").toString("base64")}`, name: "notes.txt" }];
  const responses = [];
  const result = await executor.runTurn({ ...input, contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack" },
    attachments: [{ name: "notes.txt", mimeType: "text/plain", fetchData: async () => Buffer.from("native background input") }],
    onResponse: async (response) => responses.push(response) });
  assert.equal(result.pending, true);
  await waitFor(() => responses.length === 1);
  const admitted = wire.calls.find((call) => call.path.endsWith("/prompt"));
  assert.match(admitted.body.files[0].uri, /^data:/u);
  const instructions = wire.calls.find((call) => call.method === "PUT" && call.path.endsWith("pipa.slack")).body.value;
  const directory = instructions.match(/private artifact directory: ([^\n]+)/u)[1];
  await access(directory);
  await writeFile(path.join(directory, "result.txt"), "verified background output");
  const messages = document.routes.find((route) => route.path.endsWith("/message")).responses.at(-1).json.data;
  messages.push({ id: "msg_background_result", type: "assistant", time: { created: 5, completed: 6 }, finish: "stop", content: [{ type: "text", text: 'Background finished.\nPIPA_ARTIFACTS: ["result.txt"]' }] });
  emit({ type: "session.step.ended", data: { sessionID: input.sessionId, assistantMessageID: "msg_background_result", finish: "stop" } });
  await waitFor(() => responses.length === 2);
  assert.equal(responses[1].text, "Background finished.");
  assert.equal(responses[1].files[0].data.toString(), "verified background output");
  assert.equal(await readFile(legacyJournal, "utf8"), "legacy journal retained untouched");
});

test("v1 baseline: exact prompt, trusted context and persisted-session continuation", async (t) => {
  const current = await fixture(t);
  const { runtime, document, wire, executor, input } = current;
  await executor.ready(runtime.workspace);
  assert.equal(executor.capabilities.modelDiscovery, true);
  assert.equal(executor.capabilities.liveModelSwitch, false);
  await assert.rejects(executor.switchModel({ sessionId: input.sessionId, model: null, workingDirectory: runtime.workspace }), /not supported/u);
  const store = await createSessionStore(pipaPaths(runtime.home).sessions);
  await store.set("slack:C1:1.0", document.expected.sessionId);
  const runner = createConversationRunner({ sessionStore: store, runTurn: executor.runTurn, abortTurn: executor.abortTurn });
  runtime.defer(async () => { runner.close(); await runner.drain(); }, "runner");
  const delivered = [];
  const context = { PIPA_MESSAGE_CHANNEL: "slack", PIPA_CURRENT_SLACK_CHANNEL_ID: "C1", PIPA_CURRENT_SLACK_THREAD_TS: "1.0" };
  const first = await runner.enqueue("slack:C1:1.0", { ...input, contextEnvironment: context, deliver: (result) => delivered.push(result.text) });
  assertTurnOutcome(first, document.expected, "v1 completion");
  const admission = wire.calls.find((call) => call.path.endsWith("/prompt_async"));
  const contextLines = admission.body.system.split("\n").filter((line) => line.startsWith("PIPA_") && line.includes("="));
  assertPromptReceipt({ prompt: admission.body.parts[0].text, context: Object.fromEntries(contextLines.map((line) => line.split("="))) }, { prompt: document.prompt, context }, "v1 context");
  assert.match(admission.body.system, /pipa routine --help/u);
  assert.doesNotMatch(admission.body.system, /When asked to restart|instance\/dispose/u);
  assert.doesNotMatch(admission.body.parts[0].text, /PIPA_CURRENT/u);
  const continued = await runner.enqueue("slack:C1:1.0", { ...input, prompt: "continue", deliver: (result) => delivered.push(result.text) });
  assertTurnOutcome(continued, document.continuation, "v1 continuation");
  assert.deepEqual(delivered, ["contract complete", "history retained"]);
  assert.equal((await createSessionStore(pipaPaths(runtime.home).sessions)).get("slack:C1:1.0"), document.expected.sessionId);
  assert.equal(wire.calls.filter((call) => call.path === "/session").length, 0, "continuation must not replace the mapped session");
  assert.doesNotMatch(wire.calls.filter((call) => call.path.endsWith("/prompt_async"))[1].body.system, /PIPA_CURRENT_SLACK_CHANNEL_ID=C1/u);
  wire.assertComplete();
});

test("v1 models: discovery supports the shipped flat picker and native object catalog without inference", async (t) => {
  const { runtime, document, executor, wire } = await fixture(t);
  document.routes.push({ method: "GET", path: "/config/providers", query: { directory: runtime.workspace }, repeatLast: true,
    responses: [{ json: { providers: [{ id: "connected", models: { shared: { name: "Shared", apiKey: "private-provider-secret" } } },
      { id: "other", models: { shared: { id: "shared", name: "Other" } } }], default: { connected: "shared" } } }] });
  assert.deepEqual(await executor.listModels(runtime.workspace), [
    { providerID: "connected", modelID: "shared", name: "Shared" }, { providerID: "other", modelID: "shared", name: "Other" },
  ]);
  assert.deepEqual(await executor.listModels({ workingDirectory: runtime.workspace }), {
    models: [{ providerID: "connected", id: "shared", name: "Shared", variants: ["default"] }, { providerID: "other", id: "shared", name: "Other", variants: ["default"] }],
    defaultModel: { providerID: "connected", id: "shared", variant: "default" },
  });
  assert.ok(wire.calls.every((call) => call.method === "GET"));
  wire.assertComplete();
});

for (const selection of ["explicit", "assistant", "interrupted", "new", "empty"]) test(`v1 models: ${selection} resolves model before one native prompt admission`, async (t) => {
  const { document, executor, input, wire } = await fixture(t);
  const model = { providerID: "selected", modelID: "a" };
  const defaultModel = { providerID: "default", modelID: "b" };
  const messages = document.routes.find((route) => route.path.endsWith("/message"));
  if (selection === "interrupted") messages.responses[0].json[0].info = { id: "msg_old", role: "user", model };
  if (["assistant", "explicit"].includes(selection)) Object.assign(messages.responses[0].json[0].info, model);
  if (selection === "empty") messages.responses[0].json = [];
  if (selection === "new") messages.responses.shift();
  await executor.runTurn({ ...input, ...(selection === "new" ? { sessionId: undefined } : {}), defaultModel,
    ...(selection === "explicit" ? { model: defaultModel } : {}) });
  const admissions = wire.calls.filter((call) => call.path.endsWith("/prompt_async"));
  assert.equal(admissions.length, 1);
  assert.deepEqual(admissions[0].body.model, ["explicit", "new", "empty"].includes(selection) ? defaultModel : model);
  wire.assertComplete();
});

for (const selection of ["new", "missing", "existing", "explicit", "unset"]) test(`v2 models: ${selection} bridges defaults/overrides through native switching without duplicate prompts`, async (t) => {
  const { runtime, document, executor, input, wire } = await fixture(t, "v2");
  const defaultModel = { providerID: "default", modelID: "b" };
  const model = { providerID: "snapshot", modelID: "a" };
  const shouldSwitch = ["new", "missing", "explicit"].includes(selection);
  if (selection === "existing") {
    const history = { id: "msg_history", type: "assistant", model: { providerID: "native", id: "retained", variant: "measured" }, time: { created: 0, completed: 1 }, finish: "stop", content: [] };
    for (const response of document.routes.find((route) => route.path.endsWith("/message")).responses) response.json.data.unshift(history);
  }
  if (selection === "missing") document.routes.find((route) => route.path === "/api/session/ses_contract").responses.unshift({ status: 404, json: { _tag: "SessionNotFoundError", sessionID: input.sessionId } });
  document.routes.push({ method: "POST", path: "/api/session/ses_contract/model", required: shouldSwitch, responses: [{ status: 204 }] });
  await executor.runTurn({ ...input, ...(selection === "new" ? { sessionId: undefined } : {}),
    ...(selection === "unset" ? {} : { defaultModel }), ...(selection === "explicit" ? { model } : {}) });
  const switches = wire.calls.filter((call) => call.path.endsWith("/model"));
  assert.equal(switches.length, shouldSwitch ? 1 : 0);
  if (shouldSwitch) {
    const selected = selection === "explicit" ? model : defaultModel;
    assert.deepEqual(switches[0].body, { model: { providerID: selected.providerID, id: selected.modelID, variant: "default" } });
    assert.ok(wire.calls.indexOf(switches[0]) < wire.calls.findIndex((call) => call.path.endsWith("/prompt")));
  }
  assert.equal(wire.calls.filter((call) => call.path.endsWith("/prompt")).length, 1);
  assert.equal(wire.calls.filter((call) => call.path === "/api/session").length, ["new", "missing"].includes(selection) ? 1 : 0);
  await assert.rejects(access(path.join(pipaPaths(runtime.home).directory, "opencode-recovery.json")), { code: "ENOENT" });
  wire.assertComplete();
});

for (const boundary of ["before-selection", "after-selection"]) test(`v2 default recovery: cancellation ${boundary} preserves the mapped empty session's model semantics`, async (t) => {
  const controller = new AbortController();
  const firstDefault = { providerID: "installation", modelID: "first" };
  const nextDefault = { providerID: "installation", modelID: "next" };
  const current = await fixture(t, "v2", { onRequest: (call) => {
    if (boundary === "after-selection" && call.path.endsWith("/model")) {
      current.document.routes.find((route) => route.path === "/api/session/ses_contract").responses[0].json.data.model = call.body.model;
      controller.abort(new Error("cancel after native selection"));
    }
  } });
  const { document, executor, input, wire, runtime } = current;
  document.routes.find((route) => route.path.endsWith("/message")).responses.unshift({ json: { data: [], cursor: { previous: null, next: null } } });
  document.routes.push({ method: "POST", path: "/api/session/ses_contract/model", repeatLast: true, responses: [{ status: 204 }] });
  let persisted;
  await assert.rejects(executor.runTurn({ ...input, sessionId: undefined, defaultModel: firstDefault, signal: controller.signal,
    onSession: (id) => {
      persisted = id;
      if (boundary === "before-selection") controller.abort(new Error("cancel before native selection"));
    },
  }), /cancel (?:before|after) native selection/u);
  assert.equal(persisted, input.sessionId);
  assert.equal(wire.calls.filter((call) => call.path.endsWith("/prompt")).length, 0);
  await executor.runTurn({ ...input, sessionId: persisted, defaultModel: nextDefault });
  const switches = wire.calls.filter((call) => call.path.endsWith("/model"));
  assert.equal(switches.length, 1, "an unselected empty session needs its default; an acknowledged native choice must not be replaced");
  assert.deepEqual(switches[0].body.model, { providerID: "installation", id: boundary === "before-selection" ? "next" : "first", variant: "default" });
  assert.equal(wire.calls.filter((call) => call.path === "/api/session").length, 1);
  assert.equal(wire.calls.filter((call) => call.path.endsWith("/prompt")).length, 1);
  await assert.rejects(access(path.join(pipaPaths(runtime.home).directory, "opencode-recovery.json")), { code: "ENOENT" });
  wire.assertComplete();
});

for (const selection of ["empty-native-choice", "model-switch-history"]) test(`v2 default recovery: retains ${selection} without applying the installation default`, async (t) => {
  const { document, executor, input, wire } = await fixture(t, "v2");
  const model = { providerID: "native", id: "user-choice", variant: "measured" };
  if (selection === "empty-native-choice") document.routes.find((route) => route.path === "/api/session/ses_contract").responses[0].json.data.model = model;
  else {
    const selected = { id: "msg_selected", type: "model-switched", model, time: { created: 1 } };
    for (const response of document.routes.find((route) => route.path.endsWith("/message")).responses) response.json.data.unshift(selected);
  }
  await executor.runTurn({ ...input, defaultModel: { providerID: "", modelID: "invalid-unused-default" } });
  assert.equal(wire.calls.filter((call) => call.path.endsWith("/model")).length, 0);
  assert.equal(wire.calls.filter((call) => call.path.endsWith("/prompt")).length, 1);
  wire.assertComplete();
});

for (const [label, error, providerID, expected] of [
  ["HTTP 401", { type: "provider.auth", status: 401, message: "invalid key private-message-secret" }, "connected", /selected provider authentication failed \(HTTP 401\)\. Reconnect that provider/u],
  ["expired key", { type: "provider.auth", status: 401, message: "This API key has expired. private-message-secret" }, "connected", /selected provider API key has expired\. Replace that provider's API key/u],
  ["native auth", { type: "provider.auth", message: "private-message-secret" }, "connected", /selected provider authentication failed\. Reconnect that provider/u],
  ["HTTP 429", { type: "provider.rate-limit", status: 429, message: "private-message-secret" }, "connected", /selected provider failed \(HTTP 429\)/u],
  ["unsafe provider", { type: "provider.auth", status: 401, message: "private-message-secret" }, "connected\nprivate-provider-secret", /selected provider authentication failed \(HTTP 401\)/u],
  ["unsafe type and misleading message", { type: "private-type-secret", status: 429, message: "HTTP 401 API key has expired private-message-secret" }, "connected", /OpenCode execution failed \(HTTP 429\)/u],
  ["tool failure", { type: "tool.failure", message: "private-message-secret" }, "connected", /OpenCode execution failed\./u],
  ["non-provider HTTP 401", { type: "tool.failure", status: 401, message: "private-message-secret" }, "connected", /OpenCode execution failed \(HTTP 401\)/u],
]) test(`v2 provider diagnostics: ${label} uses only safe native structured fields`, async (t) => {
  const { document, executor, input, wire, runtime } = await fixture(t, "v2");
  const timeline = document.routes.find((route) => route.path.endsWith("/message")).responses.at(-1).json.data;
  Object.assign(timeline.find((message) => message.type === "assistant"), {
    model: { providerID, id: "native" }, finish: "error", error: { ...error, response: { body: "API key has expired private-response-secret" } },
  });
  timeline.find((message) => message.type === "idle").outcome = "failed";
  await assert.rejects(executor.runTurn(input), (failure) => {
    assert.match(failure.message, expected);
    assert.doesNotMatch(failure.message, /private-(?:message|response|provider|type)-secret/u);
    if (error.type === "provider.auth") assert.match(failure.message, /change this session's model in OpenCode, then retry in this thread/u);
    if (!error.type.startsWith("provider.")) assert.doesNotMatch(failure.message, /provider|authentication/u);
    if (label !== "expired key") assert.doesNotMatch(failure.message, /expired/u);
    return true;
  });
  assert.equal(wire.calls.filter((call) => call.path.endsWith("/prompt")).length, 1);
  await assert.rejects(access(path.join(pipaPaths(runtime.home).directory, "opencode-recovery.json")), { code: "ENOENT" });
  wire.assertComplete();
});

test("v2 models: healthy catalog reads can exceed five seconds without fatal recovery", async (t) => {
  const failures = [];
  const { runtime, document, executor } = await fixture(t, "v2", {
    executorOptions: { onFatal: (error) => failures.push(error) },
    transport: async (url, init, nativeFetch) => {
      if (["/api/model", "/api/model/default"].includes(new URL(url).pathname)) {
        await new Promise((resolve, reject) => {
          const timer = setTimeout(resolve, 5_500);
          init.signal.addEventListener("abort", () => { clearTimeout(timer); reject(init.signal.reason); }, { once: true });
        });
      }
      return nativeFetch(url, init);
    },
  });
  const location = { directory: runtime.workspace };
  const model = { providerID: "connected", id: "shared", name: "Shared", enabled: true, variants: [] };
  document.routes.push(
    { method: "GET", path: "/api/model", query: { "location[directory]": runtime.workspace }, responses: [{ json: { location, data: [model] } }] },
    { method: "GET", path: "/api/model/default", query: { "location[directory]": runtime.workspace }, responses: [{ json: { location, data: model } }] },
  );
  assert.deepEqual(await bounded(executor.listModels(runtime.workspace), { timeoutMs: 8_000 }), [{ providerID: "connected", modelID: "shared", name: "Shared" }]);
  assert.deepEqual(failures, []);
});

for (const generation of ["v1", "v2"]) test(`${generation} models: picker discovery is bounded at 30s and aborts native reads`, async (t) => {
  const signals = [];
  const reading = Promise.withResolvers();
  const { runtime, executor } = await fixture(t, generation, { transport: async (url, init, nativeFetch) => {
    if (["/config/providers", "/api/model", "/api/model/default"].includes(new URL(url).pathname)) {
      signals.push(init.signal);
      if (signals.length === (generation === "v1" ? 1 : 2)) reading.resolve();
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    }
    return nativeFetch(url, init);
  } });
  await executor.ready(runtime.workspace);
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const rejected = assert.rejects(executor.listModels(runtime.workspace), /Model discovery timed out/u);
  await reading.promise;
  t.mock.timers.tick(29_999);
  assert.ok(signals.every((signal) => !signal.aborted));
  t.mock.timers.tick(1);
  await rejected;
  t.mock.timers.reset();
  assert.equal(signals.length, generation === "v1" ? 1 : 2);
  assert.ok(signals.every((signal) => signal.aborted));
});

for (const [error, expected] of [
  [{ name: "APIError", data: { statusCode: 401, message: "API key has expired private-secret" } }, /API key has expired/u],
  [{ name: "ProviderAuthError", data: { message: "private-secret" } }, /authentication failed/u],
  [{ name: "APIError", data: { statusCode: 429, message: "private-secret" } }, /failed \(HTTP 429\)/u],
]) test(`v1 provider failures preserve safe ${error.name}/${error.data.statusCode ?? "auth"} diagnostics`, async (t) => {
  const { document, executor, input } = await fixture(t);
  const messages = document.routes.find((route) => route.path.endsWith("/message"));
  Object.assign(messages.responses[1].json[0].info, { providerID: "connected", error });
  await assert.rejects(executor.runTurn(input), (failure) => {
    assert.match(failure.message, /provider "connected"/u);
    assert.match(failure.message, expected);
    assert.doesNotMatch(failure.message, /private-secret/u);
    return true;
  });
});

test("v2 models: provider-qualified discovery, native explicit selection and moved-session default reset", async (t) => {
  const { runtime, document, wire, executor, input } = await fixture(t, "v2");
  const location = { directory: runtime.workspace };
  const model = { providerID: "connected", id: "shared", name: "Shared", enabled: true, variants: [{ id: "measured" }] };
  const models = [model, { ...model, providerID: "other" }, { ...model, id: "disabled", enabled: false }];
  document.routes.push(
    { method: "GET", path: "/api/model", query: { "location[directory]": runtime.workspace }, repeatLast: true, responses: [{ json: { location, data: models } }] },
    { method: "GET", path: "/api/model/default", query: { "location[directory]": runtime.workspace }, repeatLast: true, responses: [{ json: { location, data: model } }] },
    { method: "POST", path: "/api/session/ses_contract/model", repeatLast: true, responses: [{ status: 204 }] },
  );
  const catalog = await executor.listModels({ workingDirectory: runtime.workspace });
  assert.equal(executor.capabilities.liveModelSwitch, true);
  assert.deepEqual(catalog, { models: ["connected", "other"].map((providerID) => ({ providerID, id: "shared", name: "Shared", variants: ["default", "measured"] })), defaultModel: { providerID: "connected", id: "shared", variant: "default" } });
  assert.deepEqual(await executor.listModels(runtime.workspace), ["connected", "other"].map((providerID) => ({ providerID, modelID: "shared", name: "Shared" })));
  const select = (model) => executor.switchModel({ sessionId: input.sessionId, model, workingDirectory: runtime.workspace });
  for (const invalid of [{ ...model, variant: "" }, undefined]) await assert.rejects(select(invalid), /Invalid/u);
  assert.equal(wire.calls.filter((call) => call.method === "POST" && call.path.endsWith("/model")).length, 0);
  await select({ providerID: "other", id: "shared", variant: "measured" });
  await select({ providerID: "connected", id: "shared" });
  await select(null);
  assert.deepEqual(wire.calls.filter((call) => call.method === "POST" && call.path.endsWith("/model")).map((call) => call.body), [
    { model: { providerID: "other", id: "shared", variant: "measured" } },
    { model: { providerID: "connected", id: "shared", variant: "default" } },
    { model: { providerID: "connected", id: "shared", variant: "default" } },
  ]);
  const lookup = document.routes.find((route) => route.path === "/api/session/ses_contract");
  lookup.responses = [{ json: { data: { id: input.sessionId, location: { directory: path.dirname(runtime.workspace) } } } }];
  await select({ providerID: "native-other-location", id: "not-in-starting-catalog" });
  for (const pathname of ["/api/model", "/api/model/default"]) document.routes.push({ method: "GET", path: pathname,
    query: { "location[directory]": path.dirname(runtime.workspace) }, repeatLast: true,
    responses: [{ json: { location: { directory: path.dirname(runtime.workspace) }, data: pathname.endsWith("/default") ? model : [model] } }] });
  await select(null);
  assert.equal(wire.calls.filter((call) => call.method === "POST" && call.path.endsWith("/model")).length, 5);
  executor.stopAll();
  await assert.rejects(select(null), /shutting down/u);
});

test("v2 explicit selection preserves native rejection without a catalog preflight or retry", async (t) => {
  let switches = 0;
  const { executor, input, wire } = await fixture(t, "v2", { transport: async (url, init, nativeFetch) => {
    if (new URL(url).pathname.endsWith("/model") && init.method === "POST") { switches++; return new Response(null, { status: 503 }); }
    return nativeFetch(url, init);
  } });
  await assert.rejects(executor.switchModel({ ...input, model: { providerID: "native", id: "unavailable" } }),
    (error) => error.reason === "UnexpectedStatus" && error.cause.status === 503);
  assert.equal(wire.calls.some((call) => call.path === "/api/model"), false);
  assert.equal(wire.calls.some((call) => call.path.endsWith("/prompt")), false);
  assert.equal(switches, 1);
});

for (const cancellation of ["stop", "caller"]) test(`v2 models: discovery rejects after ${cancellation} cancellation at a fetch barrier`, async (t) => {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  const signals = [];
  t.after(() => release.resolve());
  const { runtime, document, executor } = await fixture(t, "v2", { transport: async (url, init, nativeFetch) => {
    const response = await nativeFetch(url, init);
    if (["/api/model", "/api/model/default"].includes(new URL(url).pathname)) {
      signals.push(init.signal);
      if (signals.length === 2) reached.resolve();
      // Release a valid response even after cancellation to prove the facade
      // cannot return success from a transport that already received the body.
      await release.promise;
    }
    return response;
  } });
  const model = { providerID: "connected", id: "shared", name: "Shared", enabled: true, variants: [] };
  for (const [pathname, data] of [["/api/model", [model]], ["/api/model/default", model]]) document.routes.push({
    method: "GET", path: pathname, query: { "location[directory]": runtime.workspace }, repeatLast: true,
    responses: [{ json: { location: { directory: runtime.workspace }, data } }],
  });
  const controller = new AbortController();
  const operation = executor.listModels({ workingDirectory: runtime.workspace, ...(cancellation === "caller" ? { signal: controller.signal } : {}) });
  await reached.promise;
  if (cancellation === "stop") executor.stopAll();
  else controller.abort(new Error("cancel model discovery"));
  const abortedAtBarrier = signals.map((signal) => signal.aborted);
  release.resolve();
  await assert.rejects(operation, /shutting down|cancel model discovery/u);
  assert.deepEqual(abortedAtBarrier, [true, true], "Cancellation must abort both native discovery requests");
});

for (const method of ["listModels", "switchModel"]) test(`v2 models: ${method} aborts its pending sibling read on discovery failure`, async (t) => {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  let pendingSignal;
  const failureBody = { _tag: "UnauthorizedError", message: "Discovery HTTP 401" };
  const failure = new Response(JSON.stringify(failureBody), { status: 401, headers: { "content-type": "application/json" } });
  t.after(() => release.resolve());
  const { runtime, executor, input, wire } = await fixture(t, "v2", { transport: async (url, init, nativeFetch) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/model") {
      await reached.promise;
      return failure;
    }
    if (pathname === "/api/model/default") {
      pendingSignal = init.signal;
      reached.resolve();
      await Promise.race([release.promise, new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))]);
      return new Response(JSON.stringify({ location: { directory: runtime.workspace }, data: null }), { headers: { "content-type": "application/json" } });
    }
    return nativeFetch(url, init);
  } });
  await assert.rejects(executor[method]({ ...input, model: null }), (error) => {
    assert.equal(error._tag, failureBody._tag);
    assert.equal(error.message, failureBody.message, "The discovery failure must remain the original HTTP 401");
    return true;
  });
  assert.equal(pendingSignal.aborted, true, "Operation settlement must abort the pending sibling before unregistering");
  assert.ok(!wire.calls.some((call) => call.method !== "GET"), "Failed discovery must not mutate the session");
});

for (const failure of ["no-default", "wrong-location", "missing-session", "cancel", "stop"]) test(`v2 models: ${failure} prevents native mutation and replacement`, async (t) => {
  const reached = Promise.withResolvers();
  const release = Promise.withResolvers();
  const { runtime, document, executor, input, wire } = await fixture(t, "v2", { transport: async (url, init, nativeFetch) => {
    if (new URL(url).pathname === "/api/model" && ["cancel", "stop"].includes(failure)) {
      reached.resolve();
      await release.promise;
    }
    return nativeFetch(url, init);
  } });
  const model = { providerID: "connected", id: "shared", name: "Shared", enabled: true, variants: [] };
  const location = { directory: failure === "wrong-location" ? path.dirname(runtime.workspace) : runtime.workspace };
  document.routes.push(
    { method: "GET", path: "/api/model", query: { "location[directory]": runtime.workspace }, repeatLast: true, responses: [{ json: { location, data: [model] } }] },
    { method: "GET", path: "/api/model/default", query: { "location[directory]": runtime.workspace }, repeatLast: true, responses: [{ json: { location, data: failure === "no-default" ? null : model } }] },
  );
  if (failure === "missing-session") document.routes.find((route) => route.path === "/api/session/ses_contract").responses = [{ status: 404, json: { _tag: "SessionNotFoundError", sessionID: input.sessionId } }];
  const controller = new AbortController();
  const operation = executor.switchModel({ sessionId: input.sessionId, model: null, workingDirectory: runtime.workspace, signal: controller.signal });
  if (["cancel", "stop"].includes(failure)) {
    await reached.promise;
    if (failure === "stop") executor.stopAll();
    else controller.abort(new Error("cancel model selection"));
    release.resolve();
  }
  await assert.rejects(operation, /unavailable|workspace|cancel model|shutting down/u);
  assert.ok(!wire.calls.some((call) => call.method !== "GET"), "A rejected selection must make no native mutation");
  assert.equal(await readFile(path.join(pipaPaths(runtime.home).directory, "opencode-recovery.json"), "utf8").catch((error) => error.code), "ENOENT", "Selection must not create a preference/recovery record");
});

test("v1 baseline: subscription, duplicate question suppression and linked child permission", async (t) => {
  const replied = new Set();
  const current = await fixture(t, "v1", { onRequest: async (call) => {
    if (call.path.endsWith("/reply")) replied.add(call.path);
    if (call.path.endsWith("/prompt_async")) await waitFor(() => replied.size === 2, { label: "interaction replies" });
  } });
  const { document, wire, executor, input } = current;
  for (const route of document.routes) if (route.path.endsWith("/reply") || route.path === "/event") route.required = true;
  const seen = [];
  await runTurnContract({ executor, input: { ...input, onInteraction: (interaction) => {
    seen.push({ type: interaction.type, sessionId: interaction.sessionId, id: interaction.request.id });
    return interaction.type === "question" ? { type: "answer", answers: [["Blue"]] } : { type: "reply", reply: "once" };
  } }, expected: document.expected, caseName: "v1 question/child permission" });
  assert.deepEqual(seen, [
    { type: "question", sessionId: "ses_contract", id: "que_contract" },
    { type: "permission", sessionId: "ses_child", id: "per_contract" },
  ]);
  assert.ok(wire.calls.findIndex((call) => call.path === "/event") < wire.calls.findIndex((call) => call.path.endsWith("/prompt_async")));
  wire.assertComplete();
});

test("v2 native questions and child permissions expose acceptance without duplicate legacy submission", async (t) => {
  const replies = [];
  const current = await fixture(t, "v2", { onRequest: async (call) => {
    if (call.path.endsWith("/reply")) replies.push(call);
    if (call.path.endsWith("/prompt")) await waitFor(() => replies.length === 2, { label: "native interaction replies" });
  } });
  const { document, runtime, executor, input, wire } = current;
  const form = { id: "frm_contract", sessionID: "ses_contract", title: "Color", metadata: { kind: "question" }, fields: [{ key: "q0", type: "string", title: "Pick one", required: true, options: [{ value: "Blue", label: "Blue" }] }] };
  const permission = { id: "per_contract", sessionID: "ses_child", action: "bash", resources: ["pwd"] };
  for (const [route, json] of [
    ["/api/session/ses_contract/form", { data: [form] }],
    ["/api/session/ses_child/permission", { data: [permission] }],
    ["/api/session/ses_contract/form/frm_contract", { data: { ...form, state: { status: "pending" } } }],
    ["/api/session/ses_child", { data: { id: "ses_child", parentID: "ses_contract", location: { directory: runtime.workspace } } }],
  ]) document.routes.push({ method: "GET", path: route, repeatLast: true, responses: [{ json }] });
  const seen = [];
  await runTurnContract({ executor, input: { ...input, onInteraction: async (interaction) => {
    seen.push([interaction.type, interaction.sessionId]);
    assert.equal(typeof interaction.submit, "function");
    const decision = interaction.type === "question" ? { type: "answer", answers: [["Blue"]] } : { type: "reply", reply: "once" };
    await interaction.submit(decision);
    return decision;
  } }, expected: document.expected });
  assert.deepEqual(seen.sort(), [["permission", "ses_child"], ["question", "ses_contract"]]);
  assert.equal(replies.length, 2);
  wire.assertComplete();
});

async function nativeInteractions(t, { forms = [], permissions = [], onReply, onPrompt, transport, executorOptions } = {}) {
  const pendingForms = [...forms], pendingPermissions = [...permissions];
  const calls = [];
  const current = await fixture(t, "v2", {
    transport,
    executorOptions,
    onRequest: async (call) => {
      if (call.path.endsWith("/prompt")) await onPrompt?.();
      if (call.path.endsWith("/reply") || (call.method === "DELETE" && call.path.includes("/form/"))) {
        calls.push(call);
        await onReply?.(call, pendingForms, pendingPermissions);
      }
    },
  });
  const { document, runtime } = current;
  // Keep the original completion event; discovery comes from native pending reads.
  document.routes.find((route) => route.path === "/api/event").responses[0].sse = document.routes.find((route) => route.path === "/api/event").responses[0].sse.split("\n\n").filter((frame) => frame.includes("evt_done")).join("\n\n") + "\n\n";
  for (const [route, json, query] of [
    ["/api/session/ses_child", { data: { id: "ses_child", parentID: "ses_contract", location: { directory: runtime.workspace } } }],
    ["/api/session/ses_unrelated", { data: { id: "ses_unrelated", location: { directory: runtime.workspace } } }],
    ["/api/session/ses_child/message/msg_tool", { data: { id: "msg_tool", type: "assistant", time: { created: 2 }, content: [{ type: "tool", id: "call_native", name: "bash", time: { created: 2 }, state: { status: "running", input: { command: "pwd" }, metadata: {} } }] } }],
    ["/api/session/ses_other_tree", { data: { id: "ses_other_tree", parentID: "ses_unrelated", location: { directory: path.dirname(runtime.workspace) } } }],
  ]) document.routes.push({ method: "GET", path: route, ...(query ? { query } : {}), repeatLast: true, responses: [{ json }] });
  for (const sessionId of ["ses_contract", "ses_child", "ses_unrelated", "ses_other_tree"]) {
    for (const [kind, pending] of [["form", pendingForms], ["permission", pendingPermissions]]) document.routes.push({
      method: "GET", path: `/api/session/${sessionId}/${kind}`, repeatLast: true,
      responses: [{ json: { get data() { return pending.filter((item) => item.sessionID === sessionId); } } }],
    });
  }
  for (const form of forms) {
    document.routes.push({ method: "GET", path: `/api/session/${form.sessionID}/form/${form.id}`, repeatLast: true, responses: [{ json: { data: { ...form, state: { status: "pending" } } } }] });
    document.routes.push({ method: "POST", path: `/api/session/${form.sessionID}/form/${form.id}/reply`, repeatLast: true, responses: [{ status: 204 }] });
    document.routes.push({ method: "DELETE", path: `/api/session/${form.sessionID}/form/${form.id}`, repeatLast: true, responses: [{ status: 204 }] });
  }
  for (const permission of permissions) document.routes.push({ method: "POST", path: `/api/session/${permission.sessionID}/permission/${permission.id}/reply`, repeatLast: true, responses: [{ status: 204 }] });
  return { ...current, pendingForms, pendingPermissions, calls };
}

const nativeExamples = JSON.parse(await readFile(new URL("./fixtures/opencode/v2/interactions.json", import.meta.url), "utf8"));

for (const settlementEvent of ["question.replied", "question.rejected"]) test(`U3 v1 external question settlement observed during an uncertain pending read survives its stale snapshot: ${settlementEvent}`, async (t) => {
  const staleRead = Promise.withResolvers(), releaseRead = Promise.withResolvers(), nextObserved = Promise.withResolvers(), finished = Promise.withResolvers();
  const question = { id: "que_contract", sessionID: "ses_contract", questions: [{ question: "Pick", options: [{ label: "Blue" }] }] };
  const next = { ...question, id: "que_next" };
  let stream, questionReads = 0;
  const current = await fixture(t, "v1", {
    onRequest: async (call) => { if (call.path.endsWith("/prompt_async")) await finished.promise; },
    transport: async (url, init, fetch) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/event") return new Response(new ReadableStream({ start(controller) {
        stream = controller;
        controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "question.asked", properties: question })}\n\n`));
        init.signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
      } }), { headers: { "content-type": "text/event-stream" } });
      if (pathname === "/question/que_contract/reply") { await fetch(url, init); throw new TypeError("lost native reply"); }
      if (pathname === "/question" && ++questionReads === 2) {
        staleRead.resolve();
        await releaseRead.promise;
        return new Response(JSON.stringify([question]), { headers: { "content-type": "application/json" } });
      }
      return fetch(url, init);
    },
  });
  current.document.routes.push({ method: "POST", path: "/question/que_next/reply", query: { directory: current.runtime.workspace }, body: { answers: [["Blue"]] }, responses: [{ json: true }] });
  const posted = [], deleted = [];
  const thread = { id: "slack:C1:1.0", adapter: { webClient: { chat: {
    postMessage: async (value) => { posted.push(value); return { ts: String(posted.length) }; }, update: async () => {}, delete: async (value) => deleted.push(value),
  } } } };
  const controls = createPendingInteractions();
  const decisions = [];
  const turn = current.executor.runTurn({ ...current.input, onInteraction: (interaction) => {
    if (interaction.request.id === next.id) nextObserved.resolve();
    const decision = controls.onInteraction({ thread }, interaction);
    void decision.catch(() => undefined);
    decisions.push(decision);
    return decision;
  } });
  const answer = async (card) => {
    const elements = card.blocks.flatMap((block) => block.elements ?? []);
    const select = elements.find((item) => item.action_id.startsWith("pipa_select_"));
    const submit = elements.find((item) => item.action_id.startsWith("pipa_submit_"));
    const click = (item, value = item.value) => controls.onAction({ threadId: thread.id, user: { userId: "U1" }, actionId: item.action_id, value });
    await click(select, select.options[0].value);
    await click(submit);
  };
  try {
    await waitFor(() => posted.length === 1);
    const click = answer(posted[0]);
    await bounded(staleRead.promise, { signal: current.runtime.signal });
    for (const event of [{ type: settlementEvent, properties: { sessionID: question.sessionID, requestID: question.id, ...(settlementEvent === "question.replied" ? { answers: [["Blue"]] } : {}) } }, { type: "question.asked", properties: next }]) stream.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`));
    await bounded(nextObserved.promise, { signal: current.runtime.signal });
    releaseRead.resolve();
    await click;
    assert.deepEqual(await bounded(decisions[0], { timeoutMs: 100, label: "external settlement releases first card" }), { type: "cancelled" });
    await waitFor(() => posted.length === 2);
    assert.equal(deleted.length, 1);
    await answer(posted[1]);
    finished.resolve();
    assertTurnOutcome(await turn, current.document.expected);
    assert.equal(current.wire.calls.filter((call) => call.path === "/question/que_contract/reply").length, 1);
    current.wire.assertComplete();
  } finally { releaseRead.resolve(); finished.resolve(); await turn.catch(() => undefined); }
});

for (const failure of ["network", "503"]) test(`U3 v1 rejected ancestry lookup is retried on reconnect without routing unverified or foreign children (${failure})`, async (t) => {
  const failed = Promise.withResolvers(), retryReached = Promise.withResolvers(), releaseRetry = Promise.withResolvers(), reconciled = Promise.withResolvers(), replied = Promise.withResolvers(), finished = Promise.withResolvers();
  const child = { id: "que_contract", sessionID: "ses_child", questions: [{ question: "Pick", options: [{ label: "Blue" }] }] };
  const pending = [child, { ...child, id: "que_foreign", sessionID: "ses_foreign" }, { ...child, id: "que_missing", sessionID: "ses_missing" }];
  let lookups = 0, streams = 0;
  const current = await fixture(t, "v1", {
    onRequest: async (call) => {
      if (call.path.endsWith("/prompt_async")) await finished.promise;
      if (call.path === "/question/que_contract/reply") replied.resolve();
    },
    transport: async (url, init, next) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/event") {
        const sse = ++streams === 1 ? `data: ${JSON.stringify({ type: "question.asked", properties: child })}\n\n` : "";
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }
      if (pathname === "/session/ses_parent") {
        if (++lookups === 2) { retryReached.resolve(); await releaseRetry.promise; }
        const response = await next(url, init);
        if (lookups === 1) {
          failed.resolve();
          if (failure === "network") throw new TypeError("transient ancestry lookup failure");
        }
        return response;
      }
      return next(url, init);
    },
  });
  const { document, executor, input, wire } = current;
  document.routes.find((route) => route.path === "/question").responses = [{ json: [] }, { json: pending }];
  document.routes.find((route) => route.path === "/session/ses_child").responses[0].json.parentID = "ses_parent";
  const query = { directory: input.workingDirectory };
  document.routes.push(
    { method: "GET", path: "/session/ses_parent", query, responses: [{ status: 503, raw: "unavailable" }, { json: { id: "ses_parent", parentID: input.sessionId, directory: input.workingDirectory } }] },
    { method: "GET", path: "/session/ses_foreign", query, responses: [{ json: { id: "ses_foreign", parentID: input.sessionId, directory: path.dirname(input.workingDirectory) } }] },
    { method: "GET", path: "/session/ses_missing", query, responses: [{ json: null }] },
  );
  const seen = [];
  const turn = executor.runTurn({ ...input, onInteraction: (interaction) => {
    seen.push([interaction.sessionId, interaction.request.id]);
    return { type: "answer", answers: [["Blue"]] };
  }, onPermissionsReconciled: () => { if (lookups === 2) reconciled.resolve(); } });
  try {
    await bounded(failed.promise);
    await bounded(retryReached.promise, { timeoutMs: 1000, label: "reconnect retries the rejected intermediate ancestry lookup" });
    assert.deepEqual(seen, [], "No callback may route until the full ancestry is proven");
    releaseRetry.resolve();
    await bounded(reconciled.promise);
    await bounded(replied.promise);
    assert.deepEqual(seen, [["ses_child", "que_contract"]], "Foreign-directory and null lookups must not route");
    assert.ok(streams >= 2, "Retry must occur within the same watcher after reconnect");
    assert.equal(wire.calls.filter((call) => call.path === "/session/ses_parent").length, 2);
    assert.equal(wire.calls.filter((call) => call.path === "/session/ses_child").length, 1, "Successful ancestry entries remain cached");
    finished.resolve();
    assertTurnOutcome(await turn, document.expected);
    wire.assertComplete();
  } finally { releaseRetry.resolve(); finished.resolve(); await turn.catch(() => undefined); }
});

test("U3 v1 optional permission hydration 503 followed by reconnect registers one usable control", async (t) => {
  const failedHydration = Promise.withResolvers(), allow = Promise.withResolvers(), finished = Promise.withResolvers();
  const permission = { id: "per_hydrate", sessionID: "ses_contract", permission: "bash", patterns: ["pwd"], tool: { messageID: "msg_hydrate", callID: "call_hydrate" } };
  let stream, streams = 0, hydrationReads = 0;
  const current = await fixture(t, "v1", {
    onRequest: async (call) => {
      if (call.path.endsWith("/prompt_async")) await finished.promise;
      if (call.path.endsWith("per_hydrate/reply")) finished.resolve();
    },
    transport: async (url, init, fetch) => {
      const parsed = new URL(url);
      if (parsed.pathname === "/event") {
        streams++;
        return new Response(new ReadableStream({ start(controller) {
          stream = controller;
          if (streams === 1) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "permission.asked", properties: permission })}\n\n`));
          init.signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
        } }), { headers: { "content-type": "text/event-stream" } });
      }
      if (parsed.pathname === "/permission" && hydrationReads > 0) return new Response(JSON.stringify([permission]), { headers: { "content-type": "application/json" } });
      if (parsed.pathname.endsWith("/message") && parsed.searchParams.get("limit") === "100" && ++hydrationReads === 1) {
        failedHydration.resolve();
        return new Response("unavailable", { status: 503 });
      }
      return fetch(url, init);
    },
  });
  current.document.routes.push({ method: "GET", path: "/session/ses_contract/message", query: { directory: current.runtime.workspace, limit: "100" }, responses: [{ json: [{ info: { id: "msg_hydrate", role: "assistant" }, parts: [{ type: "tool", callID: "call_hydrate", tool: "bash", state: { input: { command: "pwd" } } }] }] }] });
  current.document.routes.push({ method: "POST", path: "/permission/per_hydrate/reply", query: { directory: current.runtime.workspace }, body: { reply: "once" }, responses: [{ json: true }] });
  const seen = [];
  const turn = current.executor.runTurn({ ...current.input, onInteraction: async (interaction) => { seen.push(interaction); await allow.promise; return { type: "reply", reply: "once" }; } });
  try {
    await bounded(failedHydration.promise, { signal: current.runtime.signal });
    stream.close();
    await waitFor(() => streams === 2);
    assert.equal(seen.length, 1, "a failed optional detail read must not permanently deduplicate the permission");
    assert.equal(typeof seen[0].submit, "function");
    assert.equal(seen[0].request.permission, "bash");
    allow.resolve();
    assertTurnOutcome(await turn, current.document.expected);
    assert.equal(seen.length, 1);
    assert.equal(current.wire.calls.filter((call) => call.path.endsWith("per_hydrate/reply")).length, 1);
    current.wire.assertComplete();
  } finally { allow.resolve(); finished.resolve(); await turn.catch(() => undefined); }
});

test("U3 v1 acknowledgement preserves positional arrays and retries rejection without duplicate native submission", async (t) => {
  const finished = Promise.withResolvers();
  const current = await fixture(t, "v1", { onRequest: async (call) => { if (call.path.endsWith("/prompt_async")) await finished.promise; } });
  const reply = current.document.routes.find((route) => route.path === "/question/que_contract/reply");
  reply.responses.unshift({ status: 400, json: { error: "Invalid answer" } });
  let retried = false;
  const result = await current.executor.runTurn({ ...current.input, onInteraction: async (interaction) => {
    if (interaction.type === "permission") return { type: "reply", reply: "once" };
    try {
      await assert.rejects(interaction.submit({ type: "answer", answers: [["Blue"]] }), /400/u);
      await interaction.submit({ type: "answer", answers: [["Blue"]] });
      retried = true;
      return { type: "answer", answers: [["Blue"]] };
    } finally { finished.resolve(); }
  } });
  assertTurnOutcome(result, current.document.expected);
  assert.equal(retried, true);
  assert.deepEqual(current.wire.calls.filter((call) => call.path === reply.path).map((call) => call.body), [{ answers: [["Blue"]] }, { answers: [["Blue"]] }]);
  current.wire.assertComplete();
});

test("U3 v1 reconnect reconciles externally settled questions without submitting a stale callback", async (t) => {
  const disconnected = Promise.withResolvers(), done = Promise.withResolvers();
  let streams = 0, stream;
  const current = await fixture(t, "v1", {
    onRequest: async (call) => { if (call.path.endsWith("/prompt_async")) await done.promise; },
    transport: async (url, init, fetch) => {
      if (new URL(url).pathname !== "/event") return fetch(url, init);
      streams++;
      if (streams === 2) disconnected.resolve();
      return new Response(new ReadableStream({ start(controller) { stream = controller; init.signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true }); } }), { headers: { "content-type": "text/event-stream" } });
    },
  });
  const route = current.document.routes.find((route) => route.path === "/question");
  const question = { id: "que_contract", sessionID: "ses_contract", questions: [{ question: "Pick", options: [{ label: "Blue" }] }] };
  route.responses = [{ json: [question] }, { json: [question] }, { json: [] }];
  const observed = Promise.withResolvers();
  let callbacks = 0, settled = false;
  const turn = current.executor.runTurn({ ...current.input, onInteraction: async (interaction) => {
    callbacks++;
    observed.resolve();
    await interaction.settled;
    settled = true;
    done.resolve();
    return { type: "answer", answers: [["Blue"]] };
  } });
  await observed.promise;
  stream.close();
  await disconnected.promise;
  assertTurnOutcome(await turn, current.document.expected);
  assert.equal(settled, true);
  assert.equal(callbacks, 1);
  assert.equal(current.wire.calls.some((call) => call.path.endsWith("/reply")), false);
  current.wire.assertComplete();
});

test("U3 v1 lost question reply reconciles native absence and suppresses a legacy return decision", async (t) => {
  const done = Promise.withResolvers();
  let lost = false;
  const current = await fixture(t, "v1", {
    onRequest: async (call) => { if (call.path.endsWith("/prompt_async")) await done.promise; },
    transport: async (url, init, fetch) => {
      const result = await fetch(url, init);
      if (new URL(url).pathname === "/question/que_contract/reply" && !lost) { lost = true; throw new TypeError("lost response"); }
      return result;
    },
  });
  let reconciled = false;
  const result = await current.executor.runTurn({ ...current.input, onInteraction: async (interaction) => {
    if (interaction.type === "permission") return { type: "reply", reply: "once" };
    try {
      await interaction.submit({ type: "answer", answers: [["Blue"]] });
      await interaction.settled;
      await assert.rejects(interaction.submit({ type: "answer", answers: [["Blue"]] }), /settled/u);
      reconciled = true;
      return { type: "answer", answers: [["Blue"]] };
    } finally { done.resolve(); }
  } });
  assertTurnOutcome(result, current.document.expected);
  assert.equal(reconciled, true);
  assert.equal(current.wire.calls.filter((call) => call.path === "/question/que_contract/reply").length, 1);
  current.wire.assertComplete();
});

test("U3 v2 lost keyed-form reply reads native answered state before making the stale response inert", async (t) => {
  const done = Promise.withResolvers();
  let lost = false;
  const current = await nativeInteractions(t, { forms: [nativeExamples.question], onPrompt: () => done.promise,
    transport: async (url, init, fetch) => {
      const response = await fetch(url, init);
      if (new URL(url).pathname.endsWith("frm_native/reply") && !lost) {
        lost = true;
        current.pendingForms.splice(0);
        const detail = current.document.routes.find((route) => route.method === "GET" && route.path.endsWith("frm_native"));
        detail.responses[0].json.data.state = { status: "answered", answer: { q0: "blue-id", q1: ["fast-id"], q2: "name" } };
        throw new TypeError("lost response");
      }
      return response;
    },
  });
  let reconciled = false;
  const result = await current.executor.runTurn({ ...current.input, onInteraction: async (interaction) => {
    try {
      await interaction.submit({ type: "answer", answers: [["Blue"], ["Fast"], ["name"]] });
      await interaction.settled;
      await assert.rejects(interaction.submit({ type: "answer", answers: [["Red"], ["Small"], ["other"]] }), /settled/u);
      reconciled = true;
      return { type: "answer", answers: [["Blue"], ["Fast"], ["name"]] };
    } finally { done.resolve(); }
  } });
  assertTurnOutcome(result, current.document.expected);
  assert.equal(reconciled, true);
  assert.equal(current.calls.length, 1);
  assert.equal(current.wire.calls.filter((call) => call.method === "GET" && call.path.endsWith("frm_native")).length, 2);
  current.wire.assertComplete();
});

test("U3 v2 dismissal cancels the child form and interrupts only its session", async (t) => {
  const done = Promise.withResolvers();
  const current = await nativeInteractions(t, { forms: [nativeExamples.question], onPrompt: () => done.promise });
  current.document.routes.push({ method: "POST", path: "/api/session/ses_child/interrupt", query: { resume: "false" }, responses: [{ json: { interrupted: true } }] });
  let submitted = false;
  const result = await current.executor.runTurn({ ...current.input, onInteraction: async (interaction) => {
    try { await interaction.submit({ type: "stop" }); submitted = true; return { type: "stop" }; }
    finally { done.resolve(); }
  } });
  assert.equal(result.text, "");
  assert.equal(submitted, true);
  assert.deepEqual(current.calls.map((call) => [call.method, call.path]), [["DELETE", "/api/session/ses_child/form/frm_native"]]);
  assert.equal(current.wire.calls.filter((call) => call.path.endsWith("/interrupt")).length, 1);
  current.wire.assertComplete();
});

test("U3 v2 reconnect duplicates produce one callback and reload cancellation makes replies inert", async (t) => {
  let frames;
  let streams = 0;
  const current = await nativeInteractions(t, { forms: [nativeExamples.question], transport: async (url, init, fetch) => {
    if (new URL(url).pathname !== "/api/event") return fetch(url, init);
    streams++;
    return new Response(new ReadableStream({ start(controller) {
      frames = controller;
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ id: `evt_${streams}`, created: 2, type: "form.created", data: { form: nativeExamples.question } })}\n\n`));
      init.signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const messages = current.document.routes.find((route) => route.path.endsWith("/message"));
  const completed = messages.responses.at(-1);
  messages.responses[messages.responses.length - 1] = { json: { data: [completed.json.data[0]], cursor: { previous: null, next: null } } };
  const seen = [];
  const turn = current.executor.runTurn({ ...current.input, onInteraction: async (interaction) => { seen.push(interaction); await interaction.settled; return { type: "answer", answers: [["Blue"], ["Fast"], ["name"]] }; } });
  await waitFor(() => seen.length === 1);
  frames.close();
  await waitFor(() => streams === 2);
  assert.equal(seen.length, 1);
  current.pendingForms.splice(0);
  frames.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "form.cancelled", data: { sessionID: "ses_contract", id: nativeExamples.question.id } })}\n\n`));
  await seen[0].settled;
  await assert.rejects(seen[0].submit({ type: "reject" }), /settled/u);
  messages.responses[messages.responses.length - 1] = completed;
  frames.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type: "session.step.ended", data: { sessionID: "ses_contract", assistantMessageID: completed.json.data.find((message) => message.type === "assistant").id, finish: "stop" } })}\n\n`));
  assertTurnOutcome(await turn, current.document.expected);
  assert.equal(current.calls.length, 0);
  current.wire.assertComplete();
});

test("U3 v2 retains scoped permission notification callbacks and suppresses repeated replies", async (t) => {
  const replied = { id: "evt_reply", created: 3, type: "permission.replied", data: { sessionID: "ses_child", requestID: "per_native", reply: "always" } };
  const current = await nativeInteractions(t, { transport: async (url, init, fetch) => {
    if (new URL(url).pathname !== "/api/event") return fetch(url, init);
    const events = [
      { ...replied, location: { directory: "/wrong" } },
      { ...replied, data: { ...replied.data, sessionID: "ses_unrelated" } },
      replied, replied,
    ];
    return new Response(new ReadableStream({ start(controller) {
      controller.enqueue(new TextEncoder().encode('data: {"type":"server.connected","data":{}}\n\n'));
      controller.enqueue(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
      init.signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const replies = [], reconciliations = [];
  const result = await current.executor.runTurn({ ...current.input, onResponse: async () => {},
    onPermissionReplied: (reply) => replies.push(reply), onPermissionsReconciled: (snapshot) => reconciliations.push(snapshot),
  });
  assert.equal(result.pending, true);
  await waitFor(() => reconciliations.some((snapshot) => snapshot.sessionId === "ses_child" && snapshot.requestIds.size === 0));
  assert.deepEqual(replies, [{ sessionId: "ses_child", requestId: "per_native", reply: "always" }]);
  assert.ok(reconciliations.some((snapshot) => snapshot.sessionId === "ses_child" && snapshot.requestIds.size === 0));
  assert.equal(reconciliations.some((snapshot) => snapshot.sessionId === "ses_unrelated"), false);
  current.wire.assertComplete();
});

test("U3 real Slack controls + v2: rejected keyed answer stays editable, corrected answer submits once", async (t) => {
  const complete = Promise.withResolvers();
  const current = await nativeInteractions(t, { forms: [nativeExamples.question], onPrompt: () => complete.promise });
  const reply = current.document.routes.find((route) => route.path.endsWith("frm_native/reply"));
  reply.responses.unshift({ status: 400, json: { _tag: "FormInvalidAnswerError", id: "frm_native", message: "Try another name" } });
  const posted = [], updated = [], deleted = [];
  const thread = { id: "slack:C1:1.0", adapter: { webClient: { chat: {
    postMessage: async (value) => { posted.push(value); return { ts: "2.0" }; },
    update: async (value) => updated.push(value), delete: async (value) => deleted.push(value),
  } } } };
  const controls = createPendingInteractions(["U1"]);
  let callbacks = 0;
  const turn = current.executor.runTurn({ ...current.input, onInteraction: (interaction) => { callbacks++; return controls.onInteraction({ thread }, interaction); } });
  await waitFor(() => posted.length === 1);
  const action = (prefix, card = updated.at(-1) ?? posted[0]) => card.blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id.startsWith(prefix));
  const click = (item, extra = {}) => controls.onAction({ threadId: thread.id, user: { userId: "U1" }, actionId: item.action_id, value: item.value, ...extra });
  await click(action("pipa_select_"), { value: action("pipa_select_").options[0].value });
  await click(action("pipa_submit_"));
  const multi = action("pipa_select_");
  await click(multi, { raw: { actions: [{ action_id: multi.action_id, selected_options: multi.options }] } });
  await click(action("pipa_submit_"));
  const custom = action("pipa_custom_");
  await controls.onCustomAnswer({ privateMetadata: custom.value, relatedThread: thread, user: { userId: "U1" }, values: { answer: "first" } });
  assert.equal(current.calls.length, 1);
  assert.match(JSON.stringify(updated.at(-1)), /rejected/iu);
  assert.ok(action("pipa_submit_"), "same card still has controls");
  // Retry all three questions on the same token/card, with a corrected custom value.
  await click(action("pipa_submit_"));
  await click(action("pipa_submit_"));
  await controls.onCustomAnswer({ privateMetadata: custom.value, relatedThread: thread, user: { userId: "U1" }, values: { answer: "corrected" } });
  complete.resolve();
  assertTurnOutcome(await turn, current.document.expected);
  assert.deepEqual(current.calls.map((call) => call.body), [
    { answer: { q0: "blue-id", q1: ["fast-id", "small-id"], q2: "first" } },
    { answer: { q0: "blue-id", q1: ["fast-id", "small-id"], q2: "corrected" } },
  ]);
  assert.equal(callbacks, 1);
  assert.equal(posted.length, 1);
  assert.deepEqual(deleted, []);
  current.wire.assertComplete();
});

for (const decision of ["once", "always", "reject"]) test(`U3 v2 permission ${decision}: legacy callbacks encode decision once`, async (t) => {
  const done = Promise.withResolvers();
  const current = await nativeInteractions(t, { permissions: [nativeExamples.permission], onPrompt: () => done.promise, onReply: () => done.resolve() });
  const seen = [];
  const result = await current.executor.runTurn({ ...current.input, onInteraction: (interaction) => {
    seen.push(interaction.request);
    return decision === "reject" ? { type: "reject" } : { type: "reply", reply: decision };
  } });
  if (decision === "reject") assert.match(result.text, /rejected/u);
  else assertTurnOutcome(result, current.document.expected);
  assert.deepEqual(seen, [{ ...nativeExamples.permission, tool: { name: "bash", input: { command: "pwd" } } }]);
  assert.deepEqual(current.calls.map((call) => call.body), [{ decision }]);
  current.wire.assertComplete();
});

test("U3 native permission refusal is not treated as acceptance and the same request can be rejected", async (t) => {
  const done = Promise.withResolvers();
  const current = await nativeInteractions(t, { permissions: [nativeExamples.permission], onPrompt: () => done.promise });
  const route = current.document.routes.find((route) => route.path.endsWith("per_native/reply"));
  route.responses.unshift({ status: 403, json: { error: "Configured access is denied" } });
  let retried = false;
  const result = await current.executor.runTurn({ ...current.input, onInteraction: async (interaction) => {
    try {
      await assert.rejects(interaction.submit({ type: "reply", reply: "always" }));
      assert.equal(current.pendingPermissions.length, 1);
      await interaction.submit({ type: "reject" });
      retried = true;
      return { type: "reject" };
    } finally { done.resolve(); }
  } });
  assert.match(result.text, /rejected/u);
  assert.equal(retried, true);
  assert.deepEqual(current.calls.map((call) => call.body), [{ decision: "always" }, { decision: "reject" }]);
  current.wire.assertComplete();
});

for (const lost of ["accepted", "pending"]) test(`U3 v2 lost reply reconciles ${lost} before another submission`, async (t) => {
  const done = Promise.withResolvers();
  let first = true;
  const current = await nativeInteractions(t, { permissions: [nativeExamples.permission], onPrompt: () => done.promise,
    onReply: (_, __, permissions) => {
      if (!first) return;
      if (lost === "accepted") permissions.splice(0);
    },
    transport: async (url, init, fetch) => {
      const result = await fetch(url, init);
      if (new URL(url).pathname.endsWith("/reply") && first) { first = false; throw new TypeError("lost native reply"); }
      return result;
    },
  });
  let reconciled = false;
  const turn = current.executor.runTurn({ ...current.input, onInteraction: async (interaction) => {
    try {
      if (lost === "pending") {
        await assert.rejects(interaction.submit({ type: "reply", reply: "once" }));
        await interaction.submit({ type: "reply", reply: "always" });
      } else {
        await interaction.submit({ type: "reply", reply: "once" });
        await interaction.settled;
        await assert.rejects(interaction.submit({ type: "reply", reply: "always" }), /settled/u);
      }
      reconciled = true;
      return { type: "reply", reply: "once" };
    } finally { done.resolve(); }
  } });
  assertTurnOutcome(await turn, current.document.expected);
  assert.equal(reconciled, true);
  assert.equal(current.calls.length, lost === "accepted" ? 1 : 2);
  const lastReply = current.wire.calls.findLastIndex((call) => call.path.endsWith("/reply"));
  if (lost === "pending") assert.ok(current.wire.calls.slice(0, lastReply).some((call) => call.path.endsWith("/permission") && call.method === "GET"));
  current.wire.assertComplete();
});

test("U3 v2 richer forms stay native-only; external settlement releases notices, foreign children stay invisible", async (t) => {
  const forms = [...nativeExamples.rich, ...["ses_unrelated", "ses_other_tree"].map((sessionID, index) => ({ ...nativeExamples.question, sessionID, id: `frm_foreign_${index}` }))];
  const current = await nativeInteractions(t, { forms });
  const messages = current.document.routes.find((route) => route.path.endsWith("/message"));
  const completed = messages.responses.at(-1);
  messages.responses[messages.responses.length - 1] = { json: { data: [completed.json.data[0]], cursor: { previous: null, next: null } } };
  const posted = [], deleted = [];
  const controls = createPendingInteractions();
  const thread = { id: "slack:C1:1.0", adapter: { webClient: { chat: {
    postMessage: async (value) => { posted.push(value); return { ts: String(posted.length) }; }, delete: async (value) => deleted.push(value),
  } } } };
  const seen = [];
  const turn = current.executor.runTurn({ ...current.input, onInteraction: (interaction) => { seen.push(interaction.type); return controls.onInteraction({ thread }, interaction); } });
  for (const [index, form] of nativeExamples.rich.entries()) {
    await waitFor(() => posted.length === index + 1, { label: `rich form ${index} posted` });
    assert.match(JSON.stringify(posted.at(-1)), /requires an OpenCode client/iu);
    assert.equal(posted.at(-1).blocks.some((block) => block.type === "actions"), false);
    current.pendingForms.splice(current.pendingForms.findIndex((item) => item.id === form.id), 1);
    current.emit({ type: "form.cancelled", data: { sessionID: form.sessionID, id: form.id } });
    await waitFor(() => deleted.length === index + 1, { label: `rich form ${index} settled` });
  }
  messages.responses[messages.responses.length - 1] = completed;
  current.emit({ type: "session.step.ended", data: { sessionID: "ses_contract", assistantMessageID: completed.json.data.find((message) => message.type === "assistant").id, finish: "stop" } });
  assertTurnOutcome(await turn, current.document.expected);
  assert.deepEqual(seen, ["form", "form", "form", "form"]);
  assert.equal(current.calls.length, 0);
  current.wire.assertComplete();
});

for (const projection of ["stale", "completed"]) for (const abortResult of ["acknowledged", "network", "503"]) test(`U4 v1 interaction stop cannot finish while native abort acknowledgement is in flight (${projection} assistant, ${abortResult})`, async (t) => {
  const interaction = Promise.withResolvers(), admitted = Promise.withResolvers(), abortReached = Promise.withResolvers(), acknowledge = Promise.withResolvers(), projected = Promise.withResolvers();
  let reads = 0, aborts = 0, finished = false;
  const { document, executor, input, wire } = await fixture(t, "v1", { onRequest: async (call) => {
    if (call.path.endsWith("/prompt_async")) admitted.resolve();
    if (call.path.endsWith("/message") && ++reads > 1) await abortReached.promise;
  }, transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    const directAbort = pathname.endsWith("/abort") && ++aborts === 1;
    if (directAbort) { abortReached.resolve(); await acknowledge.promise; }
    const response = await next(url, init);
    if (pathname.endsWith("/message") && reads > 1) projected.resolve();
    if (directAbort && abortResult === "network") throw new TypeError("private-abort-network-secret");
    return response;
  } });
  const messages = document.routes.find((route) => route.path.endsWith("/message"));
  messages.responses = projection === "stale" ? [messages.responses[0]] : messages.responses.slice(0, 2);
  document.routes.find((route) => route.path.endsWith("/abort")).responses = [
    abortResult === "503" ? { status: 503, raw: "private-abort-body-secret" } : { json: true },
    abortResult === "503" ? { status: 503, raw: "private-cleanup-body-secret" } : { json: true },
  ];
  const events = document.routes.find((route) => route.path === "/event");
  events.responses[0].sse = events.responses[0].sse.split("\n\n")[0] + "\n\n";
  document.routes.push({ method: "POST", path: "/question/que_contract/reject", query: { directory: input.workingDirectory }, responses: [{ json: true }] });
  const turn = executor.runTurn({ ...input, onInteraction: (value) => { interaction.resolve(value); return value.settled; } })
    .then((result) => { finished = true; return { result }; }, (error) => { finished = true; return { error }; });
  try {
    const value = await bounded(interaction.promise);
    await bounded(admitted.promise);
    const submission = value.submit({ type: "stop" }).then(() => null, (error) => error);
    await bounded(abortReached.promise);
    await bounded(projected.promise);
    await new Promise(setImmediate);
    const finishedBeforeAcknowledgement = finished;
    acknowledge.resolve();
    const submissionError = await submission;
    const outcome = await bounded(turn, { timeoutMs: 1000, label: "pending stop and independent cancellation settle" });
    assert.equal(finishedBeforeAcknowledgement, false, "Terminal assistant projection must not finish the turn while native abort is held");
    if (abortResult === "acknowledged") {
      assert.equal(submissionError, null);
      assert.equal(outcome.result?.text, "");
      assert.equal(aborts, 1);
    } else {
      assert.equal(submissionError?.message, "Pipa OpenCode cancellation could not be confirmed.");
      assert.equal(outcome.error?.message, submissionError.message);
      assert.equal(aborts, 2, "Finally must retry cancellation after the pending abort rejects");
      if (abortResult === "503") await assert.rejects(executor.ready(input.workingDirectory), /cancellation failed.*New intake is blocked/u);
      else await executor.ready(input.workingDirectory);
    }
    wire.assertComplete();
  } finally { acknowledge.resolve(); await turn.catch(() => undefined); }
});

for (const type of ["question", "permission"]) for (const failure of ["network", "503"]) for (const remains of [false, true]) for (const cleanupFails of [false, true]) test(`U4 v1 accepted ${type} stop retries native abort after ${failure} (interaction remains: ${remains}, cleanup fails: ${cleanupFails})`, async (t) => {
  const interaction = Promise.withResolvers(), admitted = Promise.withResolvers(), submitted = Promise.withResolvers();
  const abortSignals = [];
  let messageReads = 0;
  const current = await fixture(t, "v1", { onRequest: async (call) => {
    if (call.path.endsWith("/prompt_async")) admitted.resolve();
    if (call.path.endsWith("/message") && ++messageReads > 1) await submitted.promise;
    if (call.path === `/${type}/${type === "question" ? "que_contract/reject" : "per_contract/reply"}` && !remains) {
      current.document.routes.find((route) => route.path === `/${type}`).responses[0].json = [];
    }
  }, transport: async (url, init, next) => {
    const abort = new URL(url).pathname.endsWith("/abort");
    if (abort) abortSignals.push(init.signal);
    const response = await next(url, init);
    if (abort && abortSignals.length === 1 && failure === "network") throw new TypeError("private-abort-network-secret");
    return response;
  } });
  const { document, executor, input, wire } = current;
  const request = { id: type === "question" ? "que_contract" : "per_contract", sessionID: input.sessionId };
  document.routes.find((route) => route.path === `/${type}`).responses[0].json = [request];
  document.routes.find((route) => route.path === "/event").responses[0].sse = `data: ${JSON.stringify({ type: `${type}.asked`, properties: request })}\n\n`;
  document.routes.push({ method: "POST", path: "/question/que_contract/reject", query: { directory: input.workingDirectory }, repeatLast: true, responses: [{ json: true }] });
  const permissionReply = document.routes.find((route) => route.path === "/permission/per_contract/reply");
  permissionReply.body = { reply: "reject" };
  permissionReply.repeatLast = true;
  document.routes.find((route) => route.path === "/session/ses_contract/abort").responses = [
    failure === "network" ? { json: true } : { status: 503, raw: "private-abort-body-secret" },
    cleanupFails ? { status: 503, raw: "private-cleanup-body-secret" } : { json: true },
  ];
  const outcome = executor.runTurn({ ...input, onInteraction: (value) => { interaction.resolve(value); return value.settled; } }).then((result) => ({ result }), (error) => ({ error }));
  const value = await bounded(interaction.promise);
  await bounded(admitted.promise);
  const submission = await value.submit({ type: "stop" }).then(() => null, (error) => error);
  submitted.resolve();
  const result = await bounded(outcome, { timeoutMs: 1000, label: "watcher exits and independent native cancellation drains" });
  assert.equal(submission?.message, "Pipa OpenCode cancellation could not be confirmed.");
  assert.equal(result.error?.message, submission.message, "An accepted interaction must not produce turn success after uncertain abort");
  assert.equal(abortSignals.length, 2, "Finally must independently retry native session abort");
  assert.equal(abortSignals[0].aborted, true);
  assert.notEqual(abortSignals[0], abortSignals[1]);
  assert.equal(abortSignals[1].aborted, false, "Cleanup must not reuse the cancelled local signal");
  if (cleanupFails) {
    const calls = wire.calls.length;
    await assert.rejects(executor.ready(input.workingDirectory), /cancellation failed.*New intake is blocked/u);
    await assert.rejects(executor.runTurn(input), /cancellation failed.*New intake is blocked/u);
    assert.equal(wire.calls.length, calls, "Blocked intake must not reach native admission");
  } else {
    await executor.ready(input.workingDirectory);
    assertTurnOutcome(await executor.runTurn(input), document.continuation);
  }
  assert.equal(wire.calls.filter((call) => call.path.endsWith("/prompt_async")).length, cleanupFails ? 1 : 2);
  wire.assertComplete();
});

test("U4 v1 stop during admission waits for its acknowledgement before native cancellation", async (t) => {
  const admitted = Promise.withResolvers(), acknowledge = Promise.withResolvers();
  let admissionSignal;
  const { executor, input, wire } = await fixture(t, "v1", { transport: async (url, init, next) => {
    if (new URL(url).pathname.endsWith("/prompt_async")) {
      admissionSignal = init.signal;
      admitted.resolve();
      await acknowledge.promise;
    }
    return next(url, init);
  } });
  const turn = executor.runTurn(input);
  const rejected = assert.rejects(turn, /stop during admission/u);
  await admitted.promise;
  executor.stopAll(new Error("stop during admission"));
  await new Promise(setImmediate);
  assert.equal(admissionSignal.aborted, false, "An aborted HTTP request can still admit native work after an early abort");
  assert.equal(wire.calls.some((call) => call.path.endsWith("/abort")), false);
  acknowledge.resolve();
  await rejected;
  assert.equal(wire.calls.filter((call) => call.path.endsWith("/abort")).length, 1);
  wire.assertComplete();
});

for (const late of [false, true]) test(`U4 v1 cancellation drains child requests (discovered after cancellation: ${late})`, async (t) => {
  const admitted = Promise.withResolvers();
  const interaction = Promise.withResolvers();
  const acknowledge = Promise.withResolvers();
  const current = await fixture(t, "v1", { onRequest: async (call, init) => {
    if (late && call.path === "/session/ses_contract/abort") {
      current.document.routes.find((route) => route.path === "/permission").responses = [{ json: [{ id: "per_contract", sessionID: "ses_child" }, { id: "per_foreign", sessionID: "ses_foreign" }] }];
    }
    if (call.path.endsWith("/prompt_async")) {
      admitted.resolve();
      await acknowledge.promise;
    }
  } });
  const { executor, input, document, wire } = current;
  const query = { directory: current.runtime.workspace };
  document.routes.push({ method: "POST", path: "/session/ses_child/abort", query, responses: [{ json: true }] });
  document.routes.push({ method: "POST", path: "/question/que_contract/reject", query, responses: [{ json: true }] });
  document.routes.find((route) => route.path === "/question").responses = [{ json: [{ id: "que_contract", sessionID: "ses_contract" }] }];
  document.routes.find((route) => route.path === "/permission").responses = [{ json: late ? [] : [{ id: "per_contract", sessionID: "ses_child" }] }];
  document.routes.find((route) => route.path === "/session/ses_child").repeatLast = true;
  document.routes.push({ method: "GET", path: "/session/ses_foreign", query, responses: [{ json: { id: "ses_foreign", parentID: "ses_contract", directory: path.dirname(current.runtime.workspace) } }] });
  if (late) {
    const event = document.routes.find((route) => route.path === "/event");
    event.responses[0].sse = event.responses[0].sse.split("\n\n").filter((frame) => frame && !frame.includes("permission.asked")).join("\n\n") + "\n\n";
  }
  document.routes.find((route) => route.path === "/permission/per_contract/reply").body = { reply: "reject" };
  const pending = executor.runTurn({ ...input, onInteraction: async (value) => {
    if (value.sessionId === "ses_child") interaction.resolve();
    return new Promise((_, reject) => value.signal.addEventListener("abort", () => reject(value.signal.reason), { once: true }));
  } });
  const rejected = assert.rejects(pending, /cancel child/u);
  await admitted.promise;
  if (!late) await interaction.promise;
  await executor.abortTurn(input.sessionId, new Error("cancel child"));
  acknowledge.resolve();
  await rejected;
  for (const pathname of ["/session/ses_contract/abort", "/session/ses_child/abort", "/question/que_contract/reject", "/permission/per_contract/reply"]) {
    assert.equal(wire.calls.filter((call) => call.path === pathname).length, 1, `Missing or duplicate native cancellation: ${pathname}`);
  }
  await executor.ready(input.workingDirectory);
  assert.ok(!wire.calls.some((call) => call.method === "POST" && /foreign/u.test(call.path)));
  wire.assertComplete();
});

test("U4 v1 uncertain admission blocks replay even after native abort", async (t) => {
  const { executor, input, wire } = await fixture(t, "v1", { transport: async (url, init, next) => {
    const response = await next(url, init);
    if (new URL(url).pathname.endsWith("/prompt_async")) throw new TypeError("lost acknowledgement after admission");
    return response;
  } });
  await assert.rejects(executor.runTurn(input), /admission remains uncertain/u);
  assert.equal(wire.calls.filter((call) => call.path.endsWith("/abort")).length, 1);
  await assert.rejects(executor.ready(input.workingDirectory), /blocked/u);
  await assert.rejects(executor.runTurn(input), /blocked/u);
  assert.equal(wire.calls.filter((call) => call.path.endsWith("/prompt_async")).length, 1);
  wire.assertComplete();
});

test("v1 baseline: real executor supersession aborts only the replaced thread", async (t) => {
  const admitted = Promise.withResolvers();
  let old = false;
  const current = await fixture(t, "v1", { onRequest: async (call, init) => {
    if (call.path.endsWith("/prompt_async")) old = call.body?.parts?.[0]?.text === "blocked old turn";
    if (call.path !== "/session/ses_contract/message" || !old) return;
    admitted.resolve();
    await bounded(new Promise((_, reject) => {
      if (init.signal.aborted) reject(init.signal.reason);
      else init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    }), { signal: init.signal, label: "superseded admission" });
  } });
  const { runtime, document, executor, input, wire } = current;
  const other = await loadWireFixture("v1", runtime);
  for (const route of other.routes.filter((route) => route.path.startsWith("/session/ses_contract/"))) {
    route.path = route.path.replace("ses_contract", "ses_independent");
    document.routes.push(route);
  }
  const store = await createSessionStore(pipaPaths(runtime.home).sessions);
  await store.set("A", "ses_contract");
  await store.set("B", "ses_independent");
  const runner = createConversationRunner({ sessionStore: store, runTurn: executor.runTurn, abortTurn: executor.abortTurn });
  runtime.defer(async () => { runner.close(); await runner.drain(); }, "runner");
  const delivered = [];
  const previous = runner.enqueue("A", { ...input, prompt: "blocked old turn", deliver: () => delivered.push("stale") });
  await bounded(admitted.promise, { signal: runtime.signal, label: "first admission" });
  const independent = await runner.enqueue("B", { ...input, deliver: () => delivered.push("independent") });
  assert.equal(runtime.signal.aborted, false);
  const latest = await runner.enqueue("A", { ...input, prompt: "replacement", deliver: () => delivered.push("latest") });
  assertSupersessionOutcome({ previous: await previous, latest, independent, delivered }, {
    latest: document.continuation,
    independent: { ...document.expected, sessionId: "ses_independent" },
    delivered: ["independent", "latest"],
  });
  assert.deepEqual(wire.calls.filter((call) => call.path.endsWith("/abort")).map((call) => call.path), ["/session/ses_contract/abort"]);
  assert.equal(store.get("A"), "ses_contract");
  assert.equal(store.get("B"), "ses_independent");
  wire.assertComplete();
});

for (const generation of ["v1", "v2"]) test(`${generation}: malformed/truncated wire events and unknown routes fail closed`, async (t) => {
  const { document, wire, runtime } = await fixture(t, generation);
  const sse = document.routes.find((route) => route.responses[0].sse)?.responses[0].sse;
  validateEventStream(sse, generation);
  for (const [mutation, message] of [[sse.slice(0, -1), /truncated SSE/u], ["data: {broken}\n\n", /malformed SSE JSON/u], ["data: {}\n\n", /malformed event envelope/u]]) {
    assert.throws(() => validateEventStream(mutation, generation), message);
    const broken = structuredClone(document);
    const route = broken.routes.find((route) => route.responses[0].sse);
    route.responses[0].sse = mutation;
    const playback = createWireFixture(broken);
    const url = new URL(route.path, "http://127.0.0.1");
    for (const [key, value] of Object.entries(route.query ?? {})) url.searchParams.set(key, value);
    await assert.rejects(playback.fetch(url), message);
    assert.throws(() => playback.assertComplete(), /wire contract failed/u);
  }
  await assert.rejects(wire.fetch(`http://127.0.0.1/unknown?directory=${encodeURIComponent(runtime.workspace)}`), /unknown wire request/u);
  assert.throws(() => wire.assertComplete(), /unknown wire request/u);
});

test("v1 failing-proof: mutated expected text, session and artifact bytes fail named outcomes", async (t) => {
  const { executor, input, document, wire } = await fixture(t);
  const result = await runTurnContract({ executor, input, expected: document.expected, caseName: "v1 completion" });
  for (const expected of [
    { ...document.expected, text: "wrong output" },
    { ...document.expected, sessionId: "wrong session" },
    { ...document.expected, files: [{ filename: "report.txt", base64: "d3Jvbmc=" }] },
  ]) assert.throws(() => assertTurnOutcome(result, expected, "mutated outcome"), /mutated outcome/u);
  wire.assertComplete();
});

for (const failure of ["malformed response", "malformed envelope", "provider failure"]) test(`v1 ${failure === "malformed envelope" ? "wire validation" : "baseline"}: ${failure} cannot deliver success`, async (t) => {
  const { executor, input, document, wire } = await fixture(t);
  const messages = document.routes.find((route) => route.path.endsWith("/message"));
  messages.responses[1] = failure === "malformed response" ? { raw: "{truncated" }
    : failure === "malformed envelope" ? { json: { data: [] } }
    : { json: [{ info: { id: "msg_failed", role: "assistant", error: { name: "APIError" } }, parts: [{ type: "text", text: "must not deliver" }] }] };
  await assert.rejects(runTurnContract({ executor, input, expected: document.expected, caseName: failure }), failure === "malformed response" ? /malformed response: OpenCode returned an invalid response/u
    : failure === "malformed envelope" ? /malformed envelope:/u
    : /provider failure: OpenCode selected provider failed to complete the turn\./u);
  if (failure === "malformed envelope") assert.throws(() => wire.assertComplete(), /malformed message envelope/u);
  else wire.assertComplete();
});

test("v1 U2: production rejects a malformed projected envelope before a valid later poll", async (t) => {
  const { executor, input, document, wire } = await fixture(t);
  document.routes.find((route) => route.path.endsWith("/message")).responses[1] = { raw: '{"data":[]}' };
  await assert.rejects(runTurnContract({ executor, input, expected: document.expected, caseName: "v1 malformed envelope" }), /invalid message projection/u);
  wire.assertComplete();
});

test("v2 native wire integrity: data envelopes, stable-ID admission, projected idle and keyed replies (not adapter proof)", async (t) => {
  const runtime = await createRuntimeFixture();
  t.after(() => runtime.teardown());
  const document = await loadWireFixture("v2", runtime);
  const wire = createWireFixture(document);
  const request = async (route) => {
    const url = new URL(route.path, "http://127.0.0.1");
    for (const [key, value] of Object.entries(route.query ?? {})) url.searchParams.set(key, value);
    return wire.fetch(url, { method: route.method, ...(route.body ? { body: JSON.stringify(route.body) } : {}) });
  };
  const create = await (await request(document.routes.find((route) => route.path === "/api/session"))).json();
  assert.equal(create.data.location.directory, runtime.workspace);
  const admitted = await (await request(document.routes.find((route) => route.path.endsWith("/prompt")))).json();
  assert.equal(admitted.data.id, "msg_input");
  assert.equal(admitted.data.payload.text, document.prompt);
  assert.equal(admitted.data.type, "user", "admission is not a completed assistant result");
  const projected = await (await request(document.routes.find((route) => route.path.endsWith("/message")))).json();
  assert.equal(projected.data.at(-1).type, "idle");
  assert.equal(projected.data.at(-1).outcome, "succeeded");
  assert.deepEqual(projected.cursor, { previous: null, next: null });
  for (const route of document.routes.filter((route) => route.path.endsWith("/reply"))) assert.equal((await request(route)).status, 204);
  wire.assertComplete();
  const broken = createWireFixture(document);
  await assert.rejects(broken.fetch("http://127.0.0.1/api/session/ses_contract/form/frm_contract/reply", { method: "POST", body: JSON.stringify({ answers: [["Blue"]] }) }), /native body/u);
  assert.throws(() => broken.assertComplete(), /wire contract failed/u);
  const windows = await loadWireFixture("v2", { workspace: "C:\\private\\workspace", temp: "C:\\private\\temp" });
  validateEventStream(windows.routes.find((route) => route.path === "/api/event").responses[0].sse, "v2");
});

for (const sessionId of [null, "ses_contract"]) test(`v2 U2: ${sessionId ? "R2 retains mapped session" : "R1 new prepared turn"}`, async (t) => {
  const { executor, input, document, wire } = await fixture(t, "v2");
  const caseName = sessionId ? "v2 session continuation" : "v2 prompt completion";
  await runTurnContract({ executor, input: { ...input, sessionId }, expected: document.expected, caseName });
  assert.equal(wire.calls.some((call) => call.path.startsWith("/session")), false);
  wire.assertComplete();
});

test("R1 U1: attached identity and workspace readiness select both generations", async (t) => {
  for (const generation of ["v1", "v2"]) {
    const { runtime, wire } = await fixture(t, generation);
    const starting = startSocketOpenCodeServer({ workingDirectory: runtime.workspace }, { environment: { ...runtime.env, PIPA_OPENCODE_ATTACH_URL: "http://127.0.0.1:4096" }, fetch: wire.fetch, startupTimeoutMs: 10 });
    const server = await starting;
    assert.equal(server.owned, false);
    assert.equal(server.connection.major, generation === "v1" ? 1 : 2);
    assert.equal(server.connection.version, generation === "v1" ? "1.19.0" : "2.0.29");
    server.stop();
    await server.wait();
    assert.equal(wire.calls.some((call) => call.path === "/api/info"), generation === "v2");
    wire.assertComplete();
  }
});

test("U1 temporary workspace readiness with an explicit test deadline preserves state and blocks Slack intake", async (t) => {
  const runtime = await createRuntimeFixture();
  t.after(() => runtime.teardown());
  const paths = pipaPaths(runtime.home);
  await mkdir(path.dirname(paths.config), { recursive: true });
  const config = { botName: "Pipa", workingDirectory: runtime.workspace };
  const saved = new Map([
    [paths.config, JSON.stringify(config)],
    [paths.sessions, JSON.stringify({ "slack:C123:1.0": "ses_saved" })],
    [paths.routines, JSON.stringify({ version: 1, routines: [] })],
    [path.join(paths.directory, "opencode-recovery.json"), JSON.stringify({ version: 1, records: [{ sessionId: "ses_saved", phase: "admitted" }] })],
  ]);
  for (const [file, bytes] of saved) await writeFile(file, bytes);
  const calls = [];
  const intake = [];
  await assert.rejects(startPipa({ config, paths, startupTimeoutMs: 50,
    checkSlackToken: async () => ({}),
    sessionStore: { keys: () => { intake.push("subscriptions"); return []; } },
    state: { connect: () => intake.push("state") },
    chat: { initialize: () => intake.push("Slack") },
    createRoutineScheduler: () => intake.push("routines"),
    startServer: (config, options) => startSocketOpenCodeServer(config, {
      ...options, environment: runtime.env, attachUrl: "http://127.0.0.1:4096",
      fetch: async (url) => {
        const pathname = new URL(url).pathname;
        calls.push(pathname);
        if (pathname === "/global/health") return new Response("<html>");
        if (pathname === "/api/info") return Response.json({ version: "2.0.29", pid: 1, urls: [], paths: { tmp: runtime.temp } });
        assert.equal(pathname, "/api/location", "Only ordinary workspace readiness may be probed");
        return Response.json({}, { status: 503 });
      },
    }),
  }), /workspace readiness check timed out/u);
  assert.ok(calls.includes("/api/location"));
  assert.equal(calls.includes("/api/experimental/migration/v1"), false);
  assert.deepEqual(intake, []);
  for (const [file, bytes] of saved) assert.equal(await readFile(file, "utf8"), bytes);
});

test("U2 standalone facade negotiates authenticated identity before selecting either adapter", async (t) => {
  for (const generation of ["v1", "v2"]) {
    const { runtime, wire, document, input, fetch: fixtureFetch } = await fixture(t, generation);
    const executor = createOpenCodeExecutor({ baseUrl: "http://127.0.0.1:4096", environment: runtime.env, fetch: fixtureFetch, pollIntervalMs: 1, inputId: () => "msg_input" });
    await runTurnContract({ executor, input, expected: document.expected });
    await executor.ready(runtime.workspace);
    assert.equal(wire.calls.filter((call) => call.path === "/global/health").length, 1);
    assert.equal(wire.calls.some((call) => call.path === "/api/info"), generation === "v2");
    executor.stopAll();
    wire.assertComplete();
  }
});

test("U2: session persistence callback runs before artifact allocation, context writes or admission on either generation", async (t) => {
  for (const generation of ["v1", "v2"]) {
    const { executor, input, wire, runtime } = await fixture(t, generation);
    await assert.rejects(executor.runTurn({ ...input, contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack" }, onSession: async () => {
      assert.deepEqual(await readdir(runtime.artifactRoot), []);
      throw new Error("session persistence failed");
    } }), /session persistence failed/u);
    assert.equal(wire.calls.some((call) => call.method !== "GET"), false);
    await assert.rejects(access(path.join(pipaPaths(runtime.home).directory, "opencode-recovery.json")), { code: "ENOENT" });
    wire.assertComplete();
  }
});

for (const generation of ["v1", "v2"]) for (const remote of [false, true]) test(`${generation} U2: 10 MiB decoded input boundary, metadata, multiple Unicode files and ${remote ? "data URI" : "local file"} transport`, async (t) => {
  const { executor, input, document, wire } = await fixture(t, generation, { executorOptions: { baseUrl: remote ? "https://remote.fixture" : "http://127.0.0.1:4096" }, onRequest: async (call) => {
    if (remote || !call.path.endsWith(generation === "v1" ? "/prompt_async" : "/prompt")) return;
    const urls = generation === "v1" ? call.body.parts.slice(1).map((file) => file.url) : call.body.files.map((file) => file.uri);
    assert.deepEqual(await readFile(new URL(urls[0])), bytes);
    assert.equal(await readFile(new URL(urls[1]), "utf8"), "two");
  } });
  let downloaded = false;
  await assert.rejects(executor.runTurn({ ...input, attachments: [{ size: 10 * 1024 * 1024 + 1, fetchData: () => { downloaded = true; } }] }), /10 MiB/u);
  assert.equal(downloaded, false);
  await assert.rejects(executor.runTurn({ ...input, attachments: [{ size: 1, fetchData: async () => Buffer.alloc(10 * 1024 * 1024 + 1) }] }), /10 MiB/u);
  assert.equal(wire.calls.length, 0, "oversized files cannot reach admission");
  const bytes = Buffer.alloc(10 * 1024 * 1024, 97);
  const route = document.routes.find((route) => route.path.endsWith(generation === "v1" ? "/prompt_async" : "/prompt"));
  if (generation === "v2") delete route.body; // The exact native files are asserted below, alongside unchanged exact prompt bytes.
  await runTurnContract({ executor, input: { ...input, attachments: [
    { name: "café😀.txt", size: bytes.length, mimeType: "text/plain", fetchData: async () => bytes },
    { name: "second.txt", mimeType: "text/plain", fetchData: async () => Buffer.from("two") },
  ] }, expected: document.expected });
  const body = wire.calls.find((call) => call.path === route.path).body;
  assert.equal(generation === "v1" ? body.parts[0].text : body.text, document.prompt);
  const files = generation === "v1" ? body.parts.slice(1).map((part) => ({ uri: part.url, name: part.filename })) : body.files;
  assert.deepEqual(files.map((file) => file.name), ["café😀.txt", "second.txt"]);
  for (const [index, file] of files.entries()) {
    if (remote) {
      assert.equal(file.uri.startsWith("data:"), true);
      const data = Buffer.from(file.uri.split(",")[1], "base64");
      assert.deepEqual(data, index === 0 ? bytes : Buffer.from("two"));
      if (index === 0) assert.ok(Buffer.byteLength(file.uri) > bytes.length, "base64 overhead does not reduce the decoded limit");
    } else await assert.rejects(access(new URL(file.uri)), { code: "ENOENT" });
  }
  wire.assertComplete();
});

test("U2: outgoing artifacts larger than the incoming limit remain deliverable through both adapters", async (t) => {
  for (const generation of ["v1", "v2"]) {
    let artifactDirectory;
    const bytes = Buffer.alloc(20 * 1024 * 1024 + 1, 98);
    const { executor, input, document, wire } = await fixture(t, generation, { onRequest: async (call) => {
      const instructions = generation === "v1" ? call.body?.system : call.method === "PUT" ? call.body?.value : null;
      if (!instructions) return;
      artifactDirectory = instructions.match(/private artifact directory: (.+)\n/u)[1];
      await writeFile(path.join(artifactDirectory, "large.txt"), bytes);
      const response = document.routes.find((route) => route.path.endsWith("/message")).responses[generation === "v1" ? 1 : 2].json;
      const content = generation === "v1" ? response[0].parts : response.data[1].content;
      content.at(-1).text += '\nPIPA_ARTIFACTS: ["large.txt"]';
    } });
    await runTurnContract({ executor, input: { ...input, contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack" } }, expected: { ...document.expected, files: [{ filename: "large.txt", base64: bytes.toString("base64") }] } });
    await assert.rejects(access(artifactDirectory), { code: "ENOENT" });
    wire.assertComplete();
  }
});

test("U2: missing message/location routes cannot replace an existing session on either adapter", async (t) => {
  for (const generation of ["v1", "v2"]) {
    const { executor, input, document, wire } = await fixture(t, generation, { transport: async (url, init, next) => {
      if (new URL(url).pathname.endsWith("/message")) return new Response(JSON.stringify({ _tag: "MessageNotFoundError", message: "missing projection" }), { status: 404, headers: { "content-type": "application/json" } });
      return next(url, init);
    } });
    if (generation === "v1") document.routes.push({ method: "GET", path: "/session/ses_contract", query: { directory: input.workingDirectory }, responses: [{ json: { id: "ses_contract", directory: input.workingDirectory } }], required: true });
    await assert.rejects(executor.runTurn(input));
    assert.equal(wire.calls.some((call) => call.method === "POST"), false);
    wire.assertComplete();
  }
});

test("v2 U2: only a session-specific absent lookup permits stale-session replacement", async (t) => {
  for (const tag of ["SessionNotFoundError", "LocationNotFoundError"]) {
    const { executor, input, document, wire } = await fixture(t, "v2", { transport: async (url, init, next) => {
      if (new URL(url).pathname === "/api/session/ses_missing") return new Response(JSON.stringify({ _tag: tag, sessionID: "ses_missing", message: "not found" }), { status: 404, headers: { "content-type": "application/json" } });
      return next(url, init);
    } });
    if (tag === "SessionNotFoundError") await runTurnContract({ executor, input: { ...input, sessionId: "ses_missing" }, expected: document.expected });
    else await assert.rejects(executor.runTurn({ ...input, sessionId: "ses_missing" }), /not found/u);
    assert.equal(wire.calls.some((call) => call.method === "POST" && call.path === "/api/session"), tag === "SessionNotFoundError");
    wire.assertComplete();
  }
});

test("isolated concurrent roots: abort closes process trees, listeners, locks and staging", async (t) => {
  const runtimes = await Promise.all([createRuntimeFixture(), createRuntimeFixture()]);
  for (const runtime of runtimes) t.after(() => runtime.teardown());
  const [first, second] = runtimes;
  assert.notEqual(first.home, second.home);
  assert.notEqual(first.temp, second.temp);
  assert.notEqual(first.artifactRoot, second.artifactRoot);
  if (process.platform !== "win32") assert.equal((await stat(first.root)).mode & 0o777, 0o700);
  const lock = pipaPaths(first.home).lock;
  const release = await acquireInstanceLock(lock);
  first.defer(async () => { await release(); await assert.rejects(access(lock), { code: "ENOENT" }); }, "instance lock");
  await writeFile(path.join(first.temp, "staged.txt"), "staged");
  const server = createServer((_request, response) => response.end("private"));
  const url = await first.listen(server);
  const descendantFile = path.join(first.workspace, "descendant.pid");
  const processRecord = first.spawn(process.execPath, ["-e", "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); child.once('close', () => process.exit(0)); process.on('SIGTERM', () => child.kill('SIGTERM')); require('node:fs').writeFileSync(process.argv[1], String(child.pid)); setInterval(() => {}, 1000)", descendantFile]);
  const descendant = Number(await first.waitFor(() => readFile(descendantFile, "utf8").catch((error) => { if (error.code === "ENOENT") return false; throw error; }), { label: "descendant startup" }));
  assert.equal((await fetch(url)).status, 200);
  first.abort();
  await first.teardown();
  assert.ok((await processRecord.exited).signal || processRecord.child.exitCode !== null);
  assert.equal(server.listening, false);
  await assert.rejects(fetch(url, { signal: AbortSignal.timeout(500) }));
  await assert.rejects(access(first.root), { code: "ENOENT" });
  await second.waitFor(() => {
    try { process.kill(descendant, 0); return false; }
    catch (error) { if (error.code === "ESRCH") return true; throw error; }
  }, { label: "descendant termination", timeoutMs: 2_000 });
  await access(second.workspace);
  assert.equal(second.signal.aborted, false);
  await Promise.all([first.teardown(), first.teardown()]);
});

test("fixture deadlines and cleanup failures are bounded and observable", async (t) => {
  await assert.rejects(bounded(new Promise(() => {}), { timeoutMs: 5, label: "hung operation" }), /hung operation timed out/u);
  await assert.rejects(waitFor(() => new Promise(() => {}), { timeoutMs: 5, label: "hung predicate" }), /hung predicate timed out/u);
  const runtime = await createRuntimeFixture({ timeoutMs: 10 });
  t.after(() => runtime.teardown());
  await bounded(new Promise((resolve) => runtime.signal.addEventListener("abort", resolve, { once: true })));
  await runtime.teardown();
  await assert.rejects(access(runtime.root), { code: "ENOENT" });
  const failed = await createRuntimeFixture({ cleanupTimeoutMs: 5 });
  failed.defer(() => new Promise(() => {}), "hung resource");
  await assert.rejects(failed.teardown(), /cleanup failed/u);
  await access(failed.root);
  // An intentionally failed teardown retains evidence; this self-test owns it.
  const { rm } = await import("node:fs/promises");
  await rm(failed.root, { recursive: true, force: true });
});

test("private child environment excludes synthetic Slack secrets and ambient integrations, preserves deliberate integrations", async (t) => {
  const marker = "SYNTHETIC_SLACK_SECRET_DO_NOT_EXPORT";
  const environment = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec, PATHEXT: process.env.PATHEXT,
    HOME: "/ambient", PIPA_HOME: "/ambient", NODE_OPTIONS: "--invalid", HTTPS_PROXY: "http://ambient", PIPA_OPENCODE_ATTACH_URL: "http://ambient",
    OPENAI_API_KEY: "synthetic-provider", CUSTOM_MCP_KEY: "synthetic-integration", PIPA_SLACK_BOT_TOKEN: marker, Slack_Client_Secret: marker };
  const runtime = await createRuntimeFixture({ environment, allowEnvironment: ["CUSTOM_MCP_KEY", "PIPA_SLACK_BOT_TOKEN", "Slack_Client_Secret"] });
  t.after(() => runtime.teardown());
  for (const key of ["NODE_OPTIONS", "HTTPS_PROXY", "PIPA_OPENCODE_ATTACH_URL", "OPENAI_API_KEY"]) assert.equal(runtime.env[key], undefined);
  const clean = cleanChildEnvironment({ ...runtime.env, OPENAI_API_KEY: "synthetic-provider", PIPA_SLACK_BOT_TOKEN: marker, Slack_Client_Secret: marker });
  assert.equal(clean.OPENAI_API_KEY, "synthetic-provider", "production inheritance must retain intended integrations");
  assert.equal(clean.CUSTOM_MCP_KEY, "synthetic-integration");
  assert.doesNotMatch(JSON.stringify(clean), new RegExp(marker, "u"));
  const childFile = path.join(runtime.workspace, "child-environment.json");
  const { exited } = runtime.spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))", childFile]);
  assert.equal((await exited).code, 0);
  const evidence = await readFile(childFile, "utf8");
  assert.doesNotMatch(evidence, new RegExp(marker, "u"));
  const observed = JSON.parse(evidence);
  assert.equal(observed.CUSTOM_MCP_KEY, "synthetic-integration");
  for (const key of ["HOME", "USERPROFILE", "PIPA_HOME", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "TMPDIR", "TMP", "TEMP", "APPDATA", "LOCALAPPDATA", "ProgramData", "OPENCODE_DB", "OPENCODE_CONFIG"]) assert.ok(observed[key].startsWith(runtime.root + path.sep), key);
});

test("private fixture preserves the explicitly prepared production child environment", async (t) => {
  const runtime = await createRuntimeFixture();
  t.after(() => runtime.teardown());
  const env = cleanChildEnvironment({ ...runtime.env, BUN_JSC_maxRegExpStackSize: "536870912", PIPA_SLACK_BOT_TOKEN: "synthetic-secret" });
  const childFile = path.join(runtime.workspace, "prepared-environment.json");
  const { exited } = runtime.spawn(process.execPath, ["-e", "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.env))", childFile], { env });
  assert.equal((await exited).code, 0);
  const observed = JSON.parse(await readFile(childFile, "utf8"));
  assert.equal(observed.BUN_JSC_maxRegExpStackSize, "536870912");
  assert.equal(observed.PIPA_SLACK_BOT_TOKEN, undefined);
  assert.equal(observed.HOME, runtime.home);
});

test("isolated production attachment/artifact turn uses private HOME/temp and removes staged files", async (t) => {
  const runtime = await createRuntimeFixture();
  t.after(() => runtime.teardown());
  const production = pathToFileURL(fileURLToPath(new URL("../src/opencode.mjs", import.meta.url))).href;
  const contract = new URL("./helpers/opencode-contract.mjs", import.meta.url).href;
  const child = runtime.spawn(process.execPath, ["--input-type=module", "-e", String.raw`
    import assert from 'node:assert/strict';
    import { access, readFile, writeFile } from 'node:fs/promises';
    import path from 'node:path';
    import { createOpenCodeExecutor } from ${JSON.stringify(production)};
    import { loadWireFixture, createWireFixture, runTurnContract } from ${JSON.stringify(contract)};
    const workspace = process.cwd();
    const document = await loadWireFixture('v1', { workspace, temp: process.env.TMPDIR });
    let staged, artifacts;
    const wire = createWireFixture(document, { onRequest: async (call) => {
      if (!call.path.endsWith('/prompt_async')) return;
      staged = new URL(call.body.parts[1].url);
      assert.equal(await readFile(staged, 'utf8'), 'attachment bytes');
      assert.ok(staged.pathname.includes('/temp/'));
        assert.doesNotMatch(call.body.system, /When asked to restart|ensure PIPA_HOME/u);
      artifacts = call.body.system.match(/private artifact directory: (.+)\n/)[1];
      await writeFile(path.join(artifacts, 'report.txt'), 'artifact bytes');
      document.routes.find(route => route.path.endsWith('/message')).responses[1].json[0].parts[1].text += '\nPIPA_ARTIFACTS: ["report.txt"]';
    }});
    const executor = createOpenCodeExecutor({ baseUrl: 'http://127.0.0.1:4096', fetch: wire.fetch, artifactRoot: path.join(workspace, '.pipa', 'artifacts'), environment: process.env, pollIntervalMs: 1 });
    try {
      await runTurnContract({ executor, input: { prompt: document.prompt, sessionId: document.expected.sessionId, workingDirectory: workspace, contextEnvironment: { PIPA_MESSAGE_CHANNEL: 'slack' }, attachments: [{ name: 'notes.txt', mimeType: 'text/plain', fetchData: async () => Buffer.from('attachment bytes') }] }, expected: { ...document.expected, files: [{ filename: 'report.txt', base64: Buffer.from('artifact bytes').toString('base64') }] }, caseName: 'v1 isolated files' });
      await assert.rejects(access(staged), { code: 'ENOENT' });
      await assert.rejects(access(artifacts), { code: 'ENOENT' });
      wire.assertComplete();
    } finally { executor.stopAll(); }
    const cancelledDocument = await loadWireFixture('v1', { workspace, temp: process.env.TMPDIR });
    const entered = Promise.withResolvers();
    const acknowledge = Promise.withResolvers();
    const cancelledWire = createWireFixture(cancelledDocument, { onRequest: async (call, init) => {
      if (!call.path.endsWith('/prompt_async')) return;
      staged = new URL(call.body.parts[1].url);
      artifacts = call.body.system.match(/private artifact directory: (.+)\n/)[1];
      entered.resolve();
      await acknowledge.promise;
    }});
    const cancelledExecutor = createOpenCodeExecutor({ baseUrl: 'http://127.0.0.1:4096', fetch: cancelledWire.fetch, artifactRoot: path.join(workspace, '.pipa', 'artifacts'), environment: process.env });
    const turn = cancelledExecutor.runTurn({ prompt: 'cancel files', sessionId: 'ses_contract', workingDirectory: workspace, contextEnvironment: { PIPA_MESSAGE_CHANNEL: 'slack' }, attachments: [{ name: 'pending.txt', fetchData: async () => Buffer.from('pending') }] });
    const rejected = assert.rejects(turn, /cancelled file turn/);
    await entered.promise;
    await cancelledExecutor.abortTurn('ses_contract', new Error('cancelled file turn'));
    acknowledge.resolve();
    await rejected;
    await assert.rejects(access(staged), { code: 'ENOENT' });
    await assert.rejects(access(artifacts), { code: 'ENOENT' });
    cancelledWire.assertComplete();
    cancelledExecutor.stopAll();
  `]);
  let stderr = "";
  child.child.stderr.on("data", (chunk) => { stderr = (stderr + chunk).slice(-8192); });
  assert.equal((await child.exited).code, 0, stderr);
  assert.deepEqual(await readdir(runtime.temp), []);
  assert.deepEqual(await readdir(runtime.artifactRoot), []);
});
