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

  const home = path.join(directory, "home");
  const workingDirectory = path.join(directory, "work");
  const fakeBin = path.join(directory, "fake-bin");
  await Promise.all([
    writeFile(path.join(directory, "fetch-mock.mjs"), "globalThis.fetch = async () => ({ ok: true, json: async () => ({ ok: true }) });\n"),
    mkdir(home),
    mkdir(workingDirectory),
    mkdir(fakeBin),
  ]);
  const fakeOpenCode = path.join(fakeBin, process.platform === "win32" ? "opencode.cmd" : "opencode");
  await writeFile(fakeOpenCode, process.platform === "win32" ? "@ECHO 1.0.0\r\n" : "#!/bin/sh\necho 1.0.0\n");
  if (process.platform !== "win32") await chmod(fakeOpenCode, 0o755);

  const installedCli = path.join(directory, "install", "node_modules", "@usepipa", "pipa", "bin", "pipa.mjs");
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
  process.stdout.write(`Packed CLI ${stdout.trim()} installed, initialized, and ran successfully.\n`);
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
