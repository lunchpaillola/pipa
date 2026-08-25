import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { buildRunArguments, cleanChildEnvironment, createOpenCodeExecutor, MAX_ATTACHMENT_BYTES, parseOpenCodeOutput, runOpenCodeVersion, startOpenCodeServer } from "../src/opencode.mjs";

test("builds shell-free continuation arguments with a literal prompt", () => {
  const prompt = "summarize $(touch nope) && echo bad";
  assert.deepEqual(buildRunArguments({ prompt, sessionId: "ses_1", workingDirectory: "/work" }), [
    "run", "--format", "json", "--dir", "/work", "--session", "ses_1", "--", prompt,
  ]);
});

test("builds repeated file arguments before the literal prompt", () => {
  assert.deepEqual(buildRunArguments({
    prompt: "compare",
    sessionId: "ses_1",
    workingDirectory: "/work",
    attachUrl: "http://localhost:5555",
    files: ["/tmp/1-a.txt", "/tmp/2-b.txt"],
  }), [
    "run", "--format", "json", "--dir", "/work", "--attach", "http://localhost:5555",
    "--session", "ses_1", "--file", "/tmp/1-a.txt", "--file", "/tmp/2-b.txt", "--", "compare",
  ]);
});

test("removes Slack credentials from the child environment regardless of casing", () => {
  assert.deepEqual(cleanChildEnvironment({ PATH: "/bin", Slack_Bot_Token: "secret", Pipa_Slack_App_Token: "secret" }), { PATH: "/bin" });
});

test("parses assistant text and session ID without exposing tool events", () => {
  const output = parseOpenCodeOutput([
    JSON.stringify({ type: "text", text: "intermediate commentary", sessionID: "ses_1" }),
    JSON.stringify({ type: "tool", text: "hidden", sessionID: "ses_1" }),
    JSON.stringify({ type: "text", part: { type: "text", text: "Useful answer" }, sessionID: "ses_1" }),
  ].join("\n"));
  assert.deepEqual(output, { text: "Useful answer", sessionId: "ses_1", error: "" });
});

test("executor passes a clean environment and returns attributable output", async () => {
  let invocation;
  const spawn = (command, args, options) => {
    invocation = { command, args, options };
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end(`${JSON.stringify({ type: "text", text: "done", sessionID: "ses_new" })}\n`);
      child.stderr.end();
      child.emit("close", 0);
    });
    return child;
  };
  const executor = createOpenCodeExecutor({ spawn, platform: "linux", environment: { PATH: "/bin", SLACK_BOT_TOKEN: "secret", PIPA_OPENCODE_ATTACH_URL: " http://localhost:5555 " } });
  const result = await executor.runTurn({ prompt: "hello", sessionId: null, workingDirectory: "/work" });
  assert.deepEqual(result, { text: "done", sessionId: "ses_new" });
  assert.deepEqual(invocation.args, ["run", "--format", "json", "--dir", "/work", "--attach", "http://localhost:5555", "--", "hello"]);
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.SLACK_BOT_TOKEN, undefined);
});

test("Managed server inherits its environment and forwards termination signals", async () => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    let invocation;
    const child = new EventEmitter();
    child.kill = (received) => {
      assert.equal(received, signal);
      queueMicrotask(() => child.emit("close", 1));
      return true;
    };
    const environment = {
      OPENCODE_DB: "/work/opencode.db",
      OPENCODE_CONFIG_CONTENT: "config",
      PIPA_API_BASE_URL: "https://gateway.example",
      PIPA_EXECUTION_SECRET: "gateway-secret",
      PIPA_SLACK_BOT_TOKEN: "stale-slack-secret",
      COMPOSIO_API_KEY: "composio-secret",
      OPENAI_API_KEY: "provider-secret",
    };
    const server = startOpenCodeServer({ workingDirectory: "/work", openCodeHostname: "127.0.0.1", openCodePort: 4096 }, {
      environment,
      platform: "linux",
      spawn(command, args, options) {
        invocation = { command, args, options };
        return child;
      },
    });
    assert.equal(invocation.command, "opencode");
    assert.deepEqual(invocation.args, ["serve", "--hostname", "127.0.0.1", "--port", "4096", "--log-level", "ERROR"]);
    assert.equal(invocation.options.cwd, "/work");
    assert.equal(invocation.options.env.PIPA_SLACK_BOT_TOKEN, undefined);
    assert.equal(invocation.options.env.PIPA_EXECUTION_SECRET, "gateway-secret");
    assert.equal(invocation.options.env.COMPOSIO_API_KEY, "composio-secret");
    assert.equal(invocation.options.env.OPENAI_API_KEY, "provider-secret");
    assert.equal(invocation.options.shell, false);
    assert.equal(invocation.options.stdio, "inherit");
    server.stop(signal);
    await server.wait();
  }
});

test("Managed server propagates spawn errors and unexpected exits", async () => {
  const spawnFailure = new EventEmitter();
  spawnFailure.kill = () => true;
  const failedServer = startOpenCodeServer({ workingDirectory: "/work", openCodeHostname: "localhost", openCodePort: 4096 }, { spawn: () => spawnFailure });
  queueMicrotask(() => spawnFailure.emit("error", new Error("OpenCode unavailable")));
  await assert.rejects(failedServer.wait(), /OpenCode unavailable/u);

  const exited = new EventEmitter();
  exited.kill = () => true;
  const exitedServer = startOpenCodeServer({ workingDirectory: "/work", openCodeHostname: "localhost", openCodePort: 4096 }, { spawn: () => exited });
  queueMicrotask(() => exited.emit("close", 23));
  await assert.rejects(exitedServer.wait(), /exited unexpectedly with code 23/u);

  const cleanExit = new EventEmitter();
  cleanExit.kill = () => true;
  const cleanExitServer = startOpenCodeServer({ workingDirectory: "/work", openCodeHostname: "localhost", openCodePort: 4096 }, { spawn: () => cleanExit });
  queueMicrotask(() => cleanExit.emit("close", 0));
  await assert.rejects(cleanExitServer.wait(), /exited unexpectedly with code 0/u);
});

test("executor downloads attachments to distinct temporary files and removes them", async () => {
  let temporaryDirectory;
  const contents = [];
  const spawn = (_, args) => {
    const files = args.flatMap((value, index) => value === "--file" ? [args[index + 1]] : []);
    temporaryDirectory = path.dirname(files[0]);
    contents.push(...files.map((file) => readFileSync(file, "utf8")));
    assert.equal(new Set(files).size, 2);
    for (const file of files) {
      assert.doesNotMatch(path.basename(file), /[<>:"/\\|?*\u0000-\u001f]|[. ]$/u);
      assert.ok(Buffer.byteLength(path.basename(file)) <= 202);
    }
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end(`${JSON.stringify({ type: "text", text: "done" })}\n`);
      child.stderr.end();
      child.emit("close", 0);
    });
    return child;
  };
  const attachment = (text) => ({ name: `same<>:"\\|?*${"😀".repeat(100)}. `, fetchData: async () => Buffer.from(text) });
  const executor = createOpenCodeExecutor({ spawn });

  await executor.runTurn({ prompt: "compare", workingDirectory: "/work", attachments: [attachment("one"), attachment("two")] });

  assert.deepEqual(contents, ["one", "two"]);
  await assert.rejects(access(temporaryDirectory));
});

test("executor does not spawn OpenCode when an attachment cannot be downloaded", async () => {
  let spawned = false;
  const executor = createOpenCodeExecutor({ spawn: () => { spawned = true; } });
  await assert.rejects(executor.runTurn({
    prompt: "summarize",
    workingDirectory: "/work",
    attachments: [{ name: "broken.txt", fetchData: async () => { throw new Error("download failed"); } }],
  }), /Could not read one of the attached files/u);
  assert.equal(spawned, false);
});

test("executor rejects downloaded data over 100 MB before writing or spawning", async () => {
  let spawned = false;
  const executor = createOpenCodeExecutor({ spawn: () => { spawned = true; } });
  await assert.rejects(executor.runTurn({
    prompt: "summarize",
    workingDirectory: "/work",
    attachments: [{ name: "large.bin", fetchData: async () => ({ byteLength: MAX_ATTACHMENT_BYTES + 1 }) }],
  }), /100 MB or smaller/u);
  assert.equal(spawned, false);
});

test("executor kills the child when output collection fails", async () => {
  let killed = false;
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
      queueMicrotask(() => child.emit("close", 1));
      return true;
    };
    queueMicrotask(() => child.stdout.destroy(new Error("stream failed")));
    return child;
  };
  const executor = createOpenCodeExecutor({ spawn });
  await assert.rejects(executor.runTurn({ prompt: "hello", workingDirectory: "/work" }), /stream failed/u);
  assert.equal(killed, true);
});

test("executor reports OpenCode error events even with a zero exit code", async () => {
  let temporaryDirectory;
  const spawn = (_, args) => {
    temporaryDirectory = path.dirname(args[args.indexOf("--file") + 1]);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => true;
    queueMicrotask(() => {
      child.stdout.end(`${JSON.stringify({ type: "error", error: { message: "provider failed" } })}\n`);
      child.stderr.end();
      child.emit("close", 0);
    });
    return child;
  };
  await assert.rejects(createOpenCodeExecutor({ spawn }).runTurn({
    prompt: "hello",
    workingDirectory: "/work",
    attachments: [{ name: "notes.txt", fetchData: async () => Buffer.from("notes") }],
  }), /provider failed/u);
  await assert.rejects(access(temporaryDirectory));
});

test("stopAll prevents OpenCode from spawning after attachment staging", async () => {
  let spawned = false;
  let finishDownload;
  let markDownloadStarted;
  const downloadStarted = new Promise((resolve) => markDownloadStarted = resolve);
  const executor = createOpenCodeExecutor({ spawn: () => { spawned = true; }, timeoutMs: 60_000 });
  const turn = executor.runTurn({
    prompt: "summarize",
    workingDirectory: "/work",
    attachments: [{
      name: "stalled.txt",
      fetchData: () => new Promise((resolve) => {
        finishDownload = resolve;
        markDownloadStarted();
      }),
    }],
  });
  await downloadStarted;
  executor.stopAll();
  finishDownload(Buffer.from("notes"));
  await assert.rejects(turn, /shutting down/u);
  assert.equal(spawned, false);
});

test("executor times out stalled attachment downloads without spawning OpenCode", async () => {
  let spawned = false;
  const executor = createOpenCodeExecutor({ spawn: () => { spawned = true; }, timeoutMs: 5 });
  await assert.rejects(executor.runTurn({
    prompt: "summarize",
    workingDirectory: "/work",
    attachments: [{ name: "stalled.txt", fetchData: async () => new Promise(() => undefined) }],
  }), /Could not read one of the attached files/u);
  assert.equal(spawned, false);
});

test("executor times out and terminates a hung child", async () => {
  let killed = false;
  let temporaryDirectory;
  const spawn = (_, args) => {
    temporaryDirectory = path.dirname(args[args.indexOf("--file") + 1]);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
      queueMicrotask(() => child.emit("close", 1));
      return true;
    };
    return child;
  };
  await assert.rejects(createOpenCodeExecutor({ spawn, timeoutMs: 5 }).runTurn({
    prompt: "hello",
    workingDirectory: "/work",
    attachments: [{ name: "notes.txt", fetchData: async () => Buffer.from("notes") }],
  }), /timed out/u);
  assert.equal(killed, true);
  await assert.rejects(access(temporaryDirectory));
});

test("stopAll terminates an active OpenCode child", async () => {
  let killed = false;
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
      child.stdout.end();
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 1));
      return true;
    };
    return child;
  };
  const executor = createOpenCodeExecutor({ spawn, timeoutMs: 60_000 });
  const turn = executor.runTurn({ prompt: "hello", workingDirectory: "/work" });
  executor.stopAll();
  await assert.rejects(turn);
  assert.equal(killed, true);
});

test("version check times out and terminates a hung child", async () => {
  let killed = false;
  const spawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {
      killed = true;
      child.stdout.end();
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 1));
      return true;
    };
    return child;
  };
  await assert.rejects(runOpenCodeVersion({ spawn, timeoutMs: 5 }), /timed out/u);
  assert.equal(killed, true);
});

test("Windows executes an opencode.cmd shim without interpreting prompt metacharacters", { skip: process.platform !== "win32" }, async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pipa-opencode-"));
  const argsFile = path.join(directory, "args.json");
  const marker = path.join(directory, "injected.txt");
  await writeFile(path.join(directory, "fake.cjs"), `
const fs = require("node:fs");
if (process.argv[2] === "--version") console.log("1.0.0");
else {
  fs.writeFileSync(process.env.ARG_FILE, JSON.stringify(process.argv.slice(2)));
  if (process.argv.at(-1) === "hang") {
    fs.writeFileSync(process.env.PID_FILE, String(process.pid));
    setInterval(() => {}, 1000);
  } else {
    console.log(JSON.stringify({ type: "text", text: "ok", sessionID: "ses_windows" }));
  }
}
`);
  await writeFile(path.join(directory, "opencode.cmd"), `@ECHO off\r\n"${process.execPath}" "%~dp0fake.cjs" %*\r\n`);
  const environment = { ...process.env, ARG_FILE: argsFile, PATH: `${directory};${process.env.PATH}` };
  assert.equal(await runOpenCodeVersion({ environment }), "1.0.0");
  const prompt = `literal & echo injected > "${marker}"`;
  const result = await createOpenCodeExecutor({ environment }).runTurn({ prompt, workingDirectory: directory });
  assert.equal(result.text, "ok");
  assert.equal(JSON.parse(await readFile(argsFile, "utf8")).at(-1), prompt);
  await assert.rejects(access(marker));

  const pidFile = path.join(directory, "pid.txt");
  environment.PID_FILE = pidFile;
  const executor = createOpenCodeExecutor({ environment, timeoutMs: 60_000 });
  const hanging = executor.runTurn({ prompt: "hang", workingDirectory: directory });
  for (let attempts = 0; attempts < 50; attempts += 1) {
    if (await access(pidFile).then(() => true, () => false)) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const pid = Number(await readFile(pidFile, "utf8"));
  executor.stopAll();
  await assert.rejects(hanging);
  assert.throws(() => process.kill(pid, 0));
});
