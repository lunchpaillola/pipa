import assert from "node:assert/strict";
import { mkdir, rmdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { OpenCode } from "@opencode/client";
import { createOpenCodeExecutor } from "../../src/opencode.mjs";
import { bounded, createRuntimeFixture } from "../../test/helpers/runtime-fixture.mjs";
import { createProvider, providerConfig } from "./opencode-provider.mjs";

const runtime = await createRuntimeFixture({ timeoutMs: 120_000, cleanupTimeoutMs: 10_000 });
const report = { realNativeRecovery: true, liveSlack: false, cases: [] };
let executor;
try {
  const provider = await createProvider(runtime);
  await writeFile(runtime.env.OPENCODE_CONFIG, JSON.stringify(providerConfig(provider.url)));
  const requests = [];
  const headers = { authorization: `Basic ${Buffer.from("opencode:isolated-location").toString("base64")}` };
  let server, client;
  async function start() {
  server = runtime.spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "error"], {
    env: { ...runtime.env, OPENCODE_PASSWORD: "isolated-location", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1", BUN_JSC_maxRegExpStackSize: "536870912" },
  });
  const baseUrl = await bounded(new Promise((resolve, reject) => {
    let output = "";
    server.child.stdout.on("data", chunk => { output += chunk; const match = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/u); if (match) resolve(match[0]); });
    server.exited.then(() => reject(new Error("Native server exited during startup")), reject);
  }), { timeoutMs: 30_000, signal: runtime.signal });
  client = OpenCode.make({ baseUrl, headers });
  const info = await client.server.info();
  report.engine = info.version;
  executor = createOpenCodeExecutor({ baseUrl, connection: { major: 2, version: info.version, headers }, environment: runtime.env, artifactRoot: runtime.artifactRoot,
    fetch: async (url, init) => {
      const response = await fetch(url, init);
      requests.push({ path: new URL(url).pathname, method: init?.method ?? "GET", status: response.status, ...(init?.body ? { body: JSON.parse(init.body) } : {}) });
      return response;
    },
  });
  }
  await start();
  for (const mode of ["idle", "queued"]) {
    const directory = path.join(runtime.workspace, `removed-${mode}`);
    await mkdir(directory);
    const seed = `LOCATION_SEED_${mode}`, current = `LOCATION_CURRENT_${mode}`, queued = `LOCATION_QUEUED_${mode}`;
    for (const prompt of [seed, current, queued]) provider.register({ prompt, text: `DONE_${prompt}` });
    const session = await client.session.create({ location: { directory } });
    await client.session.switchModel({ sessionID: session.id, model: { providerID: "matrix", id: "matrix", variant: "default" } });
    const initial = await executor.runTurn({ prompt: seed, sessionId: session.id, workingDirectory: directory, signal: runtime.signal });
    assert.equal(initial.text, `DONE_${seed}`);
    if (mode === "queued") await client.session.prompt({ sessionID: session.id, text: queued, resume: false });
    executor.stopAll();
    await executor.drain();
    server.child.kill("SIGTERM");
    await bounded(server.exited, { timeoutMs: 10_000, label: "isolated native restart" });
    await rmdir(directory);
    await start();
    const responses = [], notices = [];
    const result = await executor.runTurn({ prompt: current, sessionId: session.id, workingDirectory: runtime.workspace, signal: runtime.signal,
      onLocationRecovered: async metadata => notices.push(metadata), onResponse: async response => responses.push(response.text),
    });
    assert.deepEqual(result, { pending: true, sessionId: session.id });
    await runtime.waitFor(() => responses.includes(`DONE_${current}`), { timeoutMs: 30_000, label: "recovered current request completes" });
    if (mode === "queued") await runtime.waitFor(() => responses.includes(`DONE_${queued}`), { timeoutMs: 30_000, label: "existing queued work completes" });
    const history = (await client.message.list({ sessionID: session.id, limit: 30 })).data;
    const userTexts = history.filter(message => message.type === "user").map(message => message.text);
    assert.equal(userTexts.filter(text => text === seed).length, 1);
    assert.equal(userTexts.filter(text => text === current).length, 1);
    if (mode === "queued") assert.equal(userTexts.filter(text => text === queued).length, 1);
    assert.equal(responses.filter(text => text === `DONE_${current}`).length, 1);
    const attempts = requests.filter(request => request.path.endsWith("/prompt") && request.body?.text === current);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].status, 404);
    assert.equal(attempts[1].status, 200);
    assert.deepEqual(attempts[0].body, attempts[1].body);
    const moved = await client.session.get({ sessionID: session.id });
    assert.equal(moved.location.directory, runtime.workspace);
    assert.equal(moved.model.providerID, "matrix");
    assert.equal(moved.model.id, "matrix");
    assert.equal(notices.length, 1);
    assert.equal(notices[0].previousDirectory, directory);
    report.cases.push({ mode, sameSession: true, historyRetained: true, modelRetained: true, currentPromptStoredOnce: true,
      oldQueuedPromptStoredOnce: mode === "queued", promptAttempts: attempts.map(request => request.status), nativeDirectory: moved.location.directory });
  }
  assert.equal(requests.some(request => request.path.endsWith("/inbox") || request.path === "/api/session/active" || request.path.endsWith("/interrupt")), false);
  provider.assertClean();
  report.completed = true;
} catch (error) { report.failure = { error: String(error), stack: error.stack }; process.exitCode = 1; }
finally {
  executor?.stopAll();
  await executor?.drain();
  try { await runtime.teardown(); report.cleanupPassed = true; }
  catch (error) { report.cleanupPassed = false; report.cleanupError = String(error); process.exitCode = 1; }
  if (process.argv[2]) await writeFile(process.argv[2], JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}
