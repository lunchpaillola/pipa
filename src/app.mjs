import { randomUUID } from "node:crypto";
import { Chat, Modal, TextInput } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { canonicalWorkingDirectory, createManifest, createSessionStore, loadConfig, pipaPaths, saveConfig } from "./state.mjs";
import { createOpenCodeExecutor, MAX_ATTACHMENT_BYTES, PipaStoppedError, runOpenCodeVersion, startSocketOpenCodeServer } from "./opencode.mjs";

const TYPING_REFRESH_MS = 75_000;
const TYPING_REFRESH_MESSAGES = [
  "Digging into the work...",
  "Making progress...",
  "Checking the details...",
  "Pulling this together...",
];

export async function initializePipa(input, options = {}) {
  const paths = options.paths ?? pipaPaths();
  const manifest = createManifest(input.botName);
  const config = {
    botName: input.botName.trim(),
    slackAppToken: requireToken(input.slackAppToken, "Slack app token", "xapp-"),
    slackBotToken: requireToken(input.slackBotToken, "Slack bot token", "xoxb-"),
    workingDirectory: await canonicalWorkingDirectory(input.workingDirectory),
    allowedSlackChannelIds: normalizeIdList(input.allowedSlackChannelIds),
    allowedSlackUserIds: normalizeIdList(input.allowedSlackUserIds),
  };
  const openCodeVersion = await (options.checkOpenCode ?? runOpenCodeVersion)();
  if (!/^v?1(?:\.|$)/u.test(openCodeVersion)) throw new Error(`Pipa requires OpenCode v1; found ${openCodeVersion || "an unknown version"}.`);
  await (options.checkSlackAppToken ?? checkSlackAppToken)(config.slackAppToken);
  const slackAuth = await (options.checkSlackToken ?? checkSlackToken)(config.slackBotToken);
  warnMissingSlackScopes(slackAuth, options.warn);

  await saveConfig(config, paths, manifest);
  return { config, manifest, paths };
}

export async function startPipa(options = {}) {
  const paths = options.paths ?? pipaPaths();
  const config = options.config ?? await loadConfig(paths.config);
  const slackAuth = await (options.checkSlackToken ?? checkSlackToken)(config.slackBotToken);
  warnMissingSlackScopes(slackAuth, options.warn);
  const sessionStore = options.sessionStore ?? await createSessionStore(paths.sessions);
  const state = options.state ?? createMemoryState();
  const chat = options.chat ?? new Chat({
    adapters: {
      slack: createSlackAdapter({
        appToken: config.slackAppToken,
        botToken: config.slackBotToken,
        mode: "socket",
        userName: config.botName,
        webClientOptions: { timeout: 30_000, retryConfig: { retries: 0 } },
      }),
    },
    concurrency: "concurrent",
    state,
    userName: config.botName,
  });
  const server = options.server ?? (options.executor ? null : await (options.startServer ?? startSocketOpenCodeServer)(config, {
    startupTimeoutMs: options.startupTimeoutMs,
  }));
  let executor;
  try {
    executor = options.executor ?? (options.createExecutor ?? createOpenCodeExecutor)({
      baseUrl: server.baseUrl,
      onFatal: server.fail,
    });
  } catch (error) {
    server?.stop();
    await withTimeout(server?.wait(), options.shutdownTimeoutMs ?? 15_000, "OpenCode shutdown timed out.").catch(() => undefined);
    throw error;
  }
  const runner = createConversationRunner({ sessionStore, runTurn: executor.runTurn });
  let accepting = true;
  const interactions = createPendingInteractions();
  chat.onAction?.(interactions.onAction);
  chat.onModalSubmit?.("pipa_custom", interactions.onCustomAnswer);

  const handle = async (thread, message, subscribe) => {
    if (!accepting || !isAuthorized(thread, message, config) || shouldIgnore(thread, message)) return;
    const prompt = subscribe || message.isMention ? stripMention(message.text) : message.text.trim();
    if (!prompt) return;
    const attachments = message.attachments ?? [];
    if (subscribe) await thread.subscribe();
    if (attachments.some(({ size }) => size !== undefined && (!Number.isSafeInteger(size) || size < 0 || size > MAX_ATTACHMENT_BYTES))) {
      await thread.post("Pipa can read files up to 100 MB each.");
      return;
    }
    if (!accepting) return;

    await react(thread, message, "eyes");
    try {
      const interactionContext = { thread };
      const result = await runner.enqueue(thread.id, {
        prompt,
        attachments,
        workingDirectory: config.workingDirectory,
        contextEnvironment: slackContext(thread, message),
        onSession: () => undefined,
        onInteraction: (interaction) => interactions.onInteraction(interactionContext, interaction),
        onPermissionReplied: interactions.onPermissionReplied,
        onPermissionsReconciled: interactions.onPermissionsReconciled,
        startTyping: (status) => thread.startTyping(status),
        deliver: (result) => postResult(thread, result),
        deliverFailure: (error) => thread.post(error instanceof PipaStoppedError
          ? `${config.botName} stopped before finishing this request.`
          : `${config.botName} failed: ${safeError(error)}`),
      });
      await finishReaction(thread, message, result.error instanceof PipaStoppedError ? null : result.error ? "warning" : "white_check_mark");
    } catch (error) {
      await finishReaction(thread, message, "warning");
      process.stderr.write("Pipa could not complete or deliver a Slack turn.\n");
    }
  };

  chat.onNewMention((thread, message) => { void handle(thread, message, true); });
  chat.onSubscribedMessage((thread, message) => { void handle(thread, message, false); });
  try {
    await state.connect();
    for (const conversationKey of sessionStore.keys()) {
      await chat.thread(conversationKey).subscribe();
    }
    await withTimeout(chat.initialize(), options.startupTimeoutMs ?? 30_000, "Slack Socket Mode startup timed out.");
  } catch (error) {
    await interactions.close();
    executor.stopAll();
    await withTimeout(chat.shutdown(), options.shutdownTimeoutMs ?? 15_000, "Slack shutdown timed out.").catch(() => undefined);
    server?.stop();
    await withTimeout(server?.wait(), options.shutdownTimeoutMs ?? 15_000, "OpenCode shutdown timed out.").catch(() => undefined);
    throw error;
  }

  const stop = (reason = new PipaStoppedError()) => {
    if (!accepting) return;
    accepting = false;
    runner.close(reason);
    executor.stopAll(reason);
  };

  return {
    server: server ? { baseUrl: server.baseUrl, owned: server.owned } : null,
    async wait() {
      try {
        return await (server?.wait() ?? new Promise(() => undefined));
      } catch (error) {
        stop(error);
        throw error;
      }
    },
    stop: () => stop(),
    async shutdown() {
      stop();
      await interactions.close();
      try {
        await withTimeout((async () => {
          await runner.drain();
          await chat.shutdown();
          server?.stop();
          await server?.wait();
        })(), options.shutdownTimeoutMs ?? 15_000, "Pipa shutdown timed out.");
      } finally {
        server?.stop();
      }
    },
  };
}

function createPendingInteractions() {
  const pending = new Map();
  const permissionRequests = new Map();
  const tails = new Map();

  async function onInteraction(context, interaction) {
    const token = randomUUID().replaceAll("-", "");
    const entry = {
      token,
      type: interaction.type,
      request: interaction.request,
      sessionId: interaction.sessionId,
      requestId: interaction.request.requestID ?? interaction.request.requestId ?? interaction.request.id,
      questionIndex: 0,
      answers: [],
      resolve: null,
    };
    const decision = new Promise((resolve, reject) => {
      const abort = () => reject(interaction.signal.reason);
      entry.resolve = (value) => {
        if (entry.decision !== undefined) return;
        entry.decision = value;
        interaction.signal.removeEventListener("abort", abort);
        resolve(value);
      };
      if (interaction.signal.aborted) abort();
      else interaction.signal.addEventListener("abort", abort, { once: true });
    });
    pending.set(token, entry);
    const requestId = interaction.request.requestID ?? interaction.request.requestId ?? interaction.request.id;
    const permissionKey = interaction.type === "permission" && requestId ? `${interaction.sessionId}:${requestId}` : null;
    if (permissionKey) permissionRequests.set(permissionKey, entry);
    const conversationKey = context.thread.id;
    const previous = tails.get(conversationKey) ?? Promise.resolve();
    let release;
    const tail = new Promise((resolve) => { release = resolve; });
    tails.set(conversationKey, tail);
    try {
      await previous;
      if (entry.decision === undefined) {
        entry.message = await postInteraction(context.thread, entry);
        if (interaction.signal.aborted) throw interaction.signal.reason;
      }
      const result = await decision;
      await submit(entry, result);
      return result;
    } finally {
      pending.delete(token);
      if (permissionKey) permissionRequests.delete(permissionKey);
      release();
      if (tails.get(conversationKey) === tail) tails.delete(conversationKey);
    }
  }

  function onPermissionReplied({ sessionId, requestId, reply }) {
    const entry = permissionRequests.get(`${sessionId}:${requestId}`);
    entry?.resolve?.(reply === "reject" ? { type: "reject" } : { type: "reply", reply });
  }

  function onPermissionsReconciled({ sessionId, requestIds }) {
    for (const entry of permissionRequests.values()) {
      if (entry.sessionId === sessionId && !requestIds.has(entry.requestId)) entry.resolve?.({ type: "cancelled" });
    }
  }

  async function close() {
    const entries = [...pending.values()];
    for (const entry of entries) entry.resolve?.({ type: "stopped" });
    await Promise.all(entries.map((entry) => submit(entry, { type: "stopped" })));
  }

  async function onAction(event) {
    const token = interactionToken(event);
    const entry = pending.get(token);
    if (!entry) return;
    if (event.actionId?.startsWith("pipa_dismiss_")) {
      entry.resolve?.({ type: "stop" });
      return;
    }
    if (entry.type === "permission") {
      const reply = String(event.value ?? "").split(".")[1];
      if (!["once", "always", "reject"].includes(reply)) return;
      const selectedBy = displayName(event.user?.fullName ?? event.user?.userName);
      entry.resolve?.(reply === "reject" ? { type: "reject", ...(selectedBy ? { selectedBy } : {}) } : { type: "reply", reply, ...(selectedBy ? { selectedBy } : {}) });
      return;
    }
    if (event.actionId?.startsWith("pipa_custom_")) {
      await event.openModal?.(Modal({ callbackId: "pipa_custom", privateMetadata: token, title: "Custom answer", submitLabel: "Submit", children: [TextInput({ id: "answer", label: "Answer" })] }));
      return;
    }
    if (entry.type !== "question") return;
    if (event.actionId?.startsWith("pipa_select_")) {
      const answers = selectedAnswers(event);
      if (!answers.length) return;
      entry.answers[entry.questionIndex] = answers;
      return;
    }
    if (event.actionId?.startsWith("pipa_submit_")) {
      if (!entry.answers[entry.questionIndex]?.length) return;
      advance(entry, event.user);
      return;
    }
  }

  async function onCustomAnswer(event) {
    const entry = pending.get(event.privateMetadata);
    if (!entry) return;
    const answer = event.values?.answer?.trim();
    if (!answer) return { action: "errors", errors: { answer: "Enter an answer." } };
    entry.answers[entry.questionIndex] = [answer];
    advance(entry, event.user);
  }

  function advance(entry, user) {
    if (++entry.questionIndex === (entry.request.questions?.length ?? 1)) {
      const selectedBy = displayName(user?.fullName ?? user?.userName);
      entry.resolve?.({ type: "answer", answers: entry.answers, ...(selectedBy ? { selectedBy } : {}) });
    }
    else entry.message?.edit();
  }

  return { onInteraction, onPermissionReplied, onPermissionsReconciled, onAction, onCustomAnswer, close };
}

async function submit(entry, decision) {
  if (entry.submitted) return;
  entry.submitted = true;
  if (decision?.type === "cancelled" || decision?.type === "stopped") {
    await entry.message?.delete?.();
    return;
  }
  await entry.message?.edit(decision);
}

function renderSubmitted(entry, decision) {
  let content = "Answered.";
  let title = entry.type === "permission" ? "Permission requested" : (entry.request.questions?.[0]?.header || "Question");
  if (decision?.type === "stop") content = "Dismissed.";
  else if (entry.type === "permission") ({ title, content } = permissionOutcome(entry.request, decision));
  else {
    const answers = decision?.answers?.flat().filter(Boolean) ?? [];
    content = `${decision?.selectedBy ? `${decision.selectedBy} selected` : "Selected"}: ${answers.map((answer) => `“${answer}”`).join(", ")}.`;
  }
  return { title, content };
}

async function postInteraction(thread, entry) {
  const [, channel, threadTs] = thread.id.split(":");
  const client = thread.adapter?.webClient;
  if (!client || !channel || !threadTs) throw new Error("Slack interaction context is unavailable.");
  const message = await client.chat.postMessage({
    channel,
    thread_ts: threadTs,
    text: interactionFallback(entry),
    blocks: renderSlackInteraction(entry),
  });
  return {
    edit: (decision) => client.chat.update({
      channel,
      ts: message.ts,
      text: decision ? submittedText(entry, decision) : interactionFallback(entry),
      blocks: decision ? renderSlackSubmitted(entry, decision) : renderSlackInteraction(entry),
    }),
    delete: () => client.chat.delete({ channel, ts: message.ts }),
  };
}

function renderSlackInteraction(entry) {
  if (entry.type === "permission") {
    const resources = entry.request.patterns ?? entry.request.resources ?? [];
    return [
      slackHeader("Permission requested"),
      slackText(permissionDetail(entry.request, resources)),
      slackActions([
        slackButton(`pipa_permission_once_${entry.token}`, "Allow once", `${entry.token}.once`, "primary"),
        slackButton(`pipa_permission_always_${entry.token}`, "Always allow", `${entry.token}.always`),
        slackButton(`pipa_permission_reject_${entry.token}`, "Reject", `${entry.token}.reject`, "danger"),
      ]),
    ];
  }
  const question = entry.request.questions?.[entry.questionIndex] ?? entry.request;
  const options = (question.options ?? []).map((option) => ({
    text: { type: "plain_text", text: option.label ?? option },
    value: `${entry.token}.${option.label ?? option}`,
  }));
  const selector = options.length && (question.multiple
    ? { type: "checkboxes", action_id: `pipa_select_${entry.token}`, options }
    : { type: "radio_buttons", action_id: `pipa_select_${entry.token}`, options });
  const actions = [
    ...(question.custom || !options.length ? [slackButton(`pipa_custom_${entry.token}`, "Custom answer", entry.token)] : []),
    ...(options.length ? [slackButton(`pipa_submit_${entry.token}`, "Submit", entry.token, "primary")] : []),
    slackButton(`pipa_dismiss_${entry.token}`, "Dismiss", entry.token, "danger"),
  ];
  return [slackHeader(question.header || "Question"), slackText(question.question ?? question.header ?? "Choose an answer."), ...(selector ? [slackActions([selector])] : []), slackActions(actions)];
}

function renderSlackSubmitted(entry, decision) {
  const submitted = renderSubmitted(entry, decision);
  return [slackHeader(submitted.title), slackText(submitted.content)];
}

function submittedText(entry, decision) {
  return renderSubmitted(entry, decision).content;
}

function permissionDetail(request, resources) {
  const input = request.tool?.input;
  const tool = request.tool?.name ? [`Tool: ${request.tool.name}`] : [];
  if (request.tool?.name === "read" && input?.filePath) tool.push(`File: ${input.filePath}`);
  if (request.tool?.name === "glob" && input?.pattern) tool.push(`Pattern: ${input.pattern}`);
  return [`Action: ${request.permission ?? request.action ?? "Unknown"}`, ...tool, ...(resources.length ? ["Resources:", ...resources.map((resource) => `- ${resource}`)] : [])].join("\n");
}

function permissionOutcome(request, decision) {
  const action = permissionAction(request);
  const detail = permissionDetail(request, request.patterns ?? request.resources ?? []);
  const actor = decision?.selectedBy ? ` by ${decision.selectedBy}` : "";
  if (decision?.type === "reject") return {
    title: "Permission rejected",
    content: `Rejected${actor}. Blocked ${action}. OpenCode may cancel related requests from the same batch.\n\n${detail}`,
  };
  if (decision?.reply === "always") return {
    title: "Permission allowed",
    content: `Allowed${actor} in this workspace. Pipa will not ask again for matching access.\n\n${detail}`,
  };
  return {
    title: "Permission allowed once",
    content: `Allowed${actor} for this request. Pipa will ask again for later protected access.\n\n${detail}`,
  };
}

function permissionAction(request) {
  const input = request.tool?.input;
  if (request.tool?.name === "read" && input?.filePath) return `\`read ${input.filePath}\``;
  if (request.tool?.name === "glob" && input?.pattern) return `\`glob ${input.pattern}\``;
  return `the ${request.permission ?? request.action ?? "requested"} action`;
}

function interactionFallback(entry) {
  const question = entry.request.questions?.[entry.questionIndex] ?? entry.request;
  return question.question ?? question.header ?? "Action required";
}

function slackHeader(text) {
  return { type: "header", text: { type: "plain_text", text } };
}

function slackText(text) {
  return { type: "section", text: { type: "mrkdwn", text } };
}

function slackActions(elements) {
  return { type: "actions", elements };
}

function slackButton(actionId, text, value, style) {
  return { type: "button", action_id: actionId, text: { type: "plain_text", text }, value, ...(style ? { style } : {}) };
}

function selectedAnswers(event) {
  const action = event.raw?.actions?.find((item) => item.action_id === event.actionId);
  const values = action?.selected_options?.map((option) => option.value) ?? [event.value];
  return values.filter(Boolean).map((value) => String(value).split(".").slice(1).join(".")).filter(Boolean);
}

function interactionToken(event) {
  const value = String(event.value ?? "").split(".")[0];
  return value || event.actionId?.split("_").at(-1) || "";
}

function displayName(value) {
  const name = String(value ?? "").trim();
  return name ? name[0].toUpperCase() + name.slice(1) : "";
}

export function createConversationRunner({ sessionStore, runTurn }) {
  const tails = new Map();
  const activeTyping = new Set();
  let closed = false;
  let closeReason;

  function enqueue(conversationKey, input) {
    if (closed && input.deliverFailure) return Promise.resolve(input.deliverFailure(closeReason)).then(() => ({ error: closeReason }));
    if (closed) return Promise.reject(closeReason);
    const previous = tails.get(conversationKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      const { deliver, deliverFailure, startTyping, ...turn } = input;
      let stopTyping;
      try {
        let result;
        try {
          if (closed) throw closeReason;
          stopTyping = createTypingLifecycle(startTyping);
          if (stopTyping) activeTyping.add(stopTyping);
          result = await runTurn({ ...turn, sessionId: sessionStore.get(conversationKey) });
          if (result.sessionId) await sessionStore.set(conversationKey, result.sessionId);
        } catch (error) {
          if (deliverFailure) {
            await deliverFailure(error);
            return { error };
          }
          throw error;
        }
        if (deliver) await deliver(result);
        return result;
      } finally {
        stopTyping?.();
        activeTyping.delete(stopTyping);
      }
    });
    const tail = current.then(() => undefined, () => undefined);
    tails.set(conversationKey, tail);
    tail.finally(() => {
      if (tails.get(conversationKey) === tail) tails.delete(conversationKey);
    });
    return current;
  }

  return {
    enqueue,
    close(reason = new PipaStoppedError()) {
      closed = true;
      closeReason ??= reason;
      for (const stopTyping of activeTyping) stopTyping();
      activeTyping.clear();
    },
    drain: () => Promise.all([...tails.values()]),
  };
}

function createTypingLifecycle(startTyping) {
  if (!startTyping) return;
  let stopped = false;
  let refreshing = false;
  let messageIndex = 0;
  const refresh = (status) => {
    if (stopped || refreshing) return;
    refreshing = true;
    try {
      Promise.resolve(startTyping(status)).catch(() => undefined).finally(() => refreshing = false);
    } catch {
      refreshing = false;
    }
  };
  refresh("Getting oriented...");
  const timer = setInterval(() => {
    if (!stopped && !refreshing) refresh(TYPING_REFRESH_MESSAGES[messageIndex++ % TYPING_REFRESH_MESSAGES.length]);
  }, TYPING_REFRESH_MS);
  timer.unref?.();
  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

export async function checkSlackToken(token, fetchImpl = fetch) {
  const botToken = requireToken(token, "Slack bot token", "xoxb-");
  const response = await fetchImpl("https://slack.com/api/auth.test", {
    method: "POST",
    headers: { authorization: `Bearer ${botToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error("Slack rejected the bot token.");
  const headerScopes = response.headers?.get?.("x-oauth-scopes");
  const grantedScopes = normalizeGrantedScopes(typeof headerScopes === "string" ? headerScopes.split(",") : undefined)
    ?? normalizeGrantedScopes(result.response_metadata?.scopes);
  return grantedScopes === undefined ? result : { ...result, grantedScopes };
}

export async function checkSlackAppToken(token, fetchImpl = fetch) {
  const appToken = requireToken(token, "Slack app token", "xapp-");
  const response = await fetchImpl("https://slack.com/api/apps.connections.open", {
    method: "POST",
    headers: {
      authorization: `Bearer ${appToken}`,
      "content-type": "application/json",
    },
    body: "{}",
    signal: AbortSignal.timeout(15_000),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error("Slack rejected the app token. Generate an app-level token with the connections:write scope.");
  return result;
}

function shouldIgnore(thread, message) {
  return message.author?.isMe
    || message.author?.isBot
    || thread.channel?.isDM
    || thread.channel?.channelVisibility === "external"
    || Boolean(message.raw?.subtype && message.raw.subtype !== "file_share")
    || !message.text?.trim();
}

function isAuthorized(thread, message, config) {
  const channelId = thread.id.split(":")[1];
  const userId = message.author?.userId ?? message.author?.id;
  if (config.allowedSlackChannelIds?.length && !config.allowedSlackChannelIds.includes(channelId)) return false;
  if (config.allowedSlackUserIds?.length && !config.allowedSlackUserIds.includes(userId)) return false;
  return true;
}

function normalizeIdList(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[\s,]+/u);
  return list.map((item) => String(item).trim()).filter(Boolean);
}

function stripMention(text = "") {
  return text.replace(/(?:<@|@)[UW][A-Z0-9]+>?/u, "").trim();
}

function requireToken(value, label, prefix) {
  const token = String(value ?? "").trim();
  if (!token.startsWith(prefix)) throw new Error(`${label} must start with ${prefix}`);
  return token;
}

function normalizeGrantedScopes(value) {
  if (Array.isArray(value) && value.every((scope) => typeof scope === "string" && scope.trim())) {
    return [...new Set(value.map((scope) => scope.trim()))];
  }
}

function warnMissingSlackScopes(auth, warn = (message) => process.stderr.write(`${message}\n`)) {
  if (!Array.isArray(auth?.grantedScopes)) return;
  const missing = ["channels:read", "assistant:write"].filter((scope) => !auth.grantedScopes.includes(scope));
  if (!missing.length) return;
  const scopes = missing.join(", ");
  try {
    warn(`Pipa warning: Slack bot token is missing recommended ${missing.length === 1 ? "scope" : "scopes"} ${scopes}. Add ${missing.length === 1 ? "it" : "them"} and reinstall or reauthorize the Slack app.`);
  } catch {}
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/xox[baprs]-[^\s]+|xapp-[^\s]+/gu, "[redacted]");
}

function slackContext(thread, message) {
  const [, channelId = "", threadTs = ""] = thread.id.split(":");
  return {
    PIPA_MESSAGE_CHANNEL: "slack",
    PIPA_CURRENT_SLACK_CHANNEL_ID: channelId,
    PIPA_CURRENT_SLACK_THREAD_TS: threadTs,
    PIPA_REQUESTER_SLACK_USER_ID: message.author?.userId ?? message.author?.id ?? "",
  };
}

async function postResult(thread, { text, files = [] }) {
  if (files.length) {
    try {
      await thread.post({ markdown: text, files });
      return;
    } catch {
      // A failed adapter call may still have uploaded files, so retry text only.
    }
  }
  if (!text) return;
  for (const markdown of splitSlackMarkdown(text)) await thread.post({ markdown });
}

function splitSlackMarkdown(text, limit = 3500) {
  if (text.length <= limit) return [text];
  const chunks = [];
  let chunk = "";
  let fence = "";
  const append = (line) => {
    const separator = chunk ? "\n" : "";
    const closing = fence ? `\n${fence}` : "";
    if (chunk && chunk.length + separator.length + line.length + closing.length > limit) {
      chunks.push(chunk + closing);
      chunk = fence ? `${fence}\n${line}` : line;
    } else {
      chunk += separator + line;
    }
    const marker = line.match(/^(```+|~~~+)/u)?.[1];
    if (marker) fence = fence ? "" : marker;
  };
  for (const inputLine of text.split("\n")) {
    let line = inputLine;
    if (line.length <= limit) {
      append(line);
      continue;
    }
    if (chunk) {
      chunks.push(chunk + (fence ? `\n${fence}` : ""));
      chunk = fence ? `${fence}\n` : "";
    }
    const room = Math.max(1, limit - chunk.length - (fence ? fence.length + 1 : 0));
    while (line.length > room) {
      const boundary = line.slice(0, room + 1).search(/\s+\S*$/u);
      const splitAt = boundary > 0 ? boundary : room;
      chunks.push(chunk + line.slice(0, splitAt) + (fence ? `\n${fence}` : ""));
      line = line.slice(splitAt).replace(/^\s+/u, "");
      chunk = fence ? `${fence}\n` : "";
    }
    chunk += line;
  }
  if (chunk) chunks.push(chunk + (fence ? `\n${fence}` : ""));
  return chunks;
}

async function react(thread, message, emoji) {
  if (!message.id) return;
  await thread.adapter.addReaction(thread.id, message.id, emoji).catch(() => undefined);
}

async function finishReaction(thread, message, emoji) {
  if (!message.id) return;
  await thread.adapter.removeReaction(thread.id, message.id, "eyes").catch(() => undefined);
  if (emoji) await react(thread, message, emoji);
}

async function withTimeout(promise, timeoutMs, message) {
  if (!promise) return;
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => timer = setTimeout(() => reject(new Error(message)), timeoutMs)),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
