import { chmod, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { createServer } from "node:net";
import { pathToFileURL } from "node:url";
import { createRuntimeFixture } from "../test/helpers/runtime-fixture.mjs";

const runtime = await createRuntimeFixture({ timeoutMs: 120000 });
const directory = runtime.root;
runtime.env.npm_config_cache = path.join(runtime.cache, "npm");
runtime.env.npm_config_userconfig = path.join(runtime.config, "npmrc");
await writeFile(runtime.env.npm_config_userconfig, "");
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
  const packedRuntime = await import(pathToFileURL(path.join(installedRoot, "src", "opencode.mjs")).href);
  if (typeof packedRuntime.createOpenCodeExecutor !== "function") throw new Error("Packed OpenCode executor is unavailable.");
  for (const [file, name] of [["opencode-v1.mjs", "createV1Adapter"], ["opencode-v2.mjs", "createV2Adapter"]]) {
    const adapter = await import(pathToFileURL(path.join(installedRoot, "src", file)).href);
    if (typeof adapter[name] !== "function") throw new Error(`Packed ${file} is unavailable.`);
  }
  const packedRestart = await import(pathToFileURL(path.join(installedRoot, "src", "restart.mjs")).href);
  if (typeof packedRestart.startRestartWatcher !== "function" || typeof packedRestart.runRestartWorker !== "function") throw new Error("Packed restart worker is unavailable.");
  const installedCli = path.join(installedRoot, "bin", "pipa.mjs");

  for (const version of ["1.19.0", "2.0.29"]) await smoke(version, installedCli, stdout.trim());
} finally {
  await runtime.teardown();
}

async function smoke(version, installedCli, pipaVersion) {
  const directory = path.join(runtime.root, version);
  await mkdir(directory);
  const home = path.join(directory, "home");
  const workingDirectory = path.join(directory, "work");
  const fakeBin = path.join(directory, "fake-bin");
  await Promise.all([
    writeFile(path.join(directory, "fetch-mock.mjs"), "globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });\n"),
    mkdir(home),
    mkdir(workingDirectory),
    mkdir(fakeBin),
  ]);
  const reservation = createServer();
  await new Promise((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const managedPort = reservation.address().port;
  await new Promise((resolve) => reservation.close(resolve));
  const fakeScript = path.join(fakeBin, "fake-opencode.cjs");
  await writeFile(fakeScript, `
const fs = require("node:fs");
if (process.argv[2] === "--version") {
  console.log(${JSON.stringify(version)});
} else {
  const expectedArgs = ["serve", "--hostname", "127.0.0.1", "--port", ${JSON.stringify(String(managedPort))}, "--log-level", ${JSON.stringify(version.startsWith("1.") ? "ERROR" : "error")}];
  const environmentKeys = ["OPENCODE_DB", "OPENCODE_CONFIG_CONTENT", "PIPA_API_BASE_URL", "PIPA_EXECUTION_SECRET", "COMPOSIO_API_KEY", "OPENAI_API_KEY"];
  if (JSON.stringify(process.argv.slice(2)) !== JSON.stringify(expectedArgs)) throw new Error("Unexpected Managed OpenCode arguments.");
  if (process.cwd() !== process.env.EXPECTED_CWD) throw new Error("Unexpected Managed OpenCode working directory.");
  if (environmentKeys.some((key) => process.env[key] !== "pack-sentinel")) throw new Error("Managed OpenCode environment was not inherited.");
  if (process.env.PIPA_SLACK_BOT_TOKEN || process.env.Slack_Client_Secret) throw new Error("Slack secret reached Managed OpenCode.");
  fs.writeFileSync(process.env.ASSERT_FILE, "managed-ok");
  process.exitCode = 23;
}
`);
  const fakeOpenCode = path.join(fakeBin, process.platform === "win32" ? "opencode.cmd" : "opencode");
  await writeFile(fakeOpenCode, process.platform === "win32"
    ? `@ECHO off\r\n"${process.execPath}" "%~dp0fake-opencode.cjs" %*\r\n`
    : `#!/bin/sh\nexec "${process.execPath}" "$(dirname "$0")/fake-opencode.cjs" "$@"\n`);
  if (process.platform !== "win32") await chmod(fakeOpenCode, 0o755);

  const init = await run(process.execPath, [installedCli, "init"], {
    ...runtime.env,
    HOME: home,
    USERPROFILE: home,
    PIPA_HOME: home,
    PIPA_BOT_NAME: "Pack Bot",
    PIPA_SLACK_APP_TOKEN: "xapp-test",
    PIPA_SLACK_BOT_TOKEN: "xoxb-test",
    PIPA_ALLOWED_CHANNEL_IDS: "",
    PIPA_ALLOWED_USER_IDS: "",
    PIPA_ALLOWED_BOT_IDS: "",
    NODE_OPTIONS: `--import=${pathToFileURL(path.join(directory, "fetch-mock.mjs")).href}`,
    PATH: `${fakeBin}${path.delimiter}${runtime.env.PATH}`,
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
  if (!["channels:read", "assistant:write"].every((scope) => manifest.oauth_config.scopes.bot.includes(scope))) throw new Error("Packed init wrote incomplete Slack bot scopes.");

  const preview = await run(process.execPath, [installedCli, "routine", "create", "--prompt", "Pack preview", "--timezone", "America/New_York", "--channel", "C123", "--every", "1d", "--times", "05:00", "--preview", "--json"], {
    ...runtime.env,
    PIPA_HOME: home,
  }, "", workingDirectory);
  const previewJson = JSON.parse(preview.stdout);
  if (!previewJson.ok || !previewJson.preview || previewJson.routine.schedule.frequency !== "daily" || previewJson.routine.schedule.times[0] !== "05:00") {
    throw new Error("Packed routine preview returned invalid normalized JSON.");
  }
  if (await readFile(path.join(home, ".pipa", "routines.json"), "utf8").then(() => true, () => false)) throw new Error("Packed routine preview mutated state.");

  const cancelledHome = path.join(directory, "cancelled-home");
  await mkdir(cancelledHome);
  const restartHelp = await run(process.execPath, [installedCli, "restart", "--help"], { ...runtime.env, PIPA_HOME: cancelledHome });
  if (!restartHelp.stdout.includes("pipa restart [--status]")) throw new Error("Packed restart help is unavailable.");
  const restartStatus = await run(process.execPath, [installedCli, "restart", "--status"], { ...runtime.env, PIPA_HOME: cancelledHome });
  if (!restartStatus.stdout.includes("No restart requested")) throw new Error("Packed restart status is unavailable.");
  if (await readFile(path.join(cancelledHome, ".pipa", "pipa.lock"), "utf8").then(() => true, () => false)) throw new Error("Packed restart status mutated state.");
  const cancelled = await run(process.execPath, [installedCli, "init"], {
    ...runtime.env,
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
    openCodePort: managedPort,
  }));
  let managedError;
  try {
    await run(process.execPath, [installedCli, "start"], {
      ...runtime.env,
      PIPA_HOME: managedHome,
      PATH: `${fakeBin}${path.delimiter}${runtime.env.PATH}`,
      EXPECTED_CWD: managedWorkingDirectory,
      ASSERT_FILE: assertionFile,
      OPENCODE_DB: "pack-sentinel",
      OPENCODE_CONFIG_CONTENT: "pack-sentinel",
      PIPA_API_BASE_URL: "pack-sentinel",
      PIPA_EXECUTION_SECRET: "pack-sentinel",
      COMPOSIO_API_KEY: "pack-sentinel",
      OPENAI_API_KEY: "pack-sentinel",
      PIPA_SLACK_BOT_TOKEN: "xoxb-forbidden-child-marker",
      Slack_Client_Secret: "forbidden-child-marker",
    }, "", workingDirectory);
  } catch (error) {
    managedError = error;
  }
  const managedAssertion = await readFile(assertionFile, "utf8").catch((error) => {
    throw new Error(`Packed Managed start did not run OpenCode: ${managedError?.message ?? error.message}`, { cause: managedError ?? error });
  });
  if (managedAssertion !== "managed-ok") throw new Error("Packed Managed start did not run OpenCode.");
  if (!managedError?.message.includes("OpenCode server exited unexpectedly with code 23")) throw new Error("Packed Managed start did not propagate the OpenCode exit.");
  if (managedError.message.includes("pack-sentinel")) throw new Error("Packed Managed start exposed an environment secret.");
  process.stdout.write(`Packed CLI ${pipaVersion} loaded both adapters/client, previewed a routine, initialized, cancelled, and ran Managed start with native ${version} contract.\n`);
}

function run(command, args, environment, input, currentDirectory) {
  return new Promise((resolve, reject) => {
    const { child } = runtime.spawn(command, args, { cwd: currentDirectory ?? process.cwd(), env: environment ?? runtime.env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => stdout += chunk);
    child.stderr.on("data", (chunk) => stderr += chunk);
    child.once("error", reject);
    child.once("close", (code) => code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `CLI exited ${code}`)));
    child.stdin.end(input ?? "");
  });
}
