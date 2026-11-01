import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { slackDestinationId } from "../src/app.mjs";
import { releaseCases } from "./verification/opencode-release-cases.mjs";
import { liveContext, observeRestart, safeError, waitFor, withAppLock } from "./verification/slack-eval.mjs";
import { runRoutineEval } from "./slack-routine-eval.mjs";

// Broad human release gates require evidence beyond a successful model response.
export function releaseChecklist(mode) {
  assert.ok(["socket-owned", "attached"].includes(mode), "Unknown live mode");
  return releaseCases.filter((c) => c.lane === "live" && c.modes.includes(mode)).map((c) => ({
    id: c.id, expected: c.expected, status: "BLOCKED", observed: c.blocked, evidenceRef: null,
  }));
}

export async function collectLive(context, { mode, restart = false, runRoutine = runRoutineEval, restartObserver = observeRestart }) {
  const report = { schema: "pipa-slack-release/v1", nonce: randomUUID(), startedAt: new Date().toISOString(),
    pipa: null, engine: null, adapterSelected: null,
    identityBinding: { status: "BLOCKED", observed: "Independent CLI/server probes are not bound to the running candidate. Operator process/package/endpoint evidence required", candidate: context.identity,
      cliVersion: context.pipa, endpointVersion: context.connection.version, endpointMajor: context.connection.major },
    node: process.version, platform: process.platform, arch: process.arch, mode, modeVerified: false,
    channelId: context.channelId, botUserId: context.botUserId, teamId: context.teamId,
    releaseQualified: false, cases: releaseChecklist(mode), automated: [] };
  const record = async (id, run) => {
    try { const result = await run(); report.automated.push({ id, status: "PASS", ...result }); return result; }
    catch (error) { report.automated.push({ id, status: "FAIL", observed: safeError(error) }); return null; }
  };
  try {
    const root = await context.post(`<@${context.botUserId}> Remember the marker ${report.nonce}. Reply with exactly: LIVE ${report.nonce}`);
    report.rootTs = root.ts;
    const session = await record("chat-continuation", async () => {
      const reply = await waitFor(async () => (await context.replies(root.ts)).find((m) => m.text?.trim() === `LIVE ${report.nonce}`));
      const key = slackDestinationId({ channelId: context.channelId, threadTs: root.ts });
      const sessionId = (await context.sessions())[key];
      assert.ok(sessionId);
      const followup = await context.post("Recall the marker from my first message. Reply with exactly: RECALL followed by a space and that marker.", root.ts);
      const recalled = await waitFor(async () => (await context.replies(root.ts)).find((m) => Number(m.ts) > Number(followup.ts) && m.text?.trim() === `RECALL ${report.nonce}`));
      assert.equal((await context.sessions())[key], sessionId, "Same mapped session");
      return { sessionId, replyTs: reply.ts, recallTs: recalled.ts };
    });
    assert.ok(session, "Chat observation failed; settle the candidate before continuing");
    if (restart && session) {
      const observed = await record("socket-detached-restart", async () => {
        const result = await restartObserver(context, root.ts);
        const followup = await context.post("After restart, recall the original marker. Reply with exactly: RESTART followed by a space and that marker.", root.ts);
        await waitFor(async () => (await context.replies(root.ts)).find((m) => Number(m.ts) > Number(followup.ts) && m.text?.trim() === `RESTART ${report.nonce}`));
        assert.equal((await context.sessions())[slackDestinationId({ channelId: context.channelId, threadTs: root.ts })], session.sessionId);
        assert.equal((await context.replies(root.ts)).filter((m) => m.text === `${context.botName} restarted and is ready.`).length, 1);
        return result;
      });
      // Attached ownership/remote-host proof remains a separate operator gate.
      const row = report.cases.find((c) => c.id === "socket-detached-restart");
      if (row) Object.assign(row, { status: observed ? "PASS" : "FAIL", observed: observed ? "External observer verified durable replacement, one ready notice and original-session recall" : "See automated restart failure", evidenceRef: `#/automated/${report.automated.findIndex((r) => r.id === "socket-detached-restart")}` });
      assert.ok(observed, "Restart observation failed; settle the candidate before continuing");
    }
    // An existing-thread routine intentionally replaces that thread's mapping.
    // Check the original chat's restart continuity before running those routines.
    for (const threadTs of [undefined, root.ts]) {
      const evidence = await runRoutine(context, { threadTs });
      report.automated.push({ id: threadTs ? "routine-once-thread" : "routine-once-channel", ...evidence });
      if (evidence.cleanup?.status !== "PASS") break;
    }
    const unconfirmed = report.automated.some((r) => r.status === "FAIL" || r.cleanup?.status !== undefined && r.cleanup.status !== "PASS");
    report.cleanup = { status: unconfirmed ? "FAIL" : "PASS", observed: unconfirmed ? "Failed observation leaves agent settlement unconfirmed; retain app lock, stop/drain candidate and reconcile nonce routines" : "Nonce routine cleanup recorded per case; messages retained as evidence; candidate remains operator-owned" };
  } catch (error) {
    report.automated.push({ id: "collection", status: "FAIL", observed: safeError(error) });
    report.cleanup = { status: "FAIL", observed: "Agent settlement unconfirmed; retain app lock and stop/drain candidate before nonce reconciliation" };
  }
  report.completedAt = new Date().toISOString();
  report.status = report.automated.some((r) => r.status === "FAIL") || report.cleanup?.status !== "PASS" ? "FAIL" : "BLOCKED";
  return report;
}

async function main(argv) {
  const mode = argv.find((a) => a.startsWith("--mode="))?.slice(7) ?? "socket-owned";
  releaseChecklist(mode);
  for (const arg of argv) assert.ok(["--plan", "--run", "--restart"].includes(arg) || arg.startsWith("--mode="), "Unknown evaluator argument");
  assert.ok(!(argv.includes("--plan") && argv.includes("--run")), "Choose --plan or --run");
  if (!argv.includes("--run")) {
    assert.ok(!argv.includes("--restart"), "--restart requires --run and operator authorization");
    process.stdout.write(`${JSON.stringify({ mode, cases: releaseChecklist(mode), instructions: "See docs/pipa-testing.md; --run posts real messages and creates confirmed nonce routines; --restart additionally requests a live candidate restart" }, null, 2)}\n`);
    return;
  }
  const directory = fileURLToPath(new URL("../tmp/slack-release-evals/", import.meta.url));
  let report;
  try {
    const context = await liveContext(path.resolve(process.env.PIPA_TEST_CLI || fileURLToPath(new URL("../bin/pipa.mjs", import.meta.url))));
    assert.equal(Boolean(process.env.PIPA_OPENCODE_ATTACH_URL), mode === "attached", "Mode must match candidate attach environment");
    report = await withAppLock(context, () => collectLive(context, { mode, restart: argv.includes("--restart") }));
  } catch (error) { report = { schema: "pipa-slack-release/v1", releaseQualified: false, status: "BLOCKED", cases: releaseChecklist(mode), error: safeError(error) }; }
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${randomUUID()}.json`);
  await writeFile(file, JSON.stringify(report, null, 2), { mode: 0o600, flag: "wx" });
  process.stdout.write(`${report.status} live release collection; private evidence: ${file}\n`);
  // A partial automated smoke never exits successfully as release qualification.
  process.exitCode = report.status === "PASS" ? 0 : 1;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url) && !process.env.NODE_TEST_CONTEXT) await main(process.argv.slice(2));
