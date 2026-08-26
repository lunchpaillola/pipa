import { constants } from "node:fs";
import { access, chmod, link, mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const MANIFEST = {
  display_information: {
    name: "Pippette",
    description: "Pippette connects Slack to OpenCode running on your computer.",
    background_color: "#1f2de6",
    long_description: "Pippette connects Slack to the OpenCode installed on your computer. Send text requests from Slack and receive replies in threads for the local folder you choose. OpenCode runs locally, and your Slack credentials stay on your machine. Learn more at usepipa.com.",
  },
  features: {
    bot_user: {
      display_name: "Pippette",
      always_online: true,
    },
  },
  oauth_config: {
    scopes: {
      user: ["files:read", "files:write"],
      bot: [
        "files:read",
        "app_mentions:read",
        "channels:history",
        "channels:read",
        "chat:write",
        "groups:history",
        "groups:read",
        "reactions:write",
        "users:read",
        "files:write",
      ],
    },
    pkce_enabled: false,
  },
  settings: {
    event_subscriptions: {
      bot_events: ["app_mention", "message.channels", "message.groups"],
    },
    interactivity: { is_enabled: true },
    org_deploy_enabled: false,
    socket_mode_enabled: true,
    token_rotation_enabled: false,
    is_mcp_enabled: false,
  },
};

export function pipaPaths(home = process.env.PIPA_HOME || os.homedir()) {
  const directory = path.join(home, ".pipa");
  return {
    directory,
    config: path.join(directory, "config.json"),
    manifest: path.join(directory, "slack-manifest.json"),
    lock: path.join(directory, "pipa.lock"),
    sessions: path.join(directory, "sessions.json"),
  };
}

export async function acquireInstanceLock(file = pipaPaths().lock) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, String(process.pid), { mode: 0o600 });
  try {
    await claimLock(temporary, file);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const pid = Number.parseInt(await readFile(file, "utf8").catch(() => ""), 10);
    if (pid && isRunning(pid)) throw new Error(`Pipa is already running (PID ${pid}).`);
    await rm(file, { force: true });
    await claimLock(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
  return () => rm(file, { force: true });
}

export async function stopInstance(file = pipaPaths().lock, kill = process.kill) {
  const pid = Number.parseInt(await readFile(file, "utf8").catch(() => ""), 10);
  if (!pid) return null;
  try {
    kill(pid, "SIGTERM");
    return pid;
  } catch (error) {
    if (error?.code === "ESRCH") await rm(file, { force: true });
    else throw error;
    return null;
  }
}

export function createManifest(botName) {
  const name = validateBotName(botName);
  const manifest = structuredClone(MANIFEST);
  manifest.display_information.name = name;
  manifest.display_information.description = manifest.display_information.description.replaceAll("Pippette", name);
  manifest.display_information.long_description = manifest.display_information.long_description.replaceAll("Pippette", name);
  manifest.features.bot_user.display_name = name;
  return manifest;
}

export function createManifestUrl(manifest) {
  return `https://api.slack.com/apps?new_app=1&manifest_json=${encodeURIComponent(JSON.stringify(manifest))}`;
}

export async function canonicalWorkingDirectory(directory) {
  const resolved = await realpath(path.resolve(directory));
  if (!(await stat(resolved)).isDirectory()) throw new Error("Working directory must be a directory.");
  await access(resolved, constants.R_OK | constants.W_OK);
  return resolved;
}

export async function loadConfig(file = pipaPaths().config) {
  const config = await readJson(file, "Run `pipa init` first.");
  const slackMode = config.slackMode === undefined ? "socket" : config.slackMode;
  if (slackMode !== "socket" && slackMode !== "managed") {
    throw new Error("Invalid Pipa config: slackMode is unsupported.");
  }
  const requiredStrings = slackMode === "socket"
    ? ["botName", "workingDirectory", "slackAppToken", "slackBotToken"]
    : ["botName", "workingDirectory", "openCodeHostname"];
  for (const key of requiredStrings) {
    if (typeof config[key] !== "string" || !config[key].trim()) {
      throw new Error(`Invalid Pipa config: ${key} is missing.`);
    }
  }
  if (slackMode === "managed" && (!Number.isInteger(config.openCodePort) || config.openCodePort < 1 || config.openCodePort > 65535)) {
    throw new Error("Invalid Pipa config: openCodePort must be an integer from 1 to 65535.");
  }
  return { ...config, slackMode };
}

export async function saveConfig(config, paths = pipaPaths(), manifest = createManifest(config.botName)) {
  await writePrivateJson(paths.manifest, manifest);
  await writePrivateJson(paths.config, config);
}

export async function loadSessions(file = pipaPaths().sessions) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string" || !value) throw new Error(`invalid session for ${key}`);
    }
    return parsed;
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw new Error(`Could not read Pipa sessions: ${error.message}`);
  }
}

export async function createSessionStore(file = pipaPaths().sessions, writeJson = writePrivateJson) {
  const sessions = await loadSessions(file);
  let writeTail = Promise.resolve();

  return {
    keys: () => Object.keys(sessions),
    get: (conversationKey) => sessions[conversationKey] ?? null,
    async set(conversationKey, sessionId) {
      sessions[conversationKey] = sessionId;
      const write = writeTail.then(() => writeJson(file, sessions));
      writeTail = write.catch(() => undefined);
      await write;
    },
  };
}

async function readJson(file, missingMessage) {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(missingMessage);
    throw new Error(`Could not read ${path.basename(file)}: ${error.message}`);
  }
}

async function writePrivateJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

function validateBotName(value) {
  const name = String(value ?? "").trim();
  if (!name || name.length > 35 || /[\r\n]/u.test(name)) {
    throw new Error("Bot name must be 1 to 35 characters on one line.");
  }
  return name;
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

function claimLock(source, destination) {
  return link(source, destination);
}
