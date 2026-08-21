import { Chat } from "chat";
import { createSlackAdapter } from "@chat-adapter/slack";
import { createMemoryState } from "@chat-adapter/state-memory";
import { canonicalWorkingDirectory, createManifest, createSessionStore, loadConfig, pipaPaths, saveConfig } from "./state.mjs";
import { createOpenCodeExecutor, runOpenCodeVersion } from "./opencode.mjs";

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
  const executor = options.executor ?? createOpenCodeExecutor();
  const runner = createConversationRunner({ sessionStore, runTurn: executor.runTurn });
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
  let accepting = true;

  const handle = async (thread, message, subscribe) => {
    if (!accepting || shouldIgnore(thread, message)) return;
    const prompt = subscribe || message.isMention ? stripMention(message.text) : message.text.trim();
    if (!prompt) return;
    if (subscribe) await thread.subscribe();
    if (!accepting) return;

    await react(thread, message, "eyes");
    try {
      const result = await runner.enqueue(thread.id, {
        prompt,
        workingDirectory: config.workingDirectory,
        contextEnvironment: slackContext(thread, message),
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
    throw error;
  }

  return {
    async shutdown() {
      accepting = false;
      runner.close();
      executor.stopAll();
      await withTimeout((async () => {
        await runner.drain();
        await chat.shutdown();
      })(), options.shutdownTimeoutMs ?? 15_000, "Pipa shutdown timed out.");
    },
  };
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
    || Boolean(message.raw?.subtype)
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
