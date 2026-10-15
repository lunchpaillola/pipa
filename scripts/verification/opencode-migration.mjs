import assert from "node:assert/strict";
import { cp, readFile, readdir, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { createRuntimeFixture, bounded } from "../../test/helpers/runtime-fixture.mjs";
import { assertTurnOutcome } from "../../test/helpers/opencode-contract.mjs";

// A stopped whole-profile copy includes SQLite companions and upstream storage.
// Rollback never opens the copy offered to v2, even when v2 startup fails.
export async function createMigrationJourney({ runtime, binaries, sourcePin, facade, state, routines, provider, config }) {
  const source = await createRuntimeFixture({ timeoutMs: 180_000 });
  runtime.defer(() => source.teardown(), `migration ${sourcePin} source resources`);
  Object.assign(source.env, { OPENCODE_SERVER_PASSWORD: "synthetic-loopback-only", OPENCODE_PASSWORD: "synthetic-loopback-only", OPENCODE_PURE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1" });
  const sourceEnvironment = { ...source.env };
  const snapshot = path.join(runtime.root, `pristine-${sourcePin}`);
  const target = path.join(runtime.root, `v2-copy-${sourcePin}`);
  const rollback = path.join(runtime.root, `rollback-${sourcePin}`);
  const marker = `MIGRATION_${sourcePin}_${randomUUID()}`;
  const workspace = source.workspace;
  let seeded;
  let pristineHashes;
  let server;
  let executor;
  const environmentAt = (root) => Object.fromEntries(Object.entries(sourceEnvironment).map(([key, value]) => [key, value.startsWith(source.root) ? root + value.slice(source.root.length) : value]));
  const profile = { botName: "Migration", workingDirectory: workspace, slackAppToken: "xapp-synthetic", slackBotToken: "xoxb-synthetic", allowedSlackChannelIds: ["CMATRIX"], allowedSlackUserIds: [], allowedSlackBotIds: [] };
  const approvalTool = { names: ["bash", "shell", "$shell"], arguments: () => ({ command: `"${process.execPath}" -e "console.log('migration-approval')"`, description: "Seed a remembered synthetic approval" }), verify: (results) => assert.match(JSON.stringify(results), /migration-approval/u) };
  const denialTool = { names: ["bash", "shell", "$shell"], arguments: () => ({ command: "pwd", description: "Verify configured synthetic deny" }), verify: (results) => assert.match(JSON.stringify(results), /prevent|denied|reject|not allowed|forbidden/iu) };
  const start = async (pin, root) => {
    assert.ok(binaries[pin], `Verified native binary unavailable for ${pin}`);
    const env = environmentAt(root);
    // spawn's environment is fixture-owned; mutate it before the native child.
    Object.assign(source.env, env);
    server = await facade.startSocketOpenCodeServer(profile, { environment: env, attachUrl: "", startupTimeoutMs: 20000, spawn: (_, args, options) => source.spawn(binaries[pin], args, { ...options, cwd: workspace }).child });
    const owned = server;
    source.defer(async () => { owned.stop(); await bounded(owned.wait(), { timeoutMs: 5000 }); }, "migration owned engine");
    executor = facade.createOpenCodeExecutor({ baseUrl: server.baseUrl, environment: env, pollIntervalMs: 50, artifactRoot: path.join(workspace, ".pipa/artifacts") });
    return env;
  };
  const stop = async () => { executor?.stopAll(); server?.stop(); if (server) await bounded(server.wait(), { timeoutMs: 5000 }); server = null; };
  const run = async (prompt, sessionId, script = {}, interaction) => {
    provider.register({ prompt, text: `${prompt}_RESULT`, ...script });
    const result = await executor.runTurn({ prompt, sessionId, workingDirectory: workspace, signal: AbortSignal.timeout(15000), onInteraction: interaction });
    assertTurnOutcome(result, { sessionId: sessionId ?? result.sessionId, text: `${prompt}_RESULT` });
    return result;
  };
  async function hashes(root) {
    const entries = {};
    async function visit(directory) {
      for (const entry of await readdir(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(file);
        else if (entry.isFile()) entries[path.relative(root, file)] = createHash("sha256").update(await readFile(file)).digest("hex");
        else assert.fail("Snapshot contains a non-regular state entry");
      }
    }
    for (const name of ["home", "config", "data", "state"]) await visit(path.join(root, name));
    return entries;
  }
  return {
    async seed() {
      assert.ok(binaries[sourcePin] && binaries["2.0.29"], "Migration requires verified source and target pins from runner");
      await writeFile(source.env.OPENCODE_CONFIG, JSON.stringify({ ...config, permission: { bash: { "*": "ask", pwd: "deny" }, read: "deny" } }));
      await state.writePrivateJson(state.pipaPaths(source.home).config, profile);
      await start(sourcePin, source.root);
      const sessions = {};
      for (const destination of ["channel", "thread"]) sessions[`slack:CMATRIX:${destination === "channel" ? "900.001" : "900.002"}`] = (await run(`${marker}_${destination}`)).sessionId;
      const store = await state.createSessionStore(state.pipaPaths(source.home).sessions);
      for (const [thread, id] of Object.entries(sessions)) await store.set(thread, id);
      const approvals = [];
      await run(`${marker}_configured_deny`, null, { tool: denialTool }, async () => { assert.fail("Configured deny became an approval request"); });
      const permission = await run(`${marker}_approval`, null, { tool: approvalTool }, async (request) => { approvals.push(request.type); return { type: "reply", reply: "always" }; });
      assert.deepEqual(approvals, ["permission"]);
      const remembered = [];
      await run(`REMEMBERED_${marker}`, permission.sessionId, { tool: approvalTool }, async (request) => { remembered.push(request.type); return { type: "reply", reply: "once" }; });
      assert.deepEqual(remembered, [], "Native v1 did not remember its accepted always approval within the running engine");
      const now = Date.now();
      for (const status of ["active", "inactive", "completed"]) await routines.createRoutine({ id: `${marker}_${status}`, status, prompt: `${marker}_routine_${status}`, timezone: "UTC", destination: { channelId: "CMATRIX", threadTs: "900.002" }, schedule: { type: "once", at: new Date(now + 3600_000).toISOString() } }, { paths: state.pipaPaths(source.home) });
      await stop();
      await cp(source.root, snapshot, { recursive: true, errorOnExist: true, force: false });
      pristineHashes = await hashes(snapshot);
      assert.ok(Object.keys(pristineHashes).some((file) => file.startsWith(`data${path.sep}`)), "No upstream engine storage was checkpointed");
      await cp(snapshot, target, { recursive: true, errorOnExist: true, force: false });
      assert.deepEqual(await hashes(target), pristineHashes);
      seeded = { sessions, permissionSession: permission.sessionId };
      return { observed: "Seeded real v1 history, thread mappings, three routine states and remembered approval; stopped writers and copied entire private profile", evidence: { sourcePin, sessionIds: Object.values(sessions), checkpointFiles: Object.keys(pristineHashes), configuredDeny: true, rememberedApproval: true } };
    },
    async upgrade() {
      if (!seeded) return { status: "BLOCKED", observed: "Migration seed case failed; no snapshot is offered to v2" };
      try {
        const env = await start("2.0.29", target);
        assert.deepEqual(JSON.parse(await readFile(state.pipaPaths(env.PIPA_HOME).sessions, "utf8")), seeded.sessions);
        assert.deepEqual((await routines.loadRoutineState(state.pipaPaths(env.PIPA_HOME).routines)).routines.map((item) => item.status), ["active", "inactive", "completed"]);
        await run(`V2_DENY_${marker}`, null, { tool: denialTool }, async () => { assert.fail("Migrated configured deny became an approval request"); });
        const reset = [];
        await run(`V2_APPROVAL_${marker}`, seeded.permissionSession, { tool: approvalTool }, async (request) => { reset.push(request.type); return { type: "reply", reply: "once" }; });
        assert.deepEqual(reset, ["permission"], "Native v2 remembered-approval reset was not observed");
        for (const [index, id] of Object.values(seeded.sessions).entries()) await run(`${marker}_v2_${index}`, id, { verify: (messages) => assert.ok(JSON.stringify(messages).includes(marker), "Migrated history missing") });
        await stop();
        await start("2.0.29", target);
        await run(`${marker}_v2_restart`, Object.values(seeded.sessions)[0], { verify: (messages) => assert.ok(JSON.stringify(messages).includes(marker)) });
        return { observed: "Disposable v2 copy continued the mapped history before and after engine restart" };
      } finally { await stop(); assert.deepEqual(await hashes(snapshot), pristineHashes, "Pristine v1 snapshot changed during v2 attempt"); }
    },
    async rollback() {
      if (!seeded) return { status: "BLOCKED", observed: "Migration seed failed; no matched snapshot exists for rollback" };
      // Remap from the original immutable root, not a v2-mutated environment.
      await cp(snapshot, rollback, { recursive: true, errorOnExist: true, force: false });
      assert.deepEqual(await hashes(rollback), pristineHashes);
      try {
        const env = await start(sourcePin, rollback);
        assert.deepEqual(JSON.parse(await readFile(state.pipaPaths(env.PIPA_HOME).sessions, "utf8")), seeded.sessions);
        assert.deepEqual((await routines.loadRoutineState(state.pipaPaths(env.PIPA_HOME).routines)).routines.map((item) => item.status), ["active", "inactive", "completed"]);
        for (const [index, id] of Object.values(seeded.sessions).entries()) await run(`${marker}_rollback_${index}`, id, { verify: (messages) => assert.ok(JSON.stringify(messages).includes(marker), "Rollback history marker absent") });
        assert.equal(JSON.parse(await readFile(env.OPENCODE_CONFIG, "utf8")).permission.read, "deny");
        const approvalRequests = [];
        await run(`${marker}_rollback_approval`, seeded.permissionSession, { tool: approvalTool }, async (request) => { approvalRequests.push(request.type); return { type: "reply", reply: "once" }; });
        assert.ok(approvalRequests.length <= 1 && approvalRequests.every((type) => type === "permission"), "Unexpected rollback approval requests");
        await run(`${marker}_rollback_deny`, null, { tool: denialTool }, async () => { assert.fail("Rollback configured deny became a grant request"); });
        return { observed: `Matched pristine v1/Pipa copy restored original session IDs/history, routine/config state and configured deny; native remembered approval ${approvalRequests.length ? "reset across service restart (observed, not recreated by Pipa)" : "survived"}; v1 never opened v2-written data`, evidence: { rememberedApprovalRequestsAfterRollback: approvalRequests.length } };
      } finally { await stop(); assert.deepEqual(await hashes(snapshot), pristineHashes); }
    },
  };
}
