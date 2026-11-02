import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { loadConfig, readInstanceLock, isRunning, loadSessions } from "../../src/state.mjs";
import { cleanChildEnvironment, checkOpenCodeConnection } from "../../src/opencode.mjs";
import { restartStatus } from "../../src/restart.mjs";
import { open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const execute = promisify(execFile);
export const sleep = delay;
export const safeError = (error) => String(error?.message ?? error).replace(/xox[baprs]-[^\s"\\]+|xapp-[^\s"\\]+/gu, "[redacted]").slice(0, 500);
export function requiredEnv(name) {
  assert.ok(process.env[name]?.trim(), `${name} is required.`);
  return process.env[name].trim();
}

export function createSlackClient({ token, fetch: fetchImpl = fetch, sleep = delay, timeoutMs = 300000 }) {
  async function call(method, fields) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const response = await fetchImpl(`https://slack.com/api/${method}`, {
        method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams(fields), signal: AbortSignal.timeout(Math.max(1, Math.min(30000, deadline - Date.now()))),
      });
      if (response.status === 429) {
        await response.body?.cancel();
        const ms = Math.max(1000, Number(response.headers.get("retry-after") ?? 1) * 1000);
        assert.ok(Number.isFinite(ms) && Date.now() + ms < deadline, "Slack rate limit exceeded evaluation deadline");
        await sleep(ms);
        continue; // Slack explicitly rejected this request; no ambiguous write retry.
      }
      const result = await response.json();
      assert.ok(response.ok && result.ok, `Slack API ${method} failed: ${result.error ?? response.status}`);
      return result;
    }
  }
  return { call, async messages(method, fields) {
    const messages = new Map();
    const cursors = new Set();
    let cursor = "";
    const deadline = Date.now() + timeoutMs;
    do {
      assert.ok(Date.now() < deadline, "Slack pagination exceeded evaluation deadline");
      const page = await call(method, { ...fields, limit: "100", ...(cursor ? { cursor } : {}) });
      for (const message of page.messages ?? []) messages.set(message.ts, message);
      cursor = page.response_metadata?.next_cursor?.trim() ?? "";
      assert.ok(!page.has_more || cursor, "Slack pagination incomplete: has_more without cursor");
      assert.ok(!cursor || !cursors.has(cursor), "Slack pagination repeated cursor");
      cursors.add(cursor);
    } while (cursor);
    return [...messages.values()];
  } };
}

export async function waitFor(check, { timeoutMs = 300000, pollMs = 3000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(Math.max(1, Math.min(pollMs, deadline - Date.now())));
  }
  throw new Error("Evaluation observation timed out");
}

export async function runCli(cli, ...args) {
  // Evaluation tokens must never reach a CLI, replacement or agent child.
  try {
    const { stdout } = await execute(process.execPath, [cli, ...args], { env: cleanChildEnvironment(process.env), timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    return stdout;
  } catch { throw new Error(`Candidate CLI failed: ${args.slice(0, 2).join(" ")}`); }
}

export async function liveContext(cli) {
  const home = requiredEnv("PIPA_HOME");
  const channelId = requiredEnv("SLACK_TEST_CHANNEL_ID");
  const botUserId = requiredEnv("SLACK_PIPA_BOT_USER_ID");
  assert.match(channelId, /^[CG][A-Z0-9]+$/u);
  assert.match(botUserId, /^U[A-Z0-9]+$/u);
  assert.equal(requiredEnv("PIPA_TEST_SOLE_CONSUMER"), "confirmed", "Confirm the selected app has no other Socket consumer, including on other hosts");
  const config = await loadConfig();
  assert.equal(config.slackMode, "socket");
  assert.deepEqual(config.allowedSlackChannelIds, [channelId], "Use a private profile restricted to exactly the test channel");
  const identity = await readInstanceLock();
  assert.ok(identity?.generation && isRunning(identity.pid), "Start the candidate Socket profile first");
  const reader = createSlackClient({ token: requiredEnv("SLACK_USER_TOKEN") });
  const sender = process.env.SLACK_SENDER_BOT_TOKEN?.trim() ? createSlackClient({ token: process.env.SLACK_SENDER_BOT_TOKEN.trim() }) : reader;
  const readerAuth = reader.call("auth.test", {});
  const [auth, senderAuth, candidateAuth] = await Promise.all([readerAuth, sender === reader ? readerAuth : sender.call("auth.test", {}), createSlackClient({ token: config.slackBotToken }).call("auth.test", {})]);
  assert.equal(candidateAuth.user_id, botUserId, "Candidate bot identity mismatch");
  assert.equal(auth.team_id, candidateAuth.team_id, "Reader workspace mismatch");
  assert.equal(senderAuth.team_id, candidateAuth.team_id, "Sender workspace mismatch");
  assert.notEqual(senderAuth.user_id, botUserId, "Pipa cannot send its own test requests");
  if (senderAuth.bot_id) assert.ok(config.allowedSlackBotIds?.includes(senderAuth.bot_id), "Allow the sender's actual bot_id in the private profile");
  else assert.ok(!config.allowedSlackUserIds?.length || config.allowedSlackUserIds.includes(senderAuth.user_id), "Sender is not authorized");
  await reader.call("conversations.info", { channel: channelId });
  const connection = await checkOpenCodeConnection(requiredEnv("PIPA_TEST_ENGINE_URL"), config.workingDirectory);
  assert.equal(connection.version, requiredEnv("PIPA_TEST_ENGINE_PIN"), "Selected server does not match qualification pin");
  const context = { cli, home, channelId, botUserId, botName: config.botName, reader, sender, identity, connection, teamId: auth.team_id,
    pipa: (await runCli(cli, "--version")).trim(),
    async post(text, threadTs) {
      const result = await sender.call("chat.postMessage", { channel: channelId, text, ...(threadTs ? { thread_ts: threadTs } : {}) });
      assert.equal(result.channel, channelId);
      assert.equal(result.message?.user, senderAuth.user_id, "Unexpected actual sender");
      if (senderAuth.bot_id) assert.ok(config.allowedSlackBotIds.includes(result.message?.bot_id), "Posted message bot_id is not allowlisted");
      return result;
    },
    async replies(ts) { return (await reader.messages("conversations.replies", { channel: channelId, ts })).filter((m) => m.user === botUserId && m.thread_ts === ts && m.ts !== ts); },
    async sessions() { return loadSessions(); },
    async routines() { return JSON.parse(await runCli(cli, "routine", "list", "--json")).routines; },
  };
  return context;
}

export function assertRoutine(routine, { prompt, channelId, threadTs, before, after }) {
  assert.equal(routine.prompt, prompt, "Exact saved routine prompt");
  assert.equal(routine.timezone, "UTC");
  assert.equal(routine.destination.channelId, channelId);
  assert.equal(routine.destination.threadTs ?? null, threadTs ?? null);
  assert.equal(routine.schedule.type, "once");
  assert.ok(Date.parse(routine.schedule.at) >= before + 59000 && Date.parse(routine.schedule.at) <= after + 61000, "Normalized --in 1m schedule");
  assert.equal(routine.status, "active");
  assert.equal(routine.nextRunAt, routine.schedule.at);
}

export function assertRestartObservation({ old, replacement, status, oldRunning }) {
  assert.equal(status?.id, old.generation);
  assert.equal(status.state, "completed");
  assert.equal(oldRunning, false);
  assert.ok(replacement?.generation && replacement.generation !== old.generation);
  assert.notEqual(replacement.pid, old.pid);
  assert.deepEqual(status.replacement, replacement);
}

export async function observeRestart(context, rootTs) {
  const old = await readInstanceLock();
  await context.post("Restart Pipa now in this thread using its detached restart command, then stop. The external evaluator will check completion.", rootTs);
  const status = await waitFor(async () => {
    const status = await restartStatus({ home: context.home, id: old.generation });
    assert.ok(!["failed", "unconfirmed"].includes(status?.state), "Restart failed or unconfirmed");
    return status?.state === "completed" && status;
  });
  const replacement = await readInstanceLock();
  assertRestartObservation({ old, replacement, status, oldRunning: isRunning(old.pid) });
  assert.ok(isRunning(replacement.pid));
  const notices = await waitFor(async () => {
    const matches = (await context.replies(rootTs)).filter((m) => m.text === `${context.botName} restarted and is ready.`);
    assert.ok(matches.length <= 1, "Duplicate restart ready notice");
    return matches.length && matches;
  });
  assert.equal(notices.length, 1, "One correctly routed ready notice");
  await delay(3000);
  assert.ok(isRunning(replacement.pid), "Replacement survives detached worker handoff");
  return { old, replacement, requestId: status.id, readyTs: notices[0].ts };
}

export async function withAppLock(context, run) {
  assert.match(context.teamId, /^T[A-Z0-9]+$/u);
  assert.match(context.botUserId, /^U[A-Z0-9]+$/u);
  const file = path.join(os.tmpdir(), `pipa-slack-eval-${context.teamId}-${context.botUserId}.lock`);
  const handle = await open(file, "wx", 0o600);
  let release = false;
  try {
    await handle.writeFile(JSON.stringify({ observerPid: process.pid, candidate: context.identity }));
    const result = await run();
    release = result.cleanup?.status === "PASS";
    return result;
  } finally { await handle.close(); if (release) await rm(file); }
}
