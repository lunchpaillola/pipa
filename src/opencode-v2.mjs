import { OpenCode } from "@opencode/client";
import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pipaPaths, writePrivateJson } from "./state.mjs";

export function createV2Adapter(options) {
  const client = OpenCode.make({ baseUrl: options.baseUrl, headers: options.headers, fetch: (url, init) => options.fetch(url, {
    ...init,
    signal: AbortSignal.any([...(init.signal ? [init.signal] : []), AbortSignal.timeout(options.connectionRequestTimeoutMs ?? 5_000)]),
  }) });
  const journalFile = options.recoveryFile ?? pipaPaths(options.environment.PIPA_HOME).openCodeRecovery;
  const prefix = `pipa-${createHash("sha256").update(path.resolve(journalFile)).digest("hex").slice(0, 16)}-`;
  const turns = new Map();
  let records;
  let mutationTail = Promise.resolve();
  let readiness;
  let blocked;
  let fatalError;

  function unavailable(cause) {
    if (!fatalError) {
      fatalError = new Error("OpenCode server became unavailable after bounded connection recovery.", { cause });
      options.onFatal?.(fatalError);
    }
    return fatalError;
  }

  async function readWithRecovery(operation, signal, confirming = false) {
    let disconnectedAt;
    while (true) {
      if (fatalError) throw fatalError;
      try { return await operation(signal); }
      catch (error) {
        if (confirming && signal.aborted && retryable(error)) throw unavailable(error);
        signal.throwIfAborted();
        if (!retryable(error)) throw error;
        disconnectedAt ??= Date.now();
        if (Date.now() - disconnectedAt >= (options.connectionRecoveryTimeoutMs ?? 10_000)) {
          // Confirm through the same authenticated authoritative read, using a
          // fresh bounded probe. Healthy long-running agent work has no deadline.
          const probe = AbortSignal.any([signal, AbortSignal.timeout(options.connectionProbeTimeoutMs ?? 1_000)]);
          try { return await operation(probe); }
          catch (cause) {
            signal.throwIfAborted();
            if (!retryable(cause) && !probe.aborted) throw cause;
            throw unavailable(cause);
          }
        }
        await delay(options.pollIntervalMs, undefined, { signal }).catch((cause) => {
          if (confirming && signal.aborted) throw unavailable(error);
          throw cause;
        });
      }
    }
  }

  async function mutate(change) {
    const operation = mutationTail.then(async () => {
      const next = change(records);
      await writePrivateJson(journalFile, { version: 1, records: next });
      records = next;
    });
    mutationTail = operation.catch(() => undefined);
    return operation;
  }

  async function lookup(sessionId, workingDirectory, signal) {
    let session;
    try { session = await readWithRecovery((readSignal) => client.session.get({ sessionID: sessionId }, { signal: readSignal }), signal); }
    catch (error) {
      if (error._tag === "SessionNotFoundError" && error.sessionID === sessionId) return null;
      throw error;
    }
    if (session?.id !== sessionId || typeof session.location?.directory !== "string"
      || path.resolve(session.location.directory) !== path.resolve(workingDirectory)) throw new Error("OpenCode session workspace identity mismatch.");
    return session;
  }

  async function messages(sessionId, signal) {
    const result = [];
    const ids = new Set();
    const cursors = new Set();
    let cursor;
    do {
      const page = await client.message.list({ sessionID: sessionId, limit: 100, ...(cursor ? { cursor } : { order: "asc" }) }, { signal });
      if (!Array.isArray(page?.data) || !page.cursor || (page.cursor.next !== null && typeof page.cursor.next !== "string")) throw new Error("OpenCode returned an invalid message projection.");
      for (const message of page.data) {
        if (typeof message?.id !== "string" || typeof message.type !== "string" || typeof message.time?.created !== "number"
          || (message.type === "assistant" && !Array.isArray(message.content))
          || (message.type === "idle" && !["succeeded", "failed", "interrupted"].includes(message.outcome))) throw new Error("OpenCode returned an invalid message projection.");
        if (ids.has(message.id)) throw new Error("OpenCode returned duplicate projected messages.");
        ids.add(message.id);
        result.push(message);
      }
      cursor = page.cursor.next;
      if (cursor && cursors.has(cursor)) throw new Error("OpenCode repeated a message cursor.");
      cursors.add(cursor);
    } while (cursor);
    return result;
  }

  async function projection(record, signal) {
    return readWithRecovery((readSignal) => readProjection(record, readSignal), signal);
  }

  async function readProjection(record, signal) {
    // Native promotion atomically removes pending input and projects its message.
    // Read inbox first so a lost cancel reply cannot hide that handoff between reads.
    // KTD3's single-writer contract applies during the turn; observed foreign
    // input prevents session-wide interruption and suppresses local delivery.
    const inbox = await client.session.inbox.list({ sessionID: record.sessionId }, { signal });
    const timeline = await messages(record.sessionId, signal);
    if (!Array.isArray(inbox) || inbox.some((item) => typeof item?.id !== "string" || item.sessionID !== record.sessionId || typeof item.type !== "string")) throw new Error("OpenCode returned an invalid inbox projection.");
    const baseline = new Set(record.baseline);
    const fresh = timeline.filter((message) => !baseline.has(message.id));
    const foreign = fresh.some((message) => ["user", "synthetic", "shell"].includes(message.type) && message.id !== record.id)
      || inbox.some((item) => item.id !== record.id);
    const index = fresh.findIndex((message) => message.id === record.id && message.type === "user");
    const own = index >= 0 ? fresh[index] : null;
    const idle = index >= 0 ? fresh.slice(index + 1).find((message) => message.type === "idle") : null;
    const assistant = idle ? fresh.slice(index + 1, fresh.indexOf(idle)).findLast((message) => message.type === "assistant") : null;
    let dismissed = false;
    if (own && !idle && !foreign && record.dismissal && !inbox.length) {
      const message = fresh.slice(index + 1).find((message) => message.id === record.dismissal.messageId && message.type === "assistant");
      const tool = message?.content.find((part) => part.type === "tool" && part.id === record.dismissal.toolId && part.name === "question");
      if (typeof message?.time.completed === "number" && message.error?.type === "aborted" && tool?.state.status === "error" && tool.state.error?.type === "aborted") {
        let cancelled;
        try {
          const form = await client.session.form.get({ sessionID: record.sessionId, formID: record.dismissal.formId }, { signal });
          cancelled = form.id === record.dismissal.formId && form.sessionID === record.sessionId && form.state.status === "cancelled";
        } catch (error) { if (error._tag !== "FormNotFoundError" || error.id !== record.dismissal.formId) throw error; cancelled = true; }
        // Native question cancellation can stop execution with reason=shutdown,
        // which deliberately has no idle projection. This is not general success:
        // require journaled dismissal intent, its exact aborted tool/assistant,
        // native cancellation/absence and no active execution before cleanup.
        if (cancelled) dismissed = !(await client.session.active({ signal }))[record.sessionId];
      }
    }
    return { foreign, own, idle, assistant, inbox, dismissed };
  }

  async function cleanup(record) {
    // Turn cancellation must never cancel removal of trusted context or recovery state.
    const signal = AbortSignal.timeout(options.cleanupTimeoutMs ?? 5_000);
    try {
      return await cleanupOwned(record, signal);
    } catch (error) {
      if (!fatalError && (retryable(error) || signal.aborted)) {
        // Cleanup can expire before the ordinary recovery window. Confirm through
        // a fresh read-only authenticated probe, independent of both expired cleanup
        // and cancelled turn signals. This adds at most one bounded probe window.
        const probe = AbortSignal.timeout(options.connectionProbeTimeoutMs ?? 1_000);
        try { await readWithRecovery((probeSignal) => client.session.get({ sessionID: record.sessionId }, { signal: probeSignal }), probe, true); }
        catch { if (fatalError) throw fatalError; }
      }
      throw error;
    }
  }

  async function cleanupOwned(record, signal) {
    if (fatalError) throw fatalError;
    if (!await lookup(record.sessionId, record.workingDirectory, signal)) {
      await mutate((items) => items.filter((item) => item.key !== record.key));
      return;
    }
    let failure;
    let foreign = Boolean(record.foreign);
    try {
      if (record.phase !== "prepared") {
        let state = await projection(record, signal);
        foreign ||= state.foreign;
        if (state.inbox.some((item) => item.id === record.id)) {
          try { await client.session.inbox.cancel({ sessionID: record.sessionId, inboxID: record.id }, { signal }); }
          catch (error) {
            // Delivery can race cancellation; a lost reply is reconciled rather than
            // treated as either an acknowledged cancellation or a missing session.
            if (!retryable(error) && !["ConflictError", "MessageNotFoundError"].includes(error._tag)) throw error;
          }
          state = await projection(record, signal);
          foreign ||= state.foreign;
          if (state.inbox.some((item) => item.id === record.id)) throw new Error("Pipa input cancellation is not acknowledged.");
          if (!state.own) {
            record.phase = "cancelled";
            await mutate((items) => items.map((item) => item.key === record.key ? { ...record } : item));
          }
        }
        if (state.own && !state.idle && !state.dismissed) {
          if (foreign || record.foreign) throw new Error("OpenCode attribution conflict: a foreign writer is still active.");
          // Native interrupt acknowledges acceptance, not settlement. Under KTD3's
          // single-writer contract it stops our active execution; never use it to
          // recover attribution after observing a foreign admission.
          try { await client.session.interrupt({ sessionID: record.sessionId, resume: false }, { signal }); }
          catch (error) { if (!retryable(error)) throw error; }
          do {
            state = await projection(record, signal);
            foreign ||= state.foreign;
            if (foreign || record.foreign) throw new Error("OpenCode attribution conflict: foreign input entered during cancellation.");
            if (!state.idle && !state.dismissed) await delay(options.pollIntervalMs, undefined, { signal });
          } while (!state.idle && !state.dismissed);
        }
        if (!state.own && record.phase !== "cancelled") throw new Error("OpenCode prompt admission remains uncertain.");
      }
    } catch (error) { failure = error; }
    // Native 2.0.29's received-body PUT handler executes its SQL mutation inline,
    // before replying; it does not enqueue a background instruction write. Live
    // cleanup follows the independently settled PUT request (including lost reply),
    // and startup removes abandoned namespaced entries without replaying that PUT.
    // A failed DELETE still retains ownership and blocks intake.
    if (record.instruction !== "absent") await client.session.instructions.entry.remove({ sessionID: record.sessionId, key: record.key }, { signal });
    if (failure) throw failure;
    await mutate((items) => items.filter((item) => item.key !== record.key));
    return foreign || Boolean(record.foreign);
  }

  async function ready(workingDirectory) {
    if (blocked) throw blocked;
    if (fatalError) throw fatalError;
    readiness ??= (async () => {
      try {
        try {
          const stats = await lstat(journalFile);
          if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Invalid Pipa OpenCode recovery file.");
          const saved = JSON.parse(await readFile(journalFile, "utf8"));
          if (saved?.version !== 1 || !Array.isArray(saved.records)) throw new Error("Invalid Pipa OpenCode recovery file.");
          records = saved.records;
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
          records = [];
        }
        const keys = new Set();
        for (const record of [...records]) {
          if (typeof record.key !== "string" || !record.key.startsWith(prefix) || !/^pipa-[a-f0-9]{16}-[a-f0-9-]{36}$/u.test(record.key)
            || keys.has(record.key) || typeof record.sessionId !== "string" || typeof record.id !== "string"
            || !Array.isArray(record.baseline) || !record.baseline.every((id) => typeof id === "string")
            || !["prepared", "admitting", "admitted", "cancelled"].includes(record.phase)
            || (record.instruction !== undefined && !["absent", "putting", "present"].includes(record.instruction))
            || (record.dismissal !== undefined && (!record.dismissal || ![record.dismissal.formId, record.dismissal.messageId, record.dismissal.toolId].every((id) => typeof id === "string" && id.length)))
            || typeof record.workingDirectory !== "string" || path.resolve(record.workingDirectory) !== path.resolve(workingDirectory)) throw new Error("Invalid or mismatched Pipa OpenCode recovery ownership.");
          keys.add(record.key);
          await cleanup(record);
        }
      } catch (cause) {
        blocked = new Error("Pipa could not reconcile abandoned OpenCode context/admissions. New intake is blocked; recovery records have been retained.", { cause });
        throw blocked;
      }
    })();
    await readiness;
  }

  async function listModels(workingDirectory, signal) {
    const input = { location: { directory: workingDirectory } };
    const [catalog, defaults] = await readWithRecovery((readSignal) => Promise.all([
      client.model.list(input, { signal: readSignal }), client.model.default(input, { signal: readSignal }),
    ]), signal);
    for (const snapshot of [catalog, defaults]) {
      if (typeof snapshot?.location?.directory !== "string" || path.resolve(snapshot.location.directory) !== path.resolve(workingDirectory)) throw new Error("OpenCode model workspace identity mismatch.");
    }
    if (!Array.isArray(catalog.data) || catalog.data.some((model) => !model || typeof model.id !== "string" || !model.id
      || typeof model.providerID !== "string" || !model.providerID || typeof model.name !== "string" || typeof model.enabled !== "boolean"
      || !Array.isArray(model.variants) || model.variants.some((variant) => typeof variant?.id !== "string" || !variant.id))) throw new Error("OpenCode returned an invalid model catalog.");
    // Native discovery resolves configured/connected providers. Never expose its
    // settings/headers/body: these can contain provider credentials.
    const models = catalog.data.filter((model) => model.enabled).map((model) => ({
      providerID: model.providerID, id: model.id, name: model.name, variants: [...new Set(["default", ...model.variants.map((variant) => variant.id)])],
    }));
    const selected = defaults.data;
    if (selected !== null && (!selected || typeof selected.providerID !== "string" || typeof selected.id !== "string")) throw new Error("OpenCode returned an invalid default model.");
    const defaultModel = selected && models.find((model) => model.providerID === selected.providerID && model.id === selected.id);
    return { models, defaultModel: defaultModel ? { providerID: defaultModel.providerID, id: defaultModel.id, variant: "default" } : null };
  }

  return {
    ready,
    listModels,
    async switchModel(sessionId, model, workingDirectory, signal) {
      if (typeof sessionId !== "string" || !sessionId) throw new Error("Invalid OpenCode session ID.");
      if (model !== null && (!model || typeof model.providerID !== "string" || !model.providerID || typeof model.id !== "string" || !model.id
        || (model.variant !== undefined && (typeof model.variant !== "string" || !model.variant)))) throw new Error("Invalid OpenCode model selection.");
      const catalog = await listModels(workingDirectory, signal);
      // 2.0.29 has no nullable switch/reset operation. Reset resolves the native
      // default now, then selects it explicitly; it does not clear a stored override.
      const selection = model === null ? catalog.defaultModel : { providerID: model.providerID, id: model.id, variant: model.variant ?? "default" };
      const available = selection && catalog.models.find((item) => item.providerID === selection.providerID && item.id === selection.id);
      if (!available || !available.variants.includes(selection.variant)) throw new Error("OpenCode model or variant is unavailable.");
      if (!await lookup(sessionId, workingDirectory, signal)) throw new Error("OpenCode session is unavailable; model selection did not create a replacement.");
      signal.throwIfAborted();
      // Do not retry a mutation with an uncertain acknowledgement or interrupt an
      // in-flight step. Native switching applies to subsequent provider steps.
      await client.session.switchModel({ sessionID: sessionId, model: selection }, { signal });
    },
    async resolveSession(sessionId, workingDirectory, controller) {
      const signal = controller.signal;
      if (sessionId && !await lookup(sessionId, workingDirectory, signal)) sessionId = null;
      if (!sessionId) {
        const session = await client.session.create({ location: { directory: workingDirectory } }, { signal });
        if (typeof session?.id !== "string" || session.location?.directory !== workingDirectory) throw new Error("OpenCode did not create a session in the configured workspace.");
        sessionId = session.id;
      }
      const [baseline, inbox, active] = await Promise.all([
        readWithRecovery((readSignal) => messages(sessionId, readSignal), signal),
        readWithRecovery((readSignal) => client.session.inbox.list({ sessionID: sessionId }, { signal: readSignal }), signal),
        readWithRecovery((readSignal) => client.session.active({ signal: readSignal }), signal),
      ]);
      if (!Array.isArray(inbox) || !active || typeof active !== "object") throw new Error("OpenCode returned invalid session projections.");
      if (inbox.length || active[sessionId] || turns.has(sessionId)) throw new Error("OpenCode attribution conflict: the session already has an active writer.");
      return { sessionId, baseline: baseline.map((message) => message.id) };
    },
    async execute({ sessionId, baseline, workingDirectory, controller, prompt, files, instructions, onInteraction, onPermissionReplied, onPermissionsReconciled }) {
      if (blocked) throw blocked;
      const signal = controller.signal;
      const record = { sessionId, workingDirectory, baseline, id: options.inputId?.() ?? `msg_${randomUUID().replaceAll("-", "")}`,
        key: `${prefix}${randomUUID()}`, phase: "prepared", instruction: "absent" };
      turns.set(sessionId, record);
      let stream;
      let watching;
      let streamError;
      let dismissed = false;
      let permissionRejected = false;
      const interactions = new Map();
      const interactionSessions = new Set([sessionId]);
      const permissionReplies = new Set();
      async function belongs(candidate) {
        const original = candidate;
        const visited = new Set();
        while (candidate && !visited.has(candidate)) {
          visited.add(candidate);
          let session;
          try { session = await readWithRecovery((readSignal) => client.session.get({ sessionID: candidate }, { signal: readSignal }), signal); }
          catch (error) { if (error._tag === "SessionNotFoundError") return false; throw error; }
          if (session?.id !== candidate || typeof session.location?.directory !== "string" || path.resolve(session.location.directory) !== path.resolve(workingDirectory)) return false;
          if (candidate === sessionId) { interactionSessions.add(original); return true; }
          candidate = session.parentID;
        }
        return false;
      }
      function settle(entry) {
        if (entry.accepted || entry.external) return;
        entry.external = true;
        entry.settled.resolve();
      }
      async function awaitSubmissions() {
        while (true) {
          const submissions = [...interactions.values()].filter((entry) => entry.submitting).map((entry) => entry.submission);
          if (!submissions.length) return;
          // HTTP acknowledgements have the client's request deadline; uncertain
          // responses use bounded authoritative recovery before this resolves.
          await Promise.allSettled(submissions);
        }
      }
      async function dispatch(kind, request) {
        const key = `${kind}:${request.sessionID}:${request.id}`;
        if (!onInteraction || interactions.has(key) || !await belongs(request.sessionID)) return;
        if (interactions.has(key) || signal.aborted) return;
        const fields = request.fields;
        const question = kind === "form" && request.metadata?.kind === "question" && Array.isArray(fields) && fields.length
          && fields.every((field, index) => field.key === `q${index}` && ["string", "multiselect"].includes(field.type) && !field.hidden && !field.when?.length);
        const type = kind === "permission" ? "permission" : question ? "question" : "form";
        let tool;
        if (kind === "permission" && request.source?.type === "tool") {
          try {
            const message = await readWithRecovery((readSignal) => client.session.message.get({ sessionID: request.sessionID, messageID: request.source.messageID }, { signal: readSignal }), signal);
            const part = message.content?.find((part) => part.type === "tool" && part.id === request.source.id);
            if (part) tool = { name: part.name, input: part.state?.input };
          } catch (error) { if (error._tag !== "MessageNotFoundError") throw error; }
        }
        if (interactions.has(key) || signal.aborted) return;
        const normalized = question ? { ...request, questions: fields.map((field) => ({
          header: field.title || request.title, question: field.description || field.title || request.title,
          multiple: field.type === "multiselect", custom: field.custom ?? !field.options?.length,
          options: field.options?.map((option) => ({ label: option.label, description: option.description })),
        })) } : tool ? { ...request, tool } : request;
        const entry = { kind, request, settled: Promise.withResolvers() };
        interactions.set(key, entry);
        const submitDecision = async (decision) => {
          if (entry.accepted) return;
          if (entry.external) throw new Error("OpenCode request is already settled.");
          if (type === "form") throw new Error("This form requires an OpenCode client response.");
          signal.throwIfAborted();
          entry.submitting = true;
          const native = { sessionID: request.sessionID, ...(kind === "form" ? { formID: request.id } : { requestID: request.id }) };
          try {
            // Reconcile an earlier lost reply before permitting another mutation.
            if (!await pending(entry)) { settle(entry); throw new Error("OpenCode request is already settled."); }
            try {
              if (kind === "permission") {
                const decisionValue = ["reject", "stop"].includes(decision?.type) ? "reject" : decision?.type === "reply" ? decision.reply : null;
                if (!["once", "always", "reject"].includes(decisionValue)) throw new Error("Invalid OpenCode permission decision.");
                await client.permission.reply({ ...native, decision: decisionValue }, { signal });
              } else if (["reject", "stop"].includes(decision?.type)) {
                if (decision.type === "stop" && request.sessionID === sessionId && typeof request.metadata?.tool?.messageID === "string" && typeof request.metadata.tool.id === "string") {
                  record.dismissal = { formId: request.id, messageId: request.metadata.tool.messageID, toolId: request.metadata.tool.id };
                  await mutate((items) => items.map((item) => item.key === record.key ? { ...record } : item));
                }
                await client.session.form.cancel(native, { signal });
              } else if (question && decision?.type === "answer") {
                if (!Array.isArray(decision.answers) || decision.answers.length !== fields.length) throw new Error("Invalid OpenCode question answers.");
                const answer = Object.fromEntries(fields.map((field, index) => {
                  const values = decision.answers[index];
                  if (!Array.isArray(values) || !values.every((value) => typeof value === "string") || (field.type === "string" && values.length !== 1)) throw new Error("Invalid OpenCode question answer.");
                  const encoded = values.map((value) => field.options?.find((option) => option.label === value)?.value ?? value);
                  return [field.key, field.type === "multiselect" ? encoded : encoded[0]];
                }));
                await client.session.form.reply({ ...native, answer }, { signal });
              } else throw new Error("This form requires an OpenCode client response.");
            } catch (error) {
              signal.throwIfAborted();
              if (retryable(error) || error.reason === "MalformedResponse" || ["FormAlreadySettledError", "FormNotFoundError", "PermissionNotFoundError"].includes(error._tag)) {
                if (!await pending(entry)) { settle(entry); return; }
              }
              throw error;
            }
            entry.accepted = true;
            if (kind === "permission" && (decision.type === "reject" || decision.reply === "reject")) permissionRejected = true;
            if (decision.type === "stop") {
              dismissed = true;
              await client.session.interrupt({ sessionID: request.sessionID, resume: false }, { signal });
            }
          } finally { entry.submitting = false; }
        };
        const submit = (decision) => {
          if (entry.submitting) return Promise.reject(new Error("OpenCode response is already being submitted."));
          entry.submission = submitDecision(decision);
          return entry.submission;
        };
        void Promise.resolve().then(() => onInteraction({ type, request: normalized, sessionId: request.sessionID, signal, submit, settled: entry.settled.promise }))
          .then(async (decision) => {
            if (!entry.accepted && !entry.external && !signal.aborted && !["cancelled", "stopped"].includes(decision?.type)) await submit(decision);
          }).catch((error) => { if (!signal.aborted) process.stderr.write(`OpenCode interaction handler error: ${error.message}\n`); });
      }
      async function pending(entry) {
        return readWithRecovery(async (readSignal) => {
          if (!await belongs(entry.request.sessionID)) return false;
          if (entry.kind === "permission") return (await client.permission.list({ sessionID: entry.request.sessionID }, { signal: readSignal })).some((item) => item.id === entry.request.id);
          try { return (await client.session.form.get({ sessionID: entry.request.sessionID, formID: entry.request.id }, { signal: readSignal })).state.status === "pending"; }
          catch (error) { if (error._tag === "FormNotFoundError") return false; throw error; }
        }, signal);
      }
      async function reconcileInteractions() {
        if (!onInteraction && !onPermissionsReconciled) return;
        const before = [...interactions.values()];
        const input = { location: { directory: workingDirectory } };
        const snapshots = await readWithRecovery(async (readSignal) => Promise.all([
          client.form.list(input, { signal: readSignal }), client.permission.request.list(input, { signal: readSignal }),
        ]), signal);
        for (const [index, snapshot] of snapshots.entries()) {
          if (path.resolve(snapshot.location?.directory ?? "") !== path.resolve(workingDirectory) || !Array.isArray(snapshot.data)) throw new Error("OpenCode returned invalid interaction location projections.");
          const kind = index === 0 ? "form" : "permission";
          for (const request of snapshot.data) await dispatch(kind, request);
          for (const entry of before) {
            if (entry.kind === kind && !entry.accepted && !entry.submitting && !entry.external
              && !snapshot.data.some((request) => request.id === entry.request.id && request.sessionID === entry.request.sessionID)) settle(entry);
          }
          if (kind === "permission" && onPermissionsReconciled) {
            const scoped = [];
            for (const request of snapshot.data) if (await belongs(request.sessionID)) scoped.push(request);
            for (const sessionId of interactionSessions) onPermissionsReconciled({ sessionId, requestIds: new Set(scoped.filter((request) => request.sessionID === sessionId).map((request) => request.id)) });
          }
        }
      }
      try {
        await mutate((items) => [...items, { ...record }]);
        signal.throwIfAborted();
        const subscribed = Promise.withResolvers();
        stream = new AbortController();
        const streamSignal = stream.signal;
        const events = OpenCode.make({ baseUrl: options.baseUrl, headers: options.headers, fetch: async (url, init) => {
          const response = await options.fetch(url, init);
          if (response.ok && response.headers.get("content-type")?.includes("text/event-stream")) subscribed.resolve();
          return response;
        } });
        watching = (async () => {
          while (!streamSignal.aborted && !fatalError) {
            try {
              for await (const event of events.event.subscribe({ signal: streamSignal })) {
                if (typeof event?.type !== "string" || !event.data || typeof event.id !== "string") throw new Error("OpenCode returned an invalid event.");
                if (event.type === "session.inbox.enqueued" && event.data.sessionID === sessionId && event.data.inboxID !== record.id) record.foreign = true;
                if ((onInteraction || onPermissionReplied || onPermissionsReconciled) && (!event.location || path.resolve(event.location.directory ?? "") === path.resolve(workingDirectory))) {
                  if (event.type === "form.created") await dispatch("form", event.data.form);
                  if (event.type === "permission.asked") await dispatch("permission", event.data);
                  if (event.type === "permission.replied" && onPermissionReplied && await belongs(event.data.sessionID)) {
                    const key = `${event.data.sessionID}:${event.data.requestID}`;
                    if (!permissionReplies.has(key)) {
                      permissionReplies.add(key);
                      onPermissionReplied({ sessionId: event.data.sessionID, requestId: event.data.requestID, reply: event.data.reply });
                    }
                  }
                  if (["form.replied", "form.cancelled", "permission.replied", "location.shutdown"].includes(event.type)) await reconcileInteractions();
                }
              }
            } catch (error) {
              if (streamSignal.aborted) return;
              if (!retryable(error)) { streamError = error; subscribed.reject(error); return; }
            }
            await delay(options.pollIntervalMs, undefined, { signal: streamSignal }).catch(() => undefined);
          }
        })();
        const subscriptionTimer = setTimeout(() => subscribed.reject(new Error("OpenCode event subscription recovery timed out.")), options.connectionRecoveryTimeoutMs ?? 10_000);
        try {
          await Promise.race([subscribed.promise, new Promise((_, reject) => {
            if (signal.aborted) reject(signal.reason);
            else signal.addEventListener("abort", () => reject(signal.reason), { once: true, signal: stream.signal });
          })]);
        } catch (error) {
          signal.throwIfAborted();
          await lookup(sessionId, workingDirectory, signal);
          throw error;
        } finally { clearTimeout(subscriptionTimer); }
        signal.throwIfAborted();
        await reconcileInteractions();
        record.instruction = "putting";
        await mutate((items) => items.map((item) => item.key === record.key ? { ...record } : item));
        // Cancellation waits for this independently bounded mutation before cleanup.
        // A lost reply retains `putting` until acknowledged namespaced removal.
        await client.session.instructions.entry.put({ sessionID: sessionId, key: record.key, value: instructions }, { signal: AbortSignal.timeout(options.instructionMutationTimeoutMs ?? 5_000) });
        record.instruction = "present";
        await mutate((items) => items.map((item) => item.key === record.key ? { ...record } : item));
        signal.throwIfAborted();
        const input = { sessionID: sessionId, id: record.id, text: prompt, ...(files.length ? { files: files.map((file) => ({ uri: file.url, name: file.filename })) } : {}) };
        let admissionDisconnectedAt;
        while (true) {
          if (streamError) throw streamError;
          await reconcileInteractions();
          const state = await projection(record, signal);
          if (state.foreign || record.foreign) throw new Error("OpenCode attribution conflict: foreign input entered the Pipa turn.");
          if (state.own || state.inbox.some((item) => item.id === record.id)) break;
          try {
            if (record.phase === "prepared") {
              record.phase = "admitting";
              await mutate((items) => items.map((item) => item.key === record.key ? { ...record } : item));
            }
            const admitted = await client.session.prompt(input, { signal });
            if (admitted?.id !== record.id || admitted.sessionID !== sessionId || admitted.type !== "user" || admitted.payload?.text !== prompt) throw new Error("OpenCode returned an invalid prompt admission.");
            break;
          } catch (error) {
            signal.throwIfAborted();
            if (!retryable(error) && error.reason !== "MalformedResponse") {
              if (["AttachmentError", "SessionNotFoundError", "AgentNotFoundError", "SkillNotFoundError"].includes(error._tag)) {
                record.phase = "prepared";
                await mutate((items) => items.map((item) => item.key === record.key ? { ...record } : item));
              }
              throw error;
            }
            admissionDisconnectedAt ??= Date.now();
            if (Date.now() - admissionDisconnectedAt >= (options.connectionRecoveryTimeoutMs ?? 10_000)) {
              const state = await projection(record, signal);
              if (state.foreign || record.foreign) throw new Error("OpenCode attribution conflict: foreign input entered the Pipa turn.");
              if (state.own || state.inbox.some((item) => item.id === record.id)) break;
              throw new Error("OpenCode prompt admission remains uncertain after bounded connection recovery.");
            }
            await delay(options.pollIntervalMs, undefined, { signal });
          }
        }
        record.phase = "admitted";
        await mutate((items) => items.map((item) => item.key === record.key ? { ...record } : item));
        while (true) {
          if (streamError) throw streamError;
          await reconcileInteractions();
          const state = await projection(record, signal);
          if (state.foreign || record.foreign) throw new Error("OpenCode attribution conflict: foreign input entered the Pipa turn.");
          if (state.own?.text !== undefined && state.own.text !== prompt) throw new Error("OpenCode attribution conflict: projected input differs from the admitted prompt.");
          if (state.dismissed || state.idle) await awaitSubmissions();
          if (state.dismissed) return "";
          if (state.idle) {
            if (dismissed) return "";
            if (state.idle.outcome !== "succeeded" || state.assistant?.error || state.assistant?.finish !== "stop"
              || typeof state.assistant.time?.completed !== "number" || state.assistant.retry) throw new Error("OpenCode failed to complete the turn.");
            const text = state.assistant.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
            if (!text && permissionRejected) return "Stopped after a permission was rejected.";
            if (!text) throw new Error("OpenCode completed without assistant text.");
            return text;
          }
          await delay(options.pollIntervalMs, undefined, { signal });
        }
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw error;
      } finally {
        await awaitSubmissions();
        for (const entry of interactions.values()) settle(entry);
        let foreign;
        try {
          try {
            if (records.some((item) => item.key === record.key)) foreign = await cleanup(record);
          } catch (cause) {
            blocked = new Error(`${cause.message.startsWith("OpenCode attribution conflict") ? "OpenCode attribution conflict. " : ""}Pipa OpenCode cleanup failed. New intake is blocked; recovery records have been retained.`, { cause });
            throw blocked;
          }
        } finally {
          stream?.abort();
          await watching;
          turns.delete(sessionId);
        }
        if (foreign || record.foreign) throw new Error("OpenCode attribution conflict: foreign input observed during final cleanup.");
      }
    },
    // Local cancellation causes execute's independent cleanup to cancel only owned input.
    async abortTurn() {},
  };
}

function retryable(error) {
  return error.reason === "Transport" || (error.reason === "UnexpectedStatus" && [502, 503, 504].includes(error.cause?.status));
}
