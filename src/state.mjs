import { constants, existsSync, readFileSync, unlinkSync } from "node:fs";
import { access, chmod, link, mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";

const MANIFEST = {
  display_information: {
    name: "Pippette",
    description: "Pippette connects Slack to OpenCode running on your computer.",
    background_color: "#1f2de6",
    long_description: "Pippette connects Slack to the OpenCode installed on your computer. Send text requests from Slack and receive replies in threads for the local folder you choose. OpenCode runs locally, and your Slack credentials stay on your machine. Learn more at usepipa.com.",
  },
  features: {
    slash_commands: [{ description: "Configure this Pipa installation", usage_hint: "model", should_escape: false }],
    bot_user: {
      display_name: "Pippette",
      always_online: true,
    },
  },
  oauth_config: {
    scopes: {
      user: ["files:read", "files:write"],
      bot: [
        "commands",
        "files:read",
        "app_mentions:read",
        "assistant:write",
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
    routines: path.join(directory, "routines.json"),
    routinesLock: path.join(directory, "routines.lock"),
    sessions: path.join(directory, "sessions.json"),
  };
}

export async function acquireInstanceLock(file = pipaPaths().lock) {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const birth = processBirth(process.pid);
  if (!birth) throw unverifiedOwner(process.pid);
  const identity = Object.freeze({ pid: process.pid, generation: randomUUID(), birth });
  await writeFile(temporary, JSON.stringify(identity), { mode: 0o600 });
  try {
    await link(temporary, file);
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const guard = `${file}.recovering`;
    // Serialize stale-lock removal across processes; re-read only after claiming the guard.
    try { await mkdir(guard, { mode: 0o700 }); }
    catch (error) {
      if (error?.code !== "EEXIST") throw error;
      throw new Error(`Pipa lock recovery is in progress. Retry; if interrupted, stop all Pipa launchers for this profile before moving ${guard} aside.`);
    }
    try {
      const previous = await readInstanceLock(file);
      if (verifyInstanceOwner(previous)) throw new Error(`Pipa is already running (PID ${previous.pid}).`);
      if (previous) {
        removeInstanceLock(file, previous);
        if (previous.birth) await rm(stopFile(file, previous), { force: true });
      }
      try { await link(temporary, file); }
      catch (error) {
        if (error?.code !== "EEXIST") throw error;
        throw new Error("Another Pipa instance acquired the lock during startup.");
      }
    } finally { await rmdir(guard); }
  } finally {
    await rm(temporary, { force: true });
  }
  const release = async () => {
    removeInstanceLock(file, identity);
    await rm(stopFile(file, identity), { force: true });
  };
  release.identity = identity;
  return release;
}

const stopFile = (file, identity) => `${file}.${identity.generation}.stop`;
const birthFormats = {
  linux: /^linux:[a-f0-9-]{36}:\d+$/u,
  darwin: /^darwin:[A-Z][a-z]{2} [A-Z][a-z]{2} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u,
  win32: /^win32:\d{1,19}$/u,
};
const birthPlatform = (birth) => Object.keys(birthFormats).find((platform) => birthFormats[platform].test(birth));

export function watchInstanceStop(identity, stop, file = pipaPaths().lock) {
  const request = stopFile(file, identity);
  const timer = setInterval(() => {
    if (!existsSync(request)) return;
    clearInterval(timer);
    stop();
  }, 100);
  timer.unref();
  return () => clearInterval(timer);
}

export async function stopInstance(file = pipaPaths().lock) {
  const identity = await readInstanceLock(file);
  if (!verifyInstanceOwner(identity)) return null;
  // A PID can be reused after inspection. Only the owning generation consumes this request.
  const request = stopFile(file, identity);
  await writeFile(request, "", { mode: 0o600, flag: "wx" }).catch((error) => {
    if (error?.code !== "EEXIST") throw error;
  });
  const current = await readInstanceLock(file);
  if (current?.generation === identity.generation) return identity.pid;
  await rm(request, { force: true });
  return null;
}

function unverifiedOwner(pid) {
  return new Error(`Cannot verify Pipa instance ownership (PID ${pid}). Stop Pipa using its original terminal or service manager. If no Pipa is running and automatic launchers are paused, move pipa.lock aside and start again.`);
}

export function verifyInstanceOwner(identity) {
  if (!identity) return false;
  const birth = processBirth(identity.pid);
  if (birth === false) return false;
  if (birth && birthPlatform(identity.birth) === process.platform) return birth === identity.birth;
  try { process.kill(identity.pid, 0); }
  catch (error) { if (error?.code === "ESRCH") return false; }
  throw unverifiedOwner(identity.pid);
}

function processBirth(pid) {
  if (process.platform === "linux") {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      if (fields[0] === "Z" || fields[0] === "X") return false;
      const boot = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
      const birth = `linux:${boot}:${fields[19]}`;
      if (birthFormats.linux.test(birth)) return birth;
    } catch { return null; }
  }
  if (process.platform === "darwin") {
    const result = spawnSync("/bin/ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", env: { LC_ALL: "C", TZ: "UTC" }, timeout: 2000,
    });
    const birth = `darwin:${result.stdout?.trim()}`;
    if (result.status === 0 && birthFormats.darwin.test(birth)) return birth;
  }
  if (process.platform === "win32" && process.env.SystemRoot) {
    const result = spawnSync(path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference = 'Stop'; (Get-Process -Id ${pid}).StartTime.ToUniversalTime().Ticks`],
      { encoding: "utf8", env: { SystemRoot: process.env.SystemRoot }, timeout: 5000, windowsHide: true });
    const birth = `win32:${result.stdout?.trim()}`;
    if (result.status === 0 && birthFormats.win32.test(birth)) return birth;
  }
  return null;
}

export async function readInstanceLock(file = pipaPaths().lock) {
  try {
    return parseInstanceLock(await readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function parseInstanceLock(text) {
  const value = JSON.parse(text);
  const identity = typeof value === "number" ? { pid: value, generation: null } : value;
  if (!Number.isSafeInteger(identity?.pid) || identity.pid <= 0
    || identity.pid > 0x7fffffff
    || (identity.generation !== null && !/^[a-f0-9-]{36}$/u.test(identity.generation ?? ""))
    || (identity.birth !== undefined && (!identity.generation || typeof identity.birth !== "string" || !birthPlatform(identity.birth)))) {
    throw new Error("Invalid Pipa instance lock.");
  }
  return identity;
}

function removeInstanceLock(file, identity) {
  try {
    // Only the owner releases a live lock; stale removers serialize under the recovery guard.
    const current = parseInstanceLock(readFileSync(file, "utf8"));
    if (current.pid === identity?.pid && current.generation === identity?.generation) unlinkSync(file);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
}

export function createManifest(botName) {
  const name = validateBotName(botName);
  const manifest = structuredClone(MANIFEST);
  manifest.display_information.name = name;
  manifest.display_information.description = manifest.display_information.description.replaceAll("Pippette", name);
  manifest.display_information.long_description = manifest.display_information.long_description.replaceAll("Pippette", name);
  manifest.features.bot_user.display_name = name;
  const commandTemplate = manifest.features.slash_commands[0];
  manifest.features.slash_commands = slackCommandNames(name).map((command) => ({ ...commandTemplate, command }));
  return manifest;
}

export function slackCommandName(botName) {
  const slug = validateBotName(botName).normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 31).replace(/-+$/u, "");
  return slug ? `/${slug}` : "/pipa";
}

export function slackCommandNames(botName) {
  return [...new Set([slackCommandName(botName), "/pipa"])];
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
  for (const key of ["allowedSlackChannelIds", "allowedSlackUserIds", "allowedSlackBotIds"]) {
    const value = config[key];
    if (value !== undefined && (!Array.isArray(value) || !value.every((item) => typeof item === "string" && item.trim()))) {
      throw new Error(`Invalid Pipa config: ${key} must be a list of non-empty Slack IDs.`);
    }
  }
  if (config.mentionOnly !== undefined && typeof config.mentionOnly !== "boolean") {
    throw new Error("Invalid Pipa config: mentionOnly must be a boolean.");
  }
  return { ...config, slackMode };
}

export function normalizeModel(value) {
  if (value == null) return null;
  if (typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => !["providerID", "modelID"].includes(key))
    || ![value.providerID, value.modelID].every((id) => typeof id === "string" && id.trim() === id && id.length > 0 && id.length <= 500 && !/[\u0000-\u001f\u007f]/u.test(id))) {
    throw new Error("Invalid model: expected providerID and modelID.");
  }
  return { providerID: value.providerID, modelID: value.modelID };
}

export function createModelSetting(file = pipaPaths().config, writeJson = writePrivateJson) {
  let tail = Promise.resolve();
  return {
    async save(model, authorize = () => undefined) {
      const selected = normalizeModel(model);
      if (!selected) return Promise.reject(new Error("A model selection is required."));
      const write = tail.then(async () => {
        const current = await loadConfig(file);
        await authorize(current);
        await writeJson(file, { ...current, defaultModel: selected });
        return selected;
      });
      tail = write.catch(() => undefined);
      return write;
    },
  };
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

export async function writePrivateJson(file, value) {
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

export function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
