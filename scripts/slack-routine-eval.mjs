import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slackDestinationId } from "../src/app.mjs";
import { assertRoutine, liveContext, runCli, safeError, sleep, waitFor, withAppLock } from "./verification/slack-eval.mjs";

export async function runRoutineEval(context, { threadTs, nonce = `routine-${randomUUID()}` } = {}) {
  const original = await context.routines();
  const baseline = new Set(original.map((r) => r.id));
  const prompt = `Reply with exactly: ROUTINE PASS ${nonce}`;
  const evidence = { nonce, status: "FAIL", destination: { channelId: context.channelId, threadTs: threadTs ?? null } };
  // ponytail: the evaluator attaches to an operator-owned candidate; only nonce
  // routines are removed. Process startup/stop belongs to the operator runbook.
  try {
    const request = await context.post(`<@${context.botUserId}> Preview a local Pipa routine with prompt exactly ${JSON.stringify(prompt)}. Use timezone UTC, channel ${context.channelId}, ${threadTs ? `existing thread ${threadTs}` : "no thread"}, and --in 1m. Do not create it yet. Show the normalized preview including ${nonce}.`, threadTs);
    const rootTs = threadTs ?? request.ts;
    evidence.previewTs = (await waitFor(async () => (await context.replies(rootTs)).find((m) => Number(m.ts) > Number(request.ts) && m.text?.includes(nonce) && /preview|next run|schedule/iu.test(m.text)))).ts;
    assert.deepEqual(await context.routines(), original, "Preview changed routine state");
    const before = Date.now();
    await context.post(`I confirm that preview for ${nonce}. Create the exact routine now using --in 1m, then reply with its ID.`, rootTs);
    const routine = await waitFor(async () => {
      const matches = (await context.routines()).filter((r) => !baseline.has(r.id) && r.prompt.includes(nonce));
      assert.ok(matches.length <= 1, "Duplicate nonce routines");
      return matches[0];
    });
    assertRoutine(routine, { prompt, channelId: context.channelId, threadTs, before, after: Date.now() });
    evidence.routineId = routine.id;
    evidence.schedule = routine.schedule;
    const results = async () => {
      const messages = threadTs ? await context.reader.messages("conversations.replies", { channel: context.channelId, ts: threadTs })
        : await context.reader.messages("conversations.history", { channel: context.channelId, oldest: String(before / 1000), inclusive: "true" });
      return messages.filter((m) => m.user === context.botUserId && (threadTs ? m.thread_ts === threadTs : !m.thread_ts || m.thread_ts === m.ts) && m.text?.trim() === `ROUTINE PASS ${nonce}`);
    };
    const result = await waitFor(async () => { const matches = await results(); assert.ok(matches.length <= 1, "Duplicate scheduled results"); return matches[0]; });
    const completed = await waitFor(async () => { const saved = (await context.routines()).find((r) => r.id === routine.id); return saved?.status === "completed" && saved; });
    assert.equal(completed.lastRun?.status, "succeeded");
    assert.equal(completed.lastRun?.trigger, "scheduled");
    assert.equal(completed.nextRunAt, null);
    const resultThread = threadTs ?? result.ts;
    const key = slackDestinationId({ channelId: context.channelId, threadTs: resultThread });
    const session = (await context.sessions())[key];
    assert.ok(session, "Routine result session mapping");
    const followup = await context.post(`Reply with exactly: CONTINUED ${nonce}`, resultThread);
    await waitFor(async () => (await context.replies(resultThread)).find((m) => Number(m.ts) > Number(followup.ts) && m.text?.trim() === `CONTINUED ${nonce}`));
    assert.equal((await context.sessions())[key], session);
    await sleep(35000); // Observe a subsequent production scheduler boundary.
    assert.equal((await results()).length, 1);
    Object.assign(evidence, { status: "PASS", resultTs: result.ts, sessionId: session, duplicateCount: 0 });
  } catch (error) { evidence.error = safeError(error); }
  finally {
    try {
      const matches = (await context.routines()).filter((r) => !baseline.has(r.id) && r.prompt.includes(nonce));
      for (const routine of matches) await runCli(context.cli, "routine", "delete", routine.id, "--json");
      assert.ok(!(await context.routines()).some((r) => !baseline.has(r.id) && r.prompt.includes(nonce)));
      evidence.cleanup = { status: evidence.status === "PASS" ? "PASS" : "FAIL", deleted: matches.map((r) => r.id),
        ...(evidence.status !== "PASS" ? { pendingTurnUnconfirmed: true, observed: "Visible nonce routines removed, but outstanding agent settlement is unconfirmed. Stop/drain the candidate and reconcile nonce routines before releasing the app lock." } : {}) };
    } catch (error) { evidence.cleanup = { status: "FAIL", error: safeError(error) }; evidence.status = "FAIL"; }
  }
  return evidence;
}

async function main() {
  const directory = fileURLToPath(new URL("../tmp/slack-routine-evals/", import.meta.url));
  let evidence;
  try {
    const context = await liveContext(path.resolve(process.env.PIPA_TEST_CLI || fileURLToPath(new URL("../bin/pipa.mjs", import.meta.url))));
    evidence = await withAppLock(context, () => runRoutineEval(context));
  }
  catch (error) { evidence = { status: "BLOCKED", error: safeError(error) }; }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(evidence, null, 2), { mode: 0o600, flag: "wx" });
  process.stdout.write(`${evidence.status} routine evaluation; private evidence: ${file}\n`);
  process.exitCode = evidence.status === "PASS" ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && !process.env.NODE_TEST_CONTEXT) await main();
