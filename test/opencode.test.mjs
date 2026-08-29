import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdir, mkdtemp, readFile, realpath, rename, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
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
      return jsonResponse(new URL(url).pathname === "/global/health" ? { healthy: true } : {});
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
  assert.deepEqual(requests, [
    "http://127.0.0.1:54321/global/health",
    "http://127.0.0.1:54321/session/status?directory=%2Fwork",
  ]);
  server.stop("SIGTERM");
  await server.wait();
  assert.equal(killed, true);
});

test("health-checks an authenticated attached server without owning it", async () => {
  let spawned = false;
  const requests = [];
  const server = await startSocketOpenCodeServer({ workingDirectory: "/work" }, {
    environment: {
      PIPA_OPENCODE_ATTACH_URL: " http://localhost:5555/ ",
      OPENCODE_SERVER_USERNAME: "pipa",
      OPENCODE_SERVER_PASSWORD: "secret",
    },
    fetch: async (url, init) => {
      requests.push({ url: String(url), init });
      return jsonResponse(new URL(url).pathname === "/global/health" ? { healthy: true } : {});
    },
    spawn: () => { spawned = true; },
  });

  assert.equal(server.baseUrl, "http://localhost:5555");
  assert.equal(server.owned, false);
  assert.equal(spawned, false);
  assert.deepEqual(requests.map(({ url }) => url), [
    "http://localhost:5555/global/health",
    "http://localhost:5555/session/status?directory=%2Fwork",
  ]);
  assert.ok(requests.every(({ init }) => init.headers.authorization === `Basic ${Buffer.from("pipa:secret").toString("base64")}`));
  server.stop();
  await server.wait();
});

test("cleans up an owned child when workspace readiness never succeeds", async () => {
  let killed = false;
  const child = childProcess();
  child.kill = () => {
    killed = true;
    queueMicrotask(() => child.emit("close", 1));
    return true;
  };
  await assert.rejects(startSocketOpenCodeServer({ workingDirectory: "/work" }, {
    startupTimeoutMs: 5,
    fetch: async (url) => new URL(url).pathname === "/global/health"
      ? jsonResponse({ healthy: true })
      : jsonResponse({}, 503),
    spawn: () => {
      queueMicrotask(() => child.stdout.write("opencode server listening on http://127.0.0.1:54321\n"));
      return child;
    },
  }), /workspace readiness check timed out/u);
  assert.equal(killed, true);
});

test("waits for a valid workspace status response", async () => {
  let statusReads = 0;
  const child = childProcess();
  child.kill = () => {
    queueMicrotask(() => child.emit("close", 0));
    return true;
  };
  const server = await startSocketOpenCodeServer({ workingDirectory: "/work" }, {
    startupTimeoutMs: 1_000,
    fetch: async (url) => {
      if (new URL(url).pathname === "/global/health") return jsonResponse({ healthy: true });
      statusReads += 1;
      return jsonResponse(statusReads === 1 ? { healthy: true } : {});
    },
    spawn: () => {
      queueMicrotask(() => child.stdout.write("opencode server listening on http://127.0.0.1:54321\n"));
      return child;
    },
  });

  assert.equal(statusReads, 2);
  server.stop();
  await server.wait();
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

  let attachmentStarted = false;
  const staging = createOpenCodeExecutor({ baseUrl: "http://localhost:5555" });
  const stagingTurn = staging.runTurn({
    prompt: "summarize",
    workingDirectory: "/work",
    contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack" },
    attachments: [{ name: "pending.txt", fetchData: () => { attachmentStarted = true; return new Promise(() => undefined); } }],
  });
  await waitForValue(() => attachmentStarted);
  staging.stopAll();
  await assert.rejects(stagingTurn, (error) => error instanceof PipaStoppedError);
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
    fetch: async (url) => jsonResponse(new URL(url).pathname === "/global/health" ? { healthy: true } : {}),
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

test("Slack turns request concise delivery and return declared binary artifacts", async () => {
  const csv = Buffer.from("name,total\nPipa,3\n");
  const pdf = Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0xff]);
  const image = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
  let system;
  let artifactDirectory;
  const result = await artifactTurn({
    contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack", PIPA_CURRENT_SLACK_CHANNEL_ID: "C1" },
    response: async (body) => {
      system = body.system;
      artifactDirectory = artifactPath(system);
      await writeFile(path.join(artifactDirectory, "totals.csv"), csv);
      await writeFile(path.join(artifactDirectory, "brief.pdf"), pdf);
      await writeFile(path.join(artifactDirectory, "image.png"), image);
      return 'Ready for review.\nPIPA_ARTIFACTS: ["totals.csv","brief.pdf","image.png"]';
    },
  });

  assert.match(system, /For deeper work or larger deliverables/u);
  assert.match(system, /Keep naturally short answers inline/u);
  assert.match(system, /use the most suitable artifact format/u);
  assert.equal(path.dirname(artifactDirectory), await realpath(os.tmpdir()));
  assert.equal(path.basename(artifactDirectory), "ses_1");
  assert.match(system, new RegExp(artifactDirectory.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  assert.match(system, /copy up to 10 top-level files \(100 MB total\)/u);
  assert.match(system, /PIPA_ARTIFACTS: \["report\.csv","brief\.pdf"\]/u);
  assert.match(system, /PIPA_CURRENT_SLACK_CHANNEL_ID=C1/u);
  assert.equal(result.text, "Ready for review.");
  assert.deepEqual(result.files.map(({ filename, data }) => [filename, data]), [
    ["totals.csv", csv], ["brief.pdf", pdf], ["image.png", image],
  ]);
  await assert.rejects(access(artifactDirectory));
});

test("Slack artifact paths are stable per session and isolated between sessions", async () => {
  const paths = [];
  for (const sessionId of ["ses_same", "ses_same", "ses_other"]) {
    await artifactTurn({
      sessionId,
      response: async (body) => {
        const directory = artifactPath(body.system);
        paths.push(directory);
        await writeFile(path.join(directory, "report.txt"), sessionId);
        return 'Summary.\nPIPA_ARTIFACTS: ["report.txt"]';
      },
    });
  }
  assert.equal(paths[0], paths[1]);
  assert.notEqual(paths[0], paths[2]);
  assert.equal(path.basename(paths[0]), "ses_same");
  assert.equal(path.basename(paths[2]), "ses_other");
  for (const directory of paths) await assert.rejects(access(directory));
});

test("Slack artifact delivery ignores a symlinked artifact root", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "pipa-artifact-root-"));
  const target = path.join(temporaryDirectory, "target");
  const root = path.join(temporaryDirectory, "artifacts");
  await mkdir(target);
  await symlink(target, root);
  let system;
  const result = await createOpenCodeExecutor({ artifactRoot: root, baseUrl: "http://localhost:5555", fetch: artifactFetch(async (body) => {
    system = body.system;
    return "Summary.";
  }), pollIntervalMs: 1 }).runTurn({
    prompt: "do the work",
    sessionId: "ses_1",
    workingDirectory: os.tmpdir(),
    contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack" },
  });
  assert.equal(result.text, "Summary.");
  assert.doesNotMatch(system, /PIPA_ARTIFACTS:/u);
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("Slack artifact delivery ignores an artifact root redirected outside the workspace", async () => {
  const temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "pipa-artifact-parent-"));
  const workspace = path.join(temporaryDirectory, "workspace");
  const outside = path.join(temporaryDirectory, "outside");
  await Promise.all([mkdir(workspace), mkdir(outside)]);
  await symlink(outside, path.join(workspace, ".pipa"));
  let system;
  const result = await createOpenCodeExecutor({ artifactRoot: path.join(workspace, ".pipa", "artifacts"), baseUrl: "http://localhost:5555", fetch: artifactFetch(async (body) => {
    system = body.system;
    return "Summary.";
  }), pollIntervalMs: 1 }).runTurn({
    prompt: "do the work",
    sessionId: "ses_1",
    workingDirectory: workspace,
    contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack" },
  });
  assert.equal(result.text, "Summary.");
  assert.doesNotMatch(system, /PIPA_ARTIFACTS:/u);
  await rm(temporaryDirectory, { recursive: true, force: true });
});

test("short Slack answers stay inline and remote attached servers get no local artifact contract", async () => {
  let localSystem;
  const local = await artifactTurn({
    contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack" },
    response: async (body) => { localSystem = body.system; return "Short answer."; },
  });
  assert.deepEqual(local, { text: "Short answer.", sessionId: "ses_1" });
  assert.match(localSystem, /Keep naturally short answers inline/u);

  let remoteSystem;
  const remote = await artifactTurn({
    baseUrl: "https://opencode.example",
    contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack" },
    response: async (body) => { remoteSystem = body.system; return 'Summary.\nPIPA_ARTIFACTS: ["private.pdf"]'; },
  });
  assert.match(remoteSystem, /For deeper work or larger deliverables/u);
  assert.doesNotMatch(remoteSystem, /PIPA_ARTIFACTS|artifact director|pipa-artifacts-/u);
  assert.deepEqual(remote, { text: "Summary.", sessionId: "ses_1" });

  let plainSystem;
  const plain = await artifactTurn({ contextEnvironment: { PIPA_MESSAGE_CHANNEL: "web" }, response: async (body) => { plainSystem = body.system; return 'Hello.\nPIPA_ARTIFACTS: ["ordinary.txt"]'; } });
  assert.doesNotMatch(plainSystem, /executive summary|TL;DR|PIPA_ARTIFACTS/u);
  assert.equal(plain.text, 'Hello.\nPIPA_ARTIFACTS: ["ordinary.txt"]');
});

test("malformed or non-private artifact declarations are stripped and upload nothing", async () => {
  const cases = [
    'Before.\nPIPA_ARTIFACTS: ["ok.txt"]\nAfter.',
    'PIPA_ARTIFACTS: ["ok.txt"]\nPIPA_ARTIFACTS: ["ok.txt"]',
    "PIPA_ARTIFACTS: nope",
    `PIPA_ARTIFACTS: ${JSON.stringify(["x".repeat(1025)])}`,
    `PIPA_ARTIFACTS: ${JSON.stringify(Array.from({ length: 11 }, (_, index) => `${index}.txt`))}`,
    `PIPA_ARTIFACTS: ["${"x".repeat(8192)}"]`,
    'PIPA_ARTIFACTS: ["same.txt","same.txt"]',
    'PIPA_ARTIFACTS: ["../escape.txt"]',
    'PIPA_ARTIFACTS: ["nested/file.txt"]',
    'PIPA_ARTIFACTS: ["/absolute.txt"]',
  ];
  for (const declaration of cases) {
    const result = await artifactTurn({ response: async (body) => {
      const directory = artifactPath(body.system);
      await writeFile(path.join(directory, "ok.txt"), "ok");
      await writeFile(path.join(directory, "same.txt"), "same");
      return `Summary.\n${declaration}`;
    } });
    assert.doesNotMatch(result.text, /^PIPA_ARTIFACTS:/mu);
    assert.equal(result.files, undefined);
  }
});

test("artifact reads reject symlinks, directories, missing files, and clean their private directory", async () => {
  for (const setup of [
    async (directory) => symlink(path.join(directory, "target.txt"), path.join(directory, "file.txt")),
    async (directory) => mkdir(path.join(directory, "file.txt")),
    async () => undefined,
  ]) {
    let directory;
    const result = await artifactTurn({ response: async (body) => {
      directory = artifactPath(body.system);
      await writeFile(path.join(directory, "target.txt"), "secret");
      await setup(directory);
      return 'Summary.\nPIPA_ARTIFACTS: ["file.txt"]';
    } });
    assert.equal(result.files, undefined);
    await assert.rejects(access(directory));
  }
});

test("artifact reads enforce per-file and aggregate 100 MB limits", async () => {
  for (const sizes of [[MAX_ATTACHMENT_BYTES + 1], [60 * 1024 * 1024, 41 * 1024 * 1024]]) {
    const result = await artifactTurn({ response: async (body) => {
      const directory = artifactPath(body.system);
      const names = [];
      for (const [index, size] of sizes.entries()) {
        const name = `${index}.bin`;
        names.push(name);
        const filename = path.join(directory, name);
        await writeFile(filename, "");
        await truncate(filename, size);
      }
      return `Summary.\nPIPA_ARTIFACTS: ${JSON.stringify(names)}`;
    } });
    assert.equal(result.files, undefined);
  }
});

test("artifact reads reject a file replaced after opening and sanitize delivered filenames", async () => {
  let replacementAttempted = false;
  const executor = createOpenCodeExecutor({
    artifactRoot: os.tmpdir(),
    baseUrl: "http://localhost:5555",
    fetch: artifactFetch(async (body) => {
      const directory = artifactPath(body.system);
      await writeFile(path.join(directory, "replace.txt"), "original");
      await writeFile(path.join(directory, 'bad:name?.csv'), "safe");
      return 'Summary.\nPIPA_ARTIFACTS: ["replace.txt","bad:name?.csv"]';
    }),
    pollIntervalMs: 1,
    onArtifactOpened: async (filename) => {
      if (!filename.endsWith("replace.txt")) return;
      replacementAttempted = true;
      await writeFile(`${filename}.new`, "replacement");
      await rename(`${filename}.new`, filename);
    },
  });
  const rejected = await executor.runTurn({ prompt: "work", sessionId: "ses_1", workingDirectory: os.tmpdir(), contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack" } });
  assert.equal(replacementAttempted, true);
  assert.equal(rejected.files, undefined);

  const sanitized = await artifactTurn({ response: async (body) => {
    const directory = artifactPath(body.system);
    await writeFile(path.join(directory, 'bad:name?.csv'), "safe");
    return 'Summary.\nPIPA_ARTIFACTS: ["bad:name?.csv"]';
  } });
  assert.equal(sanitized.files[0].filename, "bad_name_.csv");
});

test("artifact directories are cleaned after OpenCode failure, timeout, and cancellation", async () => {
  for (const mode of ["failure", "timeout", "cancel"]) {
    let directory;
    let executor;
    const fetch = artifactFetch(async (body, init) => {
      directory = artifactPath(body.system);
      if (mode === "failure") throw new Error("prompt failed");
      return new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true }));
    });
    executor = createOpenCodeExecutor({ artifactRoot: os.tmpdir(), baseUrl: "http://localhost:5555", fetch, requestTimeoutMs: mode === "timeout" ? 5 : 30_000 });
    const turn = executor.runTurn({ prompt: "work", sessionId: "ses_1", workingDirectory: os.tmpdir(), contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack" } });
    if (mode === "cancel") {
      await waitForValue(() => directory);
      executor.stopAll();
    }
    await assert.rejects(turn);
    await assert.rejects(access(directory));
  }
});

test("artifact cleanup failure does not replace a completed turn", async () => {
  let directory;
  const executor = createOpenCodeExecutor({
    artifactRoot: os.tmpdir(),
    baseUrl: "http://localhost:5555",
    fetch: artifactFetch(async (body) => {
      directory = artifactPath(body.system);
      return "Completed.";
    }),
    pollIntervalMs: 1,
    rm: async (target, options) => {
      if (target === directory) throw new Error(`could not remove ${target}`);
      await rm(target, options);
    },
  });
  const result = await executor.runTurn({ prompt: "work", sessionId: "ses_1", workingDirectory: os.tmpdir(), contextEnvironment: { PIPA_MESSAGE_CHANNEL: "slack" } });
  assert.equal(result.text, "Completed.");
  await rm(directory, { recursive: true, force: true });
});

async function artifactTurn({ baseUrl = "http://localhost:5555", contextEnvironment = { PIPA_MESSAGE_CHANNEL: "slack" }, response, sessionId = "ses_1" }) {
  return createOpenCodeExecutor({ artifactRoot: os.tmpdir(), baseUrl, fetch: artifactFetch(response, sessionId), pollIntervalMs: 1 })
    .runTurn({ prompt: "do the work", sessionId, workingDirectory: os.tmpdir(), contextEnvironment });
}

function artifactFetch(response, sessionId = "ses_1") {
  let prompted = false;
  let assistantText;
  return async (url, init = {}) => {
    const pathname = new URL(url).pathname;
    if (pathname === "/session/status") return jsonResponse({ [sessionId]: { type: "idle" } });
    if (pathname === `/session/${sessionId}/message`) return jsonResponse(prompted && assistantText !== undefined
      ? [{ info: { id: "new", role: "assistant", time: { completed: 1 } }, parts: [{ type: "text", text: assistantText }] }]
      : []);
    if (pathname === `/session/${sessionId}/prompt_async`) {
      assistantText = await response(JSON.parse(init.body), init);
      prompted = true;
      return new Response(null, { status: 204 });
    }
    throw new Error(`Unexpected request: ${init.method ?? "GET"} ${url}`);
  };
}

function artifactPath(system) {
  const match = system.match(/private artifact directory: (.+)\n/u);
  assert.ok(match, `missing artifact directory in system instruction: ${system}`);
  return match[1];
}

async function waitForValue(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error("Timed out waiting for value.");
}

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
