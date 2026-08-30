import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadConfig, pipaPaths } from "../src/state.mjs";

const runFile = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cli = path.join(root, "bin", "pipa.mjs");
const outputDirectory = path.join(root, "tmp", "slack-routine-evals");
const timeoutMs = Number.parseInt(process.env.SLACK_ROUTINE_EVAL_TIMEOUT_MS ?? "300000", 10);
const pollMs = Number.parseInt(process.env.SLACK_ROUTINE_EVAL_POLL_MS ?? "3000", 10);
const nonce = `routine-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const evidence = { status: "FAIL", nonce, startedAt: new Date().toISOString(), steps: [] };
let routineId;
let baselineIds = new Set();

try {
  const context = await preflight();
  Object.assign(evidence, { channelId: context.channelId, teamId: context.teamId });
  baselineIds = new Set((await listRoutines()).map((routine) => routine.id));

  const rootMessage = await slack("chat.postMessage", {
    channel: context.channelId,
    text: `<@${context.botUserId}> Preview a local Pipa routine with prompt exactly "Reply with exactly: ROUTINE PASS ${nonce}". Use timezone UTC, this concrete channel ${context.channelId}, no thread, and --in 1m. Do not create it yet. Show me the normalized preview including the nonce.`,
  });
  evidence.rootTs = rootMessage.ts;
  evidence.threadUrl = slackThreadUrl(context.teamId, context.channelId, rootMessage.ts);
  evidence.steps.push({ id: "request-preview", status: "PASS", ts: rootMessage.ts });

  const preview = await waitForReply(context, rootMessage.ts, rootMessage.ts, (message) => message.text?.includes(nonce) && /preview|next run|schedule/iu.test(message.text));
  evidence.steps.push({ id: "preview", status: "PASS", ts: preview.ts });

  const confirmation = await slack("chat.postMessage", {
    channel: context.channelId,
    thread_ts: rootMessage.ts,
    text: `I confirm the preview for ${nonce}. Create that exact routine now, then reply with its routine ID.`,
  });
  evidence.steps.push({ id: "confirm", status: "PASS", ts: confirmation.ts });

  const routine = await waitForRoutine();
  routineId = routine.id;
  evidence.routineId = routine.id;
  evidence.nextRunAt = routine.nextRunAt;
  evidence.steps.push({ id: "created", status: "PASS", routineId: routine.id, nextRunAt: routine.nextRunAt });

  const result = await waitForResult(context, Date.now() / 1000 - 5);
  evidence.resultTs = result.ts;
  evidence.steps.push({ id: "exact-destination-result", status: "PASS", ts: result.ts });
  await sleep(35_000);
  const duplicates = await matchingTopLevelResults(context, Date.now() / 1000 - (timeoutMs + 60_000) / 1000);
  if (duplicates.length !== 1) throw new Error(`Expected one nonce result, found ${duplicates.length}.`);
  evidence.steps.push({ id: "single-result", status: "PASS", count: 1 });
  evidence.status = "PASS";
} catch (error) {
  evidence.error = safeError(error);
  process.exitCode = 1;
} finally {
  try {
    const matches = (await listRoutines()).filter((routine) => !baselineIds.has(routine.id) && routine.prompt.includes(nonce));
    for (const routine of matches) await runCli("routine", "delete", routine.id, "--json");
    evidence.cleanup = { status: "PASS", deletedRoutineIds: matches.map((routine) => routine.id) };
    if (routineId && !matches.some((routine) => routine.id === routineId)) evidence.cleanup.note = "Routine was already absent.";
  } catch (error) {
    evidence.cleanup = { status: "FAIL", error: safeError(error) };
    evidence.status = "FAIL";
    process.exitCode = 1;
  }
  evidence.completedAt = new Date().toISOString();
  await mkdir(outputDirectory, { recursive: true });
  const file = path.join(outputDirectory, `${nonce}.json`);
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
  process.stdout.write(`${evidence.status} Local Pipa routine Slack eval\nEvidence: ${file}\n`);
  if (evidence.threadUrl) process.stdout.write(`Thread: ${evidence.threadUrl}\n`);
  if (evidence.error) process.stderr.write(`${evidence.error}\n`);
}

async function preflight() {
  const token = requiredEnv("SLACK_USER_TOKEN");
  const channelId = requiredEnv("SLACK_TEST_CHANNEL_ID");
  const botUserId = requiredEnv("SLACK_PIPA_BOT_USER_ID");
  if (!/^[CG][A-Z0-9]+$/u.test(channelId)) throw new Error("SLACK_TEST_CHANNEL_ID must be a concrete Slack channel ID.");
  const config = await loadConfig();
  if (config.slackMode !== "socket") throw new Error("The configured Pipa profile is not using Socket Mode.");
  if (config.allowedSlackChannelIds?.length && !config.allowedSlackChannelIds.includes(channelId)) throw new Error("The eval channel is not in allowedSlackChannelIds.");
  const pid = Number.parseInt(await readFile(pipaPaths().lock, "utf8").catch(() => ""), 10);
  if (!pid || !isRunning(pid)) throw new Error("A local `pipa start` Socket Mode process must be running.");
  const auth = await slackWithToken(token, "auth.test", {});
  if (config.allowedSlackUserIds?.length && !config.allowedSlackUserIds.includes(auth.user_id)) throw new Error("The Slack eval user is not in allowedSlackUserIds.");
  await slackWithToken(token, "conversations.info", { channel: channelId });
  return { token, channelId, botUserId, teamId: auth.team_id };
}

async function waitForRoutine() {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = (await listRoutines()).filter((routine) => !baselineIds.has(routine.id) && routine.prompt.includes(nonce));
    if (matches.length > 1) throw new Error(`Found ${matches.length} new nonce routines; expected one.`);
    if (matches.length === 1) return matches[0];
    await sleep(Math.min(pollMs, deadline - Date.now()));
  }
  throw new Error("Timed out waiting for the confirmed routine to appear.");
}

async function waitForResult(context, oldest) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const matches = await matchingTopLevelResults(context, oldest);
    if (matches.length > 1) throw new Error(`Found ${matches.length} nonce results; expected one.`);
    if (matches.length === 1) return matches[0];
    await sleep(Math.min(pollMs, deadline - Date.now()));
  }
  throw new Error("Timed out waiting for the scheduled Slack result.");
}

async function matchingTopLevelResults(context, oldest) {
  const history = await slack("conversations.history", { channel: context.channelId, oldest: String(oldest), limit: "100", inclusive: "true" });
  return (history.messages ?? []).filter((message) => !message.thread_ts && isBot(message, context.botUserId) && message.text?.trim() === `ROUTINE PASS ${nonce}`);
}

async function waitForReply(context, rootTs, afterTs, predicate) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const replies = await slack("conversations.replies", { channel: context.channelId, ts: rootTs, limit: "100" });
    const match = (replies.messages ?? []).find((message) => Number(message.ts) > Number(afterTs) && isBot(message, context.botUserId) && predicate(message));
    if (match) return match;
    await sleep(Math.min(pollMs, deadline - Date.now()));
  }
  throw new Error("Timed out waiting for Pipa's routine preview.");
}

async function listRoutines() {
  const output = JSON.parse(await runCli("routine", "list", "--json"));
  return output.routines;
}

async function runCli(...args) {
  const { stdout } = await runFile(process.execPath, [cli, ...args], { cwd: root, env: process.env });
  return stdout;
}

async function slack(method, fields) {
  return slackWithToken(requiredEnv("SLACK_USER_TOKEN"), method, fields);
}

async function slackWithToken(token, method, fields) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(fields),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(`Slack API ${method} failed: ${result.error ?? response.statusText}`);
  return result;
}

function isBot(message, botUserId) {
  return message.user === botUserId || Boolean(message.bot_id || message.app_id);
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function slackThreadUrl(teamId, channelId, ts) {
  return `https://app.slack.com/client/${teamId}/${channelId}/thread/${channelId}-${ts.replace(".", "")}`;
}

function safeError(error) {
  return (error instanceof Error ? error.message : String(error)).replace(/xox[baprs]-[^\s]+|xapp-[^\s]+/gu, "[redacted]").slice(0, 500);
}

function sleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, Math.max(1, milliseconds)));
}
