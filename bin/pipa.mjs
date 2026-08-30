#!/usr/bin/env node

import crossSpawn from "cross-spawn";
import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
import { acquireInstanceLock, createManifest, createManifestUrl, loadConfig, stopInstance } from "../src/state.mjs";
import { initializePipa, startPipa } from "../src/app.mjs";
import { startOpenCodeServer } from "../src/opencode.mjs";
import { createRoutine, deleteRoutine, editRoutine, loadRoutineState, requestRoutineRun } from "../src/routines.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

async function main(argv = process.argv.slice(2), io = { input: stdin, output: stdout }) {
  const command = argv[0];
  if (command === "--version" || command === "-v") {
    io.output.write(`${packageJson.version}\n`);
    return;
  }
  if (command === "init") return init(io);
  if (command === "start") return start(io);
  if (command === "stop") return stop(io);
  if (command === "routine") return routine(argv.slice(1), io);
  throw new Error("Usage: pipa init | pipa start | pipa stop | pipa routine | pipa --version");
}

const ROUTINE_HELP = `Usage: pipa routine <command>

Commands:
  create (--prompt <text> | --prompt-file <path>) --timezone <iana> --channel <id> [--thread <ts>] <schedule> [--preview] [--json]
  list [--json]
  show <id> [--json]
  edit <id> [create options] [--status active|inactive] [--json]
  run <id> [--json]
  delete <id> [--json]

Schedules: --at <iso> | --in <positive><m|h|d|w> | --every <positive><m|h|d|w>
Recurring options: --times <HH:MM,...> --weekdays <1,...,7> --until <YYYY-MM-DD>
`;

async function routine(argv, io) {
  const command = argv[0];
  if (!command || command === "--help" || command === "-h") {
    io.output.write(ROUTINE_HELP);
    return;
  }
  const { values, positionals } = parseRoutineArgs(argv.slice(1));
  const json = values.json === true;

  if (command === "list") {
    requireNoOptions(values, ["json"]);
    if (positionals.length) cliError("list does not accept an ID");
    const routines = (await loadRoutineState()).routines;
    return writeRoutineResult(io.output, json, { routines }, routines.length
      ? routines.map((item) => `${item.id}\t${item.status}\t${item.nextRunAt ?? "-"}`).join("\n")
      : "No routines.");
  }
  if (command === "show") {
    requireNoOptions(values, ["json"]);
    const id = requireId(positionals);
    const found = (await loadRoutineState()).routines.find((item) => item.id === id);
    if (!found) cliError(`Routine not found: ${id}`, "not_found");
    return writeRoutineResult(io.output, json, { routine: found }, formatRoutine(found));
  }
  if (command === "run") {
    requireNoOptions(values, ["json"]);
    const id = requireId(positionals);
    const requested = await requestRoutineRun(id);
    return writeRoutineResult(io.output, json, { routine: requested }, `Run requested for ${id}.`);
  }
  if (command === "delete") {
    requireNoOptions(values, ["json"]);
    const id = requireId(positionals);
    await deleteRoutine(id);
    return writeRoutineResult(io.output, json, { deleted: id }, `Deleted routine ${id}.`);
  }
  if (command !== "create" && command !== "edit") cliError(`Unknown routine command: ${command}`);

  const id = command === "edit" ? requireId(positionals) : positionals.length === 0 ? randomUUID() : cliError("create does not accept an ID");
  const config = await loadConfig();
  const now = new Date().toISOString();
  const changes = await routineInput(values, command === "create", now);
  const options = { now, allowedChannelIds: config.allowedSlackChannelIds ?? [] };
  const result = command === "create"
    ? await createRoutine({ id, ...changes }, { ...options, preview: values.preview === true })
    : await editRoutine(id, changes, options);
  const preview = command === "create" && values.preview === true;
  return writeRoutineResult(io.output, json, { routine: result, ...(preview ? { preview: true } : {}) }, preview
    ? `Preview: ${formatRoutine(result)}`
    : `${command === "create" ? "Created" : "Edited"} routine ${id}.`);
}

function parseRoutineArgs(argv) {
  const booleanOptions = new Set(["json", "preview"]);
  const values = {};
  const positionals = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }
    const name = argument.slice(2);
    if (!name) cliError("invalid option");
    if (Object.hasOwn(values, name)) cliError(`option --${name} may only be used once`);
    if (booleanOptions.has(name)) values[name] = true;
    else {
      if (index + 1 >= argv.length) cliError(`option --${name} requires a value`);
      values[name] = argv[index += 1];
    }
  }
  return { values, positionals };
}

async function routineInput(values, creating, now) {
  const supported = ["prompt", "prompt-file", "timezone", "channel", "thread", "at", "in", "every", "times", "weekdays", "until", "status", "preview", "json"];
  requireNoOptions(values, supported);
  if (!creating && values.preview) cliError("--preview is only supported by create");
  if (creating && values.status !== undefined) cliError("--status is only supported by edit");
  if (values.prompt !== undefined && values["prompt-file"] !== undefined) cliError("use exactly one of --prompt or --prompt-file");
  const changes = {};
  if (values.prompt !== undefined) changes.prompt = values.prompt;
  if (values["prompt-file"] !== undefined) changes.prompt = await readFile(values["prompt-file"], "utf8");
  if (creating && changes.prompt === undefined) cliError("create requires --prompt or --prompt-file");
  if (values.timezone !== undefined) changes.timezone = values.timezone;
  if (creating && changes.timezone === undefined) cliError("create requires --timezone");
  if (values.channel !== undefined || values.thread !== undefined) {
    if (creating && values.channel === undefined) cliError("create requires --channel");
    changes.destination = {
      ...(values.channel === undefined ? {} : { channelId: values.channel }),
      ...(values.thread === undefined ? {} : { threadTs: values.thread }),
    };
  }
  if (creating && changes.destination === undefined) cliError("create requires --channel");
  const schedules = ["at", "in", "every"].filter((name) => values[name] !== undefined);
  if (schedules.length > 1) cliError("use exactly one of --at, --in, or --every");
  if (creating && schedules.length !== 1) cliError("create requires exactly one schedule");
  if (schedules.length === 0 && (values.times !== undefined || values.weekdays !== undefined || values.until !== undefined)) {
    cliError("--times, --weekdays, and --until require --every");
  }
  if (schedules.length === 1) changes.schedule = scheduleFromOptions(values, now);
  if (values.status !== undefined) {
    if (values.status !== "active" && values.status !== "inactive") cliError("--status must be active or inactive");
    changes.status = values.status;
  }
  return changes;
}

function scheduleFromOptions(values, now) {
  if (values.at !== undefined) {
    rejectRecurringOptions(values);
    return { type: "once", at: values.at };
  }
  if (values.in !== undefined) {
    rejectRecurringOptions(values);
    return { type: "once", at: new Date(Date.parse(now) + parseDuration(values.in)).toISOString() };
  }
  const match = /^(\d+)([mhdw])$/u.exec(values.every ?? "");
  if (!match || Number(match[1]) <= 0) cliError("--every must be a positive duration such as 30m, 2h, 1d, or 1w");
  const frequency = { m: "minutes", h: "hours", d: "daily", w: "weekly" }[match[2]];
  return {
    type: "recurring",
    frequency,
    interval: Number(match[1]),
    times: values.times === undefined ? [] : values.times.split(","),
    weekdays: values.weekdays === undefined ? [] : values.weekdays.split(",").map(Number),
    until: values.until ?? null,
  };
}

function parseDuration(value) {
  const match = /^(\d+)([mhdw])$/u.exec(value);
  if (!match || Number(match[1]) <= 0) cliError("--in must be a positive duration such as 5m");
  const milliseconds = { m: 60_000, h: 3_600_000, d: 86_400_000, w: 604_800_000 }[match[2]];
  return Number(match[1]) * milliseconds;
}

function rejectRecurringOptions(values) {
  if (values.times !== undefined || values.weekdays !== undefined || values.until !== undefined) cliError("--times, --weekdays, and --until require --every");
}

function requireNoOptions(values, supported) {
  const unsupported = Object.keys(values).find((name) => !supported.includes(name));
  if (unsupported) cliError(`unknown option --${unsupported}`);
}

function requireId(positionals) {
  if (positionals.length !== 1) cliError("command requires exactly one routine ID");
  return positionals[0];
}

function writeRoutineResult(output, json, value, human) {
  output.write(json ? `${JSON.stringify({ ok: true, ...value })}\n` : `${human}\n`);
}

function formatRoutine(routine) {
  return `${routine.id}\nStatus: ${routine.status}\nNext run: ${routine.nextRunAt ?? "-"}\nDestination: ${routine.destination.channelId}${routine.destination.threadTs ? ` thread ${routine.destination.threadTs}` : ""}`;
}

function cliError(message, code = "invalid_arguments") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

async function stop(io) {
  const pid = await stopInstance();
  io.output.write(pid ? `Pipa is stopping (PID ${pid}).\n` : "Pipa is not running.\n");
}

async function init(io) {
  let muted = false;
  const promptOutput = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) io.output.write(chunk, encoding);
      callback();
    },
  });
  const prompt = createInterface({ input: io.input, output: promptOutput, terminal: Boolean(io.input.isTTY) });
  try {
    const botName = process.env.PIPA_BOT_NAME?.trim()
      || (await prompt.question("What should we call your bot? (leave empty to use Pipa; you can change this later): ")).trim()
      || "Pipa";
    const hasSlackTokens = process.env.PIPA_SLACK_APP_TOKEN && process.env.PIPA_SLACK_BOT_TOKEN;
    const workingDirectory = process.cwd();
    if (!hasSlackTokens) {
      io.output.write(`\nPipa will work in this folder:\n\n  ${workingDirectory}\n\nPeople in Slack channels where you add ${botName} can ask it to read and change files in this folder.\n\n`);
      if (!await confirm(prompt, io.output)) {
        io.output.write("\nSetup cancelled. Change into the folder where you want Pipa to work, then run `pipa init` again.\n");
        return;
      }
    }
    if (!hasSlackTokens) {
      const manifestUrl = createManifestUrl(createManifest(botName));
      io.output.write("\nOpening Slack with your app configuration...\n");
      if (io.input.isTTY) await openUrl(manifestUrl).catch(() => undefined);
      io.output.write(`\nIf Slack did not open, use this link:\n${manifestUrl}\n\n`);
      io.output.write("In Slack:\n1. Choose your workspace, review the configuration, and create the app.\n2. Under Basic Information, generate an app-level token with connections:write.\n3. Under OAuth & Permissions, install the app and copy its Bot User OAuth Token.\n\n");
    }
    const askSecret = async (question, label) => {
      io.output.write(question);
      muted = true;
      const value = await prompt.question("");
      muted = false;
      io.output.write(`\n✓ ${label} received.\n`);
      return value;
    };
    const slackAppToken = process.env.PIPA_SLACK_APP_TOKEN || await askSecret("Slack app token (xapp-, input hidden): ", "App token");
    const slackBotToken = process.env.PIPA_SLACK_BOT_TOKEN || await askSecret("Slack bot token (xoxb-, input hidden): ", "Bot token");
    const allowedSlackChannelIds = process.env.PIPA_ALLOWED_CHANNEL_IDS
      ?? (await prompt.question("Allowed Slack channel IDs (comma-separated, e.g. C0BSE2JTYPR; leave empty to allow any channel): ")).trim();
    const allowedSlackUserIds = process.env.PIPA_ALLOWED_USER_IDS
      ?? (await prompt.question("Allowed Slack user IDs (comma-separated, e.g. UFWBSCZ54; leave empty to allow any user): ")).trim();
    io.output.write("\nChecking OpenCode and Slack credentials...\n");
    const result = await initializePipa({ botName, workingDirectory, slackAppToken, slackBotToken, allowedSlackChannelIds, allowedSlackUserIds });
    io.output.write(`✓ Credentials validated.\n\nSaved config to ${result.paths.config}. Run \`pipa start\`.\n`);
  } finally {
    prompt.close();
  }
}

async function confirm(prompt, output) {
  while (true) {
    const answer = (await prompt.question("Continue? [Y/n]: ")).trim().toLowerCase();
    if (!answer || answer === "y" || answer === "yes") return true;
    if (answer === "n" || answer === "no") return false;
    output.write("Please answer y or n.\n");
  }
}

function openUrl(url) {
  let command = "xdg-open";
  let args = [url];
  if (process.platform === "darwin") command = "open";
  if (process.platform === "win32") {
    command = "rundll32";
    args = ["url.dll,FileProtocolHandler", url];
  }
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, { detached: true, stdio: "ignore" });
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
    child.once("error", reject);
  });
}

async function start(io) {
  const releaseLock = await acquireInstanceLock();
  let stop;
  let stopWithSigint;
  let stopWithSigterm;
  try {
    const config = await loadConfig();
    if (config.slackMode === "managed") {
      const server = startOpenCodeServer(config);
      io.output.write(`Pipa is starting OpenCode on ${config.openCodeHostname}:${config.openCodePort}.\n`);
      stopWithSigint = () => server.stop("SIGINT");
      stopWithSigterm = () => server.stop("SIGTERM");
      process.on("SIGINT", stopWithSigint);
      process.on("SIGTERM", stopWithSigterm);
      await server.wait();
      return;
    }

    const app = await startPipa({ config });
    io.output.write(app.server.owned
      ? `Pipa started a private OpenCode server at ${app.server.baseUrl}.\n`
      : `Pipa is using the configured OpenCode server at ${app.server.baseUrl}.\n`);
    io.output.write("Pipa is connected through Slack Socket Mode.\n");
    const { promise: signal, resolve: resolveSignal } = Promise.withResolvers();
    stop = () => {
      app.stop();
      resolveSignal();
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    try {
      await Promise.race([signal, app.wait()]);
    } finally {
      await app.shutdown();
    }
  } finally {
    try {
      await releaseLock();
    } finally {
      if (stop) {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
      if (stopWithSigint) process.off("SIGINT", stopWithSigint);
      if (stopWithSigterm) process.off("SIGTERM", stopWithSigterm);
    }
  }
}

main().catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  if (process.argv.includes("--json")) process.stdout.write(`${JSON.stringify({ ok: false, error: { code: error?.code ?? "routine_error", message } })}\n`);
  else process.stderr.write(`Pipa failed: ${message}\n`);
  process.exitCode = 1;
});
