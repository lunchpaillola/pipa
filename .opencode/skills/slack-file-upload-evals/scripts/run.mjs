import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const token = requiredEnv("SLACK_USER_TOKEN");
const channelId = requiredEnv("SLACK_TEST_CHANNEL_ID");
const botUserId = requiredEnv("SLACK_PIPA_BOT_USER_ID");
const readToken = await loadLocalBotToken();
const timeoutMs = Number.parseInt(process.env.SLACK_FILE_EVAL_TIMEOUT_MS ?? "300000", 10);
const pollMs = Number.parseInt(process.env.SLACK_FILE_EVAL_POLL_MS ?? "3000", 10);
const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nonce = `local-file-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
const results = [];
let threadTs = null;

try {
  console.log(`Starting local Pipa file upload eval in ${channelId}; token hidden.`);

  const initial = await uploadFile({
    filename: `pipa-initial-${nonce}.txt`,
    content: `Reply with exactly: INITIAL FILE PASS ${nonce}`,
    comment: `<@${botUserId}> read the attached file and reply with its exact pass phrase.`,
  });
  threadTs = initial.ts;
  const initialReply = await waitForReply(initial.ts, initial.ts, `INITIAL FILE PASS ${nonce}`);
  results.push(pass("initial-upload", initialReply.ts));

  const followUp = await uploadFile({
    filename: `pipa-follow-up-${nonce}.txt`,
    content: `Reply with exactly: FOLLOW UP FILE PASS ${nonce}`,
    comment: `<@${botUserId}> read this attached file and reply with its exact pass phrase.`,
    threadTs,
  });
  const followUpReply = await waitForReply(threadTs, followUp.ts, `FOLLOW UP FILE PASS ${nonce}`);
  results.push(pass("follow-up-upload", followUpReply.ts));

  await writeResult("PASS");
  printReport("PASS");
} catch (error) {
  results.push({ id: "runtime", status: "FAIL", evidence: error instanceof Error ? error.message : String(error) });
  await writeResult("FAIL");
  printReport("FAIL");
  process.exitCode = 1;
}

async function uploadFile({ filename, content, comment, threadTs: rootTs }) {
  const file = Buffer.from(content);
  const startedAt = Date.now() / 1000;
  const { file_id: fileId, upload_url: uploadUrl } = await slackFormApi("files.getUploadURLExternal", {
    filename,
    length: String(file.length),
  });
  const response = await fetch(uploadUrl, { method: "POST", body: file, headers: { "content-type": "text/plain" } });
  if (!response.ok) throw new Error(`Slack upload failed for ${filename}: ${response.status}`);

  const completed = await slackFormApi("files.completeUploadExternal", {
    files: JSON.stringify([{ id: fileId, title: filename }]),
    channel_id: channelId,
    initial_comment: comment,
    ...(rootTs ? { thread_ts: rootTs } : {}),
  });
  const ts = await waitForUploadedMessage(filename, startedAt, rootTs, completed);
  if (!ts) throw new Error(`Slack uploaded ${filename} but its message was not found.`);
  console.log(`Uploaded ${filename}: ${ts}`);
  return { ts };
}

async function waitForUploadedMessage(filename, startedAt, rootTs, completed) {
  const immediate = sharedMessageTs(completed);
  if (immediate) return immediate;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const messages = rootTs ? await fetchReplies(rootTs) : await fetchHistory(startedAt);
    const message = messages.find((item) => item.files?.some((file) => file.name === filename || file.title === filename));
    if (message?.ts) return message.ts;
    await sleep(1000);
  }
  return null;
}

function sharedMessageTs(completed) {
  for (const file of [completed.file, ...(completed.files ?? [])].filter(Boolean)) {
    for (const visibility of ["public", "private"]) {
      const ts = file.shares?.[visibility]?.[channelId]?.[0]?.ts;
      if (ts) return ts;
    }
  }
  return null;
}

async function waitForReply(rootTs, afterTs, phrase) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const replies = await fetchReplies(rootTs);
    const reply = replies.find((message) => Number.parseFloat(message.ts) > Number.parseFloat(afterTs)
      && (message.user === botUserId || message.bot_id || message.app_id)
      && String(message.text ?? "").toLowerCase().includes(phrase.toLowerCase()));
    if (reply) return reply;
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for: ${phrase}`);
}

async function fetchHistory(oldest) {
  const query = new URLSearchParams({ channel: channelId, oldest: String(oldest), limit: "50", inclusive: "true" });
  return (await slackApi(`conversations.history?${query}`, { method: "GET" }, readToken)).messages ?? [];
}

async function fetchReplies(ts) {
  const query = new URLSearchParams({ channel: channelId, ts, limit: "50" });
  return (await slackApi(`conversations.replies?${query}`, { method: "GET" }, readToken)).messages ?? [];
}

async function slackFormApi(method, fields) {
  return slackApi(method, {
    method: "POST",
    body: new URLSearchParams(fields),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

async function slackApi(method, init, authToken = token) {
  const response = await fetch(`https://slack.com/api/${method}`, {
    ...init,
    headers: { authorization: `Bearer ${authToken}`, ...(init.headers ?? {}) },
  });
  const data = await response.json();
  if (!response.ok || !data.ok) throw new Error(`Slack API ${method} failed: ${data.error ?? response.status}`);
  return data;
}

async function loadLocalBotToken() {
  const configPath = path.join(process.env.PIPA_HOME || os.homedir(), ".pipa", "config.json");
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  if (!String(config.slackBotToken ?? "").startsWith("xoxb-")) throw new Error(`A valid local Pipa bot token is required in ${configPath}`);
  return config.slackBotToken;
}

async function writeResult(status) {
  const resultsDir = path.join(skillDir, "results");
  await fs.mkdir(resultsDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(":", "-");
  const resultPath = path.join(resultsDir, `slack-file-upload-eval-${stamp}.json`);
  await fs.writeFile(resultPath, `${JSON.stringify({ status, nonce, channelId, threadTs, threadUrl: threadTs ? threadUrl() : null, results }, null, 2)}\n`);
  console.log(`Result JSON: ${resultPath}`);
}

function printReport(status) {
  console.log(`Local Pipa Slack File Upload Eval: ${status}`);
  if (threadTs) console.log(`Thread: ${threadUrl()}`);
  for (const result of results) console.log(`${result.status} ${result.id}: ${result.evidence}`);
}

function pass(id, replyTs) {
  return { id, status: "PASS", evidence: `matched Pipa reply ${replyTs}` };
}

function threadUrl() {
  return `https://app.slack.com/client/${channelId}/thread/${channelId}-${threadTs.replace(".", "")}`;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
