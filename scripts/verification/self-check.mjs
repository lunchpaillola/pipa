import assert from "node:assert/strict";
import test from "node:test";
import { access, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { createRuntimeFixture, waitFor, FIXTURE_TEARDOWN_TIMEOUT_MS } from "../../test/helpers/runtime-fixture.mjs";
import { assertTurnOutcome } from "../../test/helpers/opencode-contract.mjs";
import { assertPin, compatibilityExit, selectGate, recordCase, finishCell, CELL_WORKER_TIMEOUT_MS, PINS, MODES } from "../test-opencode-matrix.mjs";
import { observeRuntimeReadiness, observeNativeAdmissions, assertRestartRoutineAdmission, releaseCases, runCell } from "./opencode-release-cases.mjs";
import { checkOpenCodeConnection } from "../../src/opencode.mjs";
import { createWireFixture, loadWireFixture } from "../../test/helpers/opencode-contract.mjs";
import { createProvider } from "./opencode-provider.mjs";
import { command } from "../test-opencode-matrix.mjs";
import { fileURLToPath } from "node:url";
import { journal, windowsTree } from "../../test/helpers/runtime-ownership.mjs";

const facade = { checkOpenCodeConnection };

test("restarted native routine receipts reject trimmed/mutated prompt bytes and wrong attribution", async () => {
  const prompt = "  MATRIX_routine_nonce\nexact saved prompt  \n";
  for (const version of [1, 2]) {
    const admissions = [];
    const response = Response.json({}, { status: 202 });
    const observed = observeNativeAdmissions(async (request, init) => {
      assert.equal(await request.clone().text(), JSON.stringify(version === 1 ? { parts: [{ type: "text", text: prompt }] } : { text: prompt }));
      assert.equal(init, undefined);
      return response;
    }, admissions);
    const request = new Request(`http://127.0.0.1:4096/${version === 2 ? "api/" : ""}session/ses_routine/${version === 1 ? "prompt_async" : "prompt"}`, {
      method: "POST", headers: { authorization: "Basic private-marker" },
      body: JSON.stringify(version === 1 ? { parts: [{ type: "text", text: prompt }] } : { text: prompt }),
    });
    assert.equal(await observed(request), response, "Observer must return the real response unchanged");
    assert.doesNotMatch(JSON.stringify(admissions), /authorization|private-marker|127\.0\.0\.1/iu);
    const snapshot = { pid: 42, admissions };
    const expected = { pid: 42, prompt, marker: "MATRIX_routine_nonce", sessionId: "ses_routine" };
    assertRestartRoutineAdmission(snapshot, expected);
    for (const mutation of [prompt.trim(), prompt.replace("exact saved", "changed saved")]) {
      assert.throws(() => assertRestartRoutineAdmission({ ...snapshot, admissions: [{ ...admissions[0], prompt: mutation }] }, expected), /prompt/iu);
    }
    for (const mutate of [value => { value.pid = 99; }, value => { value.admissions[0].path = "/session/ses_other/prompt"; }, value => { value.admissions[0].status = 401; }, value => { value.admissions.push(value.admissions[0]); }]) {
      const changed = structuredClone(snapshot); mutate(changed);
      assert.throws(() => assertRestartRoutineAdmission(changed, expected));
    }
  }
});

test("wrong reported pin fails, including prefixed output", () => {
  assertPin("OpenCode 2.0.29", "2.0.29");
  assert.throws(() => assertPin("1.19.0", "1.18.35"));
  assert.throws(() => assertPin("2.0.29\n1.18.35", "2.0.29"));
});

test("native readiness observer validates generation, auth, migration and configured workspace", async () => {
  const runtime = await createRuntimeFixture();
  try {
    for (const generation of ["v1", "v2"]) {
      const document = await loadWireFixture(generation, runtime);
      const wire = createWireFixture(document);
      const identityPath = generation === "v1" ? "/global/health" : "/api/info";
      const calls = [];
      const connection = await observeRuntimeReadiness({ facade, baseUrl: "http://127.0.0.1:4096", workingDirectory: runtime.workspace, environment: { OPENCODE_SERVER_PASSWORD: "synthetic" }, pin: document.version,
        fetch: (url, init) => {
          calls.push({ path: new URL(url).pathname, authenticated: Boolean(init.headers?.authorization) });
          if (!init.headers?.authorization) return Promise.resolve(Response.json({}, { status: 401 }));
          return wire.fetch(url, init);
        },
      });
      assert.equal(connection.major, generation === "v1" ? 1 : 2);
      assert.equal(connection.workingDirectory, runtime.workspace);
      assert.deepEqual(calls.at(-1), { path: identityPath, authenticated: false });
    }
    const common = { facade, baseUrl: "http://127.0.0.1:4096", workingDirectory: runtime.workspace, environment: { OPENCODE_SERVER_PASSWORD: "synthetic" }, pin: "2.0.29", startupTimeoutMs: 20 };
    for (const defect of ["pin", "location", "migration", "unauthenticated", "HTML"]) {
      await assert.rejects(observeRuntimeReadiness({ ...common, fetch: async (url, init) => {
        const pathname = new URL(url).pathname;
        if (!init.headers?.authorization) return Response.json({}, { status: defect === "unauthenticated" ? 200 : 401 });
        if (pathname === "/global/health") return new Response("<html>");
        if (pathname === "/api/info") return defect === "HTML" ? new Response("<html>") : Response.json({ version: defect === "pin" ? "2.0.30" : "2.0.29", pid: 1, urls: [], paths: { tmp: runtime.temp } });
        if (pathname === "/api/experimental/migration/v1") return Response.json({ status: defect === "migration" ? "running" : "completed", progress: { label: "history" } });
        return Response.json({ directory: defect === "location" ? runtime.home : runtime.workspace, project: { id: "prj_test", directory: runtime.workspace, canonical: runtime.workspace } });
      } }), defect === "pin" ? /exact pin/u : defect === "location" ? /workspace identity mismatch/u : defect === "migration" ? /migration.*timed out/u : defect === "unauthenticated" ? /require authentication/u : /identity protocol/u);
    }
  } finally { await runtime.teardown(); }
});

const gateFixture = () => ({
  releaseQualified: false, cleanup: { status: "PASS" },
  cells: PINS.flatMap((engine) => MODES.map((mode) => ({ engine, mode, cleanup: { status: "PASS" },
    cases: releaseCases.map((definition) => ({ id: definition.id, status: definition.lane === "live" || !definition.modes.includes(mode) ? "BLOCKED" : !definition.generations.includes(engine.split(".")[0]) ? "NOT_APPLICABLE" : "PASS", observed: "fixture" })),
  }))),
  unobservedPlatforms: [{ platform: "linux", status: "BLOCKED", observed: "separate host required" }],
});

test("targeted cell diagnostics reject invalid selections and cannot qualify the full gate", async () => {
  for (const caseIds of [[], ["unknown"], ["startup-readiness", "startup-readiness"], "startup-readiness"]) await assert.rejects(runCell({ caseIds }), /Invalid targeted case selection/u);
  const report = gateFixture();
  report.cells[0].collection = "targeted-diagnostic";
  report.cells[0].caseSelection = ["startup-readiness", "stop-ownership"];
  report.cells[0].cases = report.cells[0].cases.filter((row) => report.cells[0].caseSelection.includes(row.id));
  assert.equal(selectGate(report).exitCode, 1, "Missing turn/recovery cases must remain gating");
});

test("declarative gates select applicable cases across every mode and generation without mutating evidence", () => {
  const report = gateFixture();
  const before = JSON.stringify(report);
  const selected = selectGate(report);
  assert.equal(selected.gate, "deterministic");
  assert.equal(selected.exitCode, 0);
  for (const engine of PINS) {
    for (const id of ["chat-continuation", "questions-permissions-tools", "routine-once", "reconnect-stream", "socket-fixture-restart"]) {
      assert.ok(selected.excluded.some((entry) => entry.engine === engine && entry.mode === "managed" && entry.id === id));
      for (const mode of ["socket-owned", "attached"]) assert.ok(selected.included.some((entry) => entry.engine === engine && entry.mode === mode && entry.id === id));
    }
    for (const id of ["managed-restart", "managed-restart-unready", "managed-restart-startup-failure"]) {
      assert.ok(selected.included.some((entry) => entry.engine === engine && entry.mode === "managed" && entry.id === id));
      for (const mode of ["socket-owned", "attached"]) assert.ok(selected.excluded.some((entry) => entry.engine === engine && entry.mode === mode && entry.id === id));
    }
    assert.ok(selected.included.some((entry) => entry.engine === engine && entry.mode === "managed" && entry.id === "exact-prompt-continuation"));
    assert.ok((engine.startsWith("2.") ? selected.included : selected.excluded).some((entry) => entry.engine === engine && entry.id === "models-switch"));
  }
  for (const cell of report.cells) for (const definition of releaseCases) {
    const excluded = definition.lane === "live" || !definition.modes.includes(cell.mode) || !definition.generations.includes(cell.engine.split(".")[0]);
    const entries = excluded ? selected.excluded : selected.included;
    assert.ok(entries.some((entry) => entry.engine === cell.engine && entry.mode === cell.mode && entry.id === definition.id && entry.reason));
  }
  const release = selectGate(report, { gate: "release" });
  assert.equal(release.exitCode, 1);
  for (const id of ["remote-host", "live-slack-provider", "operator-integrations", "visible-interaction-client", "slack-editable-retry-controls", "socket-detached-restart"]) {
    assert.ok(selected.excluded.some((entry) => entry.id === id));
    assert.ok(release.included.some((entry) => entry.id === id && entry.status === "BLOCKED"));
  }
  assert.equal(JSON.stringify(report), before);
  assert.equal(report.releaseQualified, false);
  assert.throws(() => selectGate(report, { gate: "baseline" }));
});

test("required deterministic defects, missing cases/cells, diagnostics and empty evidence fail closed", () => {
  for (const engine of PINS) for (const mode of MODES) for (const status of ["FAIL", "BLOCKED", "NOT_APPLICABLE"]) {
    const report = gateFixture();
    const cell = report.cells.find((cell) => cell.engine === engine && cell.mode === mode);
    for (const id of ["exact-prompt-continuation", "crash-after-instruction-registration", "crash-after-admission", "crash-during-approval", "crash-after-completion", ...(mode === "managed" ? ["managed-restart"] : ["socket-fixture-restart"]), ...(engine.startsWith("2.") ? ["models-default", "models-switch", "models-variants", "models-reset"] : [])]) {
      const row = cell.cases.find((row) => row.id === id);
      row.status = status;
      assert.equal(selectGate(report).exitCode, 1, `${engine} ${mode} ${id} ${status}`);
      row.status = "PASS";
    }
    cell.cases = cell.cases.filter((row) => row.id !== "exact-prompt-continuation");
    assert.equal(selectGate(report).exitCode, 1);
  }
  for (const id of ["worker", "engine-preflight", "cleanup"]) {
    const report = gateFixture();
    report.cells[0].cases.push({ id, status: "FAIL" });
    assert.equal(selectGate(report).exitCode, 1);
  }
  for (const mutate of [report => { report.cells.pop(); }, report => { report.cells[0].cases = []; }, report => { report.cells = []; }, report => { report.cleanup.status = "FAIL"; }, report => { report.cells[0].cleanup.status = "FAIL"; }]) {
    const report = gateFixture(); mutate(report);
    assert.equal(selectGate(report).exitCode, 1);
  }
  assert.equal(compatibilityExit([]), 1);
});

test("migration is opt-in collection, never a waiver of required transition evidence or baseline failures", () => {
  const report = gateFixture();
  report.collection = "pre-port-baseline";
  for (const cell of report.cells.filter((cell) => cell.engine.startsWith("1."))) {
    for (const row of cell.cases.filter((row) => row.id.startsWith("migration-"))) row.status = "BLOCKED";
  }
  assert.equal(selectGate(report).exitCode, 1);
  assert.ok(selectGate(report).included.some((entry) => entry.id === "migration-upgrade" && entry.status === "BLOCKED"));
  assert.ok(selectGate(report).excluded.some((entry) => entry.engine === "2.0.29" && entry.id === "migration-upgrade"));
});

test("live FAIL and missing host evidence are release requirements, never reason-string exclusions", () => {
  const report = gateFixture();
  for (const cell of report.cells) {
    for (const row of cell.cases) {
      row.observed = "No live credentials; Managed intentionally has no Chat; missing adapter";
      if (releaseCases.find((definition) => definition.id === row.id).lane === "live") row.status = "FAIL";
    }
  }
  assert.equal(selectGate(report).exitCode, 0);
  assert.equal(selectGate(report, { gate: "release" }).exitCode, 1);
  const attached = report.cells.find((cell) => cell.mode === "attached");
  attached.cases = attached.cases.filter((row) => row.id !== "remote-host");
  assert.ok(selectGate(report, { gate: "release" }).included.some((entry) => entry.id === "remote-host" && entry.mode === "attached" && entry.missing));
  attached.cases.find((row) => row.id === "exact-prompt-continuation").status = "BLOCKED";
  assert.equal(selectGate(report).exitCode, 1);
  attached.cases.find((row) => row.id === "live-slack-provider").status = "SKIP";
  assert.throws(() => selectGate(report), /Invalid evidence status/u);
});

test("failed executor outcome cannot be success", () => {
  assert.throws(() => assertTurnOutcome({ sessionId: "test", text: "OK", error: new Error("failed") }, { sessionId: "test", text: "OK" }));
});

test("unexpected provider routes and unregistered prompts are sticky failures", async () => {
  const runtime = await createRuntimeFixture();
  try {
    const provider = await createProvider(runtime);
    assert.equal((await fetch(`${provider.url}/unknown`)).status, 500);
    assert.equal((await fetch(`${provider.url}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "matrix", messages: [{ role: "user", content: "unexpected" }] }) })).status, 500);
    assert.throws(() => provider.assertClean(), /Unexpected/u);
  } finally { await runtime.teardown(); }
});

test("native Code Mode catalog update preserves the registered prompt and tool result boundary", async () => {
  const runtime = await createRuntimeFixture();
  try {
    const provider = await createProvider(runtime);
    provider.register({ prompt: "REGISTERED_PROMPT", text: "DONE" });
    const request = (messages) => fetch(`${provider.url}/chat/completions`, { method: "POST", body: JSON.stringify({ model: "matrix", messages }) });
    const messages = [{ role: "user", content: "REGISTERED_PROMPT" }, { role: "tool", content: "Custom answer", tool_call_id: "test" }];
    const update = { role: "user", content: "<system-update>\nThe Code Mode tool catalog has changed.\n\nNew tools are available in addition to those previously listed:\n  - tools.matrix.nonce(): Promise&lt;unknown&gt; // Return a synthetic matrix marker\n</system-update>" };
    const response = await request([...messages, update]);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "DONE");
    assert.deepEqual(provider.receipts[0].toolResults, [messages[1]]);
    provider.assertClean();
    assert.equal((await request([...messages, { role: "user", content: "unregistered real prompt" }, update])).status, 500, "must not search past an unknown user prompt");
    assert.equal((await request([...messages, { role: "user", content: "<system-update>arbitrary unknown input</system-update>" }])).status, 500);
  } finally { await runtime.teardown(); }
});

test("evidence refuses unknown status and common N/A; baseline remains strict", async () => {
  const rows = [];
  await recordCase(rows, { id: "red", expected: "pass" }, async () => { throw new Error("observed failure"); });
  assert.equal(rows[0].status, "FAIL");
  assert.equal(compatibilityExit(rows), 1);
  assert.equal(compatibilityExit([{ status: "BLOCKED" }]), 1);
  assert.equal(compatibilityExit([{ status: "PASS" }]), 0);
  assert.throws(() => compatibilityExit([{ status: "SKIP" }]));
  await assert.rejects(recordCase([], { id: "common" }, async () => ({ status: "NOT_APPLICABLE", observed: "missing" })));
});

test("cleanup failure fails even an otherwise passing cell and retains resource", async () => {
  const runtime = await createRuntimeFixture({ cleanupTimeoutMs: 50 });
  runtime.defer(() => { throw new Error("cleanup defect"); }, "owned sentinel");
  const cell = { cases: [{ id: "green", status: "PASS" }] };
  await finishCell(cell, runtime);
  assert.equal(cell.cleanup.status, "FAIL");
  assert.match(cell.cleanup.observed, /owned sentinel/u);
  assert.equal(compatibilityExit(cell.cases), 1);
  await rm(runtime.root, { recursive: true, force: true });
});

test("fixture environment excludes ambient credentials, proxies, Node options and attach", async () => {
  const runtime = await createRuntimeFixture({ environment: { PATH: process.env.PATH, OPENAI_API_KEY: "ambient", PIPA_SLACK_BOT_TOKEN: "ambient", NODE_OPTIONS: "ambient", HTTPS_PROXY: "ambient", PIPA_OPENCODE_ATTACH_URL: "ambient" } });
  try {
    for (const key of ["OPENAI_API_KEY", "PIPA_SLACK_BOT_TOKEN", "NODE_OPTIONS", "HTTPS_PROXY", "PIPA_OPENCODE_ATTACH_URL"]) assert.equal(runtime.env[key], undefined);
  } finally { await runtime.teardown(); }
});

test("an already-aborted poll starts no orphan promise", () => {
  const signal = AbortSignal.abort(new Error("closed"));
  assert.throws(() => waitFor(() => assert.fail("must not poll"), { signal }), /closed/u);
});

test("default test discovery cannot download or launch engines", async () => {
  const runtime = await createRuntimeFixture({ timeoutMs: 5000 });
  try {
    const script = fileURLToPath(new URL("../test-opencode-matrix.mjs", import.meta.url));
    const output = await command(runtime, process.execPath, ["--test", script]);
    assert.doesNotMatch(output, /Report:|socket-owned|Registry/u);
  } finally { await runtime.teardown(); }
});

test("cell worker deadline exceeds bounded cell plus teardown", () => {
  assert.ok(CELL_WORKER_TIMEOUT_MS > 7 * 60_000 + FIXTURE_TEARDOWN_TIMEOUT_MS);
});

test("interrupted process registration fails cleanup and retains the owned root", async () => {
  const runtime = await createRuntimeFixture();
  journal(runtime.ownership, { kind: "intent", id: "interrupted-spawn" });
  const cell = { cases: [] };
  await finishCell(cell, runtime);
  assert.equal(cell.cleanup.status, "FAIL");
  assert.match(cell.cleanup.observed, /identity could not be proven/u);
  await access(runtime.root);
  await rm(runtime.root, { recursive: true, force: true });
});

test("killed nested worker releases fixture engines and independent detached restart groups before PASS", async () => {
  const outer = await createRuntimeFixture();
  const unrelated = await createRuntimeFixture();
  const helper = new URL("../../test/helpers/runtime-fixture.mjs", import.meta.url).href;
  const evidence = path.join(outer.workspace, "nested.json");
  const survivor = unrelated.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  const cell = { cases: [] };
  let observed;
  try {
    const worker = outer.spawn(process.execPath, ["--input-type=module", "-e", `
      import { createRuntimeFixture } from ${JSON.stringify(helper)};
      import { spawn } from 'node:child_process';
      import { writeFileSync, readFileSync } from 'node:fs';
      const nested = await createRuntimeFixture();
      const engine = nested.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);
      const restartFile = nested.workspace + '/replacement.pid';
      const restart = spawn(process.execPath, ['-e', "const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' }); require('node:fs').writeFileSync(process.argv[1], String(child.pid)); child.unref();", restartFile], { detached: true, stdio: 'ignore', env: nested.env });
      const restarted = new Promise(resolve => restart.once('exit', resolve));
      restart.unref();
      const replacement = await nested.waitFor(() => { try { return Number(readFileSync(restartFile, 'utf8')); } catch { return false; } });
      await restarted;
      writeFileSync(process.argv[1], JSON.stringify({ root: nested.root, engine: engine.child.pid, restart: replacement }));
      setInterval(() => {}, 1000);
    `, evidence]);
    observed = JSON.parse(await outer.waitFor(() => readFile(evidence, "utf8").catch(() => false)));
    worker.child.kill("SIGKILL");
    await worker.exited;
    await access(observed.root);
    await finishCell(cell, outer);
    assert.equal(cell.cleanup.status, "PASS", cell.cleanup.observed);
    for (const pid of [observed.engine, observed.restart]) assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
    await assert.rejects(access(observed.root), { code: "ENOENT" });
    assert.equal(survivor.child.exitCode, null, "unrelated fixture was killed");
  } finally {
    // Explicit test-owned fallback only, so a regression cannot leak test engines.
    for (const pid of [observed?.engine, observed?.restart]) if (pid) { try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch {} }
    await outer.teardown().catch(() => undefined);
    await unrelated.teardown().catch(() => undefined);
    await rm(outer.root, { recursive: true, force: true });
    await rm(unrelated.root, { recursive: true, force: true });
  }
});

test("already-exited group leader cannot hide a living child from cleanup", async () => {
  const runtime = await createRuntimeFixture();
  const evidence = path.join(runtime.workspace, "child.pid");
  let pid;
  try {
    const leader = runtime.spawn(process.execPath, ["-e", `
      const child = require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
      require('node:fs').writeFileSync(process.argv[1], String(child.pid));
      child.unref();
    `, evidence]);
    pid = Number(await runtime.waitFor(() => readFile(evidence, "utf8").catch(() => false)));
    await leader.exited;
    process.kill(pid, 0);
    const cell = { cases: [] };
    await finishCell(cell, runtime);
    assert.equal(cell.cleanup.status, "PASS", cell.cleanup.observed);
    assert.throws(() => process.kill(pid, 0), { code: "ESRCH" });
  } finally {
    if (pid) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await runtime.teardown().catch(() => undefined);
    await rm(runtime.root, { recursive: true, force: true });
  }
});

test("Windows tree discovery retains exited-leader children and rejects reused identities", () => {
  const leader = { pid: 10, ppid: 1, birth: "2026-10-14T10:00:00.000Z" };
  const child = { pid: 11, ppid: 10, birth: "2026-10-14T10:00:01.000Z" };
  const grandchild = { pid: 12, ppid: 11, birth: "2026-10-14T10:00:03.000Z" };
  const unrelated = { pid: 13, ppid: 1, birth: "2026-10-14T10:00:01.000Z" };
  const exitedAt = Date.parse("2026-10-14T10:00:02.000Z");
  assert.deepEqual(windowsTree([child, grandchild, unrelated], [leader], exitedAt).map((item) => item.pid), [11, 12]);
  assert.deepEqual(windowsTree([{ ...grandchild, birth: child.birth }, unrelated], [leader, child], exitedAt).map((item) => item.pid), [12]);
  assert.throws(() => windowsTree([{ ...leader, birth: child.birth }, child], [leader], exitedAt), /reused PID/u);
  assert.throws(() => windowsTree([{ ...child, birth: grandchild.birth }], [leader], exitedAt), /unproven descendant/u);
  assert.throws(() => windowsTree([{ ...child, birth: null }], [leader], exitedAt), /creation identity/u);
  assert.throws(() => windowsTree([{ ...child, birth: "2026-10-14T09:00:00.000Z" }], [leader], exitedAt), /older unowned child/u);
});

test("changed birth in the ownership journal refuses to signal an unrelated live PID", async () => {
  const runtime = await createRuntimeFixture();
  const unrelated = await createRuntimeFixture();
  const survivor = unrelated.spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"]);
  try {
    journal(runtime.ownership, { kind: "process", id: "stale-pid", pid: survivor.child.pid, birth: "not-the-current-birth", detached: false });
    const cell = { cases: [] };
    await finishCell(cell, runtime);
    assert.equal(cell.cleanup.status, "FAIL");
    assert.match(cell.cleanup.observed, /identity changed.*reused PID/u);
    process.kill(survivor.child.pid, 0);
    assert.equal(survivor.child.exitCode, null);
    await access(runtime.root);
  } finally {
    await unrelated.teardown();
    await rm(runtime.root, { recursive: true, force: true });
  }
});
