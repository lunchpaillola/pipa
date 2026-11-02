import assert from "node:assert/strict";
import test from "node:test";
import { createSlackClient, assertRoutine, assertRestartObservation, withAppLock } from "../scripts/verification/slack-eval.mjs";
import { randomUUID } from "node:crypto";
import { rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { collectLive, releaseChecklist } from "../scripts/slack-release-eval.mjs";
import { runRoutineEval } from "../scripts/slack-routine-eval.mjs";
import { releaseCases } from "../scripts/verification/opencode-release-cases.mjs";

test("Slack reads paginate and honor rate limits; writes are never blindly retried", async () => {
  const calls = [];
  const sleeps = [];
  const client = createSlackClient({ token: "private", sleep: async (ms) => sleeps.push(ms), fetch: async (_, init) => {
    const fields = new URLSearchParams(init.body);
    calls.push(fields.get("cursor"));
    if (calls.length === 1) return new Response("", { status: 429, headers: { "retry-after": "1" } });
    return Response.json({ ok: true, messages: [{ ts: fields.has("cursor") ? "2.0" : "1.0" }], response_metadata: { next_cursor: fields.has("cursor") ? "" : "page2" } });
  } });
  assert.deepEqual((await client.messages("conversations.replies", { channel: "CTEST", ts: "1.0" })).map((m) => m.ts), ["1.0", "2.0"]);
  assert.deepEqual(calls, [null, null, "page2"]);
  assert.deepEqual(sleeps, [1000]);
  let writes = 0;
  const failed = createSlackClient({ token: "private", fetch: async () => { writes++; throw new Error("network"); } });
  await assert.rejects(failed.call("chat.postMessage", {}), /network/u);
  assert.equal(writes, 1);
  const truncated = createSlackClient({ token: "private", fetch: async () => Response.json({ ok: true, messages: [], has_more: true }) });
  await assert.rejects(truncated.messages("conversations.history", {}), /pagination/u);
});

test("routine evidence checks exact prompt, schedule, timezone, route and lifecycle", () => {
  const expected = { prompt: "  exact\ntext  ", channelId: "CTEST", threadTs: "1.0", before: 1000, after: 2000 };
  const routine = { prompt: expected.prompt, timezone: "UTC", destination: { channelId: "CTEST", threadTs: "1.0" }, schedule: { type: "once", at: new Date(61500).toISOString() }, status: "active", nextRunAt: new Date(61500).toISOString() };
  assertRoutine(routine, expected);
  for (const change of [{ prompt: routine.prompt.trim() }, { timezone: "America/New_York" }, { destination: { channelId: "COTHER" } }, { status: "completed" }, { schedule: { type: "once", at: new Date(0).toISOString() } }]) assert.throws(() => assertRoutine({ ...routine, ...change }, expected));
});

test("restart evidence requires durable completion, old exit and exact replacement identity", () => {
  const old = { pid: 100, generation: "old" };
  const replacement = { pid: 200, generation: "new" };
  const status = { id: "old", state: "completed", replacement };
  assertRestartObservation({ old, replacement, status, oldRunning: false });
  for (const change of [{ status: { ...status, state: "requested" } }, { oldRunning: true }, { replacement: old }, { status: { ...status, id: "other" } }, { status: { ...status, replacement: { pid: 201, generation: "new" } } }]) assert.throws(() => assertRestartObservation({ old, replacement, status, oldRunning: false, ...change }));
});

test("live checklist keeps all applicable semantic gates blocked until observed", () => {
  for (const mode of ["attached", "socket-owned"]) {
    const rows = releaseChecklist(mode);
    assert.deepEqual(rows.map((r) => r.id), releaseCases.filter((c) => c.lane === "live" && c.modes.includes(mode)).map((c) => c.id));
    assert.ok(rows.every((r) => r.status === "BLOCKED" && r.expected && r.observed));
  }
  assert.throws(() => releaseChecklist("managed"));
});

test("routine preview mutation fails before confirmation and preserves unrelated routines", async () => {
  let reads = 0;
  let posts = 0;
  const result = await runRoutineEval({
    channelId: "CTEST", botUserId: "UPIPA",
    async routines() { return [{ id: "existing", prompt: reads++ ? "mutated" : "original" }]; },
    async post() { posts++; return { ts: "1.0" }; },
    async replies() { return [{ ts: "2.0", text: "preview test-nonce schedule" }]; },
  }, { nonce: "test-nonce" });
  assert.equal(posts, 1);
  assert.equal(result.status, "FAIL");
  assert.match(result.error, /Preview changed routine state/u);
  assert.equal(result.cleanup.status, "FAIL");
  assert.equal(result.cleanup.pendingTurnUnconfirmed, true);
  assert.deepEqual(result.cleanup.deleted, []);
});

test("collector verifies original-session restart before routine remapping and never attributes unbound versions", async () => {
  let session = "original";
  let nonce;
  let posts = 0;
  const replies = [];
  const context = { pipa: "candidate-cli", identity: { pid: 123, generation: "old" }, connection: { version: "2.0.29", major: 2 }, channelId: "CTEST", botUserId: "UPIPA", botName: "Test", teamId: "TTEST",
    async post(text) {
      const ts = `${++posts}.0`;
      if (text.startsWith("<@")) { nonce = text.match(/marker ([^.]+)\./u)[1]; replies.push({ ts: "1.1", text: `LIVE ${nonce}` }); }
      else replies.push({ ts: `${posts}.1`, text: `${text.startsWith("After restart") ? "RESTART" : "RECALL"} ${nonce}` });
      return { ts };
    },
    async replies() { return replies; },
    async sessions() { return { "slack:CTEST:1.0": session }; },
  };
  let routines = 0;
  const report = await collectLive(context, { mode: "socket-owned", restart: true,
    async restartObserver() { assert.equal(session, "original"); assert.equal(routines, 0); replies.push({ text: "Test restarted and is ready." }); return { requestId: "old" }; },
    async runRoutine(_, { threadTs }) { routines++; if (threadTs) session = "routine-session"; return { status: "PASS", cleanup: { status: "PASS" } }; },
  });
  assert.equal(report.automated.find((r) => r.id === "socket-detached-restart").status, "PASS");
  assert.equal(routines, 2);
  assert.equal(report.status, "BLOCKED");
  assert.equal(report.engine, null);
  assert.equal(report.pipa, null);
  assert.equal(report.identityBinding.status, "BLOCKED");
  assert.equal(report.identityBinding.endpointVersion, "2.0.29");
});

test("app lock rejects competition and is retained after unconfirmed cleanup", async () => {
  const context = { teamId: `T${randomUUID().replaceAll("-", "").toUpperCase()}`, botUserId: "UTEST", identity: { pid: 123 } };
  const file = path.join(os.tmpdir(), `pipa-slack-eval-${context.teamId}-${context.botUserId}.lock`);
  try {
    await withAppLock(context, async () => {
      await assert.rejects(withAppLock(context, async () => assert.fail("competing run started")), { code: "EEXIST" });
      return { cleanup: { status: "PASS" } };
    });
    await withAppLock(context, async () => ({ cleanup: { status: "FAIL" } }));
    await assert.rejects(withAppLock(context, async () => assert.fail("unsafe next run started")), { code: "EEXIST" });
  } finally { await rm(file, { force: true }); }
});
