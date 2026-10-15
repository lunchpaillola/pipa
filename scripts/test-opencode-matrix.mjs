import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile, symlink, chmod } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRuntimeFixture, bounded } from "../test/helpers/runtime-fixture.mjs";
import { releaseCases, runCell } from "./verification/opencode-release-cases.mjs";

export const PINS = ["1.18.35", "1.19.0", "2.0.29"];
export const MODES = ["socket-owned", "attached", "managed"];
export const CELL_WORKER_TIMEOUT_MS = 9 * 60_000;
const self = fileURLToPath(import.meta.url);
const repo = fileURLToPath(new URL("../", import.meta.url));

// npm 10 emits pack arrays; newer npm emits records keyed by package name.
function npmSingle(text) {
  const value = JSON.parse(text);
  const rows = Array.isArray(value) ? value : value.version ? [value] : Object.values(value);
  assert.equal(rows.length, 1, "Expected one pinned npm package");
  return rows[0];
}

export function assertPin(output, pin) {
  assert.ok(PINS.includes(pin), "Unqualified engine pin");
  assert.match(output.trim(), new RegExp(`^(?:OpenCode\\s+)?v?${pin.replaceAll(".", "\\.")}$`, "iu"), "Executable version does not match exact pin");
}

export function compatibilityExit(rows) {
  for (const row of rows) assert.ok(["PASS", "FAIL", "BLOCKED", "NOT_APPLICABLE"].includes(row.status), "Invalid evidence status");
  return !rows.length || rows.some((row) => row.status === "FAIL" || row.status === "BLOCKED") ? 1 : 0;
}

// Select from catalog metadata, never observed reason text. Keep evidence intact;
// missing requirements are gate entries, not fabricated collection results.
export function selectGate(report, { gate = "deterministic", pins = PINS, modes = MODES } = {}) {
  assert.ok(["deterministic", "release"].includes(gate), "Unknown gate");
  assert.ok(pins.length && pins.every((pin) => PINS.includes(pin)), "Unknown gate pins");
  assert.ok(modes.length && modes.every((mode) => MODES.includes(mode)), "Unknown gate modes");
  const included = [];
  const excluded = [];
  const add = (identity, row, reason, exclude = false) => {
    if (row) compatibilityExit([row]);
    (exclude ? excluded : included).push({ ...identity, status: row?.status ?? "BLOCKED", reason: row ? reason : `Missing ${exclude ? "excluded" : "required"} evidence; ${reason}`, missing: !row });
  };
  for (const engine of pins) for (const mode of modes) {
    const cells = (report.cells ?? []).filter((cell) => cell.engine === engine && cell.mode === mode);
    const identity = { engine, mode };
    if (cells.length !== 1) add({ ...identity, id: "cell" }, null, `Expected one cell, found ${cells.length}`);
    const cell = cells[0];
    const rows = cell?.cases ?? [];
    for (const definition of releaseCases) {
      const reasons = [];
      if (!definition.modes.includes(mode)) reasons.push(`Mode ${mode} outside applicable modes: ${definition.modes.join(", ")}`);
      if (!definition.generations.includes(engine.split(".")[0])) reasons.push(`Engine ${engine} outside applicable generations: ${definition.generations.join(", ")}`);
      if (gate === "deterministic" && definition.lane === "live") reasons.push("Live/deployment lane belongs to release gate");
      if (!definition.required) reasons.push("Catalog case is not required");
      const matches = rows.filter((row) => row.id === definition.id);
      if (matches.length > 1) add({ ...identity, id: definition.id }, null, "Duplicate evidence identity");
      add({ ...identity, id: definition.id, lane: definition.lane }, matches[0], reasons.join("; ") || `Required applicable ${definition.lane} case`, reasons.length > 0);
    }
    // Worker/preflight/cleanup diagnostics have no catalog exclusion authority.
    for (const row of rows.filter((row) => !releaseCases.some((definition) => definition.id === row.id))) add({ ...identity, id: row.id }, row, "Uncatalogued diagnostic is always gating");
    add({ ...identity, id: "cell-cleanup" }, cell?.cleanup, "Required owned-resource cleanup");
  }
  // Retain unexpected cells/rows too; they cannot conceal failed evidence.
  for (const cell of report.cells ?? []) if (!pins.includes(cell.engine) || !modes.includes(cell.mode)) {
    for (const row of cell.cases ?? []) add({ engine: cell.engine, mode: cell.mode, id: row.id }, row, "Unexpected cell is always gating");
    add({ engine: cell.engine, mode: cell.mode, id: "cell-cleanup" }, cell.cleanup, "Unexpected cell cleanup");
  }
  for (const row of report.cases ?? []) add({ id: row.id }, row, "Report diagnostic is always gating");
  add({ id: "report-cleanup" }, report.cleanup, "Required collection cleanup");
  for (const row of report.unobservedPlatforms ?? []) add({ id: "platform", platform: row.platform }, row, "Separate OS evidence required for release", gate === "deterministic");
  return { gate, included, excluded, exitCode: included.some((entry) => entry.status !== "PASS") ? 1 : 0 };
}

export async function recordCase(rows, definition, execute) {
  const start = Date.now();
  let result;
  try { result = { status: "PASS", observed: "All case assertions passed", ...await execute() }; }
  catch (error) { result = { status: "FAIL", observed: error.message }; }
  compatibilityExit([result]);
  assert.ok(result.status !== "NOT_APPLICABLE" || definition.native, "Common case cannot be NOT_APPLICABLE");
  if (["BLOCKED", "NOT_APPLICABLE"].includes(result.status)) assert.ok(result.observed, "Missing coverage reason");
  const row = { ...definition, ...result, ms: Date.now() - start };
  rows.push(row);
  return row;
}

export async function finishCell(cell, runtime) {
  try {
    await runtime.teardown();
    cell.cleanup = { status: "PASS", observed: "Owned resources closed; private root removed" };
  } catch (error) {
    cell.cleanup = { status: "FAIL", observed: [error.message, ...(error.errors ?? []).map((item) => item.message)].join("; "), retainedRoot: runtime.root };
    cell.cases.push({ id: "cleanup", status: "FAIL", expected: "All owned resources released", observed: cell.cleanup.observed });
  }
}

export async function command(runtime, executable, args, options = {}) {
  const { timeoutMs = 180_000, ...spawnOptions } = options;
  const { child, exited } = runtime.spawn(executable, args, spawnOptions);
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (data) => { stdout = (stdout + data).slice(-2 * 1024 * 1024); });
  child.stderr?.on("data", (data) => { stderr = (stderr + data).slice(-2 * 1024 * 1024); });
  const result = await bounded(exited, { timeoutMs, signal: runtime.signal, label: path.basename(executable) });
  assert.equal(result.code, 0, `${path.basename(executable)} exited ${result.code}: ${stderr || stdout}`);
  return stdout;
}

async function installEngine(runtime, pin) {
  assert.ok(["darwin", "linux", "win32"].includes(process.platform) && ["x64", "arm64"].includes(process.arch), "Native binary unsupported on this platform");
  const platform = process.platform === "win32" ? "windows" : process.platform;
  const name = pin.startsWith("2.") ? `@opencode/cli-${platform}-${process.arch}` : `opencode-${platform}-${process.arch}`;
  const directory = path.join(runtime.root, `engine-${pin}`);
  await mkdir(directory);
  const metadata = npmSingle(await command(runtime, "npm", ["view", `${name}@${pin}`, "--json", "--registry=https://registry.npmjs.org"], { cwd: directory }));
  assert.equal(metadata.version, pin, "Registry returned wrong version");
  assert.equal(metadata.name, name, "Registry returned wrong package");
  assert.match(metadata.dist.integrity, /^sha512-/u, "Missing package integrity");
  const packed = npmSingle(await command(runtime, "npm", ["pack", `${name}@${pin}`, "--ignore-scripts", "--json", "--registry=https://registry.npmjs.org"], { cwd: directory }));
  const tarball = path.join(directory, path.basename(packed.filename));
  const digest = `sha512-${createHash("sha512").update(await readFile(tarball)).digest("base64")}`;
  assert.equal(digest, metadata.dist.integrity, "Downloaded package integrity mismatch");
  await command(runtime, "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", directory, tarball]);
  const installed = path.join(directory, "node_modules", ...name.split("/"));
  const pkg = JSON.parse(await readFile(path.join(installed, "package.json"), "utf8"));
  assert.equal(pkg.version, pin, "Installed package has wrong pin");
  const binary = path.join(installed, "bin", process.platform === "win32" ? "opencode.exe" : "opencode");
  assertPin(await command(runtime, binary, ["--version"]), pin);
  const bin = path.join(directory, "selected-bin");
  await mkdir(bin);
  if (process.platform === "win32") await writeFile(path.join(bin, "opencode.cmd"), `@ECHO off\r\n"${binary}" %*\r\n`);
  else { await chmod(binary, 0o755); await symlink(binary, path.join(bin, "opencode")); }
  return { bin, binary, package: name, version: pin, integrity: digest };
}

async function main(argv) {
  const value = (flag) => argv.find((arg) => arg.startsWith(`${flag}=`))?.slice(flag.length + 1);
  for (const arg of argv) assert.ok(["--baseline", "--migration"].includes(arg) || ["--pins=", "--modes=", "--report=", "--gate="].some((flag) => arg.startsWith(flag)), `Unknown argument ${arg}`);
  const gate = value("--gate") ?? "deterministic";
  assert.ok(["deterministic", "release"].includes(gate), "Unknown gate");
  const pins = value("--pins")?.split(",") ?? PINS;
  const modes = value("--modes")?.split(",") ?? MODES;
  assert.ok(pins.length && pins.every((pin) => PINS.includes(pin)), "Only qualified exact engine pins are supported");
  assert.ok(modes.length && modes.every((mode) => MODES.includes(mode)), "Unknown mode");
  const runtime = await createRuntimeFixture({ timeoutMs: 30 * 60_000 });
  // npm configuration and its cache are private too; never consult ~/.npmrc.
  Object.assign(runtime.env, { npm_config_cache: path.join(runtime.cache, "npm"), npm_config_userconfig: path.join(runtime.config, "npmrc"), npm_config_registry: "https://registry.npmjs.org" });
  await writeFile(runtime.env.npm_config_userconfig, "");
  const reportPath = path.resolve(value("--report") ?? path.join(os.tmpdir(), `pipa-engines-${Date.now()}.json`));
  const pkg = JSON.parse(await readFile(path.join(repo, "package.json"), "utf8"));
  const report = { schema: "pipa-opencode-matrix/v1", gate, matrix: { pins, modes }, migrationRequested: argv.includes("--migration"), collection: argv.includes("--baseline") ? "pre-port-baseline" : "compatibility", releaseQualified: false, date: new Date().toISOString(), pipa: pkg.version, node: process.version, platform: process.platform, arch: process.arch, cells: [], cases: [] };
  report.unobservedPlatforms = ["linux", "darwin", "win32"].filter((platform) => platform !== process.platform).map((platform) => ({ platform, status: "BLOCKED", observed: "Not executed by this host; separate OS CI evidence required" }));
  try {
    const pack = npmSingle(await command(runtime, "npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", runtime.root], { cwd: repo }));
    const installed = path.join(runtime.root, "candidate");
    await command(runtime, "npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--prefix", installed, path.join(runtime.root, pack.filename)]);
    const candidate = path.join(installed, "node_modules", "@usepipa", "pipa");
    report.tarballIntegrity = pack.integrity;
    const engines = new Map();
    // Migration needs both verified source pins and the target before any cell.
    if (argv.includes("--migration")) for (const pin of PINS) {
      try { engines.set(pin, await installEngine(runtime, pin)); }
      catch (error) { engines.set(pin, { error }); }
    }
    for (const pin of pins) {
      let engine;
      try { engine = engines.get(pin) ?? await installEngine(runtime, pin); if (engine.error) throw engine.error; }
      catch (error) {
        for (const mode of modes) report.cells.push({ engine: pin, mode, pipa: pkg.version, platform: process.platform, arch: process.arch, cases: [{ id: "engine-preflight", status: "FAIL", observed: error.message }, ...releaseCases.map((row) => ({ ...row, status: "BLOCKED", observed: `Engine install/preflight failed: ${error.message}` }))], cleanup: { status: "PASS", observed: "No cell launched" } });
        continue;
      }
      for (const mode of modes) {
        const cellRuntime = await createRuntimeFixture({ timeoutMs: CELL_WORKER_TIMEOUT_MS + 60_000, parent: runtime });
        Object.assign(cellRuntime.env, { PATH: `${engine.bin}${path.delimiter}${cellRuntime.env.PATH}` });
        if (argv.includes("--migration")) cellRuntime.env.PIPA_MATRIX_ENGINE_BINARIES = JSON.stringify(Object.fromEntries([...engines].filter(([, engine]) => engine.binary).map(([pin, engine]) => [pin, engine.binary])));
        const output = path.join(cellRuntime.root, "cell.json");
        let cell;
        try {
          await command(cellRuntime, process.execPath, [self, "--cell", candidate, pin, mode, output, ...(argv.includes("--migration") ? ["--migration"] : [])], { timeoutMs: CELL_WORKER_TIMEOUT_MS });
          cell = JSON.parse(await readFile(output, "utf8"));
        } catch (error) {
          cell = { cases: releaseCases.map((row) => ({ ...row, status: "BLOCKED", observed: `Cell worker failed: ${error.message}` })) };
          cell.cases.push({ id: "worker", status: "FAIL", observed: error.message });
        }
        cell.engine = pin; cell.enginePackage = engine.package; cell.engineIntegrity = engine.integrity;
        cell.mode = mode; cell.pipa = pkg.version; cell.platform = process.platform; cell.arch = process.arch;
        for (const row of cell.cases) row.evidenceRef = `#/cells/${report.cells.length}/evidence`;
        const workerCleanup = cell.cleanup;
        await finishCell(cell, cellRuntime);
        if (workerCleanup?.status === "FAIL") cell.cleanup = workerCleanup;
        report.cells.push(cell);
        for (const row of cell.cases) process.stdout.write(`${pin} ${mode} ${row.id}: ${row.status} — ${row.observed.split("\n")[0]}\n`);
        await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
      }
    }
  } finally {
    await finishCell(report, runtime);
    report.gating = selectGate(report, { gate, pins, modes });
    report.exitCode = report.gating.exitCode;
    await writeFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
    process.stdout.write(`Report: ${reportPath}\n`);
  }
  process.exitCode = report.exitCode;
}

// Node's default discovery includes scripts/test-*.mjs. Import/runner discovery
// must remain inert; the explicit npm lane is the only download/engine entry.
if (!process.env.NODE_TEST_CONTEXT && process.argv[1] && path.resolve(process.argv[1]) === self) {
  if (process.argv[2] === "--cell") {
    const [, , , candidate, pin, mode, output] = process.argv;
    const cell = await runCell({ candidate, pin, mode, migration: process.argv.includes("--migration") });
    await writeFile(output, JSON.stringify(cell, null, 2), { mode: 0o600 });
  } else await main(process.argv.slice(2));
}
