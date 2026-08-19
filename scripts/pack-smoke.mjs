import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const directory = await mkdtemp(path.join(os.tmpdir(), "pipa-pack-"));
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const filename = `${packageJson.name.replace("@", "").replace("/", "-")}-${packageJson.version}.tgz`;
try {
  await exec("npm", ["pack", "--pack-destination", directory]);
  await exec("npm", ["install", "--ignore-scripts", "--prefix", path.join(directory, "install"), path.join(directory, filename)]);

  const bin = await realpath(path.join(directory, "install", "node_modules", ".bin", process.platform === "win32" ? "pipa.cmd" : "pipa"));
  const command = process.platform === "win32" ? process.env.ComSpec ?? "cmd.exe" : process.execPath;
  const args = process.platform === "win32" ? ["/d", "/s", "/c", `"${bin}" --version`] : [bin, "--version"];
  const { stdout } = await exec(command, args);
  if (stdout.trim() !== packageJson.version) throw new Error(`Packed CLI returned ${JSON.stringify(stdout.trim())}.`);
  process.stdout.write(`Packed CLI ${stdout.trim()} installed and ran successfully.\n`);
} finally {
  await rm(directory, { recursive: true, force: true });
}
