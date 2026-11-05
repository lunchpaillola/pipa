import { OpenCode } from "@opencode/client";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";

export function createV2Adapter(options) {
  const observers = new Map();
  const controllers = new Set();
  let events;
  let eventTask;
  let connected = false;
  let stopped;
  let stopping = [];
  const client = OpenCode.make({ baseUrl: options.baseUrl, headers: options.headers, fetch: options.fetch });

  async function lookup(sessionId, signal) {
    let session;
    try { session = await client.session.get({ sessionID: sessionId }, { signal }); }
    catch (error) {
      if (error._tag === "SessionNotFoundError" && error.sessionID === sessionId) return null;
      throw error;
    }
    if (session?.id !== sessionId) throw new Error("OpenCode session identity mismatch.");
    return session;
  }

  async function listModels(workingDirectory, signal) {
    const input = { location: { directory: workingDirectory } };
    const catalog = await client.model.list(input, { signal });
    if (!Array.isArray(catalog.data)) throw new Error("OpenCode returned an invalid model catalog.");
    const enabled = catalog.data.filter((model) => model?.enabled);
    if (enabled.some((model) => typeof model.id !== "string" || !model.id
      || typeof model.providerID !== "string" || !model.providerID)) throw new Error("OpenCode returned an invalid model catalog.");
    const models = enabled.map((model) => ({
      providerID: model.providerID, id: model.id, name: model.name,
    }));
    return { models };
  }

  function settleWaiters(observer, value, error) {
    for (const waiter of observer.waiters) {
      if (error) waiter.reject(error);
      else waiter.resolve(value);
    }
  }

  async function report(observer, error) {
    await observer.onError?.(error, observer.controller.signal);
    settleWaiters(observer, undefined, error);
  }

  function detach(observer, reason = new Error("OpenCode observer stopped.")) {
    observer.controller.abort(reason);
    observer.initialized.reject(reason);
    settleWaiters(observer, undefined, reason);
    for (const entry of observer.interactions.values()) entry.settled.resolve();
    if (observers.get(observer.sessionId) === observer) observers.delete(observer.sessionId);
    if (!observers.size) events?.abort(reason);
  }

  async function belongs(observer, candidate) {
    const visited = new Set();
    while (candidate && !visited.has(candidate)) {
      visited.add(candidate);
      let session;
      try { session = await client.session.get({ sessionID: candidate }, { signal: observer.controller.signal }); }
      catch (error) { if (error._tag === "SessionNotFoundError") return false; throw error; }
      if (session?.id !== candidate) return false;
      if (candidate === observer.sessionId) return true;
      candidate = session.parentID;
    }
    return false;
  }

  async function pending(observer, entry) {
    const signal = observer.controller.signal;
    if (entry.kind === "permission") return (await client.permission.list({ sessionID: entry.request.sessionID }, { signal })).some((item) => item.id === entry.request.id);
    try { return (await client.session.form.get({ sessionID: entry.request.sessionID, formID: entry.request.id }, { signal })).state.status === "pending"; }
    catch (error) { if (error._tag === "FormNotFoundError") return false; throw error; }
  }

  function settle(entry) {
    if (entry.accepted || entry.external) return;
    entry.external = true;
    entry.settled.resolve();
  }

  async function dispatch(observer, kind, request) {
    const signal = observer.controller.signal;
    const revision = observer.interactionRevision;
    const key = `${kind}:${request.sessionID}:${request.id}`;
    if (!observer.onInteraction || observer.interactions.has(key) || !await belongs(observer, request.sessionID)) return;
    if (observer.interactions.has(key) || signal.aborted || revision !== observer.interactionRevision) return;
    const fields = request.fields;
    const question = kind === "form" && Array.isArray(fields) && fields.length
      && fields.every((field) => ["string", "multiselect"].includes(field.type) && !field.hidden && !field.when?.length);
    const type = kind === "permission" ? "permission" : question ? "question" : "form";
    let tool;
    if (kind === "permission" && request.source?.type === "tool") {
      try {
        const message = await client.session.message.get({ sessionID: request.sessionID, messageID: request.source.messageID }, { signal });
        const part = message.content?.find((part) => part.type === "tool" && part.id === request.source.id);
        if (part) tool = { name: part.name, input: part.state?.input };
      } catch (error) { if (error._tag !== "MessageNotFoundError") throw error; }
    }
    if (observer.interactions.has(key) || signal.aborted || revision !== observer.interactionRevision) return;
    const normalized = question ? { ...request, questions: fields.map((field) => ({
      header: field.title || request.title, question: field.description || field.title || request.title,
      multiple: field.type === "multiselect", custom: field.custom ?? !field.options?.length,
      required: field.required ?? false,
      options: field.options,
    })) } : tool ? { ...request, tool } : request;
    const entry = { kind, request, settled: Promise.withResolvers() };
    observer.interactions.set(key, entry);
    const submitDecision = async (decision) => {
      if (entry.accepted) return;
      if (entry.external) throw new Error("OpenCode request is already settled.");
      if (type === "form") throw new Error("This form requires an OpenCode client response.");
      signal.throwIfAborted();
      entry.submitting = true;
      const native = { sessionID: request.sessionID, ...(kind === "form" ? { formID: request.id } : { requestID: request.id }) };
      try {
        if (!await pending(observer, entry)) { settle(entry); throw new Error("OpenCode request is already settled."); }
        try {
          if (kind === "permission") {
            const value = ["reject", "stop"].includes(decision?.type) ? "reject" : decision?.type === "reply" ? decision.reply : null;
            if (!["once", "always", "reject"].includes(value)) throw new Error("Invalid OpenCode permission decision.");
            await client.permission.reply({ ...native, decision: value }, { signal });
          } else if (["reject", "stop"].includes(decision?.type)) {
            await client.session.form.cancel(native, { signal });
          } else if (question && decision?.type === "answer") {
            if (!Array.isArray(decision.answers) || decision.answers.length !== fields.length) throw new Error("Invalid OpenCode question answers.");
            const answer = Object.fromEntries(fields.flatMap((field, index) => {
              const values = decision.answers[index];
              if (values === null && !field.required) return [];
              if (!Array.isArray(values) || !values.every((value) => typeof value === "string") || (field.type === "string" && values.length !== 1)) throw new Error("Invalid OpenCode question answer.");
              return [[field.key, field.type === "multiselect" ? values : values[0]]];
            }));
            await client.session.form.reply({ ...native, answer }, { signal });
          } else throw new Error("This form requires an OpenCode client response.");
        } catch (error) {
          signal.throwIfAborted();
          if (["Transport", "MalformedResponse"].includes(error.reason)
            || (error.reason === "UnexpectedStatus" && [502, 503, 504].includes(error.cause?.status))
            || ["FormAlreadySettledError", "FormNotFoundError", "PermissionNotFoundError"].includes(error._tag)) {
            if (!await pending(observer, entry)) { settle(entry); return; }
            else throw error;
          } else throw error;
        }
        entry.accepted = true;
        // Native rejection/cancellation need not produce an idle event.
        if (decision.type === "stop") {
          try { await client.session.interrupt({ sessionID: request.sessionID, resume: false }, { signal }); }
          finally { settleWaiters(observer, ""); }
        } else if (decision.type === "reject" || decision.reply === "reject") settleWaiters(observer, "Stopped after a request was rejected.");
      } finally { entry.submitting = false; }
    };
    const submit = (decision) => {
      if (entry.submitting) return Promise.reject(new Error("OpenCode response is already being submitted."));
      const submission = submitDecision(decision);
      observer.handlers.add(submission);
      void submission.then(() => observer.handlers.delete(submission), () => observer.handlers.delete(submission));
      return submission;
    };
    const handler = Promise.resolve().then(() => {
      signal.throwIfAborted();
      return observer.onInteraction({ type, request: normalized, sessionId: request.sessionID, signal, submit, settled: entry.settled.promise });
    })
      .then(async (decision) => {
        if (!entry.accepted && !entry.external && !signal.aborted && !["cancelled", "stopped"].includes(decision?.type)) await submit(decision);
      }).catch(() => { if (!signal.aborted) process.stderr.write("OpenCode interaction handler failed.\n"); });
    observer.handlers.add(handler);
    void handler.finally(() => observer.handlers.delete(handler));
  }

  function reconcile(observer) {
    observer.reconcileRequested = true;
    if (observer.reconciliation) return observer.reconciliation;
    observer.reconciliation = Promise.resolve().then(async () => {
      try {
        while (observer.reconcileRequested && !observer.controller.signal.aborted) {
          observer.reconcileRequested = false;
          try { await reconcilePending(observer); }
          catch (error) { if (!observer.reconcileRequested) throw error; }
        }
      } finally { observer.reconciliation = undefined; }
    });
    return observer.reconciliation;
  }

  async function reconcilePending(observer) {
    if (!observer.onInteraction && !observer.onPermissionsReconciled) return;
    const signal = observer.controller.signal;
    const revision = observer.interactionRevision;
    const sessionIds = new Set([observer.sessionId]);
    for (const sessionId of sessionIds) {
      signal.throwIfAborted();
      const input = { sessionID: sessionId };
      const results = await Promise.allSettled(["form", "permission"].map(async (kind) => {
        let snapshot;
        try {
          snapshot = await (kind === "form"
            ? client.session.form.list(input, { signal }) : client.permission.list(input, { signal }));
          if (!Array.isArray(snapshot) || snapshot.some((request) => request.sessionID !== sessionId)) throw new Error("OpenCode returned an invalid interaction projection.");
        } catch {
          if (!signal.aborted) process.stderr.write(`OpenCode ${kind} reconciliation read failed.\n`);
          return;
        }
        if (signal.aborted || revision !== observer.interactionRevision) return;
        for (const request of snapshot) await dispatch(observer, kind, request);
        if (signal.aborted || revision !== observer.interactionRevision) return;
        for (const [key, entry] of observer.interactions) {
          if (entry.kind === kind && entry.request.sessionID === sessionId && !entry.submitting && !snapshot.some((request) => request.id === entry.request.id)) {
            settle(entry);
            observer.interactions.delete(key);
          }
        }
        if (kind === "permission" && observer.onPermissionsReconciled && await belongs(observer, sessionId)
          && !signal.aborted && revision === observer.interactionRevision) {
          await observer.onPermissionsReconciled({ sessionId, requestIds: new Set(snapshot.map((request) => request.id)) });
        }
      }));
      for (const result of results) if (result.status === "rejected") throw result.reason;
      if (signal.aborted || revision !== observer.interactionRevision) return;
      let cursor;
      do {
        try {
          const page = await client.session.list({ parentID: sessionId, ...(cursor ? { cursor } : {}) }, { signal });
          if (!Array.isArray(page.data)) throw new Error("OpenCode returned an invalid session projection.");
          for (const child of page.data) if (typeof child.id === "string" && child.parentID === sessionId) sessionIds.add(child.id);
          cursor = page.cursor.next;
        } catch {
          if (!signal.aborted) process.stderr.write("OpenCode descendant discovery failed.\n");
          break;
        }
      } while (cursor);
    }
  }

  // Native 2.2.5's experimental session log emits no responses; forward live events only.
  function watchEvents() {
    if (events && !events.signal.aborted) return;
    events = new AbortController();
    connected = false;
    const signal = events.signal;
    eventTask = (async () => {
      while (!signal.aborted) {
        try {
          for await (const event of client.event.subscribe({ signal })) {
            if (event.type === "server.connected") {
              connected = true;
              for (const observer of observers.values()) {
                queueResponse(observer, async () => {
                  if (!await lookup(observer.sessionId, observer.controller.signal)) throw new Error("OpenCode session is unavailable.");
                  observer.initialized.resolve();
                }, true);
                void reconcile(observer).catch(() => undefined);
              }
              continue;
            }
            for (const observer of observers.values()) {
              if (event.data?.sessionID === observer.sessionId) {
                if (event.type === "session.step.ended" && event.data.finish === "stop") queueResponse(observer, async () => {
                  const message = await client.session.message.get({ sessionID: observer.sessionId, messageID: event.data.assistantMessageID }, { signal: observer.controller.signal });
                  await deliverResponse(observer, message);
                });
                if (event.type === "session.execution.failed") queueResponse(observer, () => report(observer, Object.assign(new Error(event.data.error.message), event.data.error)));
                if (event.type === "session.execution.interrupted") settleWaiters(observer, "");
                if (event.type === "session.tool.called") void reconcile(observer).catch(() => undefined);
              }
              if (!["form.created", "permission.asked", "form.replied", "form.cancelled", "permission.replied", "location.shutdown", "session.created", "session.forked", "session.moved"].includes(event.type)) continue;
              observer.interactionTask = (observer.interactionTask ?? Promise.resolve()).then(async () => {
                if (observer.controller.signal.aborted) return;
                if (["session.created", "session.forked", "session.moved"].includes(event.type)
                  && await belongs(observer, event.data.parentID ?? event.data.sessionID)) void reconcile(observer).catch(() => undefined);
                if (event.type === "form.created") await dispatch(observer, "form", event.data.form);
                if (event.type === "permission.asked") await dispatch(observer, "permission", event.data);
                if (event.type === "permission.replied" && await belongs(observer, event.data.sessionID)) {
                  const key = `${event.data.sessionID}:${event.data.requestID}`;
                  if (!observer.replied.has(key)) {
                    await observer.onPermissionReplied?.({ sessionId: event.data.sessionID, requestId: event.data.requestID, reply: event.data.reply });
                    observer.replied.add(key);
                  }
                }
                if (["form.replied", "form.cancelled", "permission.replied", "location.shutdown"].includes(event.type)) {
                  observer.interactionRevision++;
                  const kind = event.type.startsWith("form.") ? "form" : "permission";
                  const id = kind === "form" ? event.data?.id : event.data?.requestID;
                  const entry = observer.interactions.get(`${kind}:${event.data?.sessionID}:${id}`);
                  if (entry && !entry.submitting) settle(entry);
                  void reconcile(observer).catch(() => undefined);
                }
              }).catch(() => { if (!observer.controller.signal.aborted) process.stderr.write("OpenCode interaction event failed.\n"); });
            }
          }
        } catch { if (signal.aborted) return; }
        connected = false;
        await delay(options.pollIntervalMs ?? 100, undefined, { signal }).catch(() => undefined);
      }
    })();
  }

  function queueResponse(observer, operation, fatal = false) {
    observer.task = (observer.task ?? Promise.resolve()).then(async () => {
      const signal = observer.controller.signal;
      if (signal.aborted) return;
      try { await operation(); }
      catch (error) {
        if (signal.aborted) return;
        if (fatal) {
          observer.initialized.reject(error);
          await report(observer, error).catch(() => undefined);
          detach(observer, error);
          return;
        }
        await report(observer, error).catch(() => process.stderr.write("Pipa could not deliver an OpenCode response.\n"));
      }
    });
  }

  async function deliverResponse(observer, message) {
    if (observer.controller.signal.aborted || observer.delivered.has(message.id)) return;
    if (message.type !== "assistant" || message.finish !== "stop" || typeof message.time?.completed !== "number") return;
    if (!Array.isArray(message.content)) throw new Error("OpenCode returned an invalid assistant message.");
    const text = message.content.filter((part) => part.type === "text" && typeof part.text === "string").map((part) => part.text).join("\n").trim();
    // A failed Slack post may have sent earlier chunks; never replay the whole response.
    observer.delivered.add(message.id);
    if (text) {
      await observer.onResponse?.(text, message.id, observer.controller.signal);
    }
    settleWaiters(observer, text);
  }

  async function follow(input, persistent, waiter) {
    if (stopped) throw stopped;
    if (typeof input.sessionId !== "string" || !input.sessionId || typeof input.workingDirectory !== "string" || !input.workingDirectory) throw new Error("Invalid OpenCode session context.");
    let observer = observers.get(input.sessionId);
    const created = !observer;
    if (!observer) {
      observer = { sessionId: input.sessionId, controller: new AbortController(), initialized: Promise.withResolvers(), delivered: new Set(), replied: new Set(), waiters: new Set(), handlers: new Set(), interactions: new Map(), interactionRevision: 0, persistent };
      observers.set(input.sessionId, observer);
      // Observe rejection immediately, including shutdown during initial attachment.
      void observer.initialized.promise.catch(() => undefined);
      observer.registration = (async () => {
        const signal = observer.controller.signal;
        if (!await lookup(input.sessionId, signal)) throw new Error("OpenCode session is unavailable.");
        try {
          const entries = await client.session.instructions.entry.list({ sessionID: input.sessionId }, { signal });
          observer.instructions = entries.find((entry) => entry.key === "pipa.slack")?.value;
          await Promise.all(entries.filter((entry) => /^pipa-[a-f0-9]{16}-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u.test(entry.key)).map((entry) => client.session.instructions.entry.remove({ sessionID: input.sessionId, key: entry.key }, { signal })));
        } catch { signal.throwIfAborted(); /* Old context migration is best effort and session-local. */ }
        watchEvents();
        if (connected) observer.initialized.resolve();
        await observer.initialized.promise;
      })();
    }
    if (waiter) observer.waiters.add(waiter);
    observer.persistent ||= persistent;
    for (const key of ["onResponse", "onError", "onInteraction", "onPermissionReplied", "onPermissionsReconciled"]) if (input[key] !== undefined) observer[key] = input[key];
    try {
      await observer.registration;
      observer.contextUpdate = (observer.contextUpdate ?? Promise.resolve()).catch(() => undefined).then(async () => {
        if (input.instructions !== undefined && observer.instructions !== input.instructions) {
          await client.session.instructions.entry.put({ sessionID: input.sessionId, key: "pipa.slack", value: input.instructions }, { signal: observer.controller.signal });
          observer.instructions = input.instructions;
        }
      });
      await observer.contextUpdate;
      if (observer.onInteraction || observer.onPermissionReplied || observer.onPermissionsReconciled) {
        watchEvents();
        await reconcile(observer).catch(() => undefined);
      }
      return observer;
    } catch (error) { if (created) detach(observer, error); throw error; }
  }

  return {
    async ready(workingDirectory) { if (stopped) throw stopped; },
    listModels,
    async switchModel(sessionId, model, workingDirectory, signal) {
      if (typeof sessionId !== "string" || !sessionId) throw new Error("Invalid OpenCode session ID.");
      if (model !== null && (!model || typeof model.providerID !== "string" || !model.providerID || typeof model.id !== "string" || !model.id
        || (model.variant !== undefined && (typeof model.variant !== "string" || !model.variant)))) throw new Error("Invalid OpenCode model selection.");
      const session = await lookup(sessionId, signal);
      if (!session) throw new Error("OpenCode session is unavailable; model selection did not create a replacement.");
      const selection = model === null ? (await client.model.default({ location: { directory: session.location.directory } }, { signal })).data
        : model;
      if (selection !== null && (!selection || typeof selection.providerID !== "string" || typeof selection.id !== "string")) throw new Error("OpenCode returned an invalid default model.");
      if (!selection) throw new Error("OpenCode default model is unavailable.");
      signal.throwIfAborted();
      await client.session.switchModel({ sessionID: sessionId, model: { providerID: selection.providerID, id: selection.id, variant: model?.variant ?? "default" } }, { signal });
    },
    async resolveSession(sessionId, workingDirectory, controller) {
      const signal = controller.signal;
      let session = sessionId ? await lookup(sessionId, signal) : null;
      const created = !session;
      let locationRecovered;
      if (session) {
        const directory = session.location?.directory;
        if (typeof directory !== "string" || !directory) throw new Error("OpenCode returned an invalid session location.");
        try { await client.location.get({ location: { directory } }, { signal }); }
        catch (error) {
          if (error._tag !== "LocationNotFoundError" || error.location?.directory !== directory) throw error;
          session = await lookup(sessionId, signal);
          if (!session) throw new Error("OpenCode session is unavailable; the current request was not sent.");
          if (typeof session.location?.directory !== "string" || !session.location.directory) throw new Error("OpenCode returned an invalid session location; the current request was not sent.");
          if (session.location?.directory !== directory) {
            await client.location.get({ location: session.location }, { signal });
          } else {
            const target = await client.location.get({ location: { directory: workingDirectory } }, { signal });
            if (typeof target?.directory !== "string" || !target.directory) throw new Error("OpenCode returned an invalid fallback location; the current request was not sent.");
            // These snapshots refuse visible work, but are not a lock on other native clients.
            const active = await client.session.active({ signal });
            const inbox = await client.session.inbox.list({ sessionID: session.id }, { signal });
            if (!active || typeof active !== "object" || Array.isArray(active) || !Array.isArray(inbox)
              || Object.hasOwn(active, session.id) || inbox.length) throw new Error("Pipa could not repair the working folder while native work is active or pending; the current request was not sent.");
            session = await lookup(sessionId, signal);
            if (!session) throw new Error("OpenCode session is unavailable; the current request was not sent.");
            if (typeof session.location?.directory !== "string" || !session.location.directory) throw new Error("OpenCode returned an invalid session location; the current request was not sent.");
            if (session.location?.directory !== directory) {
              await client.location.get({ location: session.location }, { signal });
            } else {
              signal.throwIfAborted();
              try {
                await client.session.move({ sessionID: session.id, directory: target.directory, delivery: "queue" }, { signal });
                session = await lookup(sessionId, signal);
                if (session?.location?.directory !== target.directory) throw new Error("Move not applied.");
              } catch {
                signal.throwIfAborted();
                throw new Error("Pipa could not confirm the working-folder move. The current request was not sent; the move may still apply later.");
              }
              locationRecovered = { previousDirectory: directory, directory: target.directory };
            }
          }
        }
      }
      if (!session) {
        session = await client.session.create({ location: { directory: workingDirectory } }, { signal });
        if (typeof session?.id !== "string" || !session.id) throw new Error("OpenCode did not return a usable session identity.");
      }
      const history = !created && !session.model ? await client.message.list({ sessionID: session.id, limit: 1 }, { signal }) : null;
      if (history && !Array.isArray(history.data)) throw new Error("OpenCode returned an invalid message projection.");
      return { sessionId: session.id, defaultEligible: !session.model && (created || !history.data.length), ...(locationRecovered ? { locationRecovered } : {}) };
    },
    async followSession(input) { await follow(input, true); },
    async execute(input) {
      const signal = input.controller.signal;
      signal.throwIfAborted();
      controllers.add(input.controller);
      const waiter = input.onResponse ? null : Promise.withResolvers();
      if (waiter) void waiter.promise.catch(() => undefined);
      const cancelled = Promise.withResolvers();
      void cancelled.promise.catch(() => undefined);
      let observer;
      const abort = () => {
        cancelled.reject(signal.reason);
        if (waiter) waiter.reject(signal.reason);
        const current = observer ?? observers.get(input.sessionId);
        if (current && !current.persistent && current.waiters.size <= 1) detach(current, signal.reason);
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        observer = await Promise.race([follow(input, Boolean(input.onResponse), waiter), cancelled.promise]);
        signal.throwIfAborted();
        const selected = input.model ?? (input.defaultEligible ? input.defaultModel : null);
        if (selected) await client.session.switchModel({ sessionID: input.sessionId, model: { providerID: selected.providerID, id: selected.modelID ?? selected.id, variant: selected.variant ?? "default" } }, { signal });
        const id = options.inputId?.() ?? `msg_${randomUUID().replaceAll("-", "")}`;
        await client.session.prompt({ sessionID: input.sessionId, id, text: input.prompt,
          ...(input.files?.length ? { files: input.files.map((file) => ({ uri: file.url, name: file.filename })) } : {}),
        }, { signal });
        if (input.onResponse) return { pending: true };
        return await waiter.promise;
      } catch (error) {
        if (signal.aborted) throw signal.reason;
        throw error;
      } finally {
        controllers.delete(input.controller);
        signal.removeEventListener("abort", abort);
        if (waiter) observer?.waiters.delete(waiter);
        if (observer && !observer.persistent && !observer.waiters.size) detach(observer);
      }
    },
    async abortTurn(sessionId) {
      if (stopped) throw stopped;
      const observer = observers.get(sessionId);
      if (observer) settleWaiters(observer, "");
      const controller = new AbortController();
      controllers.add(controller);
      try { await client.session.interrupt({ sessionID: sessionId, resume: false }, { signal: controller.signal }); }
      finally { controllers.delete(controller); }
    },
    stopAll(reason = new Error("OpenCode bridge stopped.")) {
      stopped = reason;
      const current = [...observers.values()];
      stopping = [...stopping, eventTask, ...current.flatMap((observer) => [observer.task, observer.interactionTask, observer.registration, observer.contextUpdate, observer.reconciliation, ...observer.handlers])];
      for (const controller of controllers) controller.abort(reason);
      for (const observer of current) detach(observer, reason);
      events?.abort(reason);
    },
    async drain() { await Promise.allSettled(stopping); },
  };
}
