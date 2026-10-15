import assert from "node:assert/strict";
import { createServer } from "node:http";
import { access, readFile, readdir, stat, writeFile } from "node:fs/promises";
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

test("release catalog keeps four crash boundaries and separate unqualified model/Slack proofs", async () => {
  const ids = releaseCases.map((row) => row.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of ["crash-after-instruction-registration", "crash-after-admission", "crash-during-approval", "crash-after-completion"]) {
    assert.equal(releaseCases.find((row) => row.id === id)?.owner, "U2/U6");
  }
  assert.ok(releaseCases.find((row) => row.id === "slack-editable-retry-controls")?.blocked);
  for (const id of ["models-switch", "models-variants", "models-default", "models-reset"]) {
    const definition = releaseCases.find((row) => row.id === id);
    assert.deepEqual(definition.generations, ["2"]);
    assert.equal(definition.native, true);
    assert.equal(definition.blocked, undefined);
  }
  const workflow = await readFile(new URL("../.github/workflows/opencode-compatibility.yml", import.meta.url), "utf8");
  assert.ok(workflow.includes('- "test/opencode-contract.test.mjs"'));
});

for (const boundary of ["admission", "approval", "completion"]) test(`release crash self-check: SIGKILL at ${boundary} through production runner/native HTTP fixture (not engine recovery proof)`, async (t) => {
  const runtime = await createRuntimeFixture({ timeoutMs: 25000 });
  t.after(() => runtime.teardown());
  const document = await loadWireFixture("v1", runtime);
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
      if (request.url.startsWith("/event?")) {
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
  const evidence = await abruptTurnProbe({ runtime, candidate: fileURLToPath(new URL("..", import.meta.url)), baseUrl, boundary, prompt: document.prompt, sessionFile: path.join(runtime.state, "crash-sessions.json") });
  assert.equal(evidence.boundary, boundary);
  assert.equal(evidence.sessionId, document.expected.sessionId);
  assert.equal(evidence.deliveryObserved, false);
  if (boundary === "completion") assertTurnOutcome(evidence.result, document.expected);
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
  }
  const wire = createWireFixture(document, options);
  const nativeFetch = async (url, init) => {
    const parsed = new URL(url);
    if (generation === "v2" && parsed.pathname.includes("/instructions/entries/")) {
      const saved = JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8"));
      assert.equal(saved.records.length, 1, "ownership must be durable before instruction writes");
      const key = parsed.pathname.split("/").at(-1);
      assert.equal(key, saved.records[0].key);
      assert.match(key, /^pipa-[a-f0-9]{16}-[a-f0-9-]{36}$/u);
      if (!document.routes.some((route) => route.path === parsed.pathname)) {
        for (const method of ["PUT", "DELETE"]) document.routes.push({ method, path: parsed.pathname, responses: [{ status: 204 }], required: method === init.method });
      }
    }
    return wire.fetch(url, init);
  };
  const selectedFetch = options.transport ? (url, init) => options.transport(url, init, nativeFetch) : nativeFetch;
  const executor = createOpenCodeExecutor({ baseUrl: "http://127.0.0.1:4096", connection: { major: generation === "v1" ? 1 : 2, headers: {} }, fetch: selectedFetch, environment: runtime.env, artifactRoot: runtime.artifactRoot, pollIntervalMs: 1, inputId: () => "msg_input", ...options.executorOptions });
  runtime.defer(() => executor.stopAll(), "executor");
  const input = { prompt: document.prompt, sessionId: document.expected.sessionId, workingDirectory: runtime.workspace, signal: runtime.signal };
  return { runtime, document, wire, executor, input, fetch: selectedFetch };
}

test("v1 baseline: exact prompt, trusted context and persisted-session continuation", async (t) => {
  const current = await fixture(t);
  const { runtime, document, wire, executor, input } = current;
  await executor.ready(runtime.workspace);
  assert.equal(executor.capabilities.liveModelSwitch, false);
  await assert.rejects(executor.listModels({ workingDirectory: runtime.workspace }), /not supported/u);
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
  assert.match(admission.body.system, /pipa restart --channel C1 --thread 1\.0/u);
  assert.doesNotMatch(admission.body.parts[0].text, /PIPA_CURRENT/u);
  const continued = await runner.enqueue("slack:C1:1.0", { ...input, prompt: "continue", deliver: (result) => delivered.push(result.text) });
  assertTurnOutcome(continued, document.continuation, "v1 continuation");
  assert.deepEqual(delivered, ["contract complete", "history retained"]);
  assert.equal((await createSessionStore(pipaPaths(runtime.home).sessions)).get("slack:C1:1.0"), document.expected.sessionId);
  assert.equal(wire.calls.filter((call) => call.path === "/session").length, 0, "continuation must not replace the mapped session");
  assert.doesNotMatch(wire.calls.filter((call) => call.path.endsWith("/prompt_async"))[1].body.system, /PIPA_CURRENT_SLACK_CHANNEL_ID=C1/u);
  wire.assertComplete();
});

test("v2 models: provider-qualified discovery, native default reset and validation before mutation", async (t) => {
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
  const select = (model) => executor.switchModel({ sessionId: input.sessionId, model, workingDirectory: runtime.workspace });
  for (const invalid of [{ providerID: "missing", id: "shared" }, { providerID: "connected", id: "disabled" }, { ...model, variant: "absent" }, { ...model, variant: "" }, undefined]) await assert.rejects(select(invalid), /unavailable|Invalid/u);
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
  await assert.rejects(select(null), /workspace/u);
  assert.equal(wire.calls.filter((call) => call.method === "POST" && call.path.endsWith("/model")).length, 3);
  executor.stopAll();
  await assert.rejects(select(null), /shutting down/u);
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
  assert.equal(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8").catch((error) => error.code), "ENOENT", "Selection must not create a preference/recovery record");
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
    ["/api/form", { location: { directory: runtime.workspace }, data: [form] }],
    ["/api/permission/request", { location: { directory: runtime.workspace }, data: [permission] }],
    ["/api/session/ses_child/permission", { data: [permission] }],
    ["/api/session/ses_contract/form/frm_contract", { data: { ...form, state: { status: "pending" } } }],
    ["/api/session/ses_child", { data: { id: "ses_child", parentID: "ses_contract", location: { directory: runtime.workspace } } }],
  ]) document.routes.push({ method: "GET", path: route, ...(["/api/form", "/api/permission/request"].includes(route) ? { query: { "location[directory]": runtime.workspace } } : {}), repeatLast: true, responses: [{ json }] });
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
    ["/api/form", { location: { directory: runtime.workspace }, data: pendingForms }, { "location[directory]": runtime.workspace }],
    ["/api/permission/request", { location: { directory: runtime.workspace }, data: pendingPermissions }, { "location[directory]": runtime.workspace }],
    ["/api/session/ses_child", { data: { id: "ses_child", parentID: "ses_contract", location: { directory: runtime.workspace } } }],
    ["/api/session/ses_unrelated", { data: { id: "ses_unrelated", location: { directory: runtime.workspace } } }],
    ["/api/session/ses_child/message/msg_tool", { data: { id: "msg_tool", type: "assistant", time: { created: 2 }, content: [{ type: "tool", id: "call_native", name: "bash", time: { created: 2 }, state: { status: "running", input: { command: "pwd" }, metadata: {} } }] } }],
    ["/api/session/ses_wrong_location", { data: { id: "ses_wrong_location", parentID: "ses_contract", location: { directory: path.dirname(runtime.workspace) } } }],
  ]) document.routes.push({ method: "GET", path: route, ...(query ? { query } : {}), repeatLast: true, responses: [{ json }] });
  for (const form of forms) {
    document.routes.push({ method: "GET", path: `/api/session/${form.sessionID}/form/${form.id}`, repeatLast: true, responses: [{ json: { data: { ...form, state: { status: "pending" } } } }] });
    document.routes.push({ method: "POST", path: `/api/session/${form.sessionID}/form/${form.id}/reply`, repeatLast: true, responses: [{ status: 204 }] });
    document.routes.push({ method: "DELETE", path: `/api/session/${form.sessionID}/form/${form.id}`, repeatLast: true, responses: [{ status: 204 }] });
  }
  for (const id of new Set(permissions.map((item) => item.sessionID))) document.routes.push({ method: "GET", path: `/api/session/${id}/permission`, repeatLast: true, responses: [{ json: { data: pendingPermissions } }] });
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

for (const responseKind of ["delayed", "lost", "timeout"]) for (const kind of ["question", "permission reject"]) test(`U3 v2 terminal projection waits for a ${responseKind} local ${kind} acknowledgement before settling its card`, async (t) => {
  const acknowledgement = Promise.withResolvers(), terminalRead = Promise.withResolvers();
  const form = { ...nativeExamples.question, sessionID: "ses_contract", fields: [nativeExamples.question.fields[0]] };
  let applied = false, terminal, acknowledgementLost = false, reconciled = 0;
  const current = await nativeInteractions(t, {
    executorOptions: { connectionRequestTimeoutMs: responseKind === "timeout" ? 200 : 2000 },
    forms: kind === "question" ? [form] : [], permissions: kind === "question" ? [] : [nativeExamples.permission],
    onReply: (_, forms, permissions) => {
      forms.splice(0); permissions.splice(0);
      const messages = current.document.routes.find((route) => route.path.endsWith("/message"));
      messages.responses[messages.responses.length - 1] = terminal;
      if (kind === "question") current.document.routes.find((route) => route.method === "GET" && route.path.endsWith(form.id)).responses[0].json.data.state = { status: "answered", answer: { q0: "blue-id" } };
      applied = true;
    },
    transport: async (url, init, fetch) => {
      const response = await fetch(url, init);
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/reply")) {
        try {
          await bounded(acknowledgement.promise, { signal: init.signal });
          if (responseKind === "lost") throw new TypeError("lost native acknowledgement");
        } catch (error) { acknowledgementLost = true; throw error; }
      }
      if (acknowledgementLost && init.method === "GET" && (pathname === `/api/session/ses_contract/form/${form.id}` || pathname === "/api/session/ses_child/permission")) reconciled++;
      if (applied && new URL(url).pathname === "/api/session/ses_contract/message") {
        const journal = JSON.parse(await readFile(pipaPaths(current.runtime.home).openCodeRecovery, "utf8"));
        if (journal.records[0]?.phase === "admitted") terminalRead.resolve();
      }
      return response;
    },
  });
  const messages = current.document.routes.find((route) => route.path.endsWith("/message"));
  terminal = structuredClone(messages.responses.at(-1));
  if (kind !== "question") terminal.json.data.find((message) => message.type === "assistant").content = [];
  messages.responses[messages.responses.length - 1] = { json: { data: [terminal.json.data[0]], cursor: { previous: null, next: null } } };
  const posted = [], updated = [], deleted = [];
  const thread = { id: "slack:C1:1.0", adapter: { webClient: { chat: {
    postMessage: async (value) => { posted.push(value); return { ts: "2.0" }; }, update: async (value) => updated.push(value), delete: async (value) => deleted.push(value),
  } } } };
  const controls = createPendingInteractions();
  let external = false;
  const turn = current.executor.runTurn({ ...current.input, onInteraction: (interaction) => {
    interaction.settled.then(() => { external = true; });
    return controls.onInteraction({ thread }, interaction);
  } });
  void turn.catch(() => undefined);
  try {
    await waitFor(() => posted.length === 1);
    const elements = posted[0].blocks.flatMap((block) => block.elements ?? []);
    const click = (item, value = item.value) => controls.onAction({ threadId: thread.id, user: { userId: "U1" }, actionId: item.action_id, value });
    if (kind === "question") { const select = elements.find((item) => item.action_id.startsWith("pipa_select_")); await click(select, select.options[0].value); }
    const sending = click(elements.find((item) => item.action_id.startsWith(kind === "question" ? "pipa_submit_" : "pipa_permission_reject_")));
    await bounded(terminalRead.promise, { signal: current.runtime.signal });
    // Drain runnable continuations after the terminal read; the HTTP acknowledgement
    // barrier is still closed. No callback/completion gate conceals the race.
    await new Promise(setImmediate);
    if (responseKind !== "timeout") {
      assert.equal(external, false, "in-flight local acceptance must not be labelled external by finalization");
      assert.deepEqual(deleted, []);
      acknowledgement.resolve();
    }
    await bounded(sending, { timeoutMs: 1000, label: "bounded native acknowledgement/reconciliation" });
    if (responseKind !== "delayed" && kind !== "question") await assert.rejects(turn, /without assistant text/u);
    else assertTurnOutcome(await turn, { ...current.document.expected, ...(kind !== "question" ? { text: "Stopped after a permission was rejected." } : {}) });
    if (responseKind === "delayed") {
      assert.equal(external, false);
      assert.deepEqual(deleted, []);
      assert.match(JSON.stringify(updated.at(-1)), kind === "question" ? /Selected/u : /Permission rejected/u);
    } else {
      assert.equal(acknowledgementLost, true);
      assert.ok(reconciled > 0, "missing acknowledgement requires a native pending-state read before settlement");
      assert.equal(external, true, "absence alone cannot attribute acceptance to the local decision");
      assert.equal(deleted.length, 1);
    }
    assert.equal(current.calls.length, 1);
    current.wire.assertComplete();
  } finally { acknowledgement.resolve(); await turn.catch(() => undefined); }
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

for (const confirmation of ["complete", "wrong tool", "still active", "form pending"]) test(`U3 native root dismissal without idle requires exact native confirmation: ${confirmation}`, async (t) => {
  const done = Promise.withResolvers();
  const form = { ...nativeExamples.question, sessionID: "ses_contract", metadata: { kind: "question", tool: { messageID: "msg_aborted", id: "call_question" } } };
  const current = await nativeInteractions(t, { forms: [form], executorOptions: { cleanupTimeoutMs: 100 }, onPrompt: () => done.promise,
    onReply: async () => {
      const journal = JSON.parse(await readFile(pipaPaths(current.runtime.home).openCodeRecovery, "utf8"));
      assert.deepEqual(journal.records[0].dismissal, { formId: form.id, messageId: "msg_aborted", toolId: "call_question" }, "dismissal intent must be durable before native cancellation");
      const detail = current.document.routes.find((route) => route.method === "GET" && route.path.endsWith("frm_native"));
      detail.responses[0].json.data.state = { status: confirmation === "form pending" ? "pending" : "cancelled" };
      if (confirmation === "still active") current.document.routes.find((route) => route.path === "/api/session/active").responses[0].json.data = { ses_contract: { type: "running" } };
      current.pendingForms.splice(0);
    },
  });
  const messages = current.document.routes.find((route) => route.path.endsWith("/message"));
  messages.responses.at(-1).json.data = [messages.responses.at(-1).json.data[0], {
    id: "msg_aborted", type: "assistant", time: { created: 3, completed: 4 }, finish: "error", error: { type: "aborted", message: "Step interrupted" },
    content: [{ type: "tool", id: confirmation === "wrong tool" ? "other_tool" : "call_question", name: "question", time: { created: 3, completed: 4 },
      state: { status: "error", input: {}, error: { type: "aborted", message: "The user dismissed this question" } } }],
  }];
  current.document.routes.push({ method: "POST", path: "/api/session/ses_contract/interrupt", query: { resume: "false" }, repeatLast: true, responses: [{ json: { interrupted: false } }] });
  const turn = current.executor.runTurn({ ...current.input, signal: AbortSignal.timeout(500), onInteraction: async (interaction) => {
    try { await interaction.submit({ type: "stop" }); return { type: "stop" }; }
    finally { done.resolve(); }
  } });
  if (confirmation === "complete") assert.equal((await turn).text, "");
  else await assert.rejects(turn);
  assert.equal(current.calls.length, 1);
  assert.equal(JSON.parse(await readFile(pipaPaths(current.runtime.home).openCodeRecovery, "utf8")).records.length, confirmation === "complete" ? 0 : 1);
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
  await seen[0].settled;
  await assert.rejects(seen[0].submit({ type: "reject" }), /settled/u);
  messages.responses[messages.responses.length - 1] = completed;
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
      controller.enqueue(new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("")));
      init.signal.addEventListener("abort", () => { try { controller.close(); } catch {} }, { once: true });
    } }), { headers: { "content-type": "text/event-stream" } });
  } });
  const replies = [], reconciliations = [];
  assertTurnOutcome(await current.executor.runTurn({ ...current.input,
    onPermissionReplied: (reply) => replies.push(reply), onPermissionsReconciled: (snapshot) => reconciliations.push(snapshot),
  }), current.document.expected);
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
  assertTurnOutcome(result, current.document.expected);
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
  assertTurnOutcome(result, current.document.expected);
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
  const forms = [...nativeExamples.rich, ...["ses_unrelated", "ses_wrong_location"].map((sessionID, index) => ({ ...nativeExamples.question, sessionID, id: `frm_foreign_${index}` }))];
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
    await waitFor(() => deleted.length === index + 1, { label: `rich form ${index} settled` });
  }
  messages.responses[messages.responses.length - 1] = completed;
  assertTurnOutcome(await turn, current.document.expected);
  assert.deepEqual(seen, ["form", "form", "form", "form"]);
  assert.equal(current.calls.length, 0);
  current.wire.assertComplete();
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
    : /provider failure: OpenCode failed to complete/u);
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

test("U2 recovery failure gates subscriptions, Slack connection and routine construction", async () => {
  const seen = [];
  await assert.rejects(startPipa({ config: { botName: "Pipa", workingDirectory: "/work" },
    checkSlackToken: async () => ({}), sessionStore: { keys: () => { seen.push("subscriptions"); return []; } },
    chat: { initialize: () => seen.push("Slack") }, state: { connect: () => seen.push("state") },
    server: { baseUrl: "http://127.0.0.1:4096", stop: () => seen.push("stop"), wait: async () => undefined },
    createExecutor: () => ({ ready: async () => { throw new Error("abandoned cleanup failed"); } }),
    createRoutineScheduler: () => seen.push("routines"),
  }), /abandoned cleanup failed/u);
  assert.deepEqual(seen, ["stop"]);
});

test("v2 U2: loss before admission retries the exact same ID; loss after admission reconciles without resubmission", async (t) => {
  for (const accepted of [false, true]) {
    let attempts = 0;
    const current = await fixture(t, "v2", { transport: async (url, init, next) => {
      if (!new URL(url).pathname.endsWith("/prompt")) return next(url, init);
      attempts += 1;
      if (attempts === 1) {
        assert.equal(JSON.parse(init.body).id, "msg_input");
        if (accepted) await next(url, init);
        throw new TypeError("lost response");
      }
      return next(url, init);
    } });
    const { executor, input, document, wire, runtime } = current;
    if (!accepted) document.routes.find((route) => route.path.endsWith("/message")).responses.splice(2, 0, { json: { data: [], cursor: { previous: null, next: null } } });
    await runTurnContract({ executor, input, expected: document.expected });
    assert.equal(attempts, accepted ? 1 : 2);
    assert.equal(wire.calls.filter((call) => call.path.endsWith("/prompt")).length, 1);
    assert.deepEqual(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records, []);
    wire.assertComplete();
  }
});

test("v2 U2: permanent admission rejection cleans context and permits a later turn", async (t) => {
  let rejected = false;
  let admitted = false;
  const { executor, input, document, wire, runtime } = await fixture(t, "v2", { transport: async (url, init, next) => {
    if (!rejected && new URL(url).pathname.endsWith("/prompt")) {
      rejected = true;
      return new Response(JSON.stringify({ _tag: "AttachmentError", message: "attachment unavailable" }), { status: 400, headers: { "content-type": "application/json" } });
    }
    if (new URL(url).pathname.endsWith("/prompt")) admitted = true;
    if (new URL(url).pathname.endsWith("/message") && rejected && !admitted) return new Response(JSON.stringify({ data: [], cursor: { previous: null, next: null } }), { headers: { "content-type": "application/json" } });
    return next(url, init);
  } });
  await assert.rejects(executor.runTurn(input), /attachment unavailable/u);
  assert.deepEqual(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records, []);
  const event = document.routes.find((route) => route.path === "/api/event");
  event.responses.push(structuredClone(event.responses[0]));
  await runTurnContract({ executor, input, expected: document.expected });
  wire.assertComplete();
});

test("v2 U2: single-writer active cancellation interrupts and settles before cleanup", async (t) => {
  let admitted = false;
  let interrupted = false;
  let polls = 0;
  const { executor, input, document, wire, runtime } = await fixture(t, "v2", { transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/prompt")) { admitted = true; return next(url, init); }
    if (pathname.endsWith("/interrupt")) {
      assert.equal(init.signal.aborted, false);
      interrupted = true;
      return new Response(JSON.stringify({ interrupted: true }), { headers: { "content-type": "application/json" } });
    }
    if (pathname.endsWith("/message") && admitted) {
      polls += 1;
      const result = structuredClone(document.routes.find((route) => route.path.endsWith("/message")).responses[2].json);
      if (!interrupted) result.data.pop();
      else result.data.at(-1).outcome = "interrupted";
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    }
    return next(url, init);
  } });
  let delivered = false;
  const turn = executor.runTurn(input).then(() => { delivered = true; });
  const rejection = assert.rejects(turn, /cancelled|cleanup failed/u);
  await waitFor(() => polls >= 2);
  assert.equal(delivered, false);
  await executor.abortTurn("ses_contract", new Error("cancelled"));
  await rejection;
  assert.equal(interrupted, true);
  assert.deepEqual(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records, []);
  await executor.ready(input.workingDirectory);
  wire.assertComplete();
});

for (const lostReply of [false, true]) test(`v2 U2: interrupt acceptance without terminal settlement retains recovery (lost reply: ${lostReply})`, async (t) => {
  let admitted = false;
  let interrupted = false;
  let polls = 0;
  const { executor, input, document, runtime, wire } = await fixture(t, "v2", { executorOptions: { cleanupTimeoutMs: 30 }, transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/prompt")) { admitted = true; return next(url, init); }
    if (pathname.endsWith("/interrupt")) {
      assert.equal(pathname, "/api/session/ses_contract/interrupt");
      interrupted = true;
      if (lostReply) throw new TypeError("lost interrupt acknowledgement");
      return new Response(JSON.stringify({ interrupted: true }), { headers: { "content-type": "application/json" } });
    }
    if (pathname.endsWith("/message") && admitted) {
      polls += 1;
      const page = structuredClone(document.routes.find((route) => route.path.endsWith("/message")).responses[2].json);
      page.data.pop();
      return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } });
    }
    return next(url, init);
  } });
  const turn = executor.runTurn(input).catch((error) => error);
  await waitFor(() => polls >= 2);
  await executor.abortTurn("ses_contract");
  assert.ok(await turn instanceof Error);
  assert.equal(interrupted, true);
  assert.equal(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records.length, 1);
  await assert.rejects(executor.ready(runtime.workspace), /blocked/u);
  wire.assertComplete();
});

test("v2 review: cancelled instruction PUT is awaited independently before any DELETE", async (t) => {
  const entered = Promise.withResolvers();
  const commit = Promise.withResolvers();
  const controller = new AbortController();
  let instructionPresent = false;
  let deletes = 0;
  let registered;
  const { executor, input, runtime, wire } = await fixture(t, "v2", { transport: async (url, init, next) => {
    if (new URL(url).pathname.includes("/instructions/entries/")) {
      if (init.method === "PUT") {
        registered = JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records[0];
        entered.resolve();
        const committed = commit.promise.then(() => { instructionPresent = true; return new Response(null, { status: 204 }); });
        return Promise.race([committed, new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }))]);
      }
      deletes += 1;
      instructionPresent = false;
    }
    return next(url, init);
  } });
  const turn = executor.runTurn({ ...input, signal: controller.signal });
  const rejected = assert.rejects(turn, /cancel PUT/u);
  await entered.promise;
  controller.abort(new Error("cancel PUT"));
  await new Promise((resolve) => setImmediate(resolve));
  const earlyDeletes = deletes;
  commit.resolve();
  await rejected;
  assert.equal(earlyDeletes, 0);
  assert.equal(instructionPresent, false, "a late PUT must not recreate context after DELETE");
  assert.equal(registered.instruction, "putting", "uncertainty must be journaled before PUT");
  assert.deepEqual(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records, []);
  wire.assertComplete();
});

for (const fault of ["lost reply", "mutation timeout"]) test(`v2 U2: native synchronous instruction commit with ${fault} is removed and readiness recovers`, async (t) => {
  const entered = Promise.withResolvers();
  const controller = new AbortController();
  let present = false;
  let deletes = 0;
  const { executor, input, runtime, wire, fetch: nativeFetch } = await fixture(t, "v2", { executorOptions: { instructionMutationTimeoutMs: 15 }, transport: async (url, init, next) => {
    if (new URL(url).pathname.includes("/instructions/entries/")) {
      if (init.method === "PUT") {
        present = true; // Native received-body handler performs its SQL mutation before replying.
        entered.resolve();
        if (fault === "lost reply") throw new TypeError("lost instruction reply");
        return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
      }
      deletes += 1;
      present = false;
    }
    return next(url, init);
  } });
  const turn = executor.runTurn({ ...input, signal: controller.signal });
  const failure = turn.catch((error) => error);
  await entered.promise;
  if (fault === "mutation timeout") controller.abort(new Error("cancel while PUT pending"));
  await failure;
  assert.equal(present, false);
  const saved = JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8"));
  assert.deepEqual(saved.records, []);
  assert.equal(deletes, 1);
  await executor.ready(input.workingDirectory);
  const restarted = createOpenCodeExecutor({ baseUrl: "http://127.0.0.1:4096", connection: { major: 2, headers: {} }, environment: runtime.env, fetch: nativeFetch });
  await restarted.ready(runtime.workspace);
  assert.equal(deletes, 1);
  restarted.stopAll();
  wire.assertComplete();
});

test("v2 U2: real HTTP synchronous PUT with a lost acknowledgement is cleaned before reuse", async (t) => {
  const current = await fixture(t, "v2");
  const { runtime, input, wire } = current;
  const entered = Promise.withResolvers();
  let present = false;
  let deletes = 0;
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers.authorization, "Basic synthetic-http");
      let body = "";
      for await (const chunk of request) body += chunk;
      const pathname = new URL(request.url, "http://127.0.0.1").pathname;
      if (pathname === "/api/event") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write('data: {"id":"evt_http_connected","type":"server.connected","data":{}}\n\n');
        return;
      }
      if (pathname.includes("/instructions/entries/") && request.method === "PUT") {
        present = true;
        entered.resolve(); // Lose only the reply, not the server's already completed SQL mutation.
        return;
      }
      if (pathname.includes("/instructions/entries/") && request.method === "DELETE") { deletes += 1; present = false; }
      const result = await current.fetch(`http://127.0.0.1${request.url}`, { method: request.method, ...(body ? { body } : {}) });
      response.writeHead(result.status, Object.fromEntries(result.headers));
      response.end(result.status === 204 ? undefined : await result.text());
    } catch (error) { errors.push(error); response.writeHead(500); response.end(); }
  });
  const baseUrl = await runtime.listen(server);
  const executor = createOpenCodeExecutor({ baseUrl, connection: { major: 2, headers: { authorization: "Basic synthetic-http" } }, environment: runtime.env, pollIntervalMs: 1, instructionMutationTimeoutMs: 100 });
  runtime.defer(() => executor.stopAll(), "HTTP executor");
  const controller = new AbortController();
  const turn = executor.runTurn({ ...input, signal: controller.signal }).catch((error) => error);
  await entered.promise;
  controller.abort(new Error("cancel HTTP PUT"));
  await turn;
  assert.equal(present, false);
  assert.equal(deletes, 1);
  assert.deepEqual(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records, []);
  await executor.ready(runtime.workspace);
  assert.deepEqual(errors, []);
  wire.assertComplete();
});

test("v2 U2: foreign input observed in cleanup's projection is never session-interrupted", async (t) => {
  const controller = new AbortController();
  let admitted = false;
  let polls = 0;
  let foreignRunning = false;
  let interrupts = 0;
  const { executor, input, document, runtime, wire } = await fixture(t, "v2", { transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/prompt")) { admitted = true; return next(url, init); }
    if (pathname.endsWith("/interrupt")) {
      interrupts += 1;
      foreignRunning = false;
      return new Response(JSON.stringify({ interrupted: true }), { headers: { "content-type": "application/json" } });
    }
    if (pathname.endsWith("/message") && admitted) {
      polls += 1;
      const page = structuredClone(document.routes.find((route) => route.path.endsWith("/message")).responses[2].json);
      if (!interrupts) page.data.pop();
      if (controller.signal.aborted) {
        foreignRunning = true;
        page.data.push({ id: "msg_foreign", type: "user", text: "external", time: { created: 4 } });
      }
      return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } });
    }
    return next(url, init);
  } });
  const turn = executor.runTurn({ ...input, signal: controller.signal }).catch((error) => error);
  await waitFor(() => polls >= 2);
  controller.abort(new Error("cancel active turn"));
  await turn;
  assert.equal(interrupts, 0);
  assert.equal(foreignRunning, true);
  assert.equal(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records.length, 1);
  wire.assertComplete();
});

test("v2 review: lost pending-cancel reply cannot hide promotion between inbox and message snapshots", async (t) => {
  let admitted = false;
  let promoted = false;
  let cancellationSent = false;
  let interrupted = false;
  let polls = 0;
  const controller = new AbortController();
  const { executor, input, runtime, wire } = await fixture(t, "v2", { transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (pathname.endsWith("/prompt")) { admitted = true; return next(url, init); }
    if (pathname.endsWith("/interrupt")) { interrupted = true; return json({ interrupted: true }); }
    if (pathname.includes("/inbox/") && init.method === "DELETE") { cancellationSent = true; throw new TypeError("cancel reply lost before settlement"); }
    if (pathname.endsWith("/inbox") && admitted) {
      if (cancellationSent) promoted = true; // Atomic native promotion removes inbox row and appends the user message.
      return json({ data: promoted ? [] : [{ id: "msg_input", sessionID: "ses_contract", type: "user" }] });
    }
    if (pathname.endsWith("/message") && admitted) {
      polls += 1;
      return json({ data: promoted ? [{ id: "msg_input", type: "user", text: input.prompt, time: { created: 2 } }, ...(interrupted ? [{ id: "msg_idle_cancel", type: "idle", outcome: "interrupted", time: { created: 3 } }] : [])] : [], cursor: { previous: null, next: null } });
    }
    return next(url, init);
  } });
  const turn = executor.runTurn({ ...input, signal: controller.signal }).catch((error) => error);
  await waitFor(() => polls >= 2);
  controller.abort(new Error("cancel pending input"));
  await turn;
  assert.equal(promoted, true);
  assert.equal(interrupted, true, "promotion must settle through active cancellation, not disappear as a missing pending item");
  assert.deepEqual(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records, []);
  wire.assertComplete();
});

test("v2 review: foreign admission between final poll and cleanup suppresses success even after own idle", async (t) => {
  let admitted = false;
  let polls = 0;
  const { executor, input, document, runtime, wire } = await fixture(t, "v2", { transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/prompt")) { admitted = true; return next(url, init); }
    if (pathname.endsWith("/message") && admitted) {
      const page = structuredClone(document.routes.find((route) => route.path.endsWith("/message")).responses[2].json);
      if (++polls >= 2) page.data.push({ id: "msg_foreign_late", type: "user", text: "foreign writer", time: { created: 5 } });
      return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } });
    }
    return next(url, init);
  } });
  await assert.rejects(executor.runTurn(input), /attribution conflict/u);
  assert.deepEqual(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records, [], "settled owned work/context can be cleaned despite attribution failure");
  await executor.ready(runtime.workspace);
  wire.assertComplete();
});

test("v2 review: the live watcher still detects foreign input during acknowledged context removal", async (t) => {
  let stream;
  let closed = false;
  const { executor, input, runtime, wire } = await fixture(t, "v2", { transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/api/event") return new Response(new ReadableStream({ start(controller) {
      stream = controller;
      init.signal.addEventListener("abort", () => { closed = true; controller.close(); }, { once: true });
    }, cancel() { closed = true; } }), { headers: { "content-type": "text/event-stream" } });
    if (pathname.includes("/instructions/entries/") && init.method === "DELETE") {
      if (!closed) stream.enqueue(new TextEncoder().encode('data: {"id":"evt_foreign_cleanup","type":"session.inbox.enqueued","data":{"sessionID":"ses_contract","inboxID":"msg_foreign"}}\n\n'));
      await new Promise((resolve) => setImmediate(resolve));
    }
    return next(url, init);
  } });
  await assert.rejects(executor.runTurn(input), /attribution conflict/u);
  assert.equal(closed, true);
  assert.deepEqual(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records, []);
  await executor.ready(runtime.workspace);
  wire.assertComplete();
});

test("v2 review: persistent attached-server refusal is bounded, authenticated, fatal once, and retains uncertain ownership", async (t) => {
  let admitted = false;
  const fatal = [];
  const probes = [];
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("test safety deadline")), 200);
  t.after(() => clearTimeout(timer));
  const { executor, input, runtime, wire } = await fixture(t, "v2", { executorOptions: { connection: { major: 2, headers: { authorization: "Basic synthetic-private" } }, connectionRecoveryTimeoutMs: 15, connectionProbeTimeoutMs: 10, cleanupTimeoutMs: 15, onFatal: (error) => fatal.push(error) }, transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/prompt")) { admitted = true; return next(url, init); }
    if (admitted && init.method === "GET" && pathname !== "/api/event") {
      probes.push({ path: pathname, headers: init.headers });
      throw new TypeError("ECONNREFUSED");
    }
    return next(url, init);
  } });
  await assert.rejects(executor.runTurn({ ...input, signal: controller.signal }));
  assert.equal(controller.signal.aborted, false, "connection recovery must end before the test's safety deadline");
  assert.equal(fatal.length, 1);
  assert.match(fatal[0].message, /unavailable/u);
  assert.ok(probes.length >= 2, "confirm loss through authoritative reads before fatal notification");
  assert.ok(probes.every((probe) => new Headers(probe.headers).get("authorization") === "Basic synthetic-private"));
  assert.equal(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records.length, 1);
  wire.assertComplete();
});

for (const confirmation of ["refused", "timeout", "healthy"]) test(`v2 fallback: cleanup-originated loss after successful idle confirms ${confirmation} independently before fatal notification`, async (t) => {
  let admitted = false;
  let idle = false;
  let cleanupSignal;
  let confirmed = false;
  const fatal = [];
  const probes = [];
  const controller = new AbortController();
  const { executor, input, runtime, wire } = await fixture(t, "v2", { executorOptions: {
    connection: { major: 2, headers: { authorization: "Basic cleanup-private" } },
    cleanupTimeoutMs: 15, connectionRecoveryTimeoutMs: 100, connectionProbeTimeoutMs: 5,
    onFatal: (error) => fatal.push(error),
  }, transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/prompt")) { admitted = true; return next(url, init); }
    if (idle && pathname !== "/api/event") {
      assert.equal(init.method, "GET", "failed cleanup must not mutate or interrupt the attached server");
      cleanupSignal ??= init.signal;
      const independent = cleanupSignal.aborted && !init.signal.aborted;
      probes.push({ independent, authorization: new Headers(init.headers).get("authorization") });
      if (independent) {
        confirmed = true;
        if (confirmation === "healthy") return next(url, init);
        if (confirmation === "timeout") return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
      }
      throw new TypeError("cleanup ECONNREFUSED");
    }
    const response = await next(url, init);
    if (admitted && pathname.endsWith("/message") && response.ok) {
      const page = await response.clone().json();
      idle = page.data.some((message) => message.type === "idle" && message.outcome === "succeeded");
    }
    return response;
  } });
  const safety = setTimeout(() => controller.abort(new Error("test safety deadline")), 500);
  try { await assert.rejects(executor.runTurn({ ...input, signal: controller.signal }), /cleanup failed/u); }
  finally { clearTimeout(safety); }
  assert.equal(idle, true, "loss starts only after a successful execution projection");
  assert.equal(controller.signal.aborted, false, "cleanup and confirmation must finish within their own bounded signals");
  assert.equal(confirmed, true, "the shorter cleanup timeout must not bypass the fresh confirmation probe");
  assert.ok(probes.every((probe) => probe.authorization === "Basic cleanup-private"));
  assert.equal(fatal.length, confirmation === "healthy" ? 0 : 1);
  if (fatal.length) assert.match(fatal[0].message, /unavailable/u);
  assert.equal(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records.length, 1);
  await assert.rejects(executor.runTurn(input), /blocked/u);
  assert.equal(fatal.length, confirmation === "healthy" ? 0 : 1);
  await assert.rejects(executor.listModels({ workingDirectory: input.workingDirectory }), /blocked/u);
  await assert.rejects(executor.switchModel({ ...input, model: null }), /blocked/u);
  wire.assertComplete();
});

for (const mode of ["short outage", "healthy long task"]) test(`v2 review: ${mode} is not a permanent connection failure`, async (t) => {
  let admitted = false;
  let polls = 0;
  let fatal = 0;
  const { executor, input, document, wire } = await fixture(t, "v2", { executorOptions: { connectionRecoveryTimeoutMs: 15, onFatal: () => { fatal += 1; } }, transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/prompt")) { admitted = true; return next(url, init); }
    if (pathname.endsWith("/message") && admitted) {
      polls += 1;
      if (mode === "short outage" && polls <= 3) throw new TypeError("brief connection loss");
      const page = structuredClone(document.routes.find((route) => route.path.endsWith("/message")).responses[2].json);
      if (mode === "healthy long task" && polls < 35) page.data.pop();
      return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } });
    }
    return next(url, init);
  } });
  await runTurnContract({ executor, input, expected: document.expected });
  assert.equal(fatal, 0);
  assert.ok(polls >= (mode === "short outage" ? 4 : 35));
  wire.assertComplete();
});

test("v2 review: temporary event connection refusal recovers before bounded subscription readiness", async (t) => {
  let connections = 0;
  let fatal = 0;
  const { executor, input, document, wire } = await fixture(t, "v2", { executorOptions: { connectionRecoveryTimeoutMs: 50, onFatal: () => { fatal += 1; } }, transport: async (url, init, next) => {
    if (new URL(url).pathname === "/api/event" && ++connections <= 2) throw new TypeError("brief stream refusal");
    return next(url, init);
  } });
  await runTurnContract({ executor, input, expected: document.expected });
  assert.equal(connections, 3);
  assert.equal(fatal, 0);
  wire.assertComplete();
});

test("v2 review: repeated lost admission replies are bounded without marking a healthy server unavailable", async (t) => {
  const attempts = [];
  let fatal = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("test safety deadline")), 200);
  t.after(() => clearTimeout(timer));
  const { executor, input, runtime, wire } = await fixture(t, "v2", { executorOptions: { connectionRecoveryTimeoutMs: 15, onFatal: () => { fatal += 1; } }, transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/prompt")) { attempts.push(JSON.parse(init.body).id); throw new TypeError("admission reply lost"); }
    if (pathname.endsWith("/message")) return new Response(JSON.stringify({ data: [], cursor: { previous: null, next: null } }), { headers: { "content-type": "application/json" } });
    return next(url, init);
  } });
  await assert.rejects(executor.runTurn({ ...input, signal: controller.signal }), /blocked/u);
  assert.equal(controller.signal.aborted, false);
  assert.ok(attempts.length >= 2);
  assert.deepEqual([...new Set(attempts)], ["msg_input"]);
  assert.equal(fatal, 0);
  assert.equal(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records.length, 1);
  wire.assertComplete();
});

test("v2 review: same-session reservation precedes callbacks/downloads and does not reserve other sessions", async (t) => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  let ids = 0;
  const { executor, input, document, runtime, wire } = await fixture(t, "v2", { executorOptions: { inputId: () => ++ids === 1 ? "msg_independent_input" : "msg_input" } });
  const other = JSON.parse(JSON.stringify(document).replaceAll("ses_contract", "ses_independent").replaceAll("msg_input", "msg_independent_input"));
  document.routes.push(...other.routes.filter((route) => route.path.includes("ses_independent")));
  const events = document.routes.find((route) => route.path === "/api/event");
  events.responses.push(structuredClone(events.responses[0]));
  const first = executor.runTurn({ ...input, onSession: async () => { entered.resolve(); await release.promise; } });
  await entered.promise;
  let downloaded = false;
  let callback = false;
  const second = await executor.runTurn({ ...input, attachments: [{ name: "race.txt", fetchData: async () => { downloaded = true; return Buffer.from("race"); } }], onSession: () => { callback = true; throw new Error("duplicate callback"); } }).catch((error) => error);
  let independent;
  try { independent = await executor.runTurn({ ...input, sessionId: "ses_independent" }); }
  finally { release.resolve(); }
  await first;
  assert.match(second.message, /active writer/u);
  assertTurnOutcome(independent, { ...document.expected, sessionId: "ses_independent" });
  assert.equal(callback, false);
  assert.equal(downloaded, false);
  assert.deepEqual(await readdir(runtime.artifactRoot), []);
  wire.assertComplete();
});

test("v2 U2: foreign input fails attribution and is never interrupted", async (t) => {
  let admitted = false;
  let deleted = false;
  const { executor, input, document, runtime, wire } = await fixture(t, "v2", { transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    assert.equal(pathname.endsWith("/interrupt"), false, "foreign execution must survive");
    if (pathname.endsWith("/prompt")) { admitted = true; return next(url, init); }
    if (pathname.includes("/instructions/entries/") && init.method === "DELETE") deleted = true;
    if (pathname.endsWith("/message") && admitted) {
      const result = structuredClone(document.routes.find((route) => route.path.endsWith("/message")).responses[2].json);
      result.data.pop();
      result.data.push({ id: "msg_foreign", type: "user", text: "external prompt", time: { created: 4 } });
      return new Response(JSON.stringify(result), { headers: { "content-type": "application/json" } });
    }
    return next(url, init);
  } });
  await assert.rejects(executor.runTurn(input), /attribution conflict/u);
  assert.equal(deleted, true);
  assert.equal(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records.length, 1);
  await assert.rejects(executor.runTurn(input), /blocked/u);
  wire.assertComplete();
});

test("v2 U2: failed context cleanup retains a private record, blocks intake, and startup reconciles an unbound routine session", async (t) => {
  let failRemoval = true;
  const current = await fixture(t, "v2", { transport: async (url, init, next) => {
    if (new URL(url).pathname.includes("/instructions/entries/") && init.method === "DELETE" && failRemoval) return new Response(null, { status: 503 });
    return next(url, init);
  } });
  const { executor, input, document, wire, runtime } = current;
  await assert.rejects(executor.runTurn({ ...input, sessionId: null }), /cleanup failed/u);
  const recoveryFile = pipaPaths(runtime.home).openCodeRecovery;
  const saved = JSON.parse(await readFile(recoveryFile, "utf8"));
  assert.equal(saved.records.length, 1);
  assert.equal(saved.records[0].sessionId, document.expected.sessionId);
  assert.equal(saved.records[0].phase, "admitted");
  if (process.platform !== "win32") assert.equal((await stat(recoveryFile)).mode & 0o777, 0o600);
  const admissions = wire.calls.filter((call) => call.path.endsWith("/prompt")).length;
  await assert.rejects(executor.runTurn(input), /blocked/u);
  assert.equal(wire.calls.filter((call) => call.path.endsWith("/prompt")).length, admissions);
  failRemoval = false;
  const restarted = createOpenCodeExecutor({ baseUrl: "http://127.0.0.1:4096", connection: { major: 2, headers: {} }, fetch: current.fetch, environment: runtime.env, pollIntervalMs: 1 });
  await restarted.ready(runtime.workspace);
  assert.deepEqual(JSON.parse(await readFile(recoveryFile, "utf8")).records, []);
  assert.equal(wire.calls.filter((call) => call.path.endsWith("/prompt")).length, admissions, "startup must not replay work");
  restarted.stopAll();
  wire.assertComplete();
});

test("v2 U2: all authoritative message pages are read; a foreign admission hidden on page two prevents delivery", async (t) => {
  for (const foreign of [false, true]) {
    let admitted = false;
    const pages = [];
    const { executor, input, document, wire } = await fixture(t, "v2", { transport: async (url, init, next) => {
      const parsed = new URL(url);
      if (parsed.pathname.endsWith("/prompt")) { admitted = true; return next(url, init); }
      if (parsed.pathname.endsWith("/message") && admitted) {
        const completed = structuredClone(document.routes.find((route) => route.path.endsWith("/message")).responses[2].json);
        const cursor = parsed.searchParams.get("cursor");
        pages.push(cursor);
        // 2.0.29's opaque cursor carries order; combining the two is HTTP 400.
        if (cursor && parsed.searchParams.has("order")) return new Response(JSON.stringify({ _tag: "InvalidCursorError", message: "Cursor cannot be combined with order" }), { status: 400, headers: { "content-type": "application/json" } });
        assert.equal(parsed.searchParams.get("order"), cursor ? null : "asc");
        assert.equal(parsed.searchParams.get("limit"), "100");
        if (!cursor) return new Response(JSON.stringify({ data: completed.data, cursor: { previous: null, next: "page-two" } }), { headers: { "content-type": "application/json" } });
        assert.equal(cursor, "page-two");
        return new Response(JSON.stringify({ data: foreign ? [{ id: "msg_external", type: "user", text: "foreign", time: { created: 5 } }] : [], cursor: { previous: "page-one", next: null } }), { headers: { "content-type": "application/json" } });
      }
      return next(url, init);
    } });
    if (foreign) await assert.rejects(executor.runTurn(input), /attribution conflict/u);
    else await runTurnContract({ executor, input, expected: document.expected });
    assert.deepEqual(pages, [null, "page-two", null, "page-two"]);
    wire.assertComplete();
  }
});

test("v2 U2: native cursor-only continuations read short pages through the empty tail before delivery and cleanup", async (t) => {
  const pages = createWireFixture(JSON.parse(await readFile(new URL("./fixtures/opencode/v2/message-pages.json", import.meta.url), "utf8")));
  let admitted = false;
  const { executor, input, document, wire } = await fixture(t, "v2", { transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/prompt")) admitted = true;
    if (admitted && pathname.endsWith("/message")) return pages.fetch(url, init);
    return next(url, init);
  } });
  await runTurnContract({ executor, input, expected: document.expected });
  assert.deepEqual(pages.calls.map((call) => call.query), [0, 1].flatMap(() => [
    { limit: "100", order: "asc" }, { limit: "100", cursor: "opaque-after-input" }, { limit: "100", cursor: "opaque-after-idle" },
  ]));
  pages.assertComplete();
  wire.assertComplete();
});

for (const outcome of ["failed", "interrupted"]) test(`v2 U2: terminal ${outcome} projection cannot deliver even with successful-looking assistant text`, async (t) => {
  const { executor, input, document, wire } = await fixture(t, "v2");
  document.routes.find((route) => route.path.endsWith("/message")).responses[2].json.data.at(-1).outcome = outcome;
  await assert.rejects(executor.runTurn(input), /failed to complete/u);
  wire.assertComplete();
});

test("U2: session persistence callback runs before artifact allocation, context writes or admission on either generation", async (t) => {
  for (const generation of ["v1", "v2"]) {
    const { executor, input, wire, runtime } = await fixture(t, generation);
    await assert.rejects(executor.runTurn({ ...input, contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack" }, onSession: async () => {
      assert.deepEqual(await readdir(runtime.artifactRoot), []);
      throw new Error("session persistence failed");
    } }), /session persistence failed/u);
    assert.equal(wire.calls.some((call) => call.method !== "GET"), false);
    await assert.rejects(access(pipaPaths(runtime.home).openCodeRecovery), { code: "ENOENT" });
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

for (const instruction of ["putting", "present"]) test(`v2 U2: SIGKILL with instruction ${instruction} recovers owned context without routine admission`, async (t) => {
  const { runtime, fetch: nativeFetch, wire } = await fixture(t, "v2");
  const registered = path.join(runtime.state, "registered.json");
  const production = new URL("../src/opencode.mjs", import.meta.url).href;
  const child = runtime.spawn(process.execPath, ["--input-type=module", "-e", `
    import { createOpenCodeExecutor } from ${JSON.stringify(production)};
    import { writeFile, readFile } from 'node:fs/promises';
    let installedBody;
    const checkpoint = async body => {
      const saved = JSON.parse(await readFile(${JSON.stringify(pipaPaths(runtime.home).openCodeRecovery)}, 'utf8'));
      await writeFile(${JSON.stringify(registered)}, JSON.stringify({ saved, body }));
      setInterval(() => {}, 1000);
      return new Promise(() => {});
    };
    const executor = createOpenCodeExecutor({ baseUrl: 'http://127.0.0.1:4096', connection: { major: 2, headers: {} }, environment: process.env, fetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      const json = value => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
      if (pathname === '/api/session') return json({ data: { id: 'ses_contract', location: { directory: process.cwd() } } });
      if (pathname.endsWith('/message')) return json({ data: [], cursor: { previous: null, next: null } });
      if (pathname.endsWith('/inbox')) {
        if (installedBody) return checkpoint(installedBody);
        return json({ data: [] });
      }
      if (pathname.endsWith('/active')) return json({ data: {} });
      if (pathname === '/api/event') return new Response(new ReadableStream({ start(c) { init.signal.addEventListener('abort', () => c.close(), { once: true }); } }), { headers: { 'content-type': 'text/event-stream' } });
      if (pathname.includes('/instructions/entries/') && init.method === 'PUT') {
        if (${JSON.stringify(instruction)} === 'putting') return checkpoint(JSON.parse(init.body));
        installedBody = JSON.parse(init.body);
        return new Response(null, { status: 204 });
      }
      throw new Error('Unexpected native request: ' + pathname);
    } });
    await executor.runTurn({ prompt: 'exact routine prompt', workingDirectory: process.cwd() });
  `]);
  const observed = JSON.parse(await runtime.waitFor(() => readFile(registered, "utf8").catch((error) => { if (error.code === "ENOENT") return false; throw error; })));
  assert.equal(observed.saved.records[0].phase, "prepared");
  assert.equal(observed.saved.records[0].instruction, instruction);
  assert.match(observed.body.value, /pipa routine --help/u);
  child.child.kill("SIGKILL");
  await child.exited;
  const restarted = createOpenCodeExecutor({ baseUrl: "http://127.0.0.1:4096", connection: { major: 2, headers: {} }, fetch: nativeFetch, environment: runtime.env, pollIntervalMs: 1 });
  await restarted.ready(runtime.workspace);
  assert.deepEqual(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records, []);
  assert.equal(wire.calls.some((call) => call.path.endsWith("/prompt")), false);
  assert.deepEqual(wire.calls.filter((call) => call.method === "DELETE").map((call) => call.path.split("/").at(-1)), [observed.saved.records[0].key]);
  restarted.stopAll();
  wire.assertComplete();
});

for (const lostResponse of [false, true]) test(`v2 U2: cancellation removes only the owned pending input with foreign input queued (lost response: ${lostResponse})`, async (t) => {
  let admitted = false;
  let cancelled = false;
  const { executor, input, runtime, wire } = await fixture(t, "v2", { transport: async (url, init, next) => {
    const parsed = new URL(url);
    const json = (value) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (parsed.pathname.endsWith("/prompt")) { admitted = true; return next(url, init); }
    assert.equal(parsed.pathname.endsWith("/interrupt"), false);
    if (parsed.pathname.includes("/inbox/") && init.method === "DELETE") {
      assert.equal(parsed.pathname.split("/").at(-1), "msg_input");
      assert.equal(init.signal.aborted, false);
      cancelled = true;
      if (lostResponse) throw new TypeError("lost cancellation response");
      return new Response(null, { status: 204 });
    }
    if (parsed.pathname.endsWith("/inbox") && admitted) return json({ data: [
      ...(!cancelled ? [{ id: "msg_input", sessionID: "ses_contract", type: "user" }] : []),
      { id: "msg_foreign", sessionID: "ses_contract", type: "user" },
    ] });
    if (parsed.pathname.endsWith("/message") && admitted) return json({ data: [], cursor: { previous: null, next: null } });
    return next(url, init);
  } });
  await assert.rejects(executor.runTurn(input), /attribution conflict/u);
  assert.equal(cancelled, true);
  assert.deepEqual(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records, []);
  wire.assertComplete();
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

test("v2 U2: transient projection and event-stream loss reconcile without another admission", async (t) => {
  let admitted = false;
  let lostProjection = false;
  let streams = 0;
  const { executor, input, document, wire } = await fixture(t, "v2", { transport: async (url, init, next) => {
    const pathname = new URL(url).pathname;
    if (pathname.endsWith("/prompt")) { admitted = true; return next(url, init); }
    if (pathname === "/api/event") {
      streams += 1;
      // A finite live stream has no retained terminal event to replay.
      return new Response("data: {\"id\":\"evt_connected\",\"created\":1,\"type\":\"server.connected\",\"data\":{}}\n\n", { headers: { "content-type": "text/event-stream" } });
    }
    if (admitted && pathname.endsWith("/message") && !lostProjection) { lostProjection = true; throw new TypeError("transient projection loss"); }
    return next(url, init);
  } });
  await runTurnContract({ executor, input, expected: document.expected });
  assert.equal(lostProjection, true);
  assert.ok(streams >= 1);
  assert.equal(wire.calls.filter((call) => call.path.endsWith("/prompt")).length, 1);
  wire.assertComplete();
});

test("v2 U2: hung cleanup is bounded and retains its ownership journal", async (t) => {
  const { executor, input, runtime, wire } = await fixture(t, "v2", { executorOptions: { cleanupTimeoutMs: 20 }, transport: async (url, init, next) => {
    if (new URL(url).pathname.includes("/instructions/entries/") && init.method === "DELETE") return new Promise((_, reject) => {
      assert.equal(init.signal.aborted, false);
      init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
    });
    return next(url, init);
  } });
  const started = Date.now();
  await assert.rejects(executor.runTurn(input), /cleanup failed/u);
  assert.ok(Date.now() - started < 1_000);
  assert.equal(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records.length, 1);
  wire.assertComplete();
});

test("v2 U2: continuation uses new input identity, preserves history, and removes prior Slack context", async (t) => {
  let admitted = 0;
  let ids = 0;
  const instructions = [];
  const { executor, input, document, wire, runtime } = await fixture(t, "v2", {
    executorOptions: { inputId: () => ++ids === 1 ? "msg_input" : "msg_next" },
    transport: async (url, init, next) => {
      const pathname = new URL(url).pathname;
      if (init.method === "PUT") instructions.push(JSON.parse(init.body).value);
      if (pathname.endsWith("/prompt")) admitted += 1;
      if (pathname.endsWith("/message") && admitted) {
        const page = structuredClone(document.routes.find((route) => route.path.endsWith("/message")).responses[2].json);
        if (admitted === 2) page.data.push(
          { id: "msg_next", type: "user", text: "continue", time: { created: 5 } },
          { ...page.data[1], id: "msg_followup", time: { created: 6, completed: 7 }, content: [{ type: "text", text: "history retained" }] },
          { id: "msg_next_idle", type: "idle", time: { created: 8 }, outcome: "succeeded" });
        return new Response(JSON.stringify(page), { headers: { "content-type": "application/json" } });
      }
      return next(url, init);
    },
  });
  await runTurnContract({ executor, input: { ...input, contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack", PIPA_CURRENT_SLACK_CHANNEL_ID: "C1", PIPA_CURRENT_SLACK_THREAD_TS: "1.0" } }, expected: document.expected });
  const prompt = document.routes.find((route) => route.path.endsWith("/prompt"));
  prompt.repeatLast = true;
  prompt.body = { id: "msg_next", text: "continue" };
  prompt.responses[0].json.data.id = "msg_next";
  prompt.responses[0].json.data.payload.text = "continue";
  document.routes.find((route) => route.path === "/api/event").responses.push(structuredClone(document.routes.find((route) => route.path === "/api/event").responses[0]));
  await runTurnContract({ executor, input: { ...input, prompt: "continue" }, expected: document.continuation });
  assert.equal(wire.calls.some((call) => call.path === "/api/session"), false);
  assert.match(instructions[0], /PIPA_CURRENT_SLACK_CHANNEL_ID=C1/u);
  assert.match(instructions[0], /pipa restart --channel C1 --thread 1\.0/u);
  assert.doesNotMatch(instructions[1], /PIPA_CURRENT_SLACK_CHANNEL_ID=C1|--channel C1/u);
  assert.deepEqual(JSON.parse(await readFile(pipaPaths(runtime.home).openCodeRecovery, "utf8")).records, []);
  assert.equal(wire.calls.filter((call) => call.method === "DELETE").length, 2);
  wire.assertComplete();
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
      assert.ok(call.body.system.includes(JSON.stringify(process.env.PIPA_HOME)));
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
