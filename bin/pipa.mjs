#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
import { acquireInstanceLock, createManifest } from "../src/state.mjs";
import { initializePipa, startPipa } from "../src/app.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

async function main(argv = process.argv.slice(2), io = { input: stdin, output: stdout }) {
  const command = argv[0];
  if (command === "--version" || command === "-v") {
    io.output.write(`${packageJson.version}\n`);
    return;
  }
  if (command === "init") return init(io);
  if (command === "start") return start(io);
  throw new Error("Usage: pipa init | pipa start | pipa --version");
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
      || (await prompt.question("Bot name (Pipa): ")).trim()
      || "Pipa";
    const workingDirectory = process.env.PIPA_WORKING_DIRECTORY?.trim()
      || (await prompt.question(`Working directory (${process.cwd()}): `)).trim()
      || process.cwd();
    io.output.write("\nCreate a Slack app from this manifest and install it to your workspace:\n\n");
    io.output.write(`${JSON.stringify(createManifest(botName), null, 2)}\n\n`);
    const askSecret = async (label) => {
      io.output.write(label);
      muted = true;
      const value = await prompt.question("");
      muted = false;
      io.output.write("\n");
      return value;
    };
    const slackAppToken = process.env.PIPA_SLACK_APP_TOKEN || await askSecret("Slack app token (xapp-): ");
    const slackBotToken = process.env.PIPA_SLACK_BOT_TOKEN || await askSecret("Slack bot token (xoxb-): ");
    const result = await initializePipa({ botName, workingDirectory, slackAppToken, slackBotToken });
    io.output.write(`\nSaved config to ${result.paths.config}. Run \`pipa start\`.\n`);
  } finally {
    prompt.close();
  }
}

async function start(io) {
  const releaseLock = await acquireInstanceLock();
  try {
    const app = await startPipa();
    io.output.write("Pipa is connected through Slack Socket Mode.\n");
    await new Promise((resolve, reject) => {
      let stopping = false;
      const shutdown = () => {
        if (stopping) return;
        stopping = true;
        app.shutdown().then(resolve, reject);
      };
      process.once("SIGINT", shutdown);
      process.once("SIGTERM", shutdown);
    });
  } finally {
    await releaseLock();
  }
}

main().catch((error) => {
  process.stderr.write(`Pipa failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
