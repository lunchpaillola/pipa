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
  await (options.checkOpenCode ?? runOpenCodeVersion)();
  await (options.checkSlackToken ?? checkSlackToken)(config.slackBotToken);

  await saveConfig(config, paths, manifest);
  return { config, manifest, paths };
}

export async function startPipa(options = {}) {
  const paths = options.paths ?? pipaPaths();
  const config = options.config ?? await loadConfig(paths.config);
  const sessionStore = options.sessionStore ?? await createSessionStore(paths.sessions);
  const executor = options.executor ?? createOpenCodeExecutor();
  const runner = createConversationRunner({ sessionStore, runTurn: executor.runTurn });
  const slack = options.slack ?? createSlackAdapter({
    appToken: config.slackAppToken,
    botToken: config.slackBotToken,
    mode: "socket",
    userName: config.botName,
  });
  const chat = options.chat ?? new Chat({
    adapters: { slack },
    concurrency: "concurrent",
    state: createMemoryState(),
    userName: config.botName,
  });
  let accepting = true;

  const handle = async (thread, message, subscribe) => {
    if (!accepting || shouldIgnore(thread, message)) return;
    const prompt = stripMention(message.text);
    if (!prompt) return;
    if (subscribe) await thread.subscribe();
    if (!accepting) return;

    try {
      const result = await runner.enqueue(thread.id, {
        prompt,
        workingDirectory: config.workingDirectory,
      });
      await thread.post(result.text);
    } catch (error) {
      await thread.post(`Pipa failed: ${safeError(error)}`);
    }
  };

  chat.onNewMention((thread, message) => handle(thread, message, true));
  chat.onSubscribedMessage((thread, message) => handle(thread, message, false));
  await chat.initialize();
  for (const conversationKey of sessionStore.keys()) {
    await chat.thread(conversationKey).subscribe();
  }

  return {
    async shutdown() {
      accepting = false;
      runner.close();
      executor.stopAll();
      await runner.drain();
      await chat.shutdown();
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
      const result = await runTurn({ ...input, sessionId: sessionStore.get(conversationKey) });
      if (result.sessionId && result.sessionId !== sessionStore.get(conversationKey)) {
        await sessionStore.set(conversationKey, result.sessionId);
      }
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
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error("Slack rejected the bot token.");
  return result;
}

function shouldIgnore(thread, message) {
  return message.author?.isMe
    || thread.channel?.isDM
    || thread.channel?.channelVisibility === "external"
    || Boolean(message.raw?.subtype)
    || !message.text?.trim();
}

function stripMention(text = "") {
  return text.replace(/^\s*<@[^>]+>\s*/u, "").trim();
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
