import cp from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

const contextKey = Symbol.for("pipa.test.runtimeOwnership");
const launching = Symbol.for("pipa.test.ownedLaunch");
const originalSpawn = cp.spawn;
const moduleURL = new URL(import.meta.url);
moduleURL.search = "";

export function inheritedOwnership() { return globalThis[contextKey]; }

export function journal(context, record) {
  appendFileSync(path.join(context.base, "ownership.jsonl"), JSON.stringify({ ...record, root: context.root }) + "\n", { mode: 0o600 });
}

function validate(context) {
  if (realpathSync(context.base) !== context.base || realpathSync(context.root) !== context.root || readFileSync(path.join(context.base, "ownership.key"), "utf8") !== context.key
    || (context.root !== context.base && !context.root.startsWith(context.base + path.sep))) throw new Error("Invalid private ownership capability");
  return context;
}

function snapshot(phase) {
  if (process.platform === "win32") {
    const started = performance.now();
    const timeoutMs = 5000;
    const script = "$ErrorActionPreference='Stop'; [Console]::Error.WriteLine('PIPA_CIM_QUERY_STARTED'); @(Get-CimInstance Win32_Process | ForEach-Object { @{ pid=[int]$_.ProcessId; ppid=[int]$_.ParentProcessId; birth=$(if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o') } else { $null }); state='R' } }) | ConvertTo-Json -Compress";
    const result = cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
    if (result.error || result.status !== 0) {
      const diagnostic = {
        phase, stage: result.stderr?.includes("PIPA_CIM_QUERY_STARTED") ? "query" : "startup", elapsedMs: Math.round(performance.now() - started), timeoutMs,
        errorCode: result.error ? (["ETIMEDOUT", "ENOENT", "EACCES", "EPERM", "ENOBUFS"].includes(result.error.code) ? result.error.code : "OTHER") : null,
        status: Number.isInteger(result.status) ? result.status : null,
        signal: ["SIGTERM", "SIGKILL"].includes(result.signal) ? result.signal : null,
        stdoutBytes: Buffer.byteLength(result.stdout ?? ""), stderrBytes: Buffer.byteLength(result.stderr ?? ""),
      };
      throw Object.assign(new Error(`Cannot verify Windows process identities with CIM: ${JSON.stringify(diagnostic)}`), { code: "PIPA_TEST_WINDOWS_IDENTITY" });
    }
    let value;
    try { value = JSON.parse(result.stdout.replace(/^\uFEFF/u, "")); }
    catch { throw new Error("Invalid Windows process identity snapshot"); }
    const rows = Array.isArray(value) ? value : [value];
    if (!rows.every((item) => item && Number.isSafeInteger(item.pid) && Number.isSafeInteger(item.ppid) && (item.birth === null || Number.isFinite(Date.parse(item.birth))))) throw new Error("Invalid Windows process identity snapshot");
    return rows;
  }
  const result = cp.spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,stat=,lstart="], { encoding: "utf8", timeout: 2000 });
  if (result.error || result.status !== 0) throw new Error("Cannot verify owned process identities");
  return result.stdout.trim().split("\n").filter(Boolean).map((line) => {
    const [pid, ppid, group, state, ...birth] = line.trim().split(/\s+/u);
    return { pid: Number(pid), ppid: Number(ppid), group: Number(group), state, birth: birth.join(" ") };
  });
}

// ParentProcessId alone is stale after exit/reuse. An exited parent's children
// must predate its recorded exit; surviving witnesses retain their own births.
export function windowsTree(live, seeds, exitedAt) {
  const members = [];
  const pending = [...seeds];
  const seen = new Set();
  while (pending.length) {
    const parent = pending.pop();
    if (seen.has(parent.pid)) continue;
    seen.add(parent.pid);
    const current = live.find((item) => item.pid === parent.pid);
    if (!Number.isFinite(Date.parse(parent.birth))) throw new Error("Cannot prove Windows process creation identity");
    if (current && current.birth !== parent.birth) throw new Error("Owned PID identity changed; refusing to signal reused PID");
    if (current) members.push(current);
    for (const child of live.filter((item) => item.ppid === parent.pid && item.pid !== parent.pid)) {
      if (!Number.isFinite(Date.parse(child.birth))) throw new Error("Cannot prove Windows descendant creation identity");
      if (Date.parse(child.birth) < Date.parse(parent.birth)) throw new Error("Windows parent PID has an older unowned child; refusing taskkill tree");
      if (!current && (!exitedAt || Date.parse(child.birth) > exitedAt)) throw new Error("Exited Windows parent has an unproven descendant identity");
      pending.push(child);
    }
  }
  return members;
}

export function launchOwned(launch, command, args, options, context) {
  validate(context);
  const id = randomUUID();
  // An interrupted spawn/identity capture is evidence of uncertainty, never PASS.
  journal(context, { kind: "intent", id });
  const childOptions = { ...options, [launching]: true };
  let childArgs = args;
  if (path.resolve(command) === process.execPath) {
    const preload = new URL(moduleURL);
    preload.searchParams.set("ownership", JSON.stringify({ ...context, launchId: id, detached: Boolean(options.detached) }));
    childArgs = ["--import", preload.href, ...args];
  }
  const child = launch(command, childArgs, childOptions);
  if (!child.pid) { journal(context, { kind: "empty", id }); return child; }
  const initial = snapshot("launch");
  const identity = initial.find((item) => item.pid === child.pid);
  if (!identity) {
    // A fast-exiting leader may already have left descendants: retain uncertainty.
    const registered = readFileSync(path.join(context.base, "ownership.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse).some((item) => item.kind === "process" && item.id === id);
    if (!registered) journal(context, { kind: "unproven", id, pid: child.pid });
  } else {
    journal(context, { kind: "process", id, ...identity, detached: Boolean(options.detached) });
    if (process.platform === "win32") journal(context, { kind: "witness", id, members: windowsTree(initial, [identity]) });
    if (options.detached || process.platform === "win32") child.once("exit", () => {
      const exitedAt = Date.now();
      try {
        const live = snapshot("exit");
        journal(context, { kind: "witness", id, exitedAt, members: process.platform === "win32" ? windowsTree(live, [identity], exitedAt) : live.filter((item) => item.group === child.pid) });
      }
      catch {
        // The supervisor may already have verified death and removed the journal.
        try { journal(context, { kind: "unproven", id, pid: child.pid }); } catch {}
      }
    });
  }
  return child;
}

export async function stopOwned(context, timeoutMs) {
  validate(context);
  const deadline = Date.now() + timeoutMs;
  const records = () => readFileSync(path.join(context.base, "ownership.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(JSON.parse)
    .filter((item) => item.root === context.root || item.root.startsWith(context.root + path.sep));
  const signal = (pid, value) => { try { process.kill(pid, value); } catch (error) { if (error.code !== "ESRCH") throw error; } };
  while (true) {
    const entries = records();
    const uncertain = entries.some((item) => item.kind === "unproven") || entries.some((item) => item.kind === "intent" && !entries.some((end) => end.id === item.id && end.kind !== "intent"));
    const processes = [...new Map(entries.filter((item) => item.kind === "process" && !entries.some((end) => end.kind === "dead" && end.id === item.id)).map((item) => [item.id, item])).values()];
    if (!processes.length) {
      if (uncertain) throw new Error("Owned process tree identity could not be proven; roots retained");
      return;
    }
    const live = snapshot("cleanup");
    let remaining = false;
    for (const owned of processes) {
      const leader = live.find((item) => item.pid === owned.pid);
      if (leader && leader.birth !== owned.birth) throw new Error("Owned PID identity changed; refusing to signal reused PID");
      if (process.platform === "win32") {
        const observations = entries.filter((item) => item.kind === "witness" && item.id === owned.id);
        const witnesses = observations.flatMap((item) => item.members);
        const exitedAt = Math.max(0, ...observations.map((item) => item.exitedAt ?? 0));
        const members = windowsTree(live, [owned, ...witnesses], exitedAt);
        if (!members.length) {
          journal({ ...context, root: owned.root }, { kind: "dead", id: owned.id });
          continue;
        }
        journal({ ...context, root: owned.root }, { kind: "witness", id: owned.id, exitedAt: leader ? undefined : exitedAt || undefined, members });
        remaining = true;
        // One PowerShell session avoids paying its startup cost per descendant.
        // Recheck each creation identity immediately before invoking taskkill.
        const targets = Buffer.from(JSON.stringify(members.reverse().map(({ pid, birth }) => ({ pid, birth })))).toString("base64");
        const script = `$ErrorActionPreference='Stop'; $taskkill = Join-Path $env:SystemRoot 'System32/taskkill.exe'; $targets = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${targets}')) | ConvertFrom-Json; foreach ($target in $targets) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $target.pid); if ($null -eq $p) { continue }; if ($null -eq $p.CreationDate -or $p.CreationDate.ToUniversalTime().ToString('o') -cne $target.birth) { throw 'Owned PID identity changed; refusing to signal reused PID' }; & $taskkill /PID $target.pid /T /F | Out-Null; if ($LASTEXITCODE -ne 0) { $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $target.pid); if ($null -ne $p -and $p.CreationDate.ToUniversalTime().ToString('o') -ceq $target.birth) { throw 'taskkill failed to stop owned process tree' } } }`;
        const result = cp.spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8", timeout: Math.max(1, deadline - Date.now()), windowsHide: true });
        if (result.error || result.status !== 0) throw new Error(`Windows owned process-tree termination failed: ${result.error?.message ?? result.stderr.trim()}`);
        continue;
      }
      const members = owned.detached ? live.filter((item) => item.group === owned.pid) : live.filter((item) => item.pid === owned.pid);
      if (!members.some((item) => !item.state.startsWith("Z"))) {
        journal({ ...context, root: owned.root }, { kind: "dead", id: owned.id });
        continue;
      }
      if (owned.detached && !leader) {
        const witnesses = [...processes.filter((item) => item.group === owned.pid), ...entries.filter((item) => item.kind === "witness" && item.id === owned.id).flatMap((item) => item.members)];
        if (!members.some((member) => witnesses.some((witness) => witness.pid === member.pid && witness.birth === member.birth))) {
          throw new Error("Exited leader has no surviving group identity witness; refusing to signal an unproven group");
        }
      }
      if (owned.detached) journal({ ...context, root: owned.root }, { kind: "witness", id: owned.id, members });
      remaining = true;
      signal(owned.detached ? -owned.pid : owned.pid, "SIGKILL");
    }
    if (!remaining) {
      if (uncertain) throw new Error("Owned process tree identity could not be proven; roots retained");
      return;
    }
    if (Date.now() >= deadline) throw new Error("Owned process tree is still alive; roots retained");
    await delay(20);
  }
}

const supplied = new URL(import.meta.url).searchParams.get("ownership");
if (supplied) {
  try {
    const context = validate(JSON.parse(supplied));
    globalThis[contextKey] = context;
    if (process.platform === "win32" && context.launchId) {
      const identity = snapshot("preload").find((item) => item.pid === process.pid);
      if (!identity?.birth) throw new Error("Cannot register Windows worker creation identity");
      journal(context, { kind: "process", id: context.launchId, ...identity, detached: context.detached });
      process.once("exit", () => {
        const exitedAt = Date.now();
        try { journal(context, { kind: "witness", id: context.launchId, exitedAt, members: windowsTree(snapshot("exit"), [identity], exitedAt) }); }
        catch { try { journal(context, { kind: "unproven", id: context.launchId, pid: process.pid }); } catch {} }
      });
    }
    cp.spawn = (command, args = [], options = {}) => {
      if (args && typeof args === "object" && !Array.isArray(args)) { options = args; args = []; }
      return options[launching]
        ? originalSpawn(command, args, options)
        : launchOwned(originalSpawn, command, args, options, options.env?.PIPA_TEST_OWNERSHIP ? validate(JSON.parse(options.env.PIPA_TEST_OWNERSHIP)) : context);
    };
    syncBuiltinESMExports();
  } catch (error) {
    // An uncaught preload error prints its URL, including the private capability.
    process.stderr.write(error.code === "PIPA_TEST_WINDOWS_IDENTITY" ? `${error.message}\n` : "Ownership preload initialization failed.\n");
    process.exit(1);
  }
}
