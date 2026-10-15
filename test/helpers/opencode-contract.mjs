import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// These assertions accept the public executor result, including one imported from
// an installed tarball. No adapter imports, engine launches or test registration.
export function assertTurnOutcome(result, expected, caseName = "turn outcome") {
  assert.equal(result?.sessionId, expected.sessionId, `${caseName}: session continuity`);
  assert.equal(result?.text, expected.text, `${caseName}: final assistant text`);
  assert.deepEqual((result?.files ?? []).map(({ filename, data }) => ({ filename, base64: Buffer.from(data).toString("base64") })), expected.files ?? [], `${caseName}: artifact bytes`);
  assert.equal(result?.superseded, undefined, `${caseName}: unexpected supersession`);
  assert.equal(result?.error, undefined, `${caseName}: unexpected failure`);
}

export async function runTurnContract({ executor, input, expected, caseName = "turn outcome" }) {
  try {
    const result = await executor.runTurn(input);
    assertTurnOutcome(result, expected, caseName);
    return result;
  } catch (cause) {
    throw new Error(`${caseName}: ${cause.message}`, { cause });
  }
}

export function assertPromptReceipt(receipt, expected, caseName = "prompt fidelity") {
  assert.equal(receipt.prompt, expected.prompt, `${caseName}: exact prompt bytes`);
  assert.deepEqual(receipt.context, expected.context, `${caseName}: turn-scoped context`);
}

export function assertSupersessionOutcome({ previous, latest, independent, delivered }, expected) {
  assert.deepEqual(previous, { superseded: true }, "supersession: old turn must be inert");
  assertTurnOutcome(latest, expected.latest, "supersession: latest turn");
  assertTurnOutcome(independent, expected.independent, "supersession: independent thread");
  assert.deepEqual(delivered, expected.delivered, "supersession: stale/duplicate delivery");
}

export async function loadWireFixture(generation, { workspace, temp } = {}) {
  assert.ok(["v1", "v2"].includes(generation), "Unknown wire generation");
  const document = JSON.parse(await readFile(new URL(`../fixtures/opencode/${generation}/http.json`, import.meta.url), "utf8"));
  const replace = (value) => {
    if (typeof value === "string") return value.replaceAll("$WORKSPACE", workspace ?? "/fixture/workspace").replaceAll("$TEMP", temp ?? "/fixture/temp");
    if (Array.isArray(value)) return value.map(replace);
    if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, key === "sse"
      ? item.replaceAll("$WORKSPACE", JSON.stringify(workspace ?? "/fixture/workspace").slice(1, -1)).replaceAll("$TEMP", JSON.stringify(temp ?? "/fixture/temp").slice(1, -1))
      : replace(item)]));
    return value;
  };
  return replace(document);
}

// Strict finite wire playback, not an engine emulator. Sticky failures make
// swallowed watcher errors fail verification too. Repetition is opt-in per route.
export function createWireFixture(document, { onRequest } = {}) {
  const calls = [];
  const failures = [];
  const counts = new Map();
  const streams = new Set();
  async function fetch(url, init = {}) {
    try {
      init.signal?.throwIfAborted();
      const parsed = new URL(url);
      const method = init.method ?? "GET";
      const candidates = document.routes.filter((route) => route.method === method && route.path === parsed.pathname);
      const route = candidates.find((route) => Object.keys(route.query ?? {}).length === parsed.searchParams.size
        && Object.entries(route.query ?? {}).every(([key, value]) => parsed.searchParams.get(key) === value)) ?? candidates[0];
      assert.ok(route, `${document.generation}: unknown wire request ${method} ${parsed.pathname}`);
      assert.deepEqual(Object.fromEntries(parsed.searchParams), route.query ?? {}, `${document.generation}: ${route.path}: query`);
      const body = init.body ? JSON.parse(init.body) : undefined;
      if (route.body !== undefined) assert.deepEqual(body, route.body, `${document.generation}: ${route.path}: native body`);
      const count = counts.get(route) ?? 0;
      const response = route.responses[count] ?? (route.repeatLast ? route.responses.at(-1) : undefined);
      assert.ok(response, `${document.generation}: exhausted wire route ${method} ${route.path}`);
      counts.set(route, count + 1);
      const call = { method, path: parsed.pathname, query: Object.fromEntries(parsed.searchParams), body };
      calls.push(call);
      await onRequest?.(call, init);
      init.signal?.throwIfAborted();
      if (response.json !== undefined && (response.status ?? 200) < 400) validateWireEnvelope(response.json, route.path, document.generation);
      if (response.sse !== undefined) {
        validateEventStream(response.sse, document.generation);
        let cancel;
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(response.sse));
            cancel = () => { streams.delete(stream); init.signal?.removeEventListener("abort", cancel); controller.close(); };
            init.signal?.addEventListener("abort", cancel, { once: true });
          },
          cancel() { streams.delete(stream); init.signal?.removeEventListener("abort", cancel); },
        });
        streams.add(stream);
        return new Response(stream, { status: response.status ?? 200, headers: { "content-type": "text/event-stream" } });
      }
      if (response.raw !== undefined) return new Response(response.raw, { status: response.status ?? 200, headers: { "content-type": response.contentType ?? "application/json" } });
      return new Response(response.status === 204 ? null : JSON.stringify(response.json), { status: response.status ?? 200, headers: { "content-type": "application/json" } });
    } catch (error) {
      if (!init.signal?.aborted) failures.push(error);
      throw error;
    }
  }
  return { fetch, calls,
    assertComplete() {
      if (failures.length) throw new AggregateError(failures, `${document.generation}: wire contract failed: ${failures[0].message}`);
      for (const route of document.routes) {
        if (route.required) assert.ok(counts.get(route), `${document.generation}: missing wire request ${route.method} ${route.path}`);
      }
      assert.equal(streams.size, 0, `${document.generation}: event stream leaked`);
    },
  };
}

function validateWireEnvelope(value, pathname, generation) {
  if (pathname === "/session/status") {
    assert.ok(value && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((session) => typeof session?.type === "string"), `${generation}: malformed status envelope`);
  }
  if (!pathname.endsWith("/message")) return;
  const messages = generation === "v1" ? value : value?.data;
  assert.ok(Array.isArray(messages), `${generation}: malformed message envelope`);
  for (const message of messages) {
    if (generation === "v1") {
      assert.equal(typeof message?.info?.id, "string", "v1: malformed message identity");
      assert.equal(typeof message?.info?.role, "string", "v1: malformed message role");
      assert.ok(Array.isArray(message.parts), "v1: malformed message parts");
    } else {
      assert.equal(typeof message?.id, "string", "v2: malformed message identity");
      assert.equal(typeof message?.type, "string", "v2: malformed message type");
      assert.equal(typeof message?.time?.created, "number", "v2: malformed message time");
      if (message.type === "assistant") assert.ok(Array.isArray(message.content), "v2: malformed assistant content");
      if (message.type === "idle") assert.ok(["succeeded", "failed", "interrupted"].includes(message.outcome), "v2: malformed idle outcome");
    }
  }
  if (generation === "v2") assert.ok(value.cursor && typeof value.cursor === "object", "v2: missing message cursor");
}

export function validateEventStream(text, generation) {
  assert.ok(text.endsWith("\n\n"), `${generation}: truncated SSE frame`);
  for (const frame of text.trimEnd().split("\n\n")) {
    const data = frame.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
    let event;
    try { event = JSON.parse(data); }
    catch { throw new Error(`${generation}: malformed SSE JSON`); }
    assert.equal(typeof event?.type, "string", `${generation}: malformed event envelope`);
    assert.ok(event[generation === "v1" ? "properties" : "data"] && typeof event[generation === "v1" ? "properties" : "data"] === "object", `${generation}: malformed event payload`);
    if (generation === "v2") {
      assert.equal(typeof event.id, "string", "v2: missing event ID");
      assert.equal(typeof event.created, "number", "v2: missing event time");
    }
  }
}
