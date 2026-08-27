#!/usr/bin/env node

import crossSpawn from "cross-spawn";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
import { acquireInstanceLock, createManifest, createManifestUrl, loadConfig, stopInstance } from "../src/state.mjs";
import { initializePipa, startPipa } from "../src/app.mjs";
import { startOpenCodeServer } from "../src/opencode.mjs";

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
  throw new Error("Usage: pipa init | pipa start | pipa stop | pipa --version");
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
  try {
    const config = await loadConfig();
    if (config.slackMode === "managed") {
      const server = startOpenCodeServer(config);
      io.output.write(`Pipa is starting OpenCode on ${config.openCodeHostname}:${config.openCodePort}.\n`);
      const stopWithSigint = () => server.stop("SIGINT");
      const stopWithSigterm = () => server.stop("SIGTERM");
      process.on("SIGINT", stopWithSigint);
      process.on("SIGTERM", stopWithSigterm);
      try {
        await server.wait();
      } finally {
        process.off("SIGINT", stopWithSigint);
        process.off("SIGTERM", stopWithSigterm);
      }
      return;
    }

    const app = await startPipa({ config });
    io.output.write(app.server.owned
      ? `Pipa started a private OpenCode server at ${app.server.baseUrl}.\n`
      : `Pipa is using the configured OpenCode server at ${app.server.baseUrl}.\n`);
    io.output.write("Pipa is connected through Slack Socket Mode.\n");
    let stop;
    const signal = new Promise((resolve) => stop = resolve);
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      await Promise.race([signal, app.wait()]);
    } finally {
      try {
        await app.shutdown();
      } finally {
        process.off("SIGINT", stop);
        process.off("SIGTERM", stop);
      }
    }
  } finally {
    await releaseLock();
  }
}

main().catch((error) => {
  process.stderr.write(`Pipa failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
