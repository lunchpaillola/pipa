#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { createManifest } from "../src/state.mjs";
import { initializePipa, startPipa } from "../src/app.mjs";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

export async function main(argv = process.argv.slice(2), io = { input: stdin, output: stdout }) {
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
  const prompt = createInterface(io);
  try {
    const botName = (await prompt.question("Bot name (Pipa): ")).trim() || "Pipa";
    const workingDirectory = (await prompt.question(`Working directory (${process.cwd()}): `)).trim() || process.cwd();
    io.output.write("\nCreate a Slack app from this manifest and install it to your workspace:\n\n");
    io.output.write(`${JSON.stringify(createManifest(botName), null, 2)}\n\n`);
    const slackAppToken = await prompt.question("Slack app token (xapp-): ");
    const slackBotToken = await prompt.question("Slack bot token (xoxb-): ");
    const result = await initializePipa({ botName, workingDirectory, slackAppToken, slackBotToken });
    io.output.write(`\nSaved config to ${result.paths.config}. Run \`pipa start\`.\n`);
  } finally {
    prompt.close();
  }
}

async function start(io) {
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
}

main().catch((error) => {
  process.stderr.write(`Pipa failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
