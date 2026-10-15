import { setTimeout as delay } from "node:timers/promises";

// The facade owns files, controllers and caller callbacks; this adapter owns v1 wire data.
export function createV1Adapter({ request, baseUrl, fetchImpl, headers, pollIntervalMs }) {
  let blocked;
  return {
    async ready() { if (blocked) throw blocked; },
    async resolveSession(sessionId, workingDirectory, controller) {
      let messages = [];
      if (sessionId) {
        while (true) {
          const status = (await request("/session/status", { method: "GET" }, workingDirectory, controller))?.[sessionId]?.type;
          if (status !== "busy" && status !== "retry") break;
          await delay(pollIntervalMs, undefined, { signal: controller.signal });
        }
        try {
          messages = await request(`/session/${encodeURIComponent(sessionId)}/message?limit=1`, { method: "GET" }, workingDirectory, controller);
        } catch (error) {
          if (error.status !== 404) throw error;
          // A missing message route is not evidence that a migrated session is absent.
          try {
            const session = await request(`/session/${encodeURIComponent(sessionId)}`, { method: "GET" }, workingDirectory, controller);
            if (session?.id !== sessionId) throw new Error("OpenCode returned an invalid session lookup.");
            throw error;
          } catch (lookupError) {
            if (lookupError === error || lookupError.status !== 404) throw lookupError;
            sessionId = null;
          }
        }
      }
      if (!sessionId) {
        const session = await request("/session", { method: "POST", body: "{}" }, workingDirectory, controller);
        if (!session?.id) throw new Error("OpenCode did not create a session.");
        sessionId = session.id;
        messages = [];
      }
      if (!Array.isArray(messages)) throw new Error("OpenCode returned an invalid message projection.");
      return { sessionId, baseline: new Set(messages.map((message) => message?.info?.id).filter(Boolean)) };
    },
    async execute({ sessionId, baseline, workingDirectory, controller, prompt, files, instructions, onInteraction, onPermissionReplied, onPermissionsReconciled }) {
      let dismissed = false;
      let permissionRejected = false;
      let watcher;
      let admitting = false;
      try {
        if (onInteraction) {
          watcher = watchInteractions({ baseUrl, fetchImpl, headers, sessionId, workingDirectory, controller,
            onInteraction, onPermissionReplied, onPermissionsReconciled,
            onPermissionRejected: () => { permissionRejected = true; }, onDismiss: () => { dismissed = true; }, requestTurn: request });
          await watcher.ready;
        }
        controller.signal.throwIfAborted();
        admitting = true;
        // Await bounded admission independently: cancelling its HTTP request could
        // otherwise race a late server acceptance after native abort has returned.
        const admission = new AbortController();
        const timeout = setTimeout(() => admission.abort(new Error("OpenCode prompt admission timed out.")), 5_000);
        try {
          await request(`/session/${encodeURIComponent(sessionId)}/prompt_async`, {
            method: "POST", body: JSON.stringify({ parts: [{ type: "text", text: prompt }, ...files.map((file) => ({ type: "file", ...file }))], system: instructions }),
          }, workingDirectory, admission, [204]);
        } catch (cause) {
          if (cause.status === undefined) {
            blocked = new Error("OpenCode prompt admission remains uncertain. New intake is blocked until the native work is reconciled.", { cause });
            controller.abort(blocked);
          }
          throw cause;
        } finally { clearTimeout(timeout); }
        controller.signal.throwIfAborted();
        while (true) {
          const [messages, statuses] = await Promise.all([
            request(`/session/${encodeURIComponent(sessionId)}/message?limit=1`, { method: "GET" }, workingDirectory, controller),
            request("/session/status", { method: "GET" }, workingDirectory, controller),
          ]);
          if (!Array.isArray(messages)) throw new Error("OpenCode returned an invalid message projection.");
          const message = messages.findLast((message) => message?.info?.id && !baseline.has(message.info.id) && message.info.role === "assistant");
          const status = statuses?.[sessionId]?.type;
          if (dismissed && status !== "busy" && status !== "retry") return "";
          if (["error", "failed", "cancelled"].includes(status) || message?.info.error) throw new Error("OpenCode failed to complete the turn.");
          const completed = typeof message?.info.time?.completed === "number";
          if (message && ((status !== "retry" && completed && message.info.finish === "stop") || status === "idle" || (!status && completed))) {
            const text = message.parts.filter((part) => part.type === "text" && typeof part.text === "string" && part.text).map((part) => part.text).join("\n").trim();
            if (!text && permissionRejected) return "Stopped after a permission was rejected.";
            if (!text) throw new Error("OpenCode completed without assistant text.");
            return text;
          }
          await delay(pollIntervalMs, undefined, { signal: controller.signal });
        }
      } finally {
        if (controller.signal.aborted && admitting) {
          // Native abort leaves pending v1 questions behind, including child
          // requests. Settle only sessions whose ancestry this turn verified.
          const cleanup = { signal: AbortSignal.timeout(5_000) };
          try {
            await watcher?.done;
            const sessions = watcher?.sessionIds ?? new Set([sessionId]);
            await request(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }, workingDirectory, cleanup, [200, 204, 404], false);
            if (watcher) {
              // The watcher stops on local cancellation, but a child may ask while
              // the independent admission acknowledgement is still in flight.
              const pending = await watcher.pending(cleanup);
              await Promise.all([...sessions].filter((id) => id !== sessionId).map((id) => request(`/session/${encodeURIComponent(id)}/abort`, { method: "POST" }, workingDirectory, cleanup, [200, 204, 404], false)));
              await Promise.all(pending.map(({ type, id }) => request(`/${type}/${encodeURIComponent(id)}/${type === "question" ? "reject" : "reply"}`, {
                method: "POST", ...(type === "permission" ? { body: JSON.stringify({ reply: "reject" }) } : {}),
              }, workingDirectory, cleanup, [200, 204, 404], false)));
            }
          } catch (cause) {
            blocked = new Error("Pipa OpenCode cancellation failed. New intake is blocked until the native work is reconciled.", { cause });
            throw blocked;
          }
        }
      }
    },
    // Cancellation is drained by execute before the facade releases its writer.
    async abortTurn() {},
  };
}

function watchInteractions({ baseUrl, fetchImpl, headers, sessionId, workingDirectory, controller, onInteraction, onPermissionReplied, onPermissionsReconciled, onPermissionRejected, onDismiss, requestTurn }) {
  const seenIds = new Set();
  const messages = new Map();
  const parents = new Map();
  const interactionSessionIds = new Set([sessionId]);
  const settlements = new Map();
  const readiness = Promise.withResolvers();
  let subscribed = false;
  const dispatch = async (event) => {
    const type = event.type === "question.asked" ? "question" : event.type === "permission.asked" ? "permission" : null;
    const properties = event.properties && typeof event.properties === "object" ? event.properties : event.data && typeof event.data === "object" ? event.data : event;
    const interactionSessionId = properties?.sessionID ?? properties?.sessionId;
    const requestId = properties?.requestID ?? properties?.requestId ?? properties?.id;
    if (!type || (interactionSessionId !== sessionId && !await belongsToSession(interactionSessionId)) || !requestId || seenIds.has(`${type}:${requestId}`)) return;
    seenIds.add(`${type}:${requestId}`);
    const request = type === "permission" ? await hydratePermission(properties, interactionSessionId) : properties;
    const settlement = { type, sessionId: interactionSessionId, requestId, settled: Promise.withResolvers(), external: false, accepted: false };
    settlements.set(`${type}:${requestId}`, settlement);
    void settleInteraction({ type, requestId, sessionId: interactionSessionId, request, onInteraction, onPermissionRejected, onDismiss, controller, workingDirectory, requestTurn, settlement });
  };
  const belongsToSession = async (candidate, readController = controller) => {
    const original = candidate;
    const visited = new Set();
    while (candidate && !visited.has(candidate)) {
      if (candidate === sessionId) { interactionSessionIds.add(original); return true; }
      visited.add(candidate);
      if (!parents.has(candidate)) parents.set(candidate, requestTurn(`/session/${encodeURIComponent(candidate)}`, { method: "GET" }, workingDirectory, readController).then((session) => !session.directory || session.directory === workingDirectory ? session?.parentID : undefined));
      candidate = await parents.get(candidate);
    }
    return false;
  };
  const hydratePermission = async (permission, interactionSessionId) => {
    const tool = permission.tool;
    if (!tool?.messageID || !tool.callID) return permission;
    if (!messages.has(tool.messageID)) messages.set(tool.messageID, requestTurn(`/session/${encodeURIComponent(interactionSessionId)}/message?limit=100`, { method: "GET" }, workingDirectory, controller).then((items) => items.flatMap((message) => message.info?.id === tool.messageID ? message.parts ?? [] : [])).catch(() => {
      messages.delete(tool.messageID);
      controller.signal.throwIfAborted();
      return []; // Tool detail is optional; the native permission remains usable.
    }));
    const part = (await messages.get(tool.messageID)).find((item) => item.callID === tool.callID);
    return part ? { ...permission, tool: { ...tool, name: part.tool, input: part.state?.input } } : permission;
  };
  const reconcile = async () => {
    const before = [...settlements.values()];
    const [permissions, questions] = await Promise.all([
      requestTurn("/permission", { method: "GET" }, workingDirectory, controller),
      requestTurn("/question", { method: "GET" }, workingDirectory, controller),
    ]);
    const pending = (await Promise.all((permissions ?? []).map(async (permission) => await belongsToSession(permission?.sessionID) ? permission : null))).filter(Boolean);
    await Promise.all(pending.map((permission) => dispatch({ type: "permission.asked", properties: permission })));
    await Promise.all((questions ?? []).map((question) => dispatch({ type: "question.asked", properties: question })));
    for (const entry of before) {
      const requests = entry.type === "permission" ? permissions : questions;
      if (!entry.accepted && !entry.submitting && !entry.external && !requests.some((request) => request.id === entry.requestId && request.sessionID === entry.sessionId)) {
        entry.external = true;
        entry.settled.resolve();
      }
    }
    for (const interactionSessionId of interactionSessionIds) {
      const requests = pending.filter((permission) => permission.sessionID === interactionSessionId);
      onPermissionsReconciled?.({ sessionId: interactionSessionId, requestIds: new Set(requests.map((permission) => permission.id)) });
    }
  };
  const watching = (async () => {
    while (!controller.signal.aborted) {
      try {
        const url = new URL(`${baseUrl}/event`);
        url.searchParams.set("directory", workingDirectory);
        const response = await fetchImpl(url, { headers: { ...headers, accept: "text/event-stream" }, signal: controller.signal });
        if (!response.ok) throw Object.assign(new Error(`OpenCode request failed with status ${response.status}.`), { status: response.status });
        await reconcile();
        if (!subscribed) { subscribed = true; readiness.resolve(); }
        for await (const event of readServerSentEvents(response, controller.signal)) {
          if (controller.signal.aborted) return;
          const properties = event.properties && typeof event.properties === "object" ? event.properties : event.data && typeof event.data === "object" ? event.data : event;
          const interactionSessionId = properties?.sessionID ?? properties?.sessionId;
          if (["question.replied", "question.rejected", "permission.replied"].includes(event.type) && (interactionSessionId === sessionId || await belongsToSession(interactionSessionId))) {
            const type = event.type.startsWith("question") ? "question" : "permission";
            const settlement = settlements.get(`${type}:${properties?.requestID ?? properties?.requestId}`);
            if (settlement && !settlement.accepted) {
              settlement.observed = true;
              if (!settlement.submitting) { settlement.external = true; settlement.settled.resolve(); }
            }
          }
          if (event.type === "permission.replied" && (interactionSessionId === sessionId || await belongsToSession(interactionSessionId))) {
            onPermissionReplied?.({ sessionId: interactionSessionId, requestId: properties?.requestID ?? properties?.requestId, reply: properties?.reply });
            await reconcile();
            continue;
          }
          await dispatch(event);
        }
        await reconcile();
        await delay(250, undefined, { signal: controller.signal }).catch(() => undefined);
      } catch (error) {
        if (controller.signal.aborted) { if (!subscribed) readiness.reject(controller.signal.reason); return; }
        if (!subscribed) { readiness.reject(error); return; }
        await delay(250, undefined, { signal: controller.signal }).catch(() => undefined);
      }
    }
  })();
  void watching.catch(() => {
    if (!subscribed) readiness.reject(controller.signal.reason ?? new Error("OpenCode interaction watcher failed."));
    else if (!controller.signal.aborted) process.stderr.write("OpenCode interaction watcher failed.\n");
  });
  return {
    ready: readiness.promise, done: watching, sessionIds: interactionSessionIds,
    async pending(cleanup) {
      parents.clear(); // Discard ancestry lookups cancelled with the old turn.
      const pending = await Promise.all(["question", "permission"].map(async (type) => {
        const requests = await requestTurn(`/${type}`, { method: "GET" }, workingDirectory, cleanup, [200], false);
        return (await Promise.all(requests.map(async (request) => await belongsToSession(request.sessionID, cleanup) ? { type, id: request.id } : null))).filter(Boolean);
      }));
      return pending.flat();
    },
  };
}

async function settleInteraction({ type, requestId, sessionId, request: interactionRequest, onInteraction, onPermissionRejected, onDismiss, controller, workingDirectory, requestTurn, settlement }) {
  const stillPending = async () => {
    const pending = await requestTurn(`/${type}`, { method: "GET" }, workingDirectory, controller);
    if (!Array.isArray(pending)) throw new Error("OpenCode response could not be reconciled.");
    // A settlement event may be newer than the snapshot read we just awaited.
    if (settlement.observed || !pending.some((request) => request.id === requestId && request.sessionID === sessionId)) {
      settlement.external = true;
      settlement.settled.resolve();
      return false;
    }
    settlement.uncertain = false;
    return true;
  };
  const submit = async (decision) => {
    if (settlement.accepted) return;
    if (settlement.external) throw new Error("OpenCode request is already settled.");
    if (settlement.submitting) throw new Error("OpenCode response is already being submitted.");
    controller.signal.throwIfAborted();
    if (["cancelled", "stopped"].includes(decision?.type)) return;
    const reply = decision?.type === "reply" ? decision.reply : "reject";
    if (type === "permission" && (!["reply", "reject", "stop"].includes(decision?.type) || !["once", "always", "reject"].includes(reply))) throw new Error("Invalid OpenCode permission decision.");
    if (type === "question" && !["answer", "reject", "stop"].includes(decision?.type)) throw new Error("Invalid OpenCode question decision.");
    settlement.submitting = true;
    try {
      if (settlement.uncertain && !await stillPending()) return;
      if (type === "permission") {
        await requestTurn(`/permission/${encodeURIComponent(requestId)}/reply`, { method: "POST", body: JSON.stringify({ reply }) }, workingDirectory, controller, [200, 204], false);
        if (reply === "reject") onPermissionRejected?.();
      } else {
        const answer = decision.type === "answer";
        await requestTurn(`/question/${encodeURIComponent(requestId)}/${answer ? "reply" : "reject"}`, {
          method: "POST", ...(answer ? { body: JSON.stringify({ answers: decision.answers }) } : {}),
        }, workingDirectory, controller, [200, 204], false);
      }
      settlement.accepted = true;
      if (decision.type === "stop") {
        onDismiss?.();
        await requestTurn(`/session/${encodeURIComponent(sessionId)}/abort`, { method: "POST" }, workingDirectory, controller, [200, 204], false);
      }
    } catch (error) {
      if (error.status === undefined || error.status === 404 || error.status >= 500) {
        settlement.uncertain = true;
        if (!await stillPending()) return;
      }
      throw error;
    } finally {
      settlement.submitting = false;
      if (settlement.observed && !settlement.accepted) { settlement.external = true; settlement.settled.resolve(); }
    }
  };
  try {
    const decision = await abortable(Promise.resolve().then(() => onInteraction({ type, sessionId, request: interactionRequest, signal: controller.signal, submit, settled: settlement.settled.promise })), controller.signal);
    if (!settlement.accepted && !settlement.external && !["cancelled", "stopped"].includes(decision?.type)) await submit(decision);
  } catch (error) {
    if (!controller.signal.aborted) process.stderr.write(`OpenCode interaction handler error: ${error.message}\n`);
  }
}

async function* readServerSentEvents(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) return;
  const abort = () => reader.cancel().catch(() => undefined);
  signal?.addEventListener("abort", abort, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const chunk = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const lines = chunk.split("\n");
        const data = lines.filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
        const id = lines.find((line) => line.startsWith("id:"))?.slice(3).trim();
        const type = lines.find((line) => line.startsWith("event:"))?.slice(6).trim();
        if (data) {
          try { const event = JSON.parse(data); yield type ? { id, type, data: event } : event; }
          catch { /* ponytail: preserve v1's non-JSON frame handling */ }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }
  } finally { signal?.removeEventListener("abort", abort); }
}

function abortable(operation, signal) {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const settle = (callback, value) => { signal.removeEventListener("abort", abort); callback(value); };
    const abort = () => settle(reject, signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(operation).then((value) => settle(resolve, value), (error) => settle(reject, error));
  });
}
