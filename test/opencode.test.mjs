import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import {
  cleanChildEnvironment,
  createOpenCodeExecutor,
  MAX_ATTACHMENT_BYTES,
  PipaStoppedError,
  runOpenCodeVersion,
  startOpenCodeServer,
  startSocketOpenCodeServer,
} from "../src/opencode.mjs";

test("removes Slack credentials from child environments regardless of casing", () => {
  assert.deepEqual(cleanChildEnvironment({ PATH: "/bin", Slack_Bot_Token: "secret", Pipa_Slack_App_Token: "secret" }), { PATH: "/bin" });
});

test("starts one owned loopback server on port 0 and stops it", async () => {
  let invocation;
  let killed = false;
  const child = childProcess();
  child.kill = (signal) => {
    killed = true;
    assert.equal(signal, "SIGTERM");
    queueMicrotask(() => child.emit("close", 0));
    return true;
  };
  const requests = [];
  const started = startSocketOpenCodeServer({ workingDirectory: "/work" }, {
    environment: { PATH: "/bin", PIPA_SLACK_BOT_TOKEN: "secret" },
    fetch: async (url) => {
      requests.push(String(url));
      return jsonResponse({ healthy: true });
    },
    spawn(command, args, options) {
      invocation = { command, args, options };
      queueMicrotask(() => child.stdout.write("opencode server listening on http://127.0.0.1:54321\n"));
      return child;
    },
  });

  const server = await started;
  assert.equal(server.baseUrl, "http://127.0.0.1:54321");
  assert.equal(server.owned, true);
  assert.deepEqual(invocation.args, ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "ERROR"]);
  assert.equal(invocation.options.cwd, "/work");
  assert.equal(invocation.options.env.PIPA_SLACK_BOT_TOKEN, undefined);
  assert.equal(child.stdout.readableFlowing, true);
  assert.equal(child.stderr.readableFlowing, true);
  assert.deepEqual(requests, ["http://127.0.0.1:54321/global/health"]);
  server.stop("SIGTERM");
  await server.wait();
  assert.equal(killed, true);
});

test("health-checks an authenticated attached server without owning it", async () => {
  let spawned = false;
  let request;
  const server = await startSocketOpenCodeServer({ workingDirectory: "/work" }, {
    environment: {
      PIPA_OPENCODE_ATTACH_URL: " http://localhost:5555/ ",
      OPENCODE_SERVER_USERNAME: "pipa",
      OPENCODE_SERVER_PASSWORD: "secret",
    },
    fetch: async (url, init) => {
      request = { url: String(url), init };
      return jsonResponse({ healthy: true });
    },
    spawn: () => { spawned = true; },
  });

  assert.equal(server.baseUrl, "http://localhost:5555");
  assert.equal(server.owned, false);
  assert.equal(spawned, false);
  assert.equal(request.url, "http://localhost:5555/global/health");
  assert.equal(request.init.headers.authorization, `Basic ${Buffer.from("pipa:secret").toString("base64")}`);
  server.stop();
  await server.wait();
});

test("cleans up an owned child when startup health never succeeds", async () => {
  let killed = false;
  const child = childProcess();
  child.kill = () => {
    killed = true;
    queueMicrotask(() => child.emit("close", 1));
    return true;
  };
  await assert.rejects(startSocketOpenCodeServer({ workingDirectory: "/work" }, {
    startupTimeoutMs: 5,
    fetch: async () => jsonResponse({ healthy: false }, 503),
    spawn: () => {
      queueMicrotask(() => child.stdout.write("opencode server listening on http://127.0.0.1:54321\n"));
      return child;
    },
  }), /health check timed out/u);
  assert.equal(killed, true);
});

test("uses native sessions, prompt_async, status, messages, context, and file parts", async () => {
  let prompted = false;
  let statusReads = 0;
  let promptBody;
  let temporaryFile;
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    assert.equal(parsed.searchParams.get("directory"), "/work");
    if (parsed.pathname === "/session/ses_1/message" && init.method === "GET") {
      if (!prompted) return jsonResponse([{ info: { id: "old", role: "assistant" }, parts: [{ type: "text", text: "old" }] }]);
      return jsonResponse([
        { info: { id: "old", role: "assistant" }, parts: [{ type: "text", text: "old" }] },
        { info: { id: "new", role: "assistant", time: { completed: 2 } }, parts: [
          { type: "text", text: "first" },
          { type: "reasoning", text: "hidden" },
          { type: "text", text: "second" },
        ] },
      ]);
    }
    if (parsed.pathname === "/session/ses_1/prompt_async") {
      prompted = true;
      promptBody = JSON.parse(init.body);
      temporaryFile = new URL(promptBody.parts[1].url);
      assert.equal(await readFile(temporaryFile, "utf8"), "notes");
      return new Response(null, { status: 204 });
    }
    if (parsed.pathname === "/session/status") {
      statusReads += 1;
      return jsonResponse(statusReads === 1 ? { ses_1: { type: "busy" } } : { ses_1: { type: "idle" } });
    }
    throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
  };
  const executor = createOpenCodeExecutor({ baseUrl: "http://localhost:5555", fetch, pollIntervalMs: 1 });
  const attachment = { name: "notes.txt", mimeType: "text/plain", fetchData: async () => Buffer.from("notes") };

  const result = await executor.runTurn({
    prompt: "summarize",
    sessionId: "ses_1",
    workingDirectory: "/work",
    contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack", PIPA_CURRENT_SLACK_CHANNEL_ID: "C1" },
    attachments: [attachment],
  });

  assert.deepEqual(result, { text: "first\nsecond", sessionId: "ses_1" });
  assert.deepEqual(promptBody.parts[0], { type: "text", text: "summarize" });
  assert.deepEqual(promptBody.parts[1], { type: "file", mime: "text/plain", filename: "notes.txt", url: temporaryFile.href });
  assert.match(promptBody.system, /not as shell environment variables/u);
  assert.match(promptBody.system, /PIPA_MESSAGE_CHANNEL=slack/u);
  assert.match(promptBody.system, /PIPA_CURRENT_SLACK_CHANNEL_ID=C1/u);
  await assert.rejects(access(temporaryFile));
});

test("replaces a stale persisted session only after a successful turn", async () => {
  let prompted = false;
  const fetch = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/session/ses_stale/message") return jsonResponse({ error: "not found" }, 404);
    if (pathname === "/session" && init.method === "POST") return jsonResponse({ id: "ses_new" });
    if (pathname === "/session/ses_new/message") {
      return jsonResponse(prompted ? [{ info: { id: "new", role: "assistant", time: { completed: 1 } }, parts: [{ type: "text", text: "recovered" }] }] : []);
    }
    if (pathname === "/session/ses_new/prompt_async") {
      prompted = true;
      return new Response(null, { status: 204 });
    }
    if (pathname === "/session/status") return jsonResponse({ ses_new: { type: "idle" } });
    throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
  };

  const result = await createOpenCodeExecutor({ baseUrl: "http://localhost:5555", fetch, pollIntervalMs: 1 })
    .runTurn({ prompt: "continue", sessionId: "ses_stale", workingDirectory: "/work" });
  assert.deepEqual(result, { text: "recovered", sessionId: "ses_new" });
});

test("does not complete until both the session is idle and a new assistant message exists", async () => {
  let messageReads = 0;
  const fetch = async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/session/ses_1/prompt_async") return new Response(null, { status: 204 });
    if (pathname === "/session/status") return jsonResponse({ ses_1: { type: "idle" } });
    if (pathname === "/session/ses_1/message") {
      messageReads += 1;
      if (messageReads < 3) return jsonResponse([]);
      return jsonResponse([{ info: { id: "new", role: "assistant", time: { completed: 1 } }, parts: [{ type: "text", text: "done" }] }]);
    }
    throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
  };
  const result = await createOpenCodeExecutor({ baseUrl: "http://localhost:5555", fetch, pollIntervalMs: 1 })
    .runTurn({ prompt: "hello", sessionId: "ses_1", workingDirectory: "/work" });
  assert.equal(result.text, "done");
  assert.ok(messageReads >= 3);
});

test("rejects prompt failures and aborts active requests during shutdown", async () => {
  const failed = createOpenCodeExecutor({
    baseUrl: "http://localhost:5555",
    fetch: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/session/status") return jsonResponse({ ses_1: { type: "idle" } });
      if (pathname === "/session/ses_1/message") return jsonResponse([]);
      if (pathname.endsWith("/prompt_async")) return jsonResponse({ error: "provider failed" }, 500);
      throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
    },
  });
  await assert.rejects(failed.runTurn({ prompt: "hello", sessionId: "ses_1", workingDirectory: "/work" }), /OpenCode request failed/u);

  const hanging = createOpenCodeExecutor({
    baseUrl: "http://localhost:5555",
    fetch: async (_, init = {}) => new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true })),
  });
  const turn = hanging.runTurn({ prompt: "hello", sessionId: "ses_1", workingDirectory: "/work" });
  await new Promise((resolve) => setImmediate(resolve));
  hanging.stopAll();
  await assert.rejects(turn, (error) => error instanceof PipaStoppedError);

  const failure = new Error("server exited");
  const stopped = createOpenCodeExecutor({ baseUrl: "http://localhost:5555" });
  stopped.stopAll(failure);
  await assert.rejects(stopped.runTurn({ prompt: "hello" }), (error) => error === failure);
});

test("marks the selected server fatal when a request loses its connection", async () => {
  let fatal;
  const executor = createOpenCodeExecutor({
    baseUrl: "http://localhost:5555",
    onFatal: (error) => fatal = error,
    fetch: async (url) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/session/status") throw new TypeError("fetch failed");
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  await assert.rejects(executor.runTurn({ prompt: "hello", sessionId: "ses_1", workingDirectory: "/work" }), /fetch failed/u);
  assert.match(fatal.message, /became unavailable/u);
});

test("preserves attachment validation and cleanup", async () => {
  let requested = false;
  const executor = createOpenCodeExecutor({ baseUrl: "http://localhost:5555", fetch: async () => { requested = true; } });
  await assert.rejects(executor.runTurn({
    prompt: "summarize",
    workingDirectory: "/work",
    attachments: [{ name: "large.bin", fetchData: async () => ({ byteLength: MAX_ATTACHMENT_BYTES + 1 }) }],
  }), /100 MB or smaller/u);
  assert.equal(requested, false);
});

test("sanitizes distinct attachment files and removes them after prompt failure", async () => {
  const files = [];
  const executor = createOpenCodeExecutor({
    baseUrl: "http://localhost:5555",
    fetch: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/session/status") return jsonResponse({ ses_1: { type: "idle" } });
      if (pathname === "/session/ses_1/message") return jsonResponse([]);
      if (pathname.endsWith("/prompt_async")) {
        files.push(...JSON.parse(init.body).parts.slice(1).map((part) => new URL(part.url)));
        assert.deepEqual(await Promise.all(files.map((file) => readFile(file, "utf8"))), ["one", "two"]);
        return jsonResponse({ error: "failed" }, 500);
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  const attachment = (text) => ({ name: `same<>:"\\|?*${"😀".repeat(100)}. `, mimeType: "text/plain", fetchData: async () => Buffer.from(text) });
  await assert.rejects(executor.runTurn({
    prompt: "compare",
    sessionId: "ses_1",
    workingDirectory: "/work",
    attachments: [attachment("one"), attachment("two")],
  }), /OpenCode request failed/u);
  assert.equal(new Set(files.map(({ pathname }) => pathname)).size, 2);
  for (const file of files) {
    assert.doesNotMatch(path.basename(file.pathname), /[<>:"/\\|?*\u0000-\u001f]|[. ]$/u);
    await assert.rejects(access(file));
  }
});

test("sends data attachment URLs to a remotely managed server", async () => {
  let filePart;
  const executor = createOpenCodeExecutor({
    baseUrl: "https://opencode.example",
    fetch: async (url, init = {}) => {
      const pathname = new URL(url).pathname;
      if (pathname === "/session/status") return jsonResponse({ ses_1: { type: "idle" } });
      if (pathname === "/session/ses_1/message") return jsonResponse([]);
      if (pathname.endsWith("/prompt_async")) {
        filePart = JSON.parse(init.body).parts[1];
        return jsonResponse({ error: "failed" }, 500);
      }
      throw new Error(`Unexpected request: ${url}`);
    },
  });
  await assert.rejects(executor.runTurn({
    prompt: "read",
    sessionId: "ses_1",
    workingDirectory: "/work",
    attachments: [{ name: "notes.txt", mimeType: "text/plain", fetchData: async () => Buffer.from("notes") }],
  }), /OpenCode request failed/u);
  assert.equal(filePart.url, "data:text/plain;base64,bm90ZXM=");
});

test("Managed server inherits its clean environment and forwards termination signals", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    let invocation;
    let killCount = 0;
    const child = childProcess();
    child.kill = (received) => {
      killCount += 1;
      assert.equal(received, signal);
      queueMicrotask(() => child.emit("close", 1));
      return true;
    };
    const server = startOpenCodeServer({ workingDirectory: "/work", openCodeHostname: "127.0.0.1", openCodePort: 4096 }, {
      environment: { OPENCODE_DB: "/work/opencode.db", PIPA_SLACK_BOT_TOKEN: "secret", OPENAI_API_KEY: "provider-secret" },
      platform: "linux",
      spawn(command, args, options) {
        invocation = { command, args, options };
        return child;
      },
    });
    assert.deepEqual(invocation.args, ["serve", "--hostname", "127.0.0.1", "--port", "4096", "--log-level", "ERROR"]);
    assert.equal(invocation.options.env.PIPA_SLACK_BOT_TOKEN, undefined);
    assert.equal(invocation.options.env.OPENAI_API_KEY, "provider-secret");
    server.stop(signal);
    server.stop(signal);
    await server.wait();
    assert.equal(killCount, 1);
  }
});

test("Managed server propagates spawn errors and unexpected exits", async () => {
  const spawnFailure = childProcess();
  const failedServer = startOpenCodeServer({ workingDirectory: "/work", openCodeHostname: "localhost", openCodePort: 4096 }, { spawn: () => spawnFailure });
  queueMicrotask(() => spawnFailure.emit("error", new Error("OpenCode unavailable")));
  await assert.rejects(failedServer.wait(), /OpenCode unavailable/u);

  const exited = childProcess();
  const exitedServer = startOpenCodeServer({ workingDirectory: "/work", openCodeHostname: "localhost", openCodePort: 4096 }, { spawn: () => exited });
  queueMicrotask(() => exited.emit("close", 23));
  await assert.rejects(exitedServer.wait(), /exited unexpectedly with code 23/u);
});

test("Windows server shutdown falls back when taskkill is unavailable", async () => {
  const child = childProcess();
  child.pid = 999999;
  child.kill = (signal) => {
    assert.equal(signal, "SIGKILL");
    queueMicrotask(() => child.emit("close", 1));
    return true;
  };
  const server = await startSocketOpenCodeServer({ workingDirectory: "/work" }, {
    platform: "win32",
    fetch: async () => jsonResponse({ healthy: true }),
    spawn: () => {
      queueMicrotask(() => child.stdout.write("opencode server listening on http://127.0.0.1:54321\n"));
      return child;
    },
  });
  server.stop();
  await server.wait();
});

test("version check times out and terminates a hung child", async () => {
  let killed = false;
  const child = childProcess();
  child.kill = () => {
    killed = true;
    child.stdout.end();
    child.stderr.end();
    queueMicrotask(() => child.emit("close", 1));
    return true;
  };
  await assert.rejects(runOpenCodeVersion({ spawn: () => child, timeoutMs: 5 }), /timed out/u);
  assert.equal(killed, true);
});

test("subscribes to interaction events before prompt_async", async () => {
  const requests = [];
  let settledBody;
  let prompted = false;
  const sseChunks = [
    "id: evt_1\nevent: question.asked\ndata: {\"sessionID\":\"ses_1\",\"id\":\"req_1\",\"questions\":[{\"header\":\"Color\",\"question\":\"Pick one\",\"options\":[{\"label\":\"Red\"},{\"label\":\"Blue\"}]}]}\n\n",
    "id: evt_1\nevent: question.asked\ndata: {\"sessionID\":\"ses_1\",\"id\":\"req_1\",\"questions\":[{\"header\":\"Color\",\"question\":\"Pick one\",\"options\":[{\"label\":\"Red\"},{\"label\":\"Blue\"}]}]}\n\n",
  ];
  const sseBody = () => new ReadableStream({
    start(controller) {
      for (const chunk of sseChunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    requests.push(parsed.pathname);
    if (parsed.pathname === "/event" && init?.headers?.accept === "text/event-stream") {
      return new Response(sseBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (parsed.pathname === "/question" || parsed.pathname === "/permission") return jsonResponse([]);
    if (parsed.pathname === "/session/status") return jsonResponse({ ses_1: { type: "idle" } });
    if (parsed.pathname === "/session/ses_1/message") {
      return jsonResponse(prompted ? [{ info: { id: "new", role: "assistant", time: { completed: 1 } }, parts: [{ type: "text", text: "done" }] }] : []);
    }
    if (parsed.pathname === "/session/ses_1/prompt_async") {
      prompted = true;
      return new Response(null, { status: 204 });
    }
    if (parsed.pathname.startsWith("/question/") && parsed.pathname.endsWith("/reply")) {
      settledBody = JSON.parse(init.body);
      return jsonResponse({});
    }
    if (parsed.pathname.startsWith("/question/") && parsed.pathname.endsWith("/reject")) return jsonResponse({});
    throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
  };
  const seen = [];
  const executor = createOpenCodeExecutor({ baseUrl: "http://localhost:5555", fetch, pollIntervalMs: 1 });
  const result = await executor.runTurn({
    prompt: "hello",
    sessionId: "ses_1",
    workingDirectory: "/work",
    onInteraction: (interaction) => {
      seen.push(interaction);
      return { type: "answer", answers: [["Red"]] };
    },
  });
  assert.equal(result.text, "done");
  assert.ok(prompted);
  assert.ok(requests.includes("/event"));
  const eventIndex = requests.indexOf("/event");
  const promptIndex = requests.indexOf("/session/ses_1/prompt_async");
  assert.ok(eventIndex < promptIndex, "SSE subscription must be established before prompt_async");
  assert.equal(seen.length, 1, "duplicate question.asked events with same id should be deduplicated");
  assert.equal(seen[0].type, "question");
  assert.equal(seen[0].request.id, "req_1");
  assert.deepEqual(settledBody, { answers: [["Red"]] });
});

test("routes a subagent permission through its parent session", async () => {
  let prompted = false;
  const event = `data: ${JSON.stringify({ type: "permission.asked", properties: { sessionID: "ses_child", id: "perm_1", permission: "external_directory", patterns: ["/outside"] } })}\n\n`;
  const fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/event") return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(event)); controller.close(); } }), { status: 200 });
    if (pathname === "/permission") return jsonResponse([]);
    if (pathname === "/session/ses_child") return jsonResponse({ id: "ses_child", parentID: "ses_1" });
    if (pathname === "/session/status") return jsonResponse({ ses_1: { type: "idle" } });
    if (pathname === "/session/ses_1/message") return jsonResponse(prompted ? [{ info: { id: "new", role: "assistant", time: { completed: 1 } }, parts: [{ type: "text", text: "done" }] }] : []);
    if (pathname.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
    if (pathname.startsWith("/permission/") && pathname.endsWith("/reply")) return jsonResponse({});
    throw new Error(`Unexpected request: ${url}`);
  };
  const seen = [];
  const executor = createOpenCodeExecutor({ baseUrl: "http://localhost:5555", fetch, pollIntervalMs: 1 });
  await executor.runTurn({
    prompt: "go",
    sessionId: "ses_1",
    workingDirectory: "/work",
    onInteraction: (interaction) => { seen.push(interaction); return { type: "reply", reply: "once" }; },
  });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].sessionId, "ses_child");
});

test("forwards permission replies from the OpenCode event stream", async () => {
  let prompted = false;
  const events = [
    `data: ${JSON.stringify({ type: "permission.asked", properties: { sessionID: "ses_1", id: "perm_1", permission: "shell", patterns: ["ls"] } })}\n\n`,
    `data: ${JSON.stringify({ type: "permission.replied", properties: { sessionID: "ses_1", requestID: "perm_1", reply: "always" } })}\n\n`,
  ];
  const fetch = async (url) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/event") return new Response(new ReadableStream({ start(controller) { events.forEach((event) => controller.enqueue(new TextEncoder().encode(event))); controller.close(); } }), { status: 200 });
    if (pathname === "/permission") return jsonResponse([]);
    if (pathname === "/session/status") return jsonResponse({ ses_1: { type: "idle" } });
    if (pathname === "/session/ses_1/message") return jsonResponse(prompted ? [{ info: { id: "new", role: "assistant", time: { completed: 1 } }, parts: [{ type: "text", text: "done" }] }] : []);
    if (pathname.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
    if (pathname.startsWith("/permission/") && pathname.endsWith("/reply")) return jsonResponse({});
    throw new Error(`Unexpected request: ${url}`);
  };
  const replies = [];
  const executor = createOpenCodeExecutor({ baseUrl: "http://localhost:5555", fetch, pollIntervalMs: 1 });
  await executor.runTurn({ prompt: "go", sessionId: "ses_1", workingDirectory: "/work", onInteraction: () => ({ type: "reply", reply: "always" }), onPermissionReplied: (reply) => replies.push(reply) });
  assert.deepEqual(replies, [{ sessionId: "ses_1", requestId: "perm_1", reply: "always" }]);
});

test("settles matching-session permission with exact reply payload", async () => {
  let settledPath;
  let settledBody;
  let prompted = false;
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/event" && init?.headers?.accept === "text/event-stream") {
      return sseResponse("permission.asked", { sessionId: "ses_1", requestId: "perm_1" });
    }
    if (parsed.pathname === "/question" || parsed.pathname === "/permission") return jsonResponse([]);
    if (parsed.pathname === "/session/status") return jsonResponse({ ses_1: { type: "idle" } });
    if (parsed.pathname === "/session/ses_1/message") {
      return jsonResponse(prompted ? [{ info: { id: "new", role: "assistant", time: { completed: 1 } }, parts: [{ type: "text", text: "done" }] }] : []);
    }
    if (parsed.pathname.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
    if (parsed.pathname.startsWith("/permission/") && parsed.pathname.endsWith("/reply")) {
      settledPath = parsed.pathname;
      settledBody = JSON.parse(init.body);
      return jsonResponse({});
    }
    throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
  };
  const executor = createOpenCodeExecutor({ baseUrl: "http://localhost:5555", fetch, pollIntervalMs: 1 });
  await executor.runTurn({
    prompt: "go",
    sessionId: "ses_1",
    workingDirectory: "/work",
    onInteraction: () => ({ type: "reply", reply: "always" }),
  });
  assert.ok(settledPath.includes("/permission/"));
  assert.ok(settledPath.endsWith("/reply"));
  assert.deepEqual(settledBody, { reply: "always" });
});

test("reports a rejected permission when OpenCode completes without text", async () => {
  let prompted = false;
  let rejected = false;
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/event" && init?.headers?.accept === "text/event-stream") {
      return sseResponse("permission.asked", { sessionID: "ses_1", id: "perm_1" });
    }
    if (parsed.pathname === "/question" || parsed.pathname === "/permission") return jsonResponse([]);
    if (parsed.pathname === "/session/status") return jsonResponse({ ses_1: { type: !prompted || rejected ? "idle" : "busy" } });
    if (parsed.pathname === "/session/ses_1/message") {
      return jsonResponse(prompted ? [{ info: { id: "new", role: "assistant", time: { completed: 1 } }, parts: [] }] : []);
    }
    if (parsed.pathname.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
    if (parsed.pathname.startsWith("/permission/") && parsed.pathname.endsWith("/reply")) {
      rejected = JSON.parse(init.body).reply === "reject";
      return jsonResponse({});
    }
    throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
  };
  const executor = createOpenCodeExecutor({ baseUrl: "http://localhost:5555", fetch, pollIntervalMs: 1 });
  const result = await executor.runTurn({
    prompt: "go",
    sessionId: "ses_1",
    workingDirectory: "/work",
    onInteraction: () => ({ type: "reject" }),
  });
  assert.deepEqual(result, { text: "Stopped after a permission was rejected.", sessionId: "ses_1" });
});

test("stop rejects active request and aborts session", async () => {
  const settled = [];
  let prompted = false;
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/event" && init?.headers?.accept === "text/event-stream") {
      return sseResponse("question.asked", { sessionID: "ses_1", id: "req_1" });
    }
    if (parsed.pathname === "/question" || parsed.pathname === "/permission") return jsonResponse([]);
    if (parsed.pathname === "/session/status") return jsonResponse({ ses_1: { type: "idle" } });
    if (parsed.pathname === "/session/ses_1/message") {
      return jsonResponse(prompted ? [{ info: { id: "new", role: "assistant", time: { completed: 1 } }, parts: [{ type: "text", text: "done" }] }] : []);
    }
    if (parsed.pathname.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
    if (parsed.pathname.endsWith("/reject") || parsed.pathname.endsWith("/reply")) {
      settled.push(parsed.pathname);
      return jsonResponse({});
    }
    if (parsed.pathname.endsWith("/abort")) {
      settled.push(parsed.pathname);
      return jsonResponse({});
    }
    throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
  };
  const executor = createOpenCodeExecutor({ baseUrl: "http://localhost:5555", fetch, pollIntervalMs: 1 });
  await executor.runTurn({
    prompt: "go",
    sessionId: "ses_1",
    workingDirectory: "/work",
    onInteraction: () => ({ type: "stop" }),
  });
  assert.ok(settled.some((p) => p.includes("/question/") && p.endsWith("/reject")));
  assert.ok(settled.some((p) => p.includes("/session/") && p.endsWith("/abort")));
});

test("event reading stops when turn completes", async () => {
  let sseClosed = false;
  let prompted = false;
  let interval;
  const sseBody = () => new ReadableStream({
    start(controller) {
      interval = setInterval(() => {
        controller.enqueue(new TextEncoder().encode("data: {\"type\":\"heartbeat\"}\n\n"));
      }, 1);
    },
    cancel() {
      sseClosed = true;
      clearInterval(interval);
    },
  });
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/event" && init?.headers?.accept === "text/event-stream") {
      return new Response(sseBody(), { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    if (parsed.pathname === "/question" || parsed.pathname === "/permission") return jsonResponse([]);
    if (parsed.pathname === "/session/status") return jsonResponse({ ses_1: { type: "idle" } });
    if (parsed.pathname === "/session/ses_1/message") {
      return jsonResponse(prompted ? [{ info: { id: "new", role: "assistant", time: { completed: 1 } }, parts: [{ type: "text", text: "done" }] }] : []);
    }
    if (parsed.pathname.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
    throw new Error(`Unexpected request: ${url}`);
  };
  const executor = createOpenCodeExecutor({ baseUrl: "http://localhost:5555", fetch, pollIntervalMs: 1 });
  const result = await executor.runTurn({ prompt: "go", sessionId: "ses_1", workingDirectory: "/work", onInteraction: () => undefined });
  assert.equal(result.text, "done");
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(sseClosed, "SSE stream should be closed after turn completes");
});

test("does not report fatal for non-fatal interaction settlement errors", async () => {
  let fatal;
  let prompted = false;
  const fetch = async (url, init = {}) => {
    const parsed = new URL(url);
    if (parsed.pathname === "/event" && init?.headers?.accept === "text/event-stream") {
      return sseResponse("question.asked", { sessionID: "ses_1", id: "req_1" });
    }
    if (parsed.pathname === "/question" || parsed.pathname === "/permission") return jsonResponse([]);
    if (parsed.pathname === "/session/status") return jsonResponse({ ses_1: { type: "idle" } });
    if (parsed.pathname === "/session/ses_1/message") {
      return jsonResponse(prompted ? [{ info: { id: "new", role: "assistant", time: { completed: 1 } }, parts: [{ type: "text", text: "done" }] }] : []);
    }
    if (parsed.pathname.endsWith("/prompt_async")) { prompted = true; return new Response(null, { status: 204 }); }
    if (parsed.pathname.startsWith("/question/") && parsed.pathname.endsWith("/reply")) {
      throw new TypeError("fetch failed");
    }
    throw new Error(`Unexpected request: ${url}`);
  };
  const executor = createOpenCodeExecutor({
    baseUrl: "http://localhost:5555",
    fetch,
    pollIntervalMs: 1,
    onFatal: (error) => fatal = error,
  });
  await executor.runTurn({
    prompt: "go",
    sessionId: "ses_1",
    workingDirectory: "/work",
    onInteraction: () => ({ type: "answer", answers: [["Yes"]] }),
  });
  assert.equal(fatal, undefined, "settlement errors should not trigger onFatal");
});

function childProcess() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  return child;
}

function jsonResponse(value, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
}

function sseResponse(type, properties) {
  return new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ type, properties })}\n\n`));
      controller.close();
    },
  }), { status: 200, headers: { "content-type": "text/event-stream" } });
}
