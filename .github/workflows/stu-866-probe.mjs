import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import os from 'node:os';
import {mkdtemp, rm} from 'node:fs/promises';
import {acquireInstanceLock, stopInstance} from '../../src/state.mjs';
const root = process.env.SystemRoot;
const exe = path.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
const cmd = `$ErrorActionPreference = 'Stop'; (Get-Process -Id ${process.pid}).StartTime.ToUniversalTime().Ticks`;
const allow = (...names) => Object.fromEntries(names.flatMap(n=>process.env[n] ? [[n,process.env[n]]] : []));
for (const [label, env, command, timeout] of [
  ['original', {SystemRoot: root}, cmd, 5000],
  ['minimal-trivial', {SystemRoot: root}, '1', 5000],
  ['minimal-longer', {SystemRoot: root}, cmd, 20000],
  ['with-profile', allow('SystemRoot','USERPROFILE','APPDATA','LOCALAPPDATA','HOMEDRIVE','HOMEPATH'), cmd, 5000],
  ['with-path', allow('SystemRoot','PATH'), cmd, 5000],
  ['with-windir', allow('SystemRoot','windir'), cmd, 5000],
  ['with-temp', allow('SystemRoot','TEMP','TMP'), cmd, 5000],
  ['with-cache', allow('SystemRoot','PSModuleAnalysisCachePath'), cmd, 5000],
  ['dotnet', {SystemRoot: root}, `[Console]::WriteLine(([System.Diagnostics.Process]::GetProcessById(${process.pid})).StartTime.ToUniversalTime().Ticks)`, 5000],
  ['inherited', undefined, cmd, 5000],
]) {
  const t=performance.now();
  const r=spawnSync(exe,['-NoProfile','-NonInteractive','-Command',command],{encoding:'utf8',env,timeout,windowsHide:true});
  console.log(JSON.stringify({label, ms: Math.round(performance.now()-t), error:r.error?.code, status:r.status, signal:r.signal, output:r.stdout?.trim(), stderr:r.stderr?.slice(0,800)}));
}
const home=await mkdtemp(path.join(os.tmpdir(),'pipa-windows-birth-'));
const lock=path.join(home,'pipa.lock');
try {
  const release=await acquireInstanceLock(lock);
  console.log('Exact acquisition: PASS');
  console.log('Exact stop:', await stopInstance(lock) === process.pid ? 'PASS' : 'FAIL');
  await release();
} catch(e) {
  console.log('Exact lifecycle:', e.message);
} finally { await rm(home,{recursive:true,force:true}); }
