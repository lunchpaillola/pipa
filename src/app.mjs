import { randomUUID } from "node:crypto";
import { Actions, Button, Card, CardText as Text, Chat, Modal, TextInput } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { canonicalWorkingDirectory, createManifest, createSessionStore, loadConfig, pipaPaths, saveConfig } from "./state.mjs";
import { createOpenCodeExecutor, MAX_ATTACHMENT_BYTES, runOpenCodeVersion, startSocketOpenCodeServer } from "./opencode.mjs";

export async function initializePipa(input, options = {}) {
  const paths = options.paths ?? pipaPaths();
  const manifest = createManifest(input.botName);
  const config = {
    botName: input.botName.trim(),
    slackAppToken: requireToken(input.slackAppToken, "Slack app token", "xapp-"),
    slackBotToken: requireToken(input.slackBotToken, "Slack bot token", "xoxb-"),
    workingDirectory: await canonicalWorkingDirectory(input.workingDirectory),
  };
  const openCodeVersion = await (options.checkOpenCode ?? runOpenCodeVersion)();
  if (!/^v?1(?:\.|$)/u.test(openCodeVersion)) throw new Error(`Pipa requires OpenCode v1; found ${openCodeVersion || "an unknown version"}.`);
  await (options.checkSlackAppToken ?? checkSlackAppToken)(config.slackAppToken);
  await (options.checkSlackToken ?? checkSlackToken)(config.slackBotToken);

  await saveConfig(config, paths, manifest);
  return { config, manifest, paths };
}

export async function startPipa(options = {}) {
  const paths = options.paths ?? pipaPaths();
  const config = options.config ?? await loadConfig(paths.config);
  await (options.checkSlackToken ?? checkSlackToken)(config.slackBotToken);
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
    if (!accepting || shouldIgnore(thread, message)) return;
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
        deliver: (text) => postInChunks(thread, text),
        deliverFailure: (error) => thread.post(`Pipa failed: ${safeError(error)}`),
      });
      await finishReaction(thread, message, result.error ? "warning" : "white_check_mark");
    } catch (error) {
      await finishReaction(thread, message, "warning");
      process.stderr.write("Pipa could not complete or deliver a Slack turn.\n");
    }
  };

  chat.onNewMention((thread, message) => handle(thread, message, true));
  chat.onSubscribedMessage((thread, message) => handle(thread, message, false));
  try {
    await state.connect();
    for (const conversationKey of sessionStore.keys()) {
      await chat.thread(conversationKey).subscribe();
    }
    await withTimeout(chat.initialize(), options.startupTimeoutMs ?? 30_000, "Slack Socket Mode startup timed out.");
  } catch (error) {
    executor.stopAll();
    await withTimeout(chat.shutdown(), options.shutdownTimeoutMs ?? 15_000, "Slack shutdown timed out.").catch(() => undefined);
    server?.stop();
    await withTimeout(server?.wait(), options.shutdownTimeoutMs ?? 15_000, "OpenCode shutdown timed out.").catch(() => undefined);
    throw error;
  }

  return {
    server: server ? { baseUrl: server.baseUrl, owned: server.owned } : null,
    wait: () => server?.wait() ?? new Promise(() => undefined),
    async shutdown() {
      accepting = false;
      runner.close();
      executor.stopAll();
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

  async function onInteraction(context, interaction) {
    const token = randomUUID().replaceAll("-", "");
    const entry = {
      token,
      type: interaction.type,
      request: interaction.request,
      questionIndex: 0,
      answers: [],
      resolve: null,
    };
    pending.set(token, entry);
    try {
      const message = entry.message = await context.thread.post(renderInteraction(entry));
      const decision = await new Promise((resolve, reject) => {
        entry.resolve = resolve;
        const abort = () => reject(interaction.signal.reason);
        if (interaction.signal.aborted) abort();
        else interaction.signal.addEventListener("abort", abort, { once: true });
      });
      await message.edit(renderSubmitted(entry, decision));
      return decision;
    } finally {
      pending.delete(token);
    }
  }

  async function onAction(event) {
    const token = String(event.value ?? "").split(".")[0];
    const entry = pending.get(token);
    if (!entry) {
      await event.thread?.postEphemeral(event.user, "This request is no longer active.", { fallbackToDM: false }).catch(() => undefined);
      return;
    }
    if (event.actionId?.startsWith("pipa_dismiss_")) {
      entry.resolve?.({ type: "stop" });
      return;
    }
    if (entry.type === "permission") {
      const reply = String(event.value ?? "").split(".")[1];
      if (!["once", "always", "reject"].includes(reply)) return;
      entry.resolve?.(reply === "reject" ? { type: "reject" } : { type: "reply", reply });
      return;
    }
    if (event.actionId?.startsWith("pipa_custom_")) {
      await event.openModal?.(Modal({ callbackId: "pipa_custom", privateMetadata: token, title: "Custom answer", submitLabel: "Submit", children: [TextInput({ id: "answer", label: "Answer" })] }));
      return;
    }
    if (entry.type !== "question") return;
    const question = entry.request.questions?.[entry.questionIndex] ?? entry.request;
    if (event.actionId?.startsWith("pipa_continue_")) {
      if (!entry.answers[entry.questionIndex]?.length) return;
      advance(entry);
      return;
    }
    if (!event.actionId?.startsWith("pipa_option_")) return;
    const answer = String(event.value ?? "").split(".").slice(1).join(".");
    if (!answer) return;
    const answers = entry.answers[entry.questionIndex] ?? [];
    entry.answers[entry.questionIndex] = question.multiple
      ? answers.includes(answer) ? answers.filter((value) => value !== answer) : [...answers, answer]
      : [answer];
    if (question.multiple) await entry.message?.edit(renderInteraction(entry));
    else advance(entry);
  }

  async function onCustomAnswer(event) {
    const entry = pending.get(event.privateMetadata);
    if (!entry) return;
    const answer = event.values?.answer?.trim();
    if (!answer) return { action: "errors", errors: { answer: "Enter an answer." } };
    entry.answers[entry.questionIndex] = [answer];
    advance(entry);
  }

  function advance(entry) {
    if (++entry.questionIndex === (entry.request.questions?.length ?? 1)) entry.resolve?.({ type: "answer", answers: entry.answers });
    else entry.message?.edit(renderInteraction(entry));
  }

  return { onInteraction, onAction, onCustomAnswer };
}

function renderInteraction(entry) {
  if (entry.type === "permission") {
    const resources = entry.request.patterns ?? entry.request.resources ?? [];
    const detail = [`Action: ${entry.request.permission ?? entry.request.action ?? "Unknown"}`, ...(resources.length ? ["Resources:", ...resources.map((r) => `- ${r}`)] : [])].join("\n");
    return Card({ title: "Permission requested", children: [Text(detail), Actions([
      Button({ id: `pipa_permission_once_${entry.token}`, label: "Allow once", value: `${entry.token}.once`, style: "primary" }),
      Button({ id: `pipa_permission_always_${entry.token}`, label: "Always allow in this workspace", value: `${entry.token}.always` }),
      Button({ id: `pipa_permission_reject_${entry.token}`, label: "Reject", value: `${entry.token}.reject`, style: "danger" }),
      Button({ id: `pipa_dismiss_${entry.token}`, label: "Dismiss", value: entry.token, style: "danger" }),
    ])] });
  }
  const question = entry.request.questions?.[entry.questionIndex] ?? entry.request;
  const buttons = (question.options ?? []).map((option, index) => Button({
    id: `pipa_option_${entry.token}_${index}`,
    label: option.label ?? option,
    value: `${entry.token}.${option.label ?? option}`,
  }));
  if (question.custom) buttons.push(Button({ id: `pipa_custom_${entry.token}`, label: "Custom answer", value: entry.token }));
  if (question.multiple) buttons.push(Button({ id: `pipa_continue_${entry.token}`, label: "Continue", value: entry.token, style: "primary" }));
  buttons.push(Button({ id: `pipa_dismiss_${entry.token}`, label: "Dismiss", value: entry.token, style: "danger" }));
  return Card({
    title: question.header || "Question",
    children: [Text(question.question ?? question.header ?? "Choose an answer."), Actions(buttons)],
  });
}

function renderSubmitted(entry, decision) {
  let content = "Submitted.";
  if (decision?.type === "stop") content = "Dismissed.";
  else if (entry.type === "permission") content = `Submitted: ${decision?.reply ?? (decision?.type === "reject" ? "reject" : "permission decision")}.`;
  return Card({ title: entry.type === "permission" ? "Permission requested" : (entry.request.questions?.[0]?.header || "Question"), children: [Text(content)] });
}

export function createConversationRunner({ sessionStore, runTurn }) {
  const tails = new Map();
  let closed = false;

  function enqueue(conversationKey, input) {
    if (closed) return Promise.reject(new Error("Pipa is shutting down."));
    const previous = tails.get(conversationKey) ?? Promise.resolve();
    const current = previous.catch(() => undefined).then(async () => {
      if (closed) throw new Error("Pipa is shutting down.");
      const { deliver, deliverFailure, ...turn } = input;
      let result;
      try {
        result = await runTurn({ ...turn, sessionId: sessionStore.get(conversationKey) });
        if (result.sessionId) await sessionStore.set(conversationKey, result.sessionId);
      } catch (error) {
        if (deliverFailure) {
          await deliverFailure(error);
          return { error };
        }
        throw error;
      }
      if (deliver) await deliver(result.text);
      return result;
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
    close() { closed = true; },
    drain: () => Promise.all([...tails.values()]),
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
  return result;
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

function stripMention(text = "") {
  return text.replace(/(?:<@|@)[UW][A-Z0-9]+>?/u, "").trim();
}

function requireToken(value, label, prefix) {
  const token = String(value ?? "").trim();
  if (!token.startsWith(prefix)) throw new Error(`${label} must start with ${prefix}`);
  return token;
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

async function postInChunks(thread, text) {
  for (let index = 0; index < text.length; index += 3500) {
    await thread.post({ markdown: text.slice(index, index + 3500) });
  }
}

async function react(thread, message, emoji) {
  if (!message.id) return;
  await thread.adapter.addReaction(thread.id, message.id, emoji).catch(() => undefined);
}

async function finishReaction(thread, message, emoji) {
  if (!message.id) return;
  await thread.adapter.removeReaction(thread.id, message.id, "eyes").catch(() => undefined);
  await react(thread, message, emoji);
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
