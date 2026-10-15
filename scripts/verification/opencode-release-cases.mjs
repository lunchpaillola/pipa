import assert from "node:assert/strict";
import { randomUUID, createHash } from "node:crypto";
import { readFile, writeFile, readdir, rename } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createRuntimeFixture, bounded, waitFor } from "../../test/helpers/runtime-fixture.mjs";
import { assertTurnOutcome, assertPromptReceipt } from "../../test/helpers/opencode-contract.mjs";
import { assertPin, command, recordCase, finishCell } from "../test-opencode-matrix.mjs";
import { createProvider, providerConfig, writeDefinitions } from "./opencode-provider.mjs";
import { createMigrationJourney } from "./opencode-migration.mjs";
import { deflateSync } from "node:zlib";

// Shared catalog for the deterministic lane and later live evaluator. A feature's
// subcases remain separate: small local file proof cannot pass remote/boundary UX.
const chatCase = { modes: ["socket-owned", "attached"] };
const managedCase = { modes: ["managed"] };
const liveCase = { lane: "live" };
const transitionCase = { native: true, generations: ["1"] };
const caseOf = (id, feature, expected, owner, extra = {}) => ({ id, feature, expected, owner, lane: "deterministic", modes: ["socket-owned", "attached", "managed"], generations: ["1", "2"], required: true, ...extra });
export const releaseCases = [
  caseOf("package-cli", "Init/config/version/help", "Installed version/help and side-effect-free routine preview", "U6/U9"),
  caseOf("init-identity", "Init/config/version/help", "Fresh initialization accepts the real engine identity without overwriting invalid profiles", "U1"),
  caseOf("startup-readiness", "Socket startup/stop; Managed startup/stop; Attached server", "Authenticated production workspace readiness and correct ownership", "U1"),
  caseOf("exact-prompt-continuation", "New conversation/history", "Exact prompt bytes, final text and same session/history on the installed facade", "U2"),
  caseOf("chat-continuation", "New conversation/history", "Mention/follow-up use the same persisted session and exact destination", "U2", chatCase),
  caseOf("chat-authorization", "Socket startup/stop; Permissions/questions", "Wrong channel, unauthorized user and unallowlisted bot start no engine work or delivery", "U9", chatCase),
  caseOf("supersession-concurrency", "Supersession/concurrency", "Held old turn is cancelled; only replacement and independent thread deliver", "U4", chatCase),
  caseOf("supersession-reaction-contract", "Supersession/concurrency", "Superseded input receives no success reaction", "U4", chatCase),
  caseOf("questions-permissions-tools", "Permissions/questions", "Real question and protected tool unblock through authorized fake-Chat controls; wrong thread/user/nonce rejected", "U3", chatCase),
  caseOf("failed-turn", "New conversation/history", "Engine/provider failure produces no successful outcome", "U2"),
  caseOf("local-attachment-bytes", "Incoming attachments", "Actual installed engine receives exact local document bytes", "U2"),
  caseOf("artifact-bytes", "Outgoing artifacts", "Real write tool produces delivered file bytes and checksum", "U2"),
  caseOf("routine-cli", "Routine CLI lifecycle", "Preview/create/list/show/edit/run/deactivate/reactivate/delete preserve exact prompt/destination", "U9"),
  caseOf("routine-once", "Routine scheduling; Routine continuation/access", "Real due once scheduler delivers exactly once to channel, maps result thread and continues its session", "U4", chatCase),
  caseOf("routine-recurring", "Routine scheduling; Routine continuation/access", "Real recurring due scheduler delivers to existing thread and advances occurrence without duplication", "U4", chatCase),
  caseOf("routine-revocation", "Routine continuation/access", "Revoke destination at held provider barrier; no stale delivery", "U4", chatCase),
  caseOf("stop-ownership", "Socket startup/stop; Managed startup/stop; Attached server", "Reject new work; owned port closes, attached PID/port survive Pipa shutdown", "U1"),
  caseOf("managed-restart", "Detached restart, Managed/failures", "Actual CLI replacement PID/generation becomes ready, old process exits, durable completion and follow-up", "U6", managedCase),
  caseOf("socket-fixture-restart", "Detached restart, Socket/attached", "Installed CLI detached restart with fake Chat: native readiness, worker exit, one routed notice, history follow-up and attached PID survival", "U6", chatCase),
  caseOf("reconnect-stream", "Reconnect/reload", "Close a real production event response, reconnect, settle one permission and deliver once", "U2/U3", chatCase),
  caseOf("reload-location", "Reconnect/reload", "Native location reload preserves session history and admits exactly one continuation", "U2/U3"),
  caseOf("crash-after-instruction-registration", "Abrupt crash/recovery", "Death after owned instruction registration recovers only Pipa-owned context without admitting new work", "U2/U6"),
  caseOf("crash-after-admission", "Abrupt crash/recovery", "Abrupt executor death after native acceptance retains session identity without replay or false success", "U2/U6"),
  caseOf("crash-during-approval", "Abrupt crash/recovery", "Abrupt executor death at a real pending approval recovers/cancels abandoned work without false success", "U2/U6"),
  caseOf("crash-after-completion", "Abrupt crash/recovery", "Death after engine completion before delivery retains history without automatic replay/redelivery", "U2/U6"),
  caseOf("plugin-reload-contract", "MCP/skills/agents/commands/plugins", "Modified private plugin executes its new hook once after native location reload", "U7"),
  caseOf("attachment-image-data-uri", "Incoming attachments", "Native engine receives exact image and document bytes via local and data URI transport", "U2"),
  caseOf("attachment-10mib", "Incoming attachments", "Real 10 MiB attachment reaches native admission through local and data URI transport", "U2"),
  caseOf("attachment-over-limit", "Incoming attachments", "10 MiB + 1 is rejected before native admission, both metadata and decoded bytes", "U2"),
  caseOf("attachment-over-limit-metadata", "Incoming attachments", "Oversized Chat attachment metadata rejects without downloading or admitting work", "U2", chatCase),
  caseOf("artifact-limits-fallback", "Outgoing artifacts", "Over-20-MiB outgoing file retains R9; unsafe declarations upload nothing; failed file post falls back once without declaration", "U2/U7"),
  caseOf("question-multi-custom-dismiss", "Permissions/questions", "Real multiple choice, custom modal answer and dismissal settle through production handlers", "U3", chatCase),
  caseOf("question-rejected-retry", "Permissions/questions", "A native rejected answer keeps editable controls until corrected submission is accepted", "U3"),
  caseOf("routine-overlap-recovery", "Routine overlap/restart recovery", "Held routine never overlaps; another proceeds; app restart retains run requests and skips missed occurrences", "U4/U6", chatCase),
  caseOf("routine-deactivate-delete", "Routine continuation/access", "Deactivation/deletion at a native execution barrier cancel engine work and suppress delivery", "U4", chatCase),
  caseOf("shutdown-active-work", "Shutdown/delegation", "Shutdown drains root/child questions, permissions and a quiet active tool; rejects intake and preserves attached ownership", "U4", chatCase),
  caseOf("socket-detached-restart", "Detached restart, Socket", "External observer verifies full Socket CLI restart, one ready notice and follow-up", "U6/U7", { ...liveCase, modes: ["socket-owned"], blocked: "Requires actual Socket connection and live evaluator; fake Chat is not full Socket CLI restart proof" }),
  caseOf("managed-restart-startup-failure", "Detached restart, Managed/failures", "Real replacement bind failure records failure and releases owned process/lock", "U6", managedCase),
  caseOf("managed-restart-unready", "Detached restart, Managed/failures", "Real engine with invalid workspace configuration never reports replacement readiness and cleans up", "U6", managedCase),
  caseOf("delegated-child", "Native background subagents", "Actual foreground task child asks permission/question and returns one nonce to parent", "U4"),
  caseOf("background-child", "Native background subagents", "Advertised native background task returns its child nonce through production executor", "U4"),
  caseOf("background-result-attribution", "Native background subagents", "Preserve v1 foreground completion while background work is pending; child result returns to parent history without new Pipa delivery policy", "U4"),
  caseOf("models-switch", "Models/providers", "Production model discovery/switch seam retains history and changes the next provider request", "U5", { native: true, generations: ["2"] }),
  ...["variants", "default", "reset"].map((kind) => caseOf(`models-${kind}`, "Models/providers", `Native ${kind} semantics preserve history and prove the next provider request`, "U5", { native: true, generations: ["2"] })),
  caseOf("definitions-mcp-skill", "MCP/skills/agents/commands/plugins", "Invoke real stdio MCP and file skill through actual native tools; plugin loads", "U7"),
  caseOf("definitions-command", "MCP/skills/agents/commands/plugins", "Production tool path invokes the installed native CLI file command and returns its result", "U7"),
  caseOf("migration-seed", "Package/platform/rollback", "Generate synthetic v1 histories/mappings/routines/approval; stop all writers and checkpoint-copy", "U9", transitionCase),
  caseOf("migration-upgrade", "Package/platform/rollback", "Migrate only a disposable copy with production Pipa v2, then continue and restart same sessions", "U7", transitionCase),
  caseOf("migration-rollback", "Package/platform/rollback", "Restore a matched pristine v1+Pipa copy and continue old sessions separately from v2-written data", "U9", transitionCase),
  caseOf("remote-host", "Attached server", "Separately hosted authenticated server keeps intended workspace and external ownership", "U7", { ...liveCase, modes: ["attached"], blocked: "Loopback does not qualify a separate remote host; operator deployment gate required" }),
  caseOf("live-slack-provider", "All visible-client features", "Real paid-provider inference and human/client-visible approvals, typing, files and destination evidence", "U7", { ...liveCase, ...chatCase, blocked: "No live credentials/responder in the no-secret deterministic lane" }),
  caseOf("operator-integrations", "MCP/skills/agents/commands/plugins", "Qualify private operator credentials, definitions and plugins", "U7", { ...liveCase, blocked: "No operator integration profile supplied; local stdio MCP/file definitions have separate executable cases" }),
  caseOf("visible-interaction-client", "Permissions/questions; Incoming attachments", "Human observes richer forms, native rejection/retry, oversized file UX and uploads in real Slack", "U7", { ...liveCase, ...chatCase, blocked: "Requires human responder and actual Slack client; deterministic handlers are exercised separately" }),
  caseOf("slack-editable-retry-controls", "Permissions/questions", "Rejected native submission leaves actual Slack controls editable and corrected submission settles once", "U3/U7", { ...liveCase, ...chatCase, blocked: "Executor submit/rejection proof does not prove editable Slack controls; requires production handler retry seam and actual Slack client evidence (U3/U7)" }),
];

// Both native admissions carry exact user text; provider calls and instruction
// registration are not admissions even when their payload contains the prompt.
export function isNativeAdmission(wire, prompt) {
  return /\/session\/[^/]+\/prompt(?:_async)?$/u.test(wire.path)
    && (wire.body?.text === prompt || wire.body?.parts?.some((part) => part.type === "text" && part.text === prompt) === true);
}

export function assertNativeAdmissionCount(wires, prompt, expected) {
  assert.equal(wires.filter((wire) => isNativeAdmission(wire, prompt)).length, expected, `Native admission count for ${prompt}`);
}

// Observe the installed process's real fetch boundary without replacing requests
// or responses. Retain synthetic prompt receipts only, never headers/config.
export function observeNativeAdmissions(fetchImpl, admissions) {
  return async (url, init) => {
    const request = url instanceof Request ? url : null;
    const pathname = new URL(request?.url ?? String(url)).pathname;
    const method = init?.method ?? request?.method ?? "GET";
    let receipt;
    if (method === "POST" && /\/session\/[^/]+\/prompt(?:_async)?$/u.test(pathname)) {
      const body = JSON.parse(init?.body ?? await request.clone().text());
      const prompt = body.text ?? body.parts?.find((part) => part.type === "text")?.text;
      assert.equal(typeof prompt, "string", "Native admission prompt missing");
      receipt = { method, path: pathname, prompt };
    }
    const response = await fetchImpl(url, init);
    if (receipt) admissions.push({ ...receipt, status: response.status });
    return response;
  };
}

export function assertRestartRoutineAdmission(snapshot, { pid, prompt, marker, sessionId }) {
  assert.equal(snapshot.pid, pid, "Routine receipt must come from the replacement process");
  const matches = snapshot.admissions.filter((item) => item.prompt.includes(marker));
  assert.equal(matches.length, 1, "Expected exactly one nonce-owned routine native prompt admission");
  const receipt = matches[0];
  assert.equal(receipt.method, "POST");
  assert.equal(receipt.path.match(/\/session\/([^/]+)\/prompt(?:_async)?$/u)?.[1], sessionId, "Routine native admission session must match its delivered result mapping");
  assert.ok(receipt.status >= 200 && receipt.status < 300, "Routine native admission must be accepted");
  assertPromptReceipt({ prompt: receipt.prompt, context: {} }, { prompt, context: {} });
  return receipt;
}

// Kill only a private Pipa runner/executor process. The actual attached engine
// stays alive; no shutdown, injected adapter, or engine response substitution.
export async function abruptTurnProbe({ runtime, candidate, baseUrl, boundary, prompt, sessionFile }) {
  assert.ok(["admission", "approval", "completion"].includes(boundary));
  const moduleURL = (file) => pathToFileURL(path.join(candidate, "src", `${file}.mjs`)).href;
  const worker = runtime.spawn(process.execPath, ["--input-type=module", "-e", `
    import { createOpenCodeExecutor } from ${JSON.stringify(moduleURL("opencode"))};
    import { createConversationRunner } from ${JSON.stringify(moduleURL("app"))};
    import { createSessionStore } from ${JSON.stringify(moduleURL("state"))};
    import { isNativeAdmission } from ${JSON.stringify(import.meta.url)};
    const prompt = ${JSON.stringify(prompt)};
    const admitted = Promise.withResolvers();
    const barrier = async (kind, evidence = {}) => {
      // A pending promise does not keep Node alive after the final HTTP stream closes.
      setInterval(() => {}, 1000);
      process.send({ kind: 'barrier', boundary: kind, ...evidence });
      await new Promise(() => {});
    };
    const executor = createOpenCodeExecutor({ baseUrl: ${JSON.stringify(baseUrl)}, environment: process.env, pollIntervalMs: 50,
      fetch: async (url, init = {}) => {
        const request = url instanceof Request ? url.clone() : null;
        const payload = init.body ?? (request && !['GET', 'HEAD'].includes(request.method) ? await request.text() : undefined);
        const wire = { path: new URL(request?.url ?? String(url)).pathname, body: payload ? JSON.parse(payload) : undefined };
        const response = await fetch(url, init);
        if (isNativeAdmission(wire, prompt)) {
          process.send({ kind: 'admission', wire, status: response.status });
          if (response.ok) admitted.resolve();
          if (response.ok && ${JSON.stringify(boundary)} === 'admission') await barrier('admission');
        }
        return response;
      }
    });
    const sessionStore = await createSessionStore(${JSON.stringify(sessionFile)});
    const runner = createConversationRunner({ sessionStore, runTurn: executor.runTurn, abortTurn: executor.abortTurn });
    await runner.enqueue('crash-probe', { prompt, workingDirectory: process.cwd(),
      onSession: sessionId => process.send({ kind: 'session', sessionId }),
      onInteraction: async interaction => {
        if (${JSON.stringify(boundary)} !== 'approval') throw new Error('Unexpected approval');
        await admitted.promise;
        await barrier('approval', { type: interaction.type, requestId: interaction.request.id });
      },
      deliver: async result => {
        if (${JSON.stringify(boundary)} === 'completion') await barrier('completion', { result });
        process.send({ kind: 'unexpected-delivery' });
      }
    });
  `], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  const messages = [];
  let stderr = "";
  worker.child.on("message", (message) => messages.push(message));
  worker.child.stderr.on("data", (data) => { stderr = (stderr + data).slice(-8192); });
  try {
    const reached = await runtime.waitFor(() => {
      assert.equal(worker.child.exitCode, null, `Crash probe exited before ${boundary}: ${stderr}`);
      return messages.find((message) => message.kind === "barrier" && message.boundary === boundary);
    }, { timeoutMs: 15000, label: `actual native ${boundary} crash barrier` });
    assert.equal(worker.child.kill("SIGKILL"), true);
    const exit = await bounded(worker.exited, { timeoutMs: 5000, label: "abrupt Pipa executor death" });
    if (process.platform !== "win32") assert.equal(exit.signal, "SIGKILL");
    assert.ok(!messages.some((message) => message.kind === "unexpected-delivery"));
    const sessionId = messages.find((message) => message.kind === "session")?.sessionId;
    assert.ok(sessionId);
    const persisted = JSON.parse(await readFile(sessionFile, "utf8"));
    assert.equal(persisted["crash-probe"], sessionId);
    const admissions = messages.filter((message) => message.kind === "admission");
    assert.ok(admissions.every((message) => message.status >= 200 && message.status < 300));
    assertNativeAdmissionCount(admissions.map((message) => message.wire), prompt, 1);
    return { boundary, sessionId, exit, admissions: admissions.map((message) => message.wire), ...reached, deliveryObserved: false };
  } finally {
    if (worker.child.exitCode === null && worker.child.signalCode === null) worker.child.kill("SIGKILL");
    await bounded(worker.exited, { timeoutMs: 5000, label: "crash probe exit" });
  }
}

function png() {
  const chunk = (name, data) => {
    const content = Buffer.concat([Buffer.from(name), data]);
    let crc = 0xffffffff;
    for (const byte of content) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4); checksum.writeUInt32BE((crc ^ 0xffffffff) >>> 0);
    return Buffer.concat([length, content, checksum]);
  };
  const header = Buffer.alloc(13); header.writeUInt32BE(2, 0); header.writeUInt32BE(2, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", header), chunk("IDAT", deflateSync(Buffer.from([0, 255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 0, 255, 255, 255, 255, 255, 255]))), chunk("IEND", Buffer.alloc(0))]);
}

export function fakeChat() {
  const threads = new Map();
  const posts = [];
  const controls = [];
  const reactions = [];
  const handlers = {};
  let sequence = 0;
  const chat = {
    posts, controls, reactions, handlers,
    onNewMention(fn) { handlers.mention = fn; },
    onSubscribedMessage(fn) { handlers.reply = fn; },
    onAction(fn) { handlers.action = fn; }, onModalSubmit(_, fn) { handlers.custom = fn; },
    initialize: async () => {}, shutdown: async () => {},
    thread(id) {
      if (threads.has(id)) return threads.get(id);
      const thread = {
        id, channel: { isDM: false, channelVisibility: "private" },
        subscribe: async () => {}, startTyping: async () => {},
        post: async (content) => {
          const message = { id: `${++sequence}.000`, thread: id, content };
          posts.push(message);
          return message;
        },
        adapter: {
          addReaction: async (thread, message, emoji) => { reactions.push({ thread, message, emoji, added: true }); },
          removeReaction: async (thread, message, emoji) => { reactions.push({ thread, message, emoji, added: false }); },
          webClient: { chat: {
            postMessage: async (content) => { const item = { ...content, ts: `${++sequence}.000`, thread: id }; controls.push(item); return item; },
            update: async (content) => { const item = controls.find((item) => item.ts === content.ts); Object.assign(item, { updated: content }); },
            delete: async (content) => { const item = controls.find((item) => item.ts === content.ts); item.deleted = true; },
          } },
        },
      };
      threads.set(id, thread);
      return thread;
    },
    send(id, prompt, mention = true, author = {}, attachments = []) {
      const message = { id: `${++sequence}.000`, text: prompt, attachments, isMention: mention, author: { userId: "UMATRIX", isMe: false, isBot: false, ...author }, raw: {} };
      handlers[mention ? "mention" : "reply"](chat.thread(id), message);
      return message;
    },
  };
  return chat;
}

export async function observeRuntimeReadiness({ facade, baseUrl, workingDirectory, environment, pin, fetch: fetchImpl = fetch, startupTimeoutMs = 1000 }) {
  const connection = await facade.checkOpenCodeConnection(baseUrl, workingDirectory, { environment, fetch: fetchImpl, startupTimeoutMs });
  assertPin(connection.version, pin);
  const response = await fetchImpl(`${baseUrl}${connection.major === 1 ? "/global/health" : "/api/info"}`, { signal: AbortSignal.timeout(startupTimeoutMs) });
  try { assert.equal(response.status, 401, "Engine must require authentication"); }
  finally { await response.body?.cancel(); }
  return connection;
}

export async function runCell({ candidate, pin, mode, migration = false, caseIds }) {
  if (caseIds !== undefined) assert.ok(Array.isArray(caseIds) && caseIds.length && new Set(caseIds).size === caseIds.length && caseIds.every((id) => releaseCases.some((row) => row.id === id)), "Invalid targeted case selection");
  const engineBinaries = JSON.parse(process.env.PIPA_MATRIX_ENGINE_BINARIES ?? "{}");
  const runtime = await createRuntimeFixture({ timeoutMs: 7 * 60_000 });
  // This code runs only in the privately spawned cell process, never in the host.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(runtime.env, {
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1",
    OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS: "true",
    OPENCODE_PASSWORD: "synthetic-loopback-only", OPENCODE_SERVER_PASSWORD: "synthetic-loopback-only", OPENCODE_LOG_LEVEL: "ERROR",
    PIPA_INTEGRATION_SENTINEL: "matrix-integration", npm_config_cache: path.join(runtime.cache, "npm"),
  });
  // Attached servers are independently launched by this harness, not by Pipa.
  // Match the documented v2 server configuration; owned startup must supply its own default.
  if (pin.startsWith("2.") && mode === "attached") runtime.env.BUN_JSC_maxRegExpStackSize = "536870912";
  Object.assign(process.env, runtime.env);
  const load = (file) => import(pathToFileURL(path.join(candidate, "src", `${file}.mjs`)).href);
  const [appModule, facade, state, routines, restart] = await Promise.all(["app", "opencode", "state", "routines", "restart"].map(load));
  const cell = { cases: [], adapterSelected: null, clientVersion: null, client: "Production native fetch facade", engineReported: null, migrationRequested: migration, ...(caseIds ? { collection: "targeted-diagnostic", caseSelection: caseIds } : {}), evidence: {} };
  if (runtime.env.BUN_JSC_maxRegExpStackSize) cell.evidence.serverRegexStackBytes = Number(runtime.env.BUN_JSC_maxRegExpStackSize);
  const cli = path.join(candidate, "bin", "pipa.mjs");
  const paths = state.pipaPaths(runtime.home);
  runtime.defer(async () => {
    assert.equal(await state.readInstanceLock(paths.lock), null, "Pipa lock leaked");
    const tickets = await readdir(paths.routinesLock).catch((error) => { if (error.code === "ENOENT") return []; throw error; });
    assert.deepEqual(tickets, [], "Routine mutation lock leaked");
    assert.deepEqual(await readdir(runtime.artifactRoot), [], "Artifact staging leaked");
    assert.ok(!(await readdir(runtime.temp)).some((name) => name.startsWith("pipa-files-")), "Attachment staging leaked");
  }, "profile locks and file staging");
  const config = { botName: "Matrix", workingDirectory: runtime.workspace, slackAppToken: "xapp-synthetic", slackBotToken: "xoxb-synthetic", allowedSlackChannelIds: ["CMATRIX"], allowedSlackUserIds: ["UMATRIX"], allowedSlackBotIds: [] };
  const provider = await createProvider(runtime);
  const definitions = await writeDefinitions(runtime, `DEFINITION_${randomUUID()}`, pin);
  const engineConfig = { ...providerConfig(provider.url), ...definitions.config };
  if (pin.startsWith("2.") && (!caseIds || caseIds.some((id) => id.startsWith("models-")))) {
    const modelProvider = (id) => ({ package: "@opencode/ai/providers/openai-compatible", settings: { baseURL: provider.url, apiKey: "synthetic-local-only" }, headers: { "x-matrix-provider": id }, models: {
      matrix: { variants: [{ id: "measured", body: { temperature: 0.37 } }], limit: { context: 64000, output: 8000 } },
      "matrix-next": { limit: { context: 64000, output: 8000 } }, disabled: { disabled: true },
    } });
    engineConfig.enabled_providers = ["matrix", "other"];
    engineConfig.providers = { matrix: modelProvider("matrix"), other: modelProvider("other"), excluded: modelProvider("excluded") };
  }
  // Exact-size plaintext attachment qualification must not hit this finite
  // provider fixture's ordinary 64k context and enter compaction before inference.
  if (!caseIds || caseIds.includes("attachment-10mib")) {
    for (const model of Object.values(engineConfig.provider.matrix.models)) model.limit.context = 16_000_000;
    for (const model of Object.values(engineConfig.providers?.matrix.models ?? {})) if (model.limit) model.limit.context = 16_000_000;
  }
  await writeFile(runtime.env.OPENCODE_CONFIG, JSON.stringify(engineConfig));
  const headers = { authorization: `Basic ${Buffer.from("opencode:synthetic-loopback-only").toString("base64")}` };
  const chat = fakeChat();
  const wires = [];
  let app;
  let executor;
  let server;
  let baseUrl;
  let startupError;
  let independent;
  let managed;
  let replacement;
  let port;
  let supersededMessage;
  let eventAbort;
  let eventConnections = 0;
  let disconnectEvents = false;
  let migrationJourney;
  let routineScheduler;
  const nonce = randomUUID().replaceAll("-", "");
  cell.evidence.nonce = nonce;
  const promptFor = (id) => `MATRIX_${id}_${nonce}`;
  const textFor = (id) => `RESULT_${id}_${nonce}`;
  const runCli = (...args) => command(runtime, process.execPath, [cli, ...args]);
  const connectedFetch = async (url, init = {}) => {
    const request = url instanceof Request ? url.clone() : null;
    const address = request?.url ?? String(url);
    const payload = init.body ?? (request && !["GET", "HEAD"].includes(request.method) ? await request.text() : undefined);
    if (payload) {
      const body = JSON.parse(payload);
      // Native v1 file parts and 2.0.29 URI/prepared attachments (generated
      // PromptFileAttachment/SessionPromptInput), independent of adapter choice.
      const parts = body.parts ? body.parts.filter((part) => part.type === "file") : body.files ?? [];
      const files = await Promise.all(parts.map(async (part) => {
        const uri = part.url ?? part.uri ?? part.source?.uri;
        if (typeof part.data === "string") return { filename: part.filename ?? part.name, transport: "base64", base64: part.data };
        assert.ok(uri?.startsWith("data:") || uri?.startsWith("file:"), "Unsupported native attachment transport");
        return { filename: part.filename ?? part.name, transport: uri.startsWith("data:") ? "data-uri" : "local", base64: uri.startsWith("data:") ? uri.split(",")[1] : (await readFile(new URL(uri))).toString("base64") };
      }));
      wires.push({ method: init.method ?? request?.method ?? "GET", path: new URL(address).pathname, body, files });
    }
    const eventConnection = disconnectEvents && new URL(address).pathname.endsWith("/event") ? new AbortController() : null;
    const signal = init.signal ?? request?.signal;
    const response = await fetch(url, eventConnection ? { ...init, signal: AbortSignal.any([eventConnection.signal, ...(signal ? [signal] : [])]) } : init);
    if (eventConnection && response.headers.get("content-type")?.includes("text/event-stream")) {
      eventConnections++;
      eventAbort = eventConnection;
    }
    return response;
  };
  const makeExecutor = (options) => {
    executor = facade.createOpenCodeExecutor({ ...options, environment: runtime.env, fetch: connectedFetch, pollIntervalMs: 50 });
    return executor;
  };
  const health = async (url = baseUrl) => {
    const connection = await observeRuntimeReadiness({ facade, baseUrl: url, workingDirectory: runtime.workspace, environment: runtime.env, pin });
    cell.adapterSelected = `v${connection.major} (authenticated identity; turn compatibility tested separately)`;
    cell.evidence.connection = { major: connection.major, version: connection.version, workspaceVerified: true };
    return connection;
  };
  const observeWorker = async (id) => {
    // Read process identity only, never arbitrary host command lines/environment.
    if (process.platform === "win32") {
      const query = `$p = Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${id}*' -and $_.CommandLine -like '*--worker*' }; @($p | ForEach-Object { $_.ProcessId }) | ConvertTo-Json -Compress`;
      const output = await command(runtime, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", query]);
      const value = output.trim() ? JSON.parse(output) : [];
      return (Array.isArray(value) ? value : [value]).filter(Number.isSafeInteger);
    }
    // ps output stays in memory; only the exact installed worker and request ID
    // are selected and only their PID is retained in evidence.
    const output = await command(runtime, "ps", ["-axo", "pid=,args="]);
    const worker = path.join(candidate, "src", "restart.mjs");
    return output.split("\n").filter((line) => line.includes(`${worker} --worker ${id}`)).map((line) => Number(line.trim().split(/\s/u)[0]));
  };
  const launchIndependent = async () => {
    independent = runtime.spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0"]);
    let output = "";
    for (const stream of [independent.child.stdout, independent.child.stderr]) stream.on("data", (data) => { output = (output + data).slice(-16384); });
    baseUrl = await runtime.waitFor(() => {
      assert.equal(independent.child.exitCode, null, `Independent engine exited before listening: ${output}`);
      return output.match(/http:\/\/127\.0\.0\.1:\d+/u)?.[0];
    }, { timeoutMs: 15_000, label: "native listening URL" });
  };
  const startApp = async (serverOverride) => {
    // Targeted case selection must not depend on package-cli having saved config.
    await state.writePrivateJson(paths.config, config);
    app = await appModule.startPipa({ config, paths, chat, checkSlackToken: async () => ({ ok: true }), startupTimeoutMs: 20000, shutdownTimeoutMs: 5000, routineIntervalMs: 100,
      createRoutineScheduler: (options) => { routineScheduler = routines.createRoutineScheduler(options); return routineScheduler; },
      createExecutor: makeExecutor,
      ...(serverOverride ? { server: serverOverride } : {}),
      startServer: async (input, options) => {
        server = await facade.startSocketOpenCodeServer(input, { ...options, environment: runtime.env,
          ...(mode === "attached" ? { attachUrl: baseUrl } : {}),
          spawn: (cmd, args, options) => runtime.spawn(cmd, args, options).child,
        });
        baseUrl = server.baseUrl;
        return server;
      },
    });
    const started = app;
    runtime.defer(() => started.shutdown(), "Pipa app/runner/scheduler");
  };
  const requireApp = () => app ? null : { status: "BLOCKED", observed: `Production app unavailable: ${startupError?.message ?? "Managed mode intentionally has no Chat/scheduler"}` };
  const requireExecutor = () => executor ? null : { status: "BLOCKED", observed: "Installed facade unavailable after engine startup failure" };
  const turn = async (id, input = {}, script = {}, selectedExecutor = executor) => {
    const prompt = promptFor(id);
    provider.register({ prompt, text: textFor(id), ...script });
    const controller = new AbortController();
    let session;
    const timer = setTimeout(() => controller.abort(new Error(`Case ${id} deadline exceeded`)), 12_000);
    try { return await selectedExecutor.runTurn({ prompt, workingDirectory: runtime.workspace, signal: controller.signal, ...input, onSession: async (id) => { session = id; await input.onSession?.(id); } }); }
    finally { clearTimeout(timer); if (controller.signal.aborted && session) await selectedExecutor.abortTurn(session); }
  };
  const environmentTool = (marker) => ({ names: ["bash", "shell", "$shell"], arguments: () => ({
    command: `"${process.execPath}" -e "if(process.env.PIPA_INTEGRATION_SENTINEL!=='matrix-integration'||Object.keys(process.env).some(k=>/(?:^|_)SLACK.*(?:TOKEN|SECRET)$/i.test(k)))process.exit(23);console.log('${marker}')"`,
    description: "Verify inherited integration environment and excluded Slack credentials after restart",
  }), verify: (results) => assert.ok(JSON.stringify(results).includes(marker), "Replacement tool environment check did not execute") });
  const waitMessage = async (message, label = "Chat turn settlement") => runtime.waitFor(() => chat.reactions.some((item) => item.message === message.id && !item.added), { timeoutMs: 15_000, label });
  const send = async (id, thread, mention = true) => {
    provider.register({ prompt: promptFor(id), text: textFor(id) });
    const message = chat.send(thread, promptFor(id), mention);
    await waitMessage(message);
    const result = chat.posts.findLast((post) => post.thread === thread);
    assert.equal(result?.content?.markdown, textFor(id));
    assert.ok(chat.reactions.some((item) => item.message === message.id && item.emoji === "white_check_mark"));
    return result;
  };
  const inputReceipt = (prompt) => {
    const input = wires.find((wire) => isNativeAdmission(wire, prompt));
    assert.ok(input, "Exact user prompt missing from actual production HTTP admission");
    assertPromptReceipt({ prompt: input.body.text ?? input.body.parts.find((part) => part.type === "text" && part.text === prompt).text, context: {} }, { prompt, context: {} });
    return input;
  };
  const execute = {
    "package-cli": async () => {
      const pkg = JSON.parse(await readFile(path.join(candidate, "package.json"), "utf8"));
      assert.equal((await runCli("--version")).trim(), pkg.version);
      assert.match(await runCli("--help"), /pipa start/u);
      await state.writePrivateJson(paths.config, config);
      const preview = JSON.parse(await runCli("routine", "create", "--prompt", promptFor("preview"), "--timezone", "UTC", "--channel", "CMATRIX", "--every", "1m", "--preview", "--json"));
      assert.equal(preview.preview, true);
      await assert.rejects(readFile(paths.routines), { code: "ENOENT" });
    },
    "init-identity": async () => {
      cell.engineReported = await facade.runOpenCodeVersion({ environment: runtime.env, spawn: (cmd, args, options) => runtime.spawn(cmd, args, options).child });
      assertPin(cell.engineReported, pin);
      const before = await readFile(paths.config, "utf8");
      try {
        await appModule.initializePipa({ ...config, allowedSlackChannelIds: config.allowedSlackChannelIds, allowedSlackUserIds: config.allowedSlackUserIds }, { paths,
          checkSlackToken: async () => ({ ok: true }), checkSlackAppToken: async () => {},
        });
      } catch (error) {
        assert.equal(await readFile(paths.config, "utf8"), before, "Failed init mutated config");
        throw error;
      }
    },
    "startup-readiness": async () => {
      try {
        if (mode === "managed") {
          let output = "";
          for (let attempt = 0; attempt < 3; attempt++) {
            const reservation = createServer();
            await runtime.listen(reservation);
            port = reservation.address().port;
            await new Promise((resolve) => reservation.close(resolve));
            baseUrl = `http://127.0.0.1:${port}`;
            await state.writePrivateJson(paths.config, { ...config, slackMode: "managed", openCodeHostname: "127.0.0.1", openCodePort: port });
            managed = runtime.spawn(process.execPath, [cli, "start"]);
            output = "";
            for (const stream of [managed.child.stdout, managed.child.stderr]) stream.on("data", (data) => { output = (output + data).slice(-8192); });
            try {
              await runtime.waitFor(async () => {
                assert.equal(managed.child.exitCode, null, `Actual Managed CLI exited before readiness: ${output}`);
                return health().catch(() => false);
              }, { timeoutMs: 20000, label: "production workspace readiness" });
              break;
            } catch (error) {
              cell.evidence.managedStartup = output.replaceAll(runtime.root, "<private>");
              if (attempt === 2 || !/EADDRINUSE|address.*in use/iu.test(output)) throw error;
              await bounded(managed.exited, { timeoutMs: 5000 });
            }
          }
          const managedUrl = baseUrl;
          runtime.defer(async () => {
            const lock = await state.readInstanceLock(paths.lock);
            if (lock) {
              process.kill(lock.pid, "SIGTERM");
              await waitFor(async () => !await state.readInstanceLock(paths.lock), { timeoutMs: 4000, label: "Managed lock release" });
            }
            await waitFor(() => fetch(managedUrl, { signal: AbortSignal.timeout(500) }).then(() => false, () => true), { timeoutMs: 4000, label: "Managed port close" });
            if (replacement?.pid) await waitFor(() => !state.isRunning(replacement.pid), { timeoutMs: 4000, label: "replacement exit" });
          }, "Managed CLI/replacement/lock/port");
          const connection = await health();
          makeExecutor({ baseUrl, connection, artifactRoot: runtime.artifactRoot });
        } else {
          if (mode === "attached") await launchIndependent();
          await startApp();
          assert.equal(app.server.owned, mode === "socket-owned");
          await health();
        }
      } catch (error) {
        startupError = error;
        // Diagnostic facade probe still uses the real native engine; it does not
        // bypass readiness for the product app or claim startup was successful.
        if (!baseUrl || (!app && (mode === "socket-owned" || mode === "managed"))) await launchIndependent();
        makeExecutor({ baseUrl, artifactRoot: runtime.artifactRoot });
        throw error;
      }
    },
    "exact-prompt-continuation": async () => {
      if (requireExecutor()) return requireExecutor();
      const prompt = `  ${promptFor("exact")} café\n\t$(never execute this)  \n`;
      provider.register({ prompt: promptFor("exact"), text: textFor("exact") });
      const result = await turn("exact-call", { prompt });
      assertTurnOutcome(result, { sessionId: result.sessionId, text: textFor("exact") });
      inputReceipt(prompt);
      const next = await turn("recall", { sessionId: result.sessionId }, { verify: (messages) => assert.ok(JSON.stringify(messages).includes(promptFor("exact")), "Earlier history absent from real provider request") });
      assertTurnOutcome(next, { sessionId: result.sessionId, text: textFor("recall") });
      cell.evidence.sessionId = result.sessionId;
    },
    "chat-continuation": async () => {
      if (requireApp()) return requireApp();
      const thread = "slack:CMATRIX:100.001";
      await send("mention", thread);
      const first = JSON.parse(await readFile(paths.sessions, "utf8"))[thread];
      await send("followup", thread, false);
      assert.equal(JSON.parse(await readFile(paths.sessions, "utf8"))[thread], first);
      for (const id of ["mention", "followup"]) inputReceipt(promptFor(id));
      assert.equal(chat.posts.filter((post) => post.thread === thread).length, 2);
    },
    "chat-authorization": async () => {
      if (requireApp()) return requireApp();
      const counts = [chat.posts.length, chat.reactions.length, provider.receipts.length, wires.length];
      chat.send("slack:COTHER:101.001", promptFor("wrong-channel"));
      chat.send("slack:CMATRIX:101.002", promptFor("wrong-user"), true, { userId: "UOTHER" });
      chat.send("slack:CMATRIX:101.003", promptFor("wrong-bot"), true, { isBot: true });
      await new Promise(setImmediate);
      assert.deepEqual([chat.posts.length, chat.reactions.length, provider.receipts.length, wires.length], counts);
    },
    "supersession-concurrency": async () => {
      if (requireApp()) return requireApp();
      const thread = "slack:CMATRIX:200.001";
      provider.register({ prompt: promptFor("held"), hold: true });
      const old = chat.send(thread, promptFor("held"));
      supersededMessage = old;
      const receipt = await runtime.waitFor(() => provider.receipts.find((receipt) => receipt.prompt === promptFor("held")), { timeoutMs: 12000, label: "held provider barrier" });
      await send("independent", "slack:CMATRIX:200.002");
      await send("replacement", thread, false);
      await runtime.waitFor(() => receipt.closed, { timeoutMs: 5000, label: "engine-side cancellation" });
      assert.equal(chat.posts.filter((post) => post.thread === thread).length, 1);
      assert.ok(!chat.posts.some((post) => JSON.stringify(post.content).includes(promptFor("held"))));
      assert.ok(!chat.reactions.some((item) => item.message === old.id && item.emoji === "warning"));
    },
    "supersession-reaction-contract": async () => {
      if (requireApp()) return requireApp();
      assert.ok(supersededMessage, "Supersession case did not reach replacement");
      assert.ok(!chat.reactions.some((item) => item.message === supersededMessage.id && item.added && item.emoji === "white_check_mark"), "Superseded message received a success reaction after replacement settlement");
    },
    "questions-permissions-tools": async () => {
      if (requireApp()) return requireApp();
      for (const kind of ["question", "permission"]) {
        const id = `interactive-${kind}`;
        const thread = `slack:CMATRIX:${kind === "question" ? "300.001" : "300.002"}`;
        const marker = textFor(id);
        provider.register({ prompt: promptFor(id), text: marker, tool: kind === "question"
          ? { names: ["question", "form"], arguments: (_, tool) => tool.name === "question" ? { questions: [{ header: "Matrix", question: "Choose the test answer", options: [{ label: "Yes", description: "Continue" }] }] } : { title: "Matrix", fields: [{ key: "answer", type: "string", title: "Choose", options: [{ value: "yes", label: "Yes" }], required: true }] }, verify: (results) => assert.match(JSON.stringify(results), /Yes|yes/u) }
          : { names: ["bash", "shell", "$shell"], arguments: () => ({ command: `"${process.execPath}" -e "if(process.env.PIPA_INTEGRATION_SENTINEL!=='matrix-integration'||Object.keys(process.env).some(k=>/SLACK.*(TOKEN|SECRET)|^NODE_OPTIONS$|PROXY|ATTACH_URL/i.test(k)))process.exit(23);console.log('${marker}')"`, description: "Verify isolated tool environment and print a synthetic marker" }), verify: (results) => assert.ok(JSON.stringify(results).includes(marker), "Actual protected tool/environment verification did not execute") } });
        const message = chat.send(thread, promptFor(id));
        const control = await runtime.waitFor(() => chat.controls.findLast((item) => item.thread === thread), { timeoutMs: 12000, label: "native interaction card" });
        const elements = control.blocks.flatMap((block) => block.elements ?? []);
        const action = elements.find((element) => kind === "permission" ? element.action_id.startsWith("pipa_permission_once_") : element.action_id.startsWith("pipa_select_"));
        assert.ok(action);
        const value = kind === "permission" ? action.value : action.options[0].value;
        const event = { actionId: action.action_id, value, threadId: thread, user: { userId: "UMATRIX" } };
        for (const invalid of [{ ...event, threadId: "slack:CMATRIX:999.001" }, { ...event, user: { userId: "UOTHER" } }, { ...event, value: "wrong-nonce.once" }]) await chat.handlers.action(invalid);
        assert.equal(control.updated, undefined, "Unauthorized/stale decision acted");
        await chat.handlers.action(event);
        if (kind === "question") {
          const submit = elements.find((element) => element.action_id.startsWith("pipa_submit_"));
          await chat.handlers.action({ ...event, actionId: submit.action_id, value: submit.value });
        }
        await waitMessage(message);
        assert.equal(chat.posts.findLast((post) => post.thread === thread)?.content?.markdown, marker);
        assert.ok(provider.receipts.some((receipt) => receipt.prompt === promptFor(id) && receipt.toolResults.length), "Tool continuation absent");
        assert.ok(control.updated, "Accepted control did not settle");
      }
    },
    "question-multi-custom-dismiss": async () => {
      if (requireApp()) return requireApp();
      for (const [index, kind] of ["multi", "custom", "dismiss"].entries()) {
        const id = `question-${kind}`;
        const thread = `slack:CMATRIX:430.${index + 1}`;
        provider.register({ prompt: promptFor(id), text: textFor(id), tool: { names: ["question"], arguments: () =>
          ({ questions: [{ header: "Matrix", question: "Select synthetic answers", multiple: kind === "multi", custom: true, options: kind === "custom" ? [] : [{ label: "Yes", description: "First" }, { label: "Other", description: "Second" }] }] }),
          ...(kind === "dismiss" ? {} : { verify: (results) => { const text = JSON.stringify(results); assert.ok(text.includes(kind === "custom" ? "Custom matrix answer" : "Yes")); if (kind === "multi") assert.ok(text.includes("Other")); } }),
        } });
        const message = chat.send(thread, promptFor(id));
        const control = await runtime.waitFor(() => chat.controls.find((item) => item.thread === thread), { timeoutMs: 12000 });
        const elements = control.blocks.flatMap((block) => block.elements ?? []);
        const event = { threadId: thread, user: { userId: "UMATRIX" } };
        if (kind === "multi") {
          const select = elements.find((item) => item.type === "checkboxes");
          assert.ok(select, "Native multiple choice did not render checkboxes");
          await chat.handlers.action({ ...event, actionId: select.action_id, value: select.options[0].value, raw: { actions: [{ action_id: select.action_id, selected_options: select.options }] } });
          const submit = elements.find((item) => item.action_id.startsWith("pipa_submit_"));
          await chat.handlers.action({ ...event, actionId: submit.action_id, value: submit.value });
        } else if (kind === "custom") {
          const custom = elements.find((item) => item.action_id.startsWith("pipa_custom_"));
          assert.ok(custom, "Native custom answer control absent");
          await chat.handlers.action({ ...event, actionId: custom.action_id, value: custom.value, openModal: async () => {} });
          await chat.handlers.custom({ privateMetadata: custom.value, relatedThread: { id: thread }, user: event.user, values: { answer: "Custom matrix answer" } });
        } else {
          const dismiss = elements.find((item) => item.action_id.startsWith("pipa_dismiss_"));
          await chat.handlers.action({ ...event, actionId: dismiss.action_id, value: dismiss.value });
        }
        await waitMessage(message, `${kind} question turn settlement`);
        if (kind === "dismiss") {
          assert.ok(!chat.posts.some((item) => item.thread === thread));
          assert.match(control.updated.text, /Dismissed/u);
        } else assert.equal(chat.posts.find((item) => item.thread === thread)?.content.markdown, textFor(id));
        assertNativeAdmissionCount(wires, promptFor(id), 1);
        assert.equal(chat.controls.filter((item) => item.thread === thread).length, 1);
        (cell.evidence.questionVariants ??= []).push({ kind, settled: true, nativeAdmissions: 1 });
      }
    },
    "question-rejected-retry": async () => {
      if (requireExecutor()) return requireExecutor();
      const calls = [];
      let selected;
      const result = await turn("question-retry", { onInteraction: async (interaction) => {
        selected = interaction;
        calls.push(interaction.request);
        // Submission acknowledgement is the additive production seam from KTD5.
        if (typeof interaction.submit !== "function") return { type: "answer", answers: [["Yes"]] };
        await assert.rejects(interaction.submit({ type: "answer", answers: [[]] }));
        return { type: "answer", answers: [["Yes"]] };
      } }, { tool: { names: ["question", "form"], arguments: (_, tool) => tool.name === "question" ? { questions: [{ header: "Retry", question: "Pick an answer", options: [{ label: "Yes", description: "Continue" }] }] } : { title: "Retry", fields: [{ key: "q0", type: "string", options: [{ value: "Yes", label: "Yes" }], required: true }] } } });
      assertTurnOutcome(result, { sessionId: result.sessionId, text: textFor("question-retry") });
      assert.equal(calls.length, 1);
      if (typeof selected.submit !== "function") return { status: "BLOCKED", observed: `Real question executed, but production callback fields are ${Object.keys(selected).join(", ")}; no native acceptance/rejected-retry submission seam exists` };
    },
    "delegated-child": async () => {
      if (requireExecutor()) return requireExecutor();
      const childPrompt = promptFor("child");
      provider.register({ prompt: childPrompt, text: textFor("child"), allowMissingTool: true, steps: [
        { names: ["question", "form"], arguments: (_, tool) => tool.name === "question" ? { questions: [{ header: "Child", question: "Approve child continuation", options: [{ label: "Yes", description: "Continue" }] }] } : { title: "Child", fields: [{ key: "q0", type: "string", options: [{ value: "Yes", label: "Yes" }], required: true }] } },
        { names: ["bash", "shell", "$shell"], arguments: () => ({ command: `"${process.execPath}" -e "console.log('${textFor("child")}')"`, description: "Execute protected child tool" }), verify: (results) => assert.ok(JSON.stringify(results).includes(textFor("child"))) },
      ] });
      const interactions = [];
      let parent;
      const result = await turn("delegate", { onSession: (id) => { parent = id; }, onInteraction: async (interaction) => {
        interactions.push({ type: interaction.type, session: interaction.sessionId });
        return interaction.type === "question" ? { type: "answer", answers: [["Yes"]] } : { type: "reply", reply: "once" };
      } }, { allowMissingTool: true, tool: { names: ["task", "subagent"], arguments: (_, tool) => tool.name === "task" ? { description: "Run synthetic foreground child", prompt: childPrompt, subagent_type: "matrix-fixture" } : { description: "Run synthetic foreground child", prompt: childPrompt, agent: "matrix-fixture" } } });
      const missing = provider.receipts.find((receipt) => [promptFor("delegate"), childPrompt].includes(receipt.prompt) && receipt.missingTool);
      if (missing) return { status: "BLOCKED", observed: `Actual ${missing.prompt === childPrompt ? "child" : "parent"} native catalog lacks ${missing.missingTool.join("/")}; advertised tools: ${missing.tools.map((tool) => tool.name).join(", ")}` };
      assertTurnOutcome(result, { sessionId: parent, text: textFor("delegate") });
      assert.ok(provider.receipts.some((receipt) => receipt.prompt === childPrompt), "Actual task tool never started child inference");
      const parentResult = provider.receipts.find((receipt) => receipt.prompt === promptFor("delegate") && receipt.toolResults.length);
      assert.ok(JSON.stringify(parentResult?.toolResults).includes(textFor("child")), "Child nonce did not return through real task tool");
      assert.ok(interactions.some((item) => item.type === "question" && item.session !== parent), "Child question was not routed through parent executor");
      assert.ok(interactions.some((item) => item.type === "permission" && item.session !== parent), "Child protected tool permission was not routed");
      cell.evidence.childInteractions = interactions;
    },
    "background-child": async () => {
      if (requireExecutor()) return requireExecutor();
      const receipt = provider.receipts.find((receipt) => receipt.prompt === promptFor("delegate"));
      if (!receipt) return { status: "BLOCKED", observed: "Foreground native delegation did not reach a provider tool catalog; no background operation can be selected safely" };
      const tool = receipt.tools.find((tool) => ["task", "subagent"].includes(tool.name));
      const fields = Object.keys(tool?.parameters?.properties ?? {});
      const background = ["run_in_background", "background"].find((field) => fields.includes(field));
      if (!background) return { status: "BLOCKED", observed: `Real native ${tool?.name ?? "delegation"} schema fields: ${fields.join(", ")}; with OPENCODE_EXPERIMENTAL_BACKGROUND_SUBAGENTS=true, no background selector is advertised; facade operations: ${Object.keys(executor).join(", ")}` };
      const child = promptFor("background-child");
      provider.register({ prompt: child, text: textFor("background-child"), hold: true });
      const completed = (messages) => JSON.stringify(messages).includes(textFor("background-child"));
      const pending = turn("background-parent", {}, {
        maxCalls: 6, toolOnce: true,
        // Native background completion may add a new user projection. Accept only
        // this parent's unique history plus this child's actual result marker.
        match: (messages) => completed(messages) && JSON.stringify(messages).includes(promptFor("background-parent")),
        text: (messages) => `${textFor("background-parent")}:${completed(messages) ? "child-complete" : "child-pending"}`,
        tool: { names: [tool.name], arguments: () => ({ description: "Run actual synthetic background child", prompt: child, ...(tool.name === "task" ? { subagent_type: "matrix-fixture" } : { agent: "matrix-fixture" }), [background]: true }) },
      });
      try {
        await runtime.waitFor(() => provider.receipts.some((receipt) => receipt.prompt === child), { timeoutMs: 5000, label: "actual held background inference" });
        // Characterized v1 behavior: the foreground result returns while a native
        // background child remains held. Pipa does not invent late-result delivery.
        const result = await pending;
        provider.release(child);
        const admission = inputReceipt(promptFor("background-parent"));
        // Derive the native read namespace from the actual facade admission,
        // never from a forced adapter or requested engine generation.
        const namespace = admission.path.startsWith("/api/") ? "/api" : "";
        const projection = new URL(`${baseUrl}${namespace}/session/${encodeURIComponent(result.sessionId)}/message`);
        projection.searchParams.set("limit", "100");
        if (namespace) projection.searchParams.set("order", "asc");
        else projection.searchParams.set("directory", runtime.workspace);
        await runtime.waitFor(async () => {
          const response = await fetch(projection, { headers, signal: AbortSignal.timeout(1000) });
          assert.ok(response.ok, `Native background projection HTTP ${response.status}`);
          return completed(await response.json());
        }, { timeoutMs: 5000, label: "authoritative parent projection contains background child result" });
        const drained = await turn("background-drain", { sessionId: result.sessionId }, { verify: (messages) => assert.ok(completed(messages), "Native background result never returned to parent history") });
        assertTurnOutcome(drained, { sessionId: result.sessionId, text: textFor("background-drain") });
        cell.evidence.background = { selector: background, publicResult: result.text, childProviderObserved: true, parentSession: result.sessionId, drainRetainedChildHistory: true };
      } finally {
        if (provider.receipts.some((receipt) => receipt.prompt === child)) provider.release(child);
        await pending.catch(() => undefined);
      }
    },
    "background-result-attribution": async () => {
      if (!cell.evidence.background) return { status: "BLOCKED", observed: "Native background case did not reach its held-child barrier and result observation" };
      assert.equal(cell.evidence.background.publicResult, `${textFor("background-parent")}:child-pending`);
    },
    "definitions-mcp-skill": async () => {
      if (requireExecutor()) return requireExecutor();
      if (pin.startsWith("2.")) await runtime.waitFor(async () => {
        const response = await fetch(`${baseUrl}/api/mcp?directory=${encodeURIComponent(runtime.workspace)}`, { headers, signal: AbortSignal.timeout(1000) });
        assert.ok(response.ok, `Native MCP discovery HTTP ${response.status}`);
        const result = await response.json();
        return result.data.some((server) => server.name === "matrix" && server.status.status === "connected");
      }, { timeoutMs: 10000, label: "native fixture MCP connection" });
      for (const [kind, names, args] of [["mcp", ["matrix_nonce", "mcp_matrix_nonce"], {}], ["skill", ["skill"], { name: "matrix-fixture" }]]) {
        const id = `definition-${kind}`;
        const result = await turn(id, {}, { allowMissingTool: true, tool: { names, arguments: (_, tool) => kind === "skill" && tool.parameters.properties.id ? { id: "matrix-fixture" } : args, verify: (results) => assert.ok(JSON.stringify(results).includes(definitions.marker), `Native ${kind} did not return fixture bytes: ${JSON.stringify(results).slice(0, 1000)}`) } });
        const missing = provider.receipts.find((receipt) => receipt.prompt === promptFor(id) && receipt.missingTool);
        if (missing) return { status: "BLOCKED", observed: `Real native ${kind} catalog: ${missing.tools.map((tool) => tool.name).join(", ")}; ${names.join("/")} not registered from private file/config` };
        assertTurnOutcome(result, { sessionId: result.sessionId, text: textFor(id) });
      }
      const pluginLoads = (await readFile(definitions.pluginLog, "utf8")).trim().split("\n").map(JSON.parse).filter((item) => item.kind === "loaded").length;
      assert.ok(pluginLoads > 0, "Private plugin never loaded");
      cell.evidence.definitionPluginLoads = pluginLoads;
    },
    "definitions-command": async () => {
      if (requireExecutor()) return requireExecutor();
      const inspection = runtime.spawn("opencode", ["run", "--help"]);
      let help = "";
      for (const stream of [inspection.child.stdout, inspection.child.stderr]) stream.on("data", (data) => { help = (help + data).slice(-32000); });
      assert.equal((await bounded(inspection.exited, { timeoutMs: 15000 })).code, 0, "Native command capability inspection failed");
      cell.evidence.commandHelp = help.slice(0, 3000);
      const attach = help.includes("--attach") ? "--attach" : help.includes("--server") ? "--server" : null;
      let invocation;
      if (pin.startsWith("2.")) {
        // V2 removed run --command; its supported CLI API invokes session.command.
        // Admission is not completion: collect only the completed native assistant.
        const probe = path.join(runtime.workspace, "matrix-command.mjs");
        await writeFile(probe, `import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
const base = ${JSON.stringify(baseUrl)};
const api = (method, route, data) => execFileSync('opencode', ['api', method, route, '--server', base, ...(data ? ['--data', JSON.stringify(data)] : [])], {encoding:'utf8', timeout:10000});
const session = JSON.parse(api('POST', '/api/session', {location:{directory:${JSON.stringify(runtime.workspace)}}})).data;
assert.ok(session.id);
api('POST', '/api/session/'+session.id+'/command', {name:'matrix-fixture',text:''});
const deadline = Date.now()+8000;
while (Date.now()<deadline) {
  const response = await fetch(base+'/api/session/'+session.id+'/message?limit=100&order=asc', {headers:{authorization:'Basic '+Buffer.from('opencode:'+process.env.OPENCODE_PASSWORD).toString('base64')},signal:AbortSignal.timeout(1000)});
  assert.ok(response.ok);
  const messages = (await response.json()).data;
  const assistant = messages.findLast(message => message.type==='assistant' && typeof message.time?.completed==='number');
  if (assistant) { assert.ok(!assistant.error); console.log(assistant.content.filter(part=>part.type==='text').map(part=>part.text).join('\\n')); process.exit(0); }
  await delay(50);
}
throw Error('Native file-command completion deadline exceeded');
`);
        invocation = `"${process.execPath}" "${probe}"`;
        cell.evidence.commandInterface = "Pinned opencode api: session.create, session.command, then authoritative completed assistant projection";
      } else {
        if (!help.includes("--command") || !attach) return { status: "BLOCKED", observed: `Actual pinned native run --help advertises command=${help.includes("--command")}, attach=${attach ?? "none"}; cannot invoke private file command against the selected server safely` };
        invocation = `opencode run ${attach} ${baseUrl} --command matrix-fixture${help.includes("--model") ? " --model matrix/matrix" : ""}${help.includes("--format") ? " --format json" : ""}`;
      }
      provider.register({ prompt: definitions.marker, text: textFor("file-command") });
      const result = await turn("command-via-tool", { onInteraction: async ({ type }) => { assert.equal(type, "permission"); return { type: "reply", reply: "once" }; } }, {
        tool: { names: ["bash", "shell", "$shell"], arguments: () => ({ command: invocation, description: "Invoke the pinned engine's real file-defined command" }) },
      });
      assertTurnOutcome(result, { sessionId: result.sessionId, text: textFor("command-via-tool") });
      assert.ok(provider.receipts.some((receipt) => receipt.prompt === definitions.marker), "Native CLI never expanded the actual command file into a provider request");
      const returned = provider.receipts.find((receipt) => receipt.prompt === promptFor("command-via-tool") && receipt.toolResults.length);
      if (pin.startsWith("1.") && !JSON.stringify(returned?.toolResults).includes(textFor("file-command"))) {
        // Characterize the upstream attached-CLI defect without passing its gate.
        const standalone = await turn("command-standalone", { onInteraction: async ({ type }) => { assert.equal(type, "permission"); return { type: "reply", reply: "once" }; } }, {
          tool: { names: ["bash"], arguments: () => ({ command: "opencode run --command matrix-fixture --model matrix/matrix --format json", description: "Compare an isolated standalone native file command" }) },
        });
        assertTurnOutcome(standalone, { sessionId: standalone.sessionId, text: textFor("command-standalone") });
        const output = provider.receipts.find((receipt) => receipt.prompt === promptFor("command-standalone") && receipt.toolResults.length);
        assert.ok(JSON.stringify(output?.toolResults).includes(textFor("file-command")), "Standalone native command also lost output");
        const loads = (await readFile(definitions.pluginLog, "utf8")).trim().split("\n").map(JSON.parse).filter((entry) => entry.kind === "loaded");
        assert.ok(loads.some((entry) => entry.version === 2), "Fresh native process did not load modified plugin bytes");
        cell.evidence.commandStandalone = { completedOutput: true, freshProcessLoadedPluginVersion: 2, attachedOutputMissing: true };
      }
      assert.ok(JSON.stringify(returned?.toolResults).includes(textFor("file-command")), `Native command result absent from production tool output: ${JSON.stringify(returned?.toolResults).slice(0, 1500)}`);
    },
    "models-switch": async () => {
      if (requireExecutor()) return requireExecutor();
      if (typeof executor.listModels !== "function" || typeof executor.switchModel !== "function") return { status: "BLOCKED", observed: `Installed production facade exposes ${Object.keys(executor).join(", ")}; native model discovery/switch seam absent` };
      const models = await executor.listModels({ workingDirectory: runtime.workspace });
      assert.equal(executor.capabilities.liveModelSwitch, true);
      assert.deepEqual(models.models.map(({ providerID, id }) => `${providerID}/${id}`).sort(), ["matrix/matrix", "matrix/matrix-next", "other/matrix", "other/matrix-next"]);
      assert.ok(!JSON.stringify(models).includes("synthetic-local-only"), "Discovery exposed provider credentials");
      cell.evidence.modelCatalog = models;
      const first = await turn("model-first");
      const get = async () => {
        const response = await connectedFetch(`${baseUrl}/api/session/${first.sessionId}`, { headers });
        assert.equal(response.status, 200);
        return response.json();
      };
      const before = await get();
      const writesBefore = wires.filter((wire) => wire.method === "POST" && wire.path.endsWith("/model")).length;
      for (const model of [{ providerID: "absent", id: "matrix" }, { providerID: "excluded", id: "matrix" }, { providerID: "matrix", id: "disabled" }, { providerID: "matrix", id: "matrix", variant: "absent" }]) {
        await assert.rejects(executor.switchModel({ sessionId: first.sessionId, model, workingDirectory: runtime.workspace }), /unavailable/u);
        assert.deepEqual(await get(), before, "Unavailable selection mutated the native session");
      }
      assert.equal(wires.filter((wire) => wire.method === "POST" && wire.path.endsWith("/model")).length, writesBefore);
      await executor.switchModel({ sessionId: first.sessionId, model: { providerID: "matrix", id: "matrix-next" }, workingDirectory: runtime.workspace });
      const next = await turn("model-next", { sessionId: first.sessionId }, { verify: (messages) => assert.ok(JSON.stringify(messages).includes(promptFor("model-first"))) });
      assertTurnOutcome(next, { sessionId: first.sessionId, text: textFor("model-next") });
      assert.equal(provider.receipts.find((receipt) => receipt.prompt === promptFor("model-next")).model, "matrix-next");
      await executor.switchModel({ sessionId: first.sessionId, model: { providerID: "other", id: "matrix" }, workingDirectory: runtime.workspace });
      await turn("model-other", { sessionId: first.sessionId });
      assert.equal(provider.receipts.find((receipt) => receipt.prompt === promptFor("model-other")).provider, "other");
      const running = turn("model-inflight", { sessionId: first.sessionId, onInteraction: () => ({ type: "answer", answers: [["Yes"]] }) }, {
        hold: true, holdOnce: true, tool: { names: ["question"], arguments: () => ({ questions: [{ header: "Timing", question: "Continue?", options: [{ label: "Yes", description: "Continue" }] }] }) },
      });
      // An already-issued request stays on the old provider; the next tool-loop
      // provider step in this same Pipa turn must use the new native selection.
      try {
        await runtime.waitFor(() => provider.receipts.find((receipt) => receipt.prompt === promptFor("model-inflight")), { label: "held provider step" });
        await executor.switchModel({ sessionId: first.sessionId, model: { providerID: "matrix", id: "matrix-next" }, workingDirectory: runtime.workspace });
      } finally { provider.release(promptFor("model-inflight")); }
      assertTurnOutcome(await running, { sessionId: first.sessionId, text: textFor("model-inflight") });
      const steps = provider.receipts.filter((receipt) => receipt.prompt === promptFor("model-inflight"));
      assert.deepEqual(steps.map(({ provider, model }) => [provider, model]), [["other", "matrix"], ["matrix", "matrix-next"]]);
      cell.evidence.modelTiming = { sessionId: first.sessionId, providerSteps: steps.map(({ provider, model }) => ({ provider, model })) };
    },
    "models-variants": async () => {
      if (requireExecutor()) return requireExecutor();
      const first = await turn("variant-first");
      await executor.switchModel({ sessionId: first.sessionId, model: { providerID: "matrix", id: "matrix", variant: "measured" }, workingDirectory: runtime.workspace });
      const next = await turn("variant-measured", { sessionId: first.sessionId }, { verify: (messages) => assert.ok(JSON.stringify(messages).includes(promptFor("variant-first"))) });
      assertTurnOutcome(next, { sessionId: first.sessionId, text: textFor("variant-measured") });
      assert.equal(provider.receipts.find((receipt) => receipt.prompt === promptFor("variant-measured")).temperature, 0.37);
      for (const [suffix, model] of [["omitted", { providerID: "matrix", id: "matrix" }], ["explicit", { providerID: "matrix", id: "matrix", variant: "default" }]]) {
        await executor.switchModel({ sessionId: first.sessionId, model, workingDirectory: runtime.workspace });
        await turn(`variant-${suffix}`, { sessionId: first.sessionId });
        assert.equal(provider.receipts.find((receipt) => receipt.prompt === promptFor(`variant-${suffix}`)).temperature, undefined);
      }
    },
    "models-default": async () => {
      if (requireExecutor()) return requireExecutor();
      const catalog = await executor.listModels({ workingDirectory: runtime.workspace });
      assert.deepEqual(catalog.defaultModel, { providerID: "matrix", id: "matrix", variant: "default" });
      await turn("model-default");
      const receipt = provider.receipts.find((receipt) => receipt.prompt === promptFor("model-default"));
      assert.deepEqual([receipt.provider, receipt.model, receipt.temperature], ["matrix", "matrix", undefined]);
    },
    "models-reset": async () => {
      if (requireExecutor()) return requireExecutor();
      const first = await turn("reset-first");
      await executor.switchModel({ sessionId: first.sessionId, model: { providerID: "other", id: "matrix", variant: "measured" }, workingDirectory: runtime.workspace });
      await turn("reset-selected", { sessionId: first.sessionId });
      await executor.switchModel({ sessionId: first.sessionId, model: null, workingDirectory: runtime.workspace });
      await turn("reset-default", { sessionId: first.sessionId }, { verify: (messages) => assert.ok(JSON.stringify(messages).includes(promptFor("reset-first"))) });
      const selected = provider.receipts.find((receipt) => receipt.prompt === promptFor("reset-selected"));
      const reset = provider.receipts.find((receipt) => receipt.prompt === promptFor("reset-default"));
      assert.deepEqual([selected.provider, selected.temperature, reset.provider, reset.model, reset.temperature], ["other", 0.37, "matrix", "matrix", undefined]);
      cell.evidence.modelReset = "Resolve native model.default at request time and explicitly switch to its default variant; native 2.0.29 rejects null and has no clear-override operation";
    },
    "failed-turn": async () => {
      if (requireExecutor()) return requireExecutor();
      await assert.rejects(turn("failure", {}, { fail: true }), /failed|status|response/iu);
      assert.ok(provider.receipts.some((receipt) => receipt.prompt === promptFor("failure")), "Failure occurred before the controlled provider request (native admission incompatible)");
    },
    "local-attachment-bytes": async () => {
      if (requireExecutor()) return requireExecutor();
      const bytes = Buffer.from(`café\n${textFor("attachment")}\n`);
      const result = await turn("attachment", { attachments: [{ name: "document.txt", mimeType: "text/plain", fetchData: async () => bytes }] }, { verify: (messages) => assert.ok(JSON.stringify(messages).includes(textFor("attachment")), "Native model request omitted document marker") });
      assertTurnOutcome(result, { sessionId: result.sessionId, text: textFor("attachment") });
      assert.deepEqual(inputReceipt(promptFor("attachment")).files.map(({ filename, base64 }) => ({ filename, base64 })), [{ filename: "document.txt", base64: bytes.toString("base64") }]);
    },
    "attachment-image-data-uri": async () => {
      if (requireExecutor()) return requireExecutor();
      const image = png();
      const document = Buffer.from(textFor("document-transport"));
      for (const transport of ["local", "data-uri"]) {
        const remote = transport === "data-uri" ? facade.createOpenCodeExecutor({ baseUrl: baseUrl.replace("127.0.0.1", "matrix.invalid"), environment: runtime.env, pollIntervalMs: 50,
          fetch: (url, init) => connectedFetch(url instanceof Request ? new Request(url.url.replace("matrix.invalid", "127.0.0.1"), url) : String(url).replace("matrix.invalid", "127.0.0.1"), init) }) : executor;
        try {
          const id = `image-${transport}`;
          const result = await turn(id, { attachments: [{ name: "pixel.png", mimeType: "image/png", fetchData: async () => image }, { name: "document.txt", mimeType: "text/plain", fetchData: async () => document }] }, {
            verify: (messages) => { assert.ok(JSON.stringify(messages).includes("data:image/png;base64,")); assert.ok(JSON.stringify(messages).includes(document.toString())); },
          }, remote);
          assertTurnOutcome(result, { sessionId: result.sessionId, text: textFor(id) });
          const files = inputReceipt(promptFor(id)).files;
          assert.deepEqual(files.map(({ filename, base64 }) => ({ filename, base64 })), [{ filename: "pixel.png", base64: image.toString("base64") }, { filename: "document.txt", base64: document.toString("base64") }]);
          if (transport === "data-uri") assert.ok(files.every((file) => file.transport !== "local"), "Remote-style admission depended on shared local files instead of encoded bytes");
        } finally { if (remote !== executor) remote.stopAll(); }
      }
    },
    "attachment-10mib": async () => {
      if (requireExecutor()) return requireExecutor();
      const bytes = Buffer.alloc(10 * 1024 * 1024, 97);
      for (const transport of ["local", "data-uri"]) {
        const remote = transport === "data-uri" ? facade.createOpenCodeExecutor({ baseUrl: baseUrl.replace("127.0.0.1", "matrix.invalid"), environment: runtime.env, pollIntervalMs: 50,
          fetch: (url, init) => connectedFetch(url instanceof Request ? new Request(url.url.replace("matrix.invalid", "127.0.0.1"), url) : String(url).replace("matrix.invalid", "127.0.0.1"), init) }) : executor;
        try {
          const id = `boundary-accepted-${transport}`;
          const result = await turn(id, { attachments: [{ name: "boundary.txt", size: bytes.length, mimeType: "text/plain", fetchData: async () => bytes }] }, {}, remote);
          assertTurnOutcome(result, { sessionId: result.sessionId, text: textFor(id) });
          const file = inputReceipt(promptFor(id)).files[0];
          assert.equal(file.base64, bytes.toString("base64"));
          if (transport === "data-uri") assert.notEqual(file.transport, "local");
        } finally { if (remote !== executor) remote.stopAll(); }
      }
    },
    "attachment-over-limit": async () => {
      if (requireExecutor()) return requireExecutor();
      const bytes = Buffer.alloc(10 * 1024 * 1024 + 1, 97);
      let failure;
      try { await turn("boundary-rejected", { attachments: [{ name: "oversized.txt", mimeType: "text/plain", fetchData: async () => bytes }] }); }
      catch (error) { failure = error; }
      assert.ok(failure, "Current product accepted 10 MiB + 1 decoded bytes instead of enforcing R8");
      assert.match(failure.message, /10.*MiB|too large|smaller/iu, `Oversized input failed for an unrelated reason: ${failure.message}`);
      assertNativeAdmissionCount(wires, promptFor("boundary-rejected"), 0);
    },
    "attachment-over-limit-metadata": async () => {
      if (requireApp()) return requireApp();
      const id = "metadata-rejected";
      provider.register({ prompt: promptFor(id), text: textFor(id) });
      let downloaded = false;
      const thread = "slack:CMATRIX:410.001";
      chat.send(thread, promptFor(id), true, {}, [{ name: "oversized.txt", size: 10 * 1024 * 1024 + 1, mimeType: "text/plain", fetchData: async () => { downloaded = true; return Buffer.from("small bytes behind oversized metadata"); } }]);
      await runtime.waitFor(() => chat.posts.some((post) => post.thread === thread), { timeoutMs: 15000 });
      assert.equal(downloaded, false, "Current product downloaded an attachment above R8 metadata limit");
      assert.match(JSON.stringify(chat.posts.find((post) => post.thread === thread).content), /10.*MiB/u);
      assertNativeAdmissionCount(wires, promptFor(id), 0);
    },
    "reconnect-stream": async () => {
      if (requireApp()) return requireApp();
      const id = "disconnect";
      const thread = "slack:CMATRIX:420.001";
      disconnectEvents = true;
      const before = eventConnections;
      provider.register({ prompt: promptFor(id), text: textFor(id), tool: { names: ["bash", "shell", "$shell"], arguments: () => ({ command: `"${process.execPath}" -e "console.log('${textFor(id)}')"`, description: "Hold for a real approval across stream disconnect" }), verify: (results) => assert.ok(JSON.stringify(results).includes(textFor(id))) } });
      try {
        const message = chat.send(thread, promptFor(id));
        const control = await runtime.waitFor(() => chat.controls.find((item) => item.thread === thread), { timeoutMs: 12000 });
        assert.ok(eventAbort, "Production did not subscribe to native event stream");
        eventAbort.abort(new Error("Controlled real event connection disconnect"));
        await runtime.waitFor(() => eventConnections >= before + 2, { timeoutMs: 5000, label: "real event reconnection" });
        const action = control.blocks.flatMap((block) => block.elements ?? []).find((element) => element.action_id.startsWith("pipa_permission_once_"));
        await chat.handlers.action({ actionId: action.action_id, value: action.value, threadId: thread, user: { userId: "UMATRIX" } });
        await waitMessage(message);
        assert.equal(chat.controls.filter((item) => item.thread === thread).length, 1);
        assert.equal(chat.posts.filter((item) => item.thread === thread).length, 1);
        assert.equal(chat.posts.find((item) => item.thread === thread).content.markdown, textFor(id));
        assertNativeAdmissionCount(wires, promptFor(id), 1);
      } finally { disconnectEvents = false; }
    },
    "reload-location": async () => {
      if (requireExecutor()) return requireExecutor();
      const before = await readFile(definitions.pluginLog, "utf8").then((text) => text.trim().split("\n").map(JSON.parse), (error) => { if (error.code === "ENOENT") return []; throw error; });
      await definitions.rewritePlugin(2);
      // Native 2.0.29 reloads all loaded locations; this cell owns one private server.
      const endpoint = pin.startsWith("2.") ? "/api/location/reload" : `/instance/dispose?directory=${encodeURIComponent(runtime.workspace)}`;
      const response = await fetch(`${baseUrl}${endpoint}`, { method: "POST", headers, signal: AbortSignal.timeout(5000) });
      assert.ok(response.ok, `Native location reload returned HTTP ${response.status}`);
      await health();
      const after = await readFile(definitions.pluginLog, "utf8").then((text) => text.trim().split("\n").map(JSON.parse), (error) => { if (error.code === "ENOENT") return []; throw error; });
      cell.evidence.reload = { pluginLoadsBefore: before.filter((item) => item.kind === "loaded").length, pluginLoadsAfter: after.filter((item) => item.kind === "loaded").length };
      const session = cell.evidence.sessionId;
      assert.ok(session);
      const result = await turn("reload-recall", { sessionId: session }, { verify: (messages) => assert.ok(JSON.stringify(messages).includes(promptFor("exact"))) });
      assertTurnOutcome(result, { sessionId: session, text: textFor("reload-recall") });
      assertNativeAdmissionCount(wires, promptFor("reload-recall"), 1);
    },
    "crash-after-instruction-registration": async () => ({ status: "BLOCKED", observed: `U2/U6: no separately observable owned instruction-registration/recovery seam in the production facade; v1 instructions are inline prompt system bytes. Operations: ${Object.keys(executor ?? {}).join(", ")}. Cannot substitute session creation or admission for this boundary.` }),
    "crash-after-admission": () => crashed("admission"),
    "crash-during-approval": () => crashed("approval"),
    "crash-after-completion": () => crashed("completion"),
    "plugin-reload-contract": async () => {
      if (!cell.evidence.reload) return { status: "BLOCKED", observed: "Native location reload case did not reach plugin observation" };
      const before = (await readFile(definitions.pluginLog, "utf8")).trim().split("\n").length;
      // A built-in tool isolates plugin lifecycle from asynchronous MCP discovery.
      const result = await turn("plugin-version", {}, { tool: { names: ["read"], arguments: (_, tool) => ({ [tool.parameters.properties.path ? "path" : "filePath"]: path.join(runtime.workspace, ".opencode", "commands", "matrix-fixture.md") }), verify: (results) => assert.ok(JSON.stringify(results).includes(definitions.marker)) } });
      assertTurnOutcome(result, { sessionId: result.sessionId, text: textFor("plugin-version") });
      const hooks = (await readFile(definitions.pluginLog, "utf8")).trim().split("\n").slice(before).map(JSON.parse).filter((item) => item.kind === "hook" && item.tool === "read");
      cell.evidence.reload.hooks = hooks;
      assert.equal(hooks.length, 1, "Native reload duplicated or lost plugin hook registration");
      assert.equal(hooks[0].version, 2, "Native location dispose/reload retained old plugin module bytes instead of loading modified private file");
    },
    "artifact-bytes": async () => {
      if (requireExecutor()) return requireExecutor();
      const bytes = Buffer.from(`matrix artifact café\n${nonce}\n`);
      const result = await turn("artifact", { contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack", PIPA_CURRENT_SLACK_CHANNEL_ID: "CMATRIX", PIPA_CURRENT_SLACK_THREAD_TS: "400.001" } }, {
        text: `${textFor("artifact")}\nPIPA_ARTIFACTS: ["result.txt"]`,
        tool: { names: ["write"], arguments: (messages, tool) => {
          const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n");
          const directory = system.match(/private artifact directory: ([^\n]+)/u)?.[1];
          assert.ok(directory, "Production artifact context missing");
          // Native v2 write uses `path`; v1 uses `filePath`. Select from the
          // actual tool schema, keeping the delivered-byte assertion unchanged.
          const key = tool.parameters.properties.path ? "path" : "filePath";
          assert.ok(tool.parameters.properties[key], "Native write tool has no supported path field");
          return { [key]: path.join(directory, "result.txt"), content: bytes.toString() };
        } },
      });
      assertTurnOutcome(result, { sessionId: result.sessionId, text: textFor("artifact"), files: [{ filename: "result.txt", base64: bytes.toString("base64") }] });
      cell.evidence.artifactSha256 = createHash("sha256").update(result.files[0].data).digest("hex");
      assert.deepEqual(await readdir(runtime.artifactRoot), [], "Artifact staging leaked");
    },
    "artifact-limits-fallback": async () => {
      if (requireExecutor()) return requireExecutor();
      const size = 20 * 1024 * 1024 + 1;
      const writer = path.join(runtime.workspace, "artifact-writer.cjs");
      await writeFile(writer, "require('node:fs').writeFileSync(process.argv[2], Buffer.alloc(Number(process.argv[3]), 97));\n");
      const result = await turn("large-artifact", {
        contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack", PIPA_CURRENT_SLACK_CHANNEL_ID: "CMATRIX" },
        onInteraction: async ({ type }) => { assert.equal(type, "permission"); return { type: "reply", reply: "once" }; },
      }, {
        text: `${textFor("large-artifact")}\nPIPA_ARTIFACTS: ["large.txt"]`,
        tool: { names: ["bash", "shell", "$shell"], arguments: (messages) => {
          const system = messages.filter((item) => item.role === "system").map((item) => item.content).join("\n");
          const directory = system.match(/private artifact directory: ([^\n]+)/u)?.[1];
          assert.ok(directory);
          return { command: `"${process.execPath}" "${writer}" "${path.join(directory, "large.txt")}" ${size}`, description: "Write a synthetic outgoing file above the incoming limit" };
        } },
      });
      assert.equal(result.files?.length, 1);
      assert.equal(result.files[0].data.length, size);
      assert.ok(Buffer.from(result.files[0].data).equals(Buffer.alloc(size, 97)), "Outgoing bytes changed");
      const attempts = [];
      await appModule.postResult({ post: async (content) => { attempts.push(content); if (content.files) throw new Error("Controlled upload failure"); return { id: "800.001" }; } }, result);
      assert.equal(attempts.length, 2, "Upload fallback must happen exactly once");
      assert.ok(attempts[0].files);
      assert.deepEqual(attempts[1], { markdown: textFor("large-artifact") });
      const unsafe = await turn("unsafe-artifact", { contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack" } }, { text: `${textFor("unsafe-artifact")}\nPIPA_ARTIFACTS: ["../unsafe.txt"]` });
      assertTurnOutcome(unsafe, { sessionId: unsafe.sessionId, text: textFor("unsafe-artifact") });
      assert.deepEqual(await readdir(runtime.artifactRoot), []);
    },
    "routine-cli": async () => {
      const prompt = `  ${promptFor("routine-cli")}\ncafé $(never execute)  \n`;
      provider.register({ prompt: promptFor("routine-cli"), text: textFor("routine-cli") });
      const file = path.join(runtime.workspace, "prompt.txt");
      await writeFile(file, prompt);
      const created = JSON.parse(await runCli("routine", "create", "--prompt-file", file, "--timezone", "UTC", "--channel", "CMATRIX", "--thread", "500.001", "--every", "1m", "--json")).routine;
      assert.equal(created.prompt, prompt);
      assert.deepEqual(JSON.parse(await runCli("routine", "show", created.id, "--json")).routine, created);
      assert.ok(JSON.parse(await runCli("routine", "list", "--json")).routines.some((item) => item.id === created.id));
      assert.equal(JSON.parse(await runCli("routine", "edit", created.id, "--status", "inactive", "--json")).routine.status, "inactive");
      assert.ok(JSON.parse(await runCli("routine", "run", created.id, "--json")).routine.runRequestedAt);
      assert.equal(JSON.parse(await runCli("routine", "edit", created.id, "--status", "active", "--json")).routine.status, "active");
      assert.equal(JSON.parse(await runCli("routine", "delete", created.id, "--json")).deleted, created.id);
    },
    "routine-once": () => scheduled("once"),
    "routine-recurring": () => scheduled("recurring"),
    "routine-revocation": async () => {
      if (requireApp()) return requireApp();
      const id = "revoke";
      provider.register({ prompt: promptFor(id), text: textFor(id), hold: true });
      await routines.createRoutine({ id, prompt: promptFor(id), timezone: "UTC", destination: { channelId: "CMATRIX", threadTs: "600.003" }, schedule: { type: "once", at: new Date(Date.now() + 500).toISOString() } }, { paths });
      const receipt = await runtime.waitFor(() => provider.receipts.find((item) => item.prompt === promptFor(id)), { timeoutMs: 12000, label: "revocation provider barrier" });
      await state.writePrivateJson(paths.config, { ...config, allowedSlackChannelIds: ["COTHER"] });
      provider.release(promptFor(id));
      await runtime.waitFor(async () => {
        const current = (await routines.loadRoutineState(paths.routines)).routines.find((item) => item.id === id);
        if (current?.lastRun) {
          assert.equal(current.lastRun.status, "denied", JSON.stringify(current.lastRun));
          assert.equal(current.status, "inactive");
          return current;
        }
        return false;
      }, { timeoutMs: 5000, label: "revoked routine terminal outcome" });
      assert.ok(!chat.posts.some((post) => post.thread === "slack:CMATRIX:600.003"));
      await state.writePrivateJson(paths.config, config);
      await routines.deleteRoutine(id, paths);
    },
    "routine-overlap-recovery": async () => {
      if (requireApp()) return requireApp();
      const id = "overlap-held";
      provider.register({ prompt: promptFor(id), text: textFor(id), hold: true });
      provider.register({ prompt: promptFor("overlap-independent"), text: textFor("overlap-independent") });
      for (const name of [id, "overlap-independent"]) await routines.createRoutine({ id: name, prompt: promptFor(name), timezone: "UTC", destination: { channelId: "CMATRIX", threadTs: name === id ? "610.001" : "610.002" }, schedule: { type: "once", at: new Date(Date.now() + 400).toISOString() } }, { paths });
      const held = await runtime.waitFor(() => provider.receipts.find((item) => item.prompt === promptFor(id)), { timeoutMs: 15000 });
      await runtime.waitFor(async () => (await routines.loadRoutineState(paths.routines)).routines.find((item) => item.id === "overlap-independent")?.lastRun?.status === "succeeded", { timeoutMs: 15000 });
      await routines.requestRoutineRun(id, new Date().toISOString(), paths);
      await schedulerBarrier("held routine overlap");
      assert.equal(provider.receipts.filter((item) => item.prompt === promptFor(id)).length, 1, "Same routine overlapped itself at subsequent ticks");
      const pending = (await routines.loadRoutineState(paths.routines)).routines.find((item) => item.id === id).runRequestedAt;
      assert.ok(pending);
      await app.shutdown();
      await runtime.waitFor(() => held.closed, { timeoutMs: 5000, label: "shutdown engine-side routine cancellation" });
      assert.equal((await routines.loadRoutineState(paths.routines)).routines.find((item) => item.id === id).runRequestedAt, pending);
      assert.ok(!chat.posts.some((item) => item.thread === "slack:CMATRIX:610.001"));
      const missedAt = Date.now() + 400;
      await routines.createRoutine({ id: "missed-once", prompt: promptFor("missed-once"), timezone: "UTC", destination: { channelId: "CMATRIX" }, schedule: { type: "once", at: new Date(missedAt).toISOString() } }, { paths });
      await routines.createRoutine({ id: "missed-recurring", prompt: promptFor("missed-recurring"), timezone: "UTC", createdAt: new Date(missedAt - 60_000).toISOString(), destination: { channelId: "CMATRIX" }, schedule: { type: "recurring", frequency: "minutes", interval: 1 } }, { paths });
      await runtime.waitFor(() => Date.now() > missedAt, { timeoutMs: 2000 });
      await startApp();
      await runtime.waitFor(() => provider.receipts.filter((item) => item.prompt === promptFor(id)).length === 2, { timeoutMs: 12000, label: "preserved run request dispatch after restart" });
      provider.release(promptFor(id));
      await runtime.waitFor(async () => (await routines.loadRoutineState(paths.routines)).routines.find((item) => item.id === id)?.lastRun?.status === "succeeded", { timeoutMs: 12000 });
      const saved = await routines.loadRoutineState(paths.routines);
      assert.equal(saved.routines.find((item) => item.id === id).runRequestedAt, null);
      assert.equal(saved.routines.find((item) => item.id === "missed-once").status, "inactive");
      assert.ok(Date.parse(saved.routines.find((item) => item.id === "missed-recurring").nextRunAt) > Date.now());
      assert.ok(!provider.receipts.some((item) => item.prompt.includes("missed-once") || item.prompt.includes("missed-recurring")));
      assert.equal(chat.posts.filter((item) => item.thread === "slack:CMATRIX:610.001").length, 1);
      for (const name of [id, "overlap-independent", "missed-once", "missed-recurring"]) await routines.deleteRoutine(name, paths);
    },
    "routine-deactivate-delete": async () => {
      if (requireApp()) return requireApp();
      for (const [index, operation] of ["deactivate", "delete"].entries()) {
        const id = `routine-${operation}`;
        const thread = `slack:CMATRIX:620.${index + 1}`;
        provider.register({ prompt: promptFor(id), text: textFor(id), hold: true });
        await routines.createRoutine({ id, prompt: promptFor(id), timezone: "UTC", destination: { channelId: "CMATRIX", threadTs: `620.${index + 1}` }, schedule: { type: "once", at: new Date(Date.now() + 400).toISOString() } }, { paths });
        const held = await runtime.waitFor(() => provider.receipts.find((item) => item.prompt === promptFor(id)), { timeoutMs: 12000 });
        if (operation === "delete") await routines.deleteRoutine(id, paths);
        else await routines.editRoutine(id, { status: "inactive" }, { paths });
        await runtime.waitFor(() => held.closed, { timeoutMs: 5000, label: `native routine ${operation} cancellation` });
        await schedulerBarrier(`routine ${operation} cancellation`);
        assert.ok(!chat.posts.some((item) => item.thread === thread));
        const saved = (await routines.loadRoutineState(paths.routines)).routines.find((item) => item.id === id);
        if (operation === "delete") assert.equal(saved, undefined);
        else { assert.equal(saved.status, "inactive"); await routines.deleteRoutine(id, paths); }
      }
    },
    "shutdown-active-work": async () => {
      if (requireApp()) return requireApp();
      for (const [index, kind] of ["root-question", "child-question", "child-permission", "quiet-tool", "child-quiet-tool"].entries()) {
        const id = `shutdown-${kind}`;
        const thread = `slack:CMATRIX:630.${index + 1}`;
        const child = promptFor(`${id}-child`);
        const marker = path.join(runtime.workspace, `${id}.pid`);
        const question = { names: ["question", "form"], arguments: (_, tool) => tool.name === "question"
          ? { questions: [{ header: "Shutdown", question: "Wait for cancellation", options: [{ label: "Yes", description: "Continue" }] }] }
          : { title: "Shutdown", fields: [{ key: "q0", type: "string", options: [{ value: "Yes", label: "Yes" }], required: true }] } };
        const tool = { names: ["bash", "shell", "$shell"], arguments: () => ({ command: `"${process.execPath}" -e 'require("node:fs").writeFileSync(${JSON.stringify(marker)},String(process.pid));setInterval(()=>{},1000)'`, description: "Quiet tool held until native cancellation" }) };
        if (kind.startsWith("child-")) provider.register({ prompt: child, text: textFor(id), tool: kind === "child-question" ? question : tool });
        provider.register({ prompt: promptFor(id), text: textFor(id), tool: kind.startsWith("child-")
          ? { names: ["task", "subagent"], arguments: (_, tool) => ({ description: "Held child for shutdown", prompt: child, ...(tool.name === "task" ? { subagent_type: "matrix-fixture" } : { agent: "matrix-fixture" }) }) }
          : kind === "quiet-tool" ? tool : question });
        const message = chat.send(thread, promptFor(id));
        const control = await runtime.waitFor(() => chat.controls.findLast((item) => item.thread === thread), { timeoutMs: 12000, label: `${kind} pending control` });
        let toolPid;
        if (kind.endsWith("quiet-tool")) {
          const action = control.blocks.flatMap((block) => block.elements ?? []).find((item) => item.action_id?.startsWith("pipa_permission_once_"));
          assert.ok(action);
          await chat.handlers.action({ actionId: action.action_id, value: action.value, threadId: thread, user: { userId: "UMATRIX" } });
          toolPid = await runtime.waitFor(() => readFile(marker, "utf8").then(Number, (error) => { if (error.code !== "ENOENT") throw error; return false; }), { timeoutMs: 5000, label: "quiet tool started" });
          assert.equal(state.isRunning(toolPid), true);
          // A completed native tool, not a short production deadline, ends work.
          assert.ok(!chat.posts.some((item) => item.thread === thread));
        }
        const previousAdmissions = wires.filter((wire) => isNativeAdmission(wire, "intake after shutdown")).length;
        await app.shutdown();
        assert.ok(control.deleted || control.updated?.blocks?.every((block) => block.type !== "actions"), `${kind} retained live controls`);
        assert.ok(!chat.posts.some((item) => item.thread === thread && item.content?.markdown === textFor(id)));
        assert.ok(!chat.reactions.some((item) => item.message === message.id && item.added && item.emoji === "white_check_mark"));
        chat.send(thread, "intake after shutdown");
        await new Promise(setImmediate);
        assertNativeAdmissionCount(wires, "intake after shutdown", previousAdmissions);
        if (toolPid) await runtime.waitFor(() => !state.isRunning(toolPid), { timeoutMs: 5000, label: "quiet native tool process exit" });
        if (mode === "attached") {
          await health();
          const read = async (pathname, query = {}) => {
            const url = new URL(`${baseUrl}${pathname}`);
            for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
            const response = await fetch(url, { headers, signal: AbortSignal.timeout(1000) });
            assert.equal(response.status, 200);
            return response.json();
          };
          if (pin.startsWith("2.")) {
            for (const pathname of ["/api/form", "/api/permission/request"]) assert.deepEqual((await read(pathname, { "location[directory]": runtime.workspace })).data, []);
            assert.deepEqual((await read("/api/session/active")).data, {});
          } else {
            for (const pathname of ["/question", "/permission"]) assert.deepEqual(await read(pathname, { directory: runtime.workspace }), []);
            assert.ok(Object.values(await read("/session/status", { directory: runtime.workspace })).every((item) => !["busy", "retry"].includes(item.type)));
          }
        }
        await startApp();
      }
    },
    "managed-restart-startup-failure": () => managedFailure("bind"),
    "managed-restart-unready": () => managedFailure("workspace"),
    "migration-seed": async () => {
      if (!migration) return { status: "BLOCKED", observed: "Run with --migration to allocate synthetic source/target/rollback copies" };
      if (pin.startsWith("2.")) return { status: "NOT_APPLICABLE", observed: "This is a source-v1 transition case; both v1 source pins execute it separately" };
      migrationJourney = await createMigrationJourney({ runtime, binaries: engineBinaries, sourcePin: pin, facade, state, routines, provider, config: engineConfig });
      return migrationJourney.seed();
    },
    "migration-upgrade": async () => {
      if (pin.startsWith("2.")) return { status: "NOT_APPLICABLE", observed: "Target-v2 transition is executed from each native v1 snapshot; fresh v2 has separate cell cases" };
      return migrationJourney ? migrationJourney.upgrade() : { status: "BLOCKED", observed: "No migration seed; --migration required or source preflight failed" };
    },
    "migration-rollback": async () => {
      if (pin.startsWith("2.")) return { status: "NOT_APPLICABLE", observed: "Matched rollback is a native v1 snapshot case, executed for each source pin" };
      return migrationJourney ? migrationJourney.rollback() : { status: "BLOCKED", observed: "No matched pristine snapshot; --migration required or source seed failed" };
    },
    "stop-ownership": async () => {
      if (!app && mode !== "managed") return requireApp();
      if (mode === "managed") {
        if (startupError) return { status: "BLOCKED", observed: `Managed readiness failed: ${startupError.message}` };
        await runCli("stop");
        await runtime.waitFor(async () => !await state.readInstanceLock(paths.lock), { timeoutMs: 8000, label: "Managed stop lock release" });
        await runtime.waitFor(() => fetch(baseUrl, { signal: AbortSignal.timeout(500) }).then(() => false, () => true), { timeoutMs: 5000, label: "Managed stop owned port" });
        if (replacement?.pid) await runtime.waitFor(() => !state.isRunning(replacement.pid), { timeoutMs: 5000, label: "Managed replacement process exit" });
        return;
      }
      const before = chat.posts.length;
      const appUrl = app.server.baseUrl;
      await app.shutdown();
      chat.send("slack:CMATRIX:700.001", "intake after stop");
      assert.equal(chat.posts.length, before);
      if (mode === "attached") {
        assert.equal(independent.child.exitCode, null);
        await health(appUrl);
        cell.evidence.attachedPidSurvived = independent.child.pid;
      } else await runtime.waitFor(() => fetch(appUrl, { signal: AbortSignal.timeout(500) }).then(() => false, () => true), { timeoutMs: 5000, label: "owned port close" });
    },
    "managed-restart": async () => {
      if (mode !== "managed") return { status: "BLOCKED", observed: "Full detached restart belongs to Managed cell or actual Socket live lane" };
      if (startupError) return { status: "BLOCKED", observed: `Production workspace readiness failed: ${startupError.message}` };
      const old = await state.readInstanceLock(paths.lock);
      assert.equal(old.pid, managed.child.pid);
      await runCli("restart");
      const workerPids = new Set();
      const outcome = await runtime.waitFor(async () => {
        for (const pid of await observeWorker(old.generation)) workerPids.add(pid);
        const status = await restart.restartStatus({ home: runtime.home });
        if (status?.state === "failed" || status?.state === "unconfirmed") assert.fail(JSON.stringify(status));
        return status?.state === "completed" ? status : false;
      }, { timeoutMs: 45000, label: "external detached restart observer" });
      replacement = outcome.replacement;
      assert.notEqual(replacement.pid, old.pid);
      assert.notEqual(replacement.generation, old.generation);
      assert.equal((await bounded(managed.exited, { timeoutMs: 5000 })).code, 0);
      assert.ok(!state.isRunning(old.pid));
      assert.ok(workerPids.size, "Restart worker PID was not observed externally");
      await runtime.waitFor(() => [...workerPids].every((pid) => !state.isRunning(pid)), { timeoutMs: 5000, label: "detached worker exit" });
      await health();
      assert.deepEqual(await state.readInstanceLock(paths.lock), replacement);
      assert.equal(JSON.parse(await runCli("restart", "--status")).state, "completed");
      cell.evidence.restart = { requestId: outcome.id, old, replacement, workerPids: [...workerPids], workersExited: true, durableState: outcome.state, lifecycleStatus: "PASS", followupStatus: "FAIL" };
      const result = await turn("after-restart", { onInteraction: async () => ({ type: "reply", reply: "once" }) }, { tool: environmentTool(textFor("after-restart")) });
      assertTurnOutcome(result, { sessionId: result.sessionId, text: textFor("after-restart") });
      cell.evidence.restart.followupStatus = "PASS";
    },
    "socket-fixture-restart": async () => {
      if (requireApp()) return requireApp();
      // Stop the in-process app before exercising the real installed CLI. Only
      // Chat/auth are injected; CLI, watcher, worker, facade and engine are real.
      await app.shutdown();
      const probe = await createRuntimeFixture({ timeoutMs: 90000, parent: runtime });
      runtime.defer(() => probe.teardown(), "Socket CLI fixture resources");
      Object.assign(probe.env, runtime.env, {
        ...Object.fromEntries(Object.entries(probe.env).filter(([key]) => key !== "PATH")),
        OPENCODE_CONFIG: runtime.env.OPENCODE_CONFIG,
        NODE_OPTIONS: `--import=${new URL("./socket-cli-fixture.mjs", import.meta.url).href}`,
        PIPA_FIXTURE_CANDIDATE: candidate,
        PIPA_INTEGRATION_SENTINEL: "matrix-integration",
        PIPA_SLACK_BOT_TOKEN: "xoxb-forbidden-child-marker",
        Slack_Client_Secret: "forbidden-child-marker",
        ...(mode === "attached" ? { PIPA_OPENCODE_ATTACH_URL: baseUrl } : {}),
      });
      if (mode !== "attached") delete probe.env.PIPA_OPENCODE_ATTACH_URL;
      const probePaths = state.pipaPaths(probe.home);
      const probeConfig = { ...config, workingDirectory: probe.workspace };
      // Attached workspace is checked against the independent engine, not a new
      // fixture workspace. Its database/process remains owned by the outer cell.
      if (mode === "attached") probeConfig.workingDirectory = runtime.workspace;
      await state.writePrivateJson(probePaths.config, probeConfig);
      const snapshot = () => readFile(path.join(probe.state, "chat.json"), "utf8").then(JSON.parse).catch(() => null);
      let identity;
      const original = probe.spawn(process.execPath, [cli, "start"]);
      const invoke = (...args) => command(probe, process.execPath, [cli, ...args]);
      probe.defer(async () => {
        const lock = await state.readInstanceLock(probePaths.lock);
        if (lock) process.kill(lock.pid, "SIGTERM");
        await waitFor(async () => !await state.readInstanceLock(probePaths.lock), { timeoutMs: 8000, label: "Socket CLI lock release" });
        if (identity) await waitFor(() => !state.isRunning(identity.pid), { timeoutMs: 5000, label: "Socket replacement exit" });
      }, "Socket CLI replacement and lock");
      try {
        await probe.waitFor(async () => (await snapshot())?.ready, { timeoutMs: 20000, label: "Socket native and Chat startup" });
        const old = await state.readInstanceLock(probePaths.lock);
        assert.equal(old.pid, original.child.pid);
        const thread = "slack:CMATRIX:777.001";
        const prompt = promptFor("socket-before-restart");
        provider.register({ prompt, text: textFor("socket-before-restart") });
        await state.writePrivateJson(path.join(probe.state, "input.json"), { id: "before", thread, prompt });
        await probe.waitFor(async () => (await snapshot())?.posts.some((post) => post.content?.markdown === textFor("socket-before-restart")), { timeoutMs: 15000, label: "Socket pre-restart turn" });
        const sessionId = JSON.parse(await readFile(probePaths.sessions, "utf8"))[thread];
        assert.ok(sessionId);
        const routinePrompt = `  ${promptFor("socket-restart-routine")}\nexact saved prompt  \n`;
        provider.register({ prompt: promptFor("socket-restart-routine"), text: textFor("socket-restart-routine") });
        const created = JSON.parse(await invoke("routine", "create", "--prompt", routinePrompt, "--timezone", "UTC", "--channel", "CMATRIX", "--thread", "777.001", "--at", new Date(Date.now() + 60000).toISOString(), "--json"));
        await invoke("routine", "edit", created.routine.id, "--status", "inactive", "--json");
        const requested = await Promise.all(Array.from({ length: 2 }, () => invoke("restart", "--channel", "CMATRIX", "--thread", "777.001")));
        assert.ok(requested.every((output) => output.includes(old.generation) && !output.includes("completed")));
        const workerPids = new Set();
        const outcome = await probe.waitFor(async () => {
          for (const pid of await observeWorker(old.generation)) workerPids.add(pid);
          const status = await restart.restartStatus({ home: probe.home });
          assert.ok(!["failed", "unconfirmed"].includes(status?.state), JSON.stringify(status));
          return status?.state === "completed" && status;
        }, { timeoutMs: 45000, label: "external Socket CLI restart observer" });
        identity = outcome.replacement;
        assert.notEqual(identity.pid, old.pid);
        assert.notEqual(identity.generation, old.generation);
        assert.equal((await bounded(original.exited, { timeoutMs: 5000 })).code, 0);
        assert.ok(workerPids.size);
        await probe.waitFor(() => [...workerPids].every((pid) => !state.isRunning(pid)), { timeoutMs: 5000, label: "Socket restart worker exit" });
        await probe.waitFor(async () => (await snapshot())?.posts.some((post) => post.content === "Matrix restarted and is ready."), { timeoutMs: 5000, label: "routed ready notice" });
        const afterPrompt = promptFor("socket-after-restart");
        provider.register({ prompt: afterPrompt, text: textFor("socket-after-restart"), tool: environmentTool(textFor("socket-after-restart")), verify: (messages) => assert.ok(JSON.stringify(messages).includes(prompt), "Restart lost session history") });
        await state.writePrivateJson(path.join(probe.state, "input.json"), { id: "after", thread, prompt: afterPrompt, mention: false });
        const control = await probe.waitFor(async () => (await snapshot())?.controls.find((item) => item.thread === thread), { timeoutMs: 15000, label: "replacement native tool approval" });
        const action = control.blocks.flatMap((block) => block.elements ?? []).find((item) => item.action_id.startsWith("pipa_permission_once_"));
        assert.ok(action);
        await state.writePrivateJson(path.join(probe.state, "input.json"), { id: "approve", action: { actionId: action.action_id, value: action.value, threadId: thread, user: { userId: "UMATRIX" } } });
        const observed = await probe.waitFor(async () => {
          const value = await snapshot();
          return value?.pid === identity.pid && value.posts.some((post) => post.content?.markdown === textFor("socket-after-restart")) && value;
        }, { timeoutMs: 15000, label: "Socket replacement follow-up" });
        const notices = observed.posts.filter((post) => post.content === "Matrix restarted and is ready.");
        assert.equal(notices.length, 1);
        assert.equal(notices[0].thread, thread);
        assert.equal(JSON.parse(await readFile(probePaths.sessions, "utf8"))[thread], sessionId);
        assert.deepEqual(await state.readInstanceLock(probePaths.lock), identity);
        const retained = JSON.parse(await invoke("routine", "show", created.routine.id, "--json")).routine;
        assert.equal(retained.prompt, routinePrompt);
        assert.equal(retained.status, "inactive");
        await invoke("routine", "edit", created.routine.id, "--status", "active", "--at", new Date(Date.now() + 1500).toISOString(), "--json");
        const completed = await probe.waitFor(async () => {
          const item = (await routines.loadRoutineState(probePaths.routines)).routines.find((item) => item.id === created.routine.id);
          if (item?.lastRun && item.lastRun.status !== "succeeded") assert.fail(JSON.stringify(item.lastRun));
          return item?.status === "completed" && item;
        }, { timeoutMs: 15000, label: "replacement scheduler dispatch" });
        assert.equal(completed.lastRun.trigger, "scheduled");
        assert.equal(completed.runRequestedAt, null);
        await state.writePrivateJson(path.join(probe.state, "input.json"), { id: "scheduler-barrier", barrier: true });
        const reconciled = await probe.waitFor(async () => {
          const value = await snapshot();
          return value?.schedulerBarriers > 0 && value;
        }, { timeoutMs: 5000, label: "replacement scheduler reconciliation" });
        const results = reconciled.posts.filter((post) => post.content?.markdown === textFor("socket-restart-routine"));
        assert.equal(results.length, 1);
        assert.equal(results[0].thread, thread);
        const routineSessionId = JSON.parse(await readFile(probePaths.sessions, "utf8"))[thread];
        assert.ok(routineSessionId);
        const nativeAdmission = assertRestartRoutineAdmission(reconciled, { pid: identity.pid, prompt: routinePrompt, marker: promptFor("socket-restart-routine"), sessionId: routineSessionId });
        await invoke("routine", "delete", created.routine.id, "--json");
        await invoke("stop");
        await probe.waitFor(async () => !await state.readInstanceLock(probePaths.lock), { timeoutMs: 8000, label: "Socket stop lock" });
        await probe.waitFor(() => !state.isRunning(identity.pid), { timeoutMs: 5000, label: "Socket stopped replacement" });
        if (mode === "attached") {
          assert.equal(independent.child.exitCode, null);
          await health();
        } else await probe.waitFor(() => fetch(observed.nativeUrl, { signal: AbortSignal.timeout(500) }).then(() => false, () => true), { timeoutMs: 5000, label: "Socket replacement owned port close" });
        cell.evidence.socketFixtureRestart = { requestId: outcome.id, old, replacement: identity, workerPids: [...workerPids], workersExited: true, sessionId, readyNotices: notices.length, routine: { id: created.routine.id, trigger: completed.lastRun.trigger, resultCount: results.length, reconciliations: 2, nativeAdmission }, attachedPid: mode === "attached" ? independent.child.pid : null, transport: "fake Chat/auth; actual installed CLI and native engine; not live Slack" };
      } finally { await probe.teardown(); await startApp(); }
    },
  };
  async function schedulerBarrier(label) {
    assert.ok(routineScheduler, "Production scheduler factory was not reached");
    // First call may join an already running interval tick. The second starts
    // another actual reconciliation after that tick completes.
    await bounded(routineScheduler.tick(), { timeoutMs: 5000, label });
    await bounded(routineScheduler.tick(), { timeoutMs: 5000, label });
    (cell.evidence.schedulerBarriers ??= []).push({ label, reconciliations: 2, scope: "Production tick reconciliation; not proof against arbitrarily delayed native completion or routine process-crash duplicates" });
  }
  async function crashed(boundary) {
    if (requireExecutor()) return requireExecutor();
    const prerequisite = cell.cases.find((row) => row.id === "exact-prompt-continuation");
    if (prerequisite?.status !== "PASS") return { status: "BLOCKED", observed: `U2/U6: production native admission/completion prerequisite is ${prerequisite?.status ?? "absent"}; cannot reach an authoritative ${boundary} death boundary before the port. ${prerequisite?.observed ?? ""}` };
    const id = `crash-${boundary}`;
    provider.register({ prompt: promptFor(id), text: textFor(id), ...(boundary === "admission" ? { hold: true } : {}),
      ...(boundary === "approval" ? { tool: { names: ["bash", "shell", "$shell"], arguments: () => ({ command: `"${process.execPath}" -e "console.log('${textFor(id)}')"`, description: "Reach a real protected-tool approval before abrupt Pipa death" }) } } : {}),
    });
    const evidence = await abruptTurnProbe({ runtime, candidate, baseUrl, boundary, prompt: promptFor(id), sessionFile: path.join(runtime.state, `${id}-sessions.json`) });
    (cell.evidence.crashes ??= []).push(evidence);
    if (boundary === "admission") {
      await runtime.waitFor(() => provider.receipts.some((receipt) => receipt.prompt === promptFor(id)), { timeoutMs: 12000, label: "accepted crash turn reaches native provider" });
      provider.release(promptFor(id));
    }
    if (boundary === "completion") {
      assertTurnOutcome(evidence.result, { sessionId: evidence.sessionId, text: textFor(id) });
      const next = await turn(`${id}-followup`, { sessionId: evidence.sessionId }, { verify: (messages) => assert.ok(JSON.stringify(messages).includes(promptFor(id)), "Completed crash history lost") });
      assertTurnOutcome(next, { sessionId: evidence.sessionId, text: textFor(`${id}-followup`) });
      evidence.followupRetainedHistory = true;
    }
    return { status: "BLOCKED", observed: `U2/U6: actual SIGKILL at native ${boundary} barrier; one accepted admission, persisted session and no delivery. ${boundary === "completion" ? "Explicit follow-up retained completed history. " : ""}Owned instruction/admission startup recovery has no qualified public seam; this bounded runner/executor probe is not full Socket death, automatic recovery, or routine crash-window proof.`, evidence };
  }
  async function managedFailure(kind) {
    if (mode !== "managed") return { status: "BLOCKED", observed: "Managed CLI fault case runs in the Managed cell; full Socket CLI fault requires real Slack" };
    if (startupError) return { status: "BLOCKED", observed: `Actual Managed startup failed: ${startupError.message.split("\n")[0]}` };
    const fault = await createRuntimeFixture({ timeoutMs: 65000, cleanupTimeoutMs: 8000 });
    runtime.defer(() => fault.teardown(), `Managed ${kind} fault resources`);
    Object.assign(fault.env, { OPENCODE_CONFIG_CONTENT: JSON.stringify(providerConfig(provider.url)), OPENCODE_SERVER_PASSWORD: "synthetic-loopback-only", OPENCODE_PASSWORD: "synthetic-loopback-only", OPENCODE_PURE: "1", OPENCODE_DISABLE_DEFAULT_PLUGINS: "1" });
    const faultPaths = state.pipaPaths(fault.home);
    let original;
    let replacementIdentity;
    let url;
    let blocker;
    const invoke = (...args) => command(fault, process.execPath, [cli, ...args]);
    try {
      const reservation = createServer();
      await fault.listen(reservation);
      const port = reservation.address().port;
      await new Promise((resolve) => reservation.close(resolve));
      url = `http://127.0.0.1:${port}`;
      const saved = { botName: "Fault", slackMode: "managed", workingDirectory: fault.workspace, openCodeHostname: "127.0.0.1", openCodePort: port };
      await state.writePrivateJson(faultPaths.config, saved);
      await writeFile(fault.env.OPENCODE_CONFIG, JSON.stringify(providerConfig(provider.url)));
      original = fault.spawn(process.execPath, [cli, "start"]);
      await fault.waitFor(() => observeRuntimeReadiness({ facade, baseUrl: url, workingDirectory: fault.workspace, environment: fault.env, pin }).catch(() => false), { timeoutMs: 10000, label: "fault original native workspace readiness" });
      const old = await state.readInstanceLock(faultPaths.lock);
      fault.defer(async () => {
        const lock = await state.readInstanceLock(faultPaths.lock);
        if (lock && state.isRunning(lock.pid)) { process.kill(lock.pid, "SIGTERM"); await waitFor(async () => !await state.readInstanceLock(faultPaths.lock), { timeoutMs: 5000 }); }
        if (replacementIdentity?.pid) await waitFor(() => !state.isRunning(replacementIdentity.pid), { timeoutMs: 5000 });
      }, "fault replacement identity and lock");
      if (kind === "bind") {
        blocker = createServer();
        await fault.listen(blocker);
        await state.writePrivateJson(faultPaths.config, { ...saved, openCodePort: blocker.address().port });
      } else if (pin.startsWith("2.")) {
        // 2.0.29 ignores malformed JSON documents. Break its actual native config
        // directory instead; do not call a tolerated document a readiness fault.
        const configUrl = new URL(`${url}/api/config`);
        configUrl.searchParams.set("location[directory]", fault.workspace);
        const response = await fetch(configUrl, { headers, signal: AbortSignal.timeout(1000) });
        assert.equal(response.status, 200);
        const entries = await response.json();
        assert.ok(Array.isArray(entries), "Native config must list its sources");
        const directory = entries.find((entry) => entry.type === "directory")?.path;
        assert.equal(typeof directory, "string", "Native config directory not discovered");
        const relative = path.relative(fault.root, directory);
        assert.ok(relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative), "Config fault must stay inside its private fixture");
        await rename(directory, `${directory}.unready`);
        await writeFile(directory, "Not a configuration directory.");
      } else {
        // Native v1 rejects this document during workspace initialization.
        await writeFile(fault.env.OPENCODE_CONFIG, "{ invalid configuration");
      }
      const requests = await Promise.all([restart.requestRestart({ home: fault.home }), restart.requestRestart({ home: fault.home })]);
      assert.equal(requests[0].id, requests[1].id, "Concurrent requests did not join one generation");
      assert.equal(requests[0].id, old.generation);
      const outcome = await fault.waitFor(async () => {
        const lock = await state.readInstanceLock(faultPaths.lock);
        if (lock && lock.pid !== old.pid) replacementIdentity = lock;
        const status = await restart.restartStatus({ home: fault.home });
        assert.notEqual(status?.state, "completed", "Faulty real service reported readiness");
        assert.notEqual(status?.state, "unconfirmed", "Replacement fault was not reconciled before its deadline");
        return status?.state === "failed" ? status : false;
      }, { timeoutMs: 45000, label: `actual Managed ${kind} fault outcome` });
      assert.equal(outcome.phase, "starting");
      assert.equal((await bounded(original.exited, { timeoutMs: 5000 })).code, 0);
      await fault.waitFor(async () => !await state.readInstanceLock(faultPaths.lock), { timeoutMs: 5000 });
      await fault.waitFor(() => fetch(url, { signal: AbortSignal.timeout(500) }).then(() => false, () => true), { timeoutMs: 5000 });
      if (replacementIdentity) await fault.waitFor(() => !state.isRunning(replacementIdentity.pid), { timeoutMs: 5000 });
      return { observed: `Real native ${kind === "bind" ? "bind collision" : "workspace configuration failure"} produced durable failed restart; concurrent requests joined; old/replacement processes and lock cleared`, evidence: { requestId: outcome.id, phase: outcome.phase, state: outcome.state } };
    } finally { await fault.teardown(); }
  }
  async function scheduled(type) {
    if (requireApp()) return requireApp();
    const id = `routine-${type}`;
    const prompt = `  ${promptFor(id)} café\nexact saved bytes  \n`;
    provider.register({ prompt: promptFor(id), text: textFor(id) });
    const now = Date.now();
    const at = new Date(now + 600).toISOString();
    const createdAt = new Date(now - 60_000 + 600).toISOString();
    const destination = { channelId: "CMATRIX", threadTs: type === "once" ? null : "600.002" };
    await routines.createRoutine({ id, prompt, timezone: "UTC", destination, ...(type === "recurring" ? { createdAt } : {}), schedule: type === "once" ? { type: "once", at } : { type: "recurring", frequency: "minutes", interval: 1 } }, { paths });
    const completed = await runtime.waitFor(async () => {
      const routine = (await routines.loadRoutineState(paths.routines)).routines.find((item) => item.id === id);
      if (routine?.lastRun && routine.lastRun.status !== "succeeded") assert.fail(JSON.stringify(routine.lastRun));
      return routine?.lastRun?.status === "succeeded" ? routine : false;
    }, { timeoutMs: 15000, label: "real due scheduler dispatch" });
    assert.equal(completed.lastRun.trigger, "scheduled");
    assert.equal(completed.runRequestedAt, null, "Manual run cannot substitute for scheduling");
    inputReceipt(prompt);
    const post = chat.posts.find((post) => post.content?.markdown === textFor(id));
    assert.equal(post.thread, `slack:CMATRIX:${destination.threadTs ?? ""}`);
    const thread = `slack:CMATRIX:${destination.threadTs ?? post.id}`;
    const session = JSON.parse(await readFile(paths.sessions, "utf8"))[thread];
    assert.ok(session);
    await send(`${id}-reply`, thread, false);
    assert.equal(JSON.parse(await readFile(paths.sessions, "utf8"))[thread], session);
    await schedulerBarrier(`routine ${type} duplicate suppression`);
    assert.equal(chat.posts.filter((post) => post.content?.markdown === textFor(id)).length, 1);
    if (type === "once") assert.equal(completed.status, "completed");
    else assert.ok(Date.parse(completed.nextRunAt) > Date.parse(completed.lastRun.occurrenceAt));
    await routines.deleteRoutine(id, paths);
  }
  try {
    const selectedCases = caseIds ? releaseCases.filter((row) => caseIds.includes(row.id)) : releaseCases;
    for (const definition of [...selectedCases.filter((row) => row.id !== "stop-ownership"), ...selectedCases.filter((row) => row.id === "stop-ownership")]) {
      await recordCase(cell.cases, definition, async () => {
        if (definition.id.startsWith("models-") && !pin.startsWith("2.")) {
          assert.equal(executor.capabilities.liveModelSwitch, false);
          return { status: "NOT_APPLICABLE", observed: "Native v1 has no live v2 HTTP switch operation; ordinary model execution is covered separately" };
        }
        if (definition.blocked) return { status: "BLOCKED", observed: definition.blocked };
        const checkpoint = provider.checkpoint();
        try { return await execute[definition.id](); }
        finally { provider.assertClean(checkpoint); }
      });
    }
    cell.evidence.provider = provider.receipts.map((receipt) => ({ prompt: receipt.prompt, model: receipt.model, provider: receipt.provider, temperature: receipt.temperature, toolNames: receipt.tools.map((tool) => tool.name), toolResultCount: receipt.toolResults.length, cancelledConnection: receipt.closed && !receipt.released }));
    cell.evidence.admissions = wires.filter((wire) => wire.body.text || wire.body.parts).map((wire) => ({ path: wire.path, prompt: wire.body.text ?? wire.body.parts[0]?.text, files: wire.files.map((file) => ({ filename: file.filename, sha256: createHash("sha256").update(Buffer.from(file.base64, "base64")).digest("hex") })) }));
    if (migration) {
      const manifest = JSON.parse(await readFile(new URL("../../test/fixtures/opencode-migration/manifest.json", import.meta.url), "utf8"));
      assert.equal(manifest.synthetic, true);
      cell.evidence.migrationManifest = manifest;
    }
  } finally {
    executor?.stopAll();
    await finishCell(cell, runtime);
  }
  return cell;
}
