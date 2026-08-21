#!/usr/bin/env node

import crossSpawn from "cross-spawn";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { Writable } from "node:stream";
import { stdin, stdout } from "node:process";
import { acquireInstanceLock, createManifest, createManifestUrl, loadConfig, pipaPaths, saveConfig } from "../src/state.mjs";
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
  const askSecret = async (question, label) => {
    io.output.write(question);
    muted = true;
    const value = await prompt.question("");
    muted = false;
    io.output.write(`\n✓ ${label} received.\n`);
    return value.trim();
  };
  try {
    const previous = await tryLoadConfig();
    const envBotName = process.env.PIPA_BOT_NAME?.trim();
    let botName = envBotName || previous?.botName || "Pipa";
    if (previous && !envBotName) {
      io.output.write(`Found existing Pipa config: "${previous.botName}" in ${previous.workingDirectory}.\n`);
      if (!await confirm(prompt, io.output, "Reconfigure it?", true)) {
        io.output.write("Nothing changed. Run `pipa start`.\n");
        return;
      }
      if (!await confirm(prompt, io.output, `Keep bot name "${previous.botName}"?`, true)) {
        botName = (await prompt.question("What should we call your bot? (leave empty to use Pipa; you can change this later): ")).trim() || "Pipa";
      }
    } else if (!previous && !envBotName) {
      botName = (await prompt.question("What should we call your bot? (leave empty to use Pipa; you can change this later): ")).trim() || "Pipa";
    }

    const hasSlackTokens = Boolean(process.env.PIPA_SLACK_APP_TOKEN && process.env.PIPA_SLACK_BOT_TOKEN);
    let workingDirectory = previous?.workingDirectory || process.cwd();
    if (!hasSlackTokens) {
      if (previous) {
        if (!await confirm(prompt, io.output, `Keep working directory "${workingDirectory}"?`, true)) {
          io.output.write("Reconfigure from another folder: change into it first, then run `pipa init` again.\n");
          return;
        }
      } else {
        io.output.write(`\nPipa will work in this folder:\n\n  ${workingDirectory}\n\nPeople in Slack channels where you add ${botName} can ask it to read and change files in this folder.\n\n`);
        if (!await confirm(prompt, io.output, "Continue?", true)) {
          io.output.write("\nSetup cancelled. Change into the folder where you want Pipa to work, then run `pipa init` again.\n");
          return;
        }
      }
    }

    const manifest = createManifest(botName);
    await writeManifest(manifest);

    let slackAppToken = process.env.PIPA_SLACK_APP_TOKEN;
    let slackBotToken = process.env.PIPA_SLACK_BOT_TOKEN;
    if (!hasSlackTokens && previous) {
      if (await confirm(prompt, io.output, "Keep the existing Slack app and tokens?", true)) {
        slackAppToken = previous.slackAppToken;
        slackBotToken = previous.slackBotToken;
      }
    }
    if (!slackAppToken || !slackBotToken) {
      const setup = await setupSlack({ botName, io, askSecret });
      if (!setup?.slackAppToken || !setup?.slackBotToken) {
        io.output.write("\nSetup incomplete; run `pipa init` again once Slack is ready.\n");
        return;
      }
      slackAppToken = setup.slackAppToken;
      slackBotToken = setup.slackBotToken;
    }

    io.output.write("\nChecking OpenCode and Slack credentials...\n");
    const result = await initializePipa({ botName, workingDirectory, slackAppToken, slackBotToken });
    io.output.write(`✓ Credentials validated.\n\nSaved config to ${result.paths.config}. Run \`pipa start\`.\n`);
  } finally {
    prompt.close();
  }
}

async function setupSlack({ botName, io, askSecret }) {
  const cliVersion = await slackCliVersion();
  if (cliVersion) {
    io.output.write(`\nSlack CLI found (${cliVersion}). Setting up the app for you...\n`);
    const setup = await setupSlackViaCli({ botName, io, askSecret });
    if (setup) return setup;
    io.output.write("\nSlack CLI setup did not finish. Falling back to the browser flow.\n");
  } else {
    io.output.write("\nSlack CLI not found; using the browser flow. Install it later for a faster setup:\n  curl -fsSL https://downloads.slack-edge.com/slack-cli/install.sh | bash\n");
  }
  return setupSlackViaBrowser({ botName, io, askSecret });
}

async function setupSlackViaCli({ botName, io, askSecret }) {
  if (!await slackLogin(io)) return null;

  io.output.write(`\nCreating the Slack app "${botName}"...\n`);
  const created = await runSecondary("slack", ["app", "create", "--manifest", pipaPaths().manifest]);
  if (created.code !== 0) {
    io.output.write(`Slack app create did not succeed: ${created.stderr.trim() || "see the error above"}.\n`);
    return null;
  }
  const output = created.stdout.trim() || created.stderr.trim();
  if (output) io.output.write(`${output}\n`);
  const appId = parseAppId(created.stdout + created.stderr);

  io.output.write(`\nInstalling the app in your workspace...\n`);
  const installed = await runSecondary("slack", ["app", "install"]);
  if (installed.code !== 0) {
    io.output.write(`Slack app install did not succeed: ${installed.stderr.trim() || "you can install it from the app page instead"}.\n`);
  } else if (installed.stdout.trim() || installed.stderr.trim()) {
    io.output.write(`${installed.stdout.trim()}\n`);
  }

  io.output.write("\nLast step in the browser: generate an app-level token and copy the bot token.\n");
  if (appId) {
    io.output.write(`  App-level token: https://api.slack.com/apps/${appId}/app-level-tokens\n`);
    io.output.write(`  Bot token:       https://api.slack.com/apps/${appId}/oauth\n`);
    if (io.input.isTTY) await openUrl(`https://api.slack.com/apps/${appId}/app-level-tokens`).catch(() => undefined);
  } else {
    io.output.write("  Open https://api.slack.com/apps, pick the app you just created, and locate its token pages.\n");
  }

  const slackAppToken = await askSecret("Slack app token (xapp-, input hidden): ", "App token");
  const slackBotToken = await askSecret("Slack bot token (xoxb-, input hidden): ", "Bot token");
  return { slackAppToken, slackBotToken };
}

async function setupSlackViaBrowser({ botName, io, askSecret }) {
  const manifestUrl = createManifestUrl(createManifest(botName));
  io.output.write("\nOpening Slack with your app configuration...\n");
  if (io.input.isTTY) await openUrl(manifestUrl).catch(() => undefined);
  io.output.write(`\nIf Slack did not open, use this link:\n${manifestUrl}\n\n`);
  io.output.write("If Slack shows a sign-in page or workspace picker instead of the app preview:\n  1. Sign in or pick a workspace.\n  2. Use the link above again.\n  3. If the preview is still empty, create the app from the saved manifest file at:\n     ~/.pipa/slack-manifest.json\n\n");
  io.output.write("In Slack:\n1. Choose your workspace, review the configuration, and create the app.\n2. Under Basic Information, generate an app-level token with connections:write.\n3. Under OAuth & Permissions, install the app and copy its Bot User OAuth Token.\n\n");
  const slackAppToken = await askSecret("Slack app token (xapp-, input hidden): ", "App token");
  const slackBotToken = await askSecret("Slack bot token (xoxb-, input hidden): ", "Bot token");
  return { slackAppToken, slackBotToken };
}

async function slackLogin(io) {
  for (const args of [["login"], ["auth", "login"]]) {
    io.output.write("\nSigning into Slack. Your browser will open and redirect you back automatically.\n");
    const code = await runInteractive("slack", args);
    if (code === 0) return true;
    io.output.write(`\nSlack sign-in did not complete${args[0] === "auth" ? " (exit code " + code + ")." : "; trying the newer command..."}\n`);
  }
  return false;
}

async function tryLoadConfig() {
  try {
    return await loadConfig();
  } catch {
    return null;
  }
}

async function writeManifest(manifest) {
  await mkdir(pipaPaths().directory, { recursive: true, mode: 0o700 });
  await writeFile(pipaPaths().manifest, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function parseAppId(output) {
  const text = String(output);
  const match = text.match(/(?:apps\/)(A[A-Z0-9]{6,})/u) || text.match(/\bapp\s+id[:\s]+\b(A[A-Z0-9]{6,})\b/iu);
  return match ? match[1] : null;
}

async function slackCliVersion() {
  const result = await runSecondary("slack", ["--version"]);
  return result.code === 0 ? (result.stdout.trim() || result.stderr.trim() || "unknown") : null;
}

function runSecondary(command, args) {
  return new Promise((resolve) => {
    const child = crossSpawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", (error) => resolve({ code: -1, stdout, stderr: error.message }));
    child.once("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function runInteractive(command, args) {
  return new Promise((resolve) => {
    const child = crossSpawn(command, args, { stdio: "inherit" });
    child.once("error", () => resolve(1));
    child.once("close", (code) => resolve(code ?? 1));
  });
}

async function confirm(prompt, output, question, defaultYes = true) {
  const hint = defaultYes ? "[Y/n]" : "[y/N]";
  while (true) {
    const answer = (await prompt.question(`${question} ${hint}: `)).trim().toLowerCase();
    if (!answer) return defaultYes;
    if (answer === "y" || answer === "yes") return true;
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