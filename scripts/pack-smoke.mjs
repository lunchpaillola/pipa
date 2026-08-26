import crossSpawn from "cross-spawn";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directory = await mkdtemp(path.join(os.tmpdir(), "pipa-pack-"));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const filename = `${packageJson.name.replace("@", "").replace("/", "-")}-${packageJson.version}.tgz`;
try {
  await run("npm", ["pack", "--pack-destination", directory]);
  await run("npm", ["install", "--ignore-scripts", "--prefix", path.join(directory, "install"), path.join(directory, filename)]);

  const bin = await realpath(path.join(directory, "install", "node_modules", ".bin", process.platform === "win32" ? "pipa.cmd" : "pipa"));
  const command = process.platform === "win32" ? bin : process.execPath;
  const args = process.platform === "win32" ? ["--version"] : [bin, "--version"];
  const { stdout } = await run(command, args);
  if (stdout.trim() !== packageJson.version) throw new Error(`Packed CLI returned ${JSON.stringify(stdout.trim())}.`);

  const installedRoot = path.join(directory, "install", "node_modules", "@usepipa", "pipa");
  const { createOpenCodeExecutor } = await import(pathToFileURL(path.join(installedRoot, "src", "opencode.mjs")).href);
  let prompted = false;
  const executor = createOpenCodeExecutor({
    baseUrl: "http://127.0.0.1:54321",
    pollIntervalMs: 1,
    fetch: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/event") return new Response('data: {"type":"session.idle","properties":{"sessionID":"ses_pack"}}\n\n');
      if (pathname === "/session/ses_pack/prompt_async") {
        prompted = true;
        return new Response(null, { status: 204 });
      }
      if (pathname === "/session/ses_pack/message") {
        const messages = prompted ? [{ info: { id: "msg_pack", role: "assistant" }, parts: [{ type: "text", text: "packed-native-ok" }] }] : [];
        return new Response(JSON.stringify(messages));
      }
      if (pathname === "/session/status") return new Response(JSON.stringify({ ses_pack: { type: "idle" } }));
      throw new Error(`Unexpected packed native request: ${init.method ?? "GET"} ${url}`);
    },
  });
  const nativeResult = await executor.runTurn({ prompt: "hello", sessionId: "ses_pack", workingDirectory: directory });
  if (nativeResult.text !== "packed-native-ok") throw new Error("Packed native OpenCode executor failed.");

  const home = path.join(directory, "home");
  const workingDirectory = path.join(directory, "work");
  const fakeBin = path.join(directory, "fake-bin");
  await Promise.all([
    writeFile(path.join(directory, "fetch-mock.mjs"), "globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });\n"),
    mkdir(home),
    mkdir(workingDirectory),
    mkdir(fakeBin),
  ]);
  const fakeScript = path.join(fakeBin, "fake-opencode.cjs");
  await writeFile(fakeScript, `
const fs = require("node:fs");
if (process.argv[2] === "--version") {
  console.log("1.0.0");
} else {
  const expectedArgs = ["serve", "--hostname", "127.0.0.1", "--port", "4096", "--log-level", "ERROR"];
  const environmentKeys = ["OPENCODE_DB", "OPENCODE_CONFIG_CONTENT", "PIPA_API_BASE_URL", "PIPA_EXECUTION_SECRET", "COMPOSIO_API_KEY", "OPENAI_API_KEY"];
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expectedArgs)) throw new Error("Unexpected Managed OpenCode arguments.");
  if (process.cwd() !== process.env.EXPECTED_CWD) throw new Error("Unexpected Managed OpenCode working directory.");
  if (environmentKeys.some((key) => process.env[key] !== "pack-sentinel")) throw new Error("Managed OpenCode environment was not inherited.");
  fs.writeFileSync(process.env.ASSERT_FILE, "managed-ok");
  process.exitCode = 23;
}
`);
  const fakeOpenCode = path.join(fakeBin, process.platform === "win32" ? "opencode.cmd" : "opencode");
  await writeFile(fakeOpenCode, process.platform === "win32"
    ? `@ECHO off\r\n"${process.execPath}" "%~dp0fake-opencode.cjs" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-opencode.cjs" "$@"\n`);
  if (process.platform !== "win32") await chmod(fakeOpenCode, 0o755);

  const installedCli = path.join(installedRoot, "bin", "pipa.mjs");
  const init = await run(process.execPath, [installedCli, "init"], {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    PIPA_HOME: home,
    PIPA_BOT_NAME: "Pack Bot",
    PIPA_SLACK_APP_TOKEN: "xapp-test",
    PIPA_SLACK_BOT_TOKEN: "xoxb-test",
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(directory, "fetch-mock.mjs")).href}`,
    PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
  }, "", workingDirectory);
  if (init.stdout.includes("xapp-test") || init.stdout.includes("xoxb-test")) throw new Error("Packed init echoed Slack credentials.");
  if (init.stdout.includes("api.slack.com/apps?new_app=1")) throw new Error("Non-interactive init opened Slack setup.");
  const configText = await readFile(path.join(home, ".pipa", "config.json"), "utf8").catch((error) => {
    throw new Error(`Packed init did not write config: ${error.message}\nstdout:\n${init.stdout}\nstderr:\n${init.stderr}`);
  });
  const config = JSON.parse(configText);
  const manifest = JSON.parse(await readFile(path.join(home, ".pipa", "slack-manifest.json"), "utf8"));
  if (config.botName !== "Pack Bot" || config.workingDirectory !== await realpath(workingDirectory)) throw new Error("Packed init wrote invalid config.");
  if (manifest.display_information.name !== "Pack Bot") throw new Error("Packed init wrote invalid manifest.");

  const cancelledHome = path.join(directory, "cancelled-home");
  await mkdir(cancelledHome);
  const cancelled = await run(process.execPath, [installedCli, "init"], {
    ...process.env,
    PIPA_HOME: cancelledHome,
    PIPA_BOT_NAME: "Pack Bot",
  }, "n\n", workingDirectory);
  if (!cancelled.stdout.includes("Setup cancelled")) throw new Error("Interactive init did not explain cancellation.");
  if (await readFile(path.join(cancelledHome, ".pipa", "config.json"), "utf8").then(() => true, () => false)) {
    throw new Error("Cancelled init wrote config.");
  }

  const managedWorkingDirectory = await realpath(workingDirectory);
  const managedHome = path.join(directory, "managed-home");
  const managedConfigDirectory = path.join(managedHome, ".pipa");
  const assertionFile = path.join(directory, "managed-assertion.txt");
  await mkdir(managedConfigDirectory, { recursive: true });
  await writeFile(path.join(managedConfigDirectory, "config.json"), JSON.stringify({
    botName: "Managed Pack Bot",
    workingDirectory: managedWorkingDirectory,
    slackMode: "managed",
    openCodeHostname: "127.0.0.1",
    openCodePort: 4096,
  }));
  let managedError;
  try {
    await run(process.execPath, [installedCli, "start"], {
      ...process.env,
      PIPA_HOME: managedHome,
      PATH: `${fakeBin}${path.delimiter}${process.env.PATH}`,
      EXPECTED_CWD: managedWorkingDirectory,
      ASSERT_FILE: assertionFile,
      OPENCODE_DB: "pack-sentinel",
      OPENCODE_CONFIG_CONTENT: "pack-sentinel",
      PIPA_API_BASE_URL: "pack-sentinel",
      PIPA_EXECUTION_SECRET: "pack-sentinel",
      COMPOSIO_API_KEY: "pack-sentinel",
      OPENAI_API_KEY: "pack-sentinel",
    }, "", workingDirectory);
  } catch (error) {
    managedError = error;
  }
  if (await readFile(assertionFile, "utf8") !== "managed-ok") throw new Error("Packed Managed start did not run OpenCode.");
  if (!managedError?.message.includes("OpenCode server exited unexpectedly with code 23")) throw new Error("Packed Managed start did not propagate the OpenCode exit.");
  if (managedError.message.includes("pack-sentinel")) throw new Error("Packed Managed start exposed an environment secret.");
  process.stdout.write(`Packed CLI ${stdout.trim()} installed, ran native sessions, initialized, cancelled, and ran Managed start successfully.\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}

function run(command, args, environment, input, currentDirectory) {
  return new Promise((resolve, reject) => {
    const child = crossSpawn(command, args, { cwd: currentDirectory, env: environment ?? process.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `CLI exited ${code}`)));
    child.stdin.end(input ?? "");
  });
}
