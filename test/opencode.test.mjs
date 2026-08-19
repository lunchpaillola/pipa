import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { buildRunArguments, cleanChildEnvironment, createOpenCodeExecutor, opencodeCommand, parseOpenCodeOutput, runOpenCodeVersion } from "../src/opencode.mjs";

test("builds shell-free continuation arguments with a literal prompt", () => {
  const prompt = "summarize $(touch nope) && echo bad";
  assert.deepEqual(buildRunArguments({ prompt, sessionId: "ses_1", workingDirectory: "/work" }), [
    "run", "--format", "json", "--dir", "/work", "--session", "ses_1", "--", prompt,
  ]);
  assert.equal(opencodeCommand("win32"), "opencode");
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
  const executor = createOpenCodeExecutor({ spawn, platform: "linux", environment: { PATH: "/bin", SLACK_BOT_TOKEN: "secret" } });
  const result = await executor.runTurn({ prompt: "hello", sessionId: null, workingDirectory: "/work" });
  assert.deepEqual(result, { text: "done", sessionId: "ses_new" });
  assert.equal(invocation.options.shell, false);
  assert.equal(invocation.options.env.SLACK_BOT_TOKEN, undefined);
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
  const spawn = () => {
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
  await assert.rejects(createOpenCodeExecutor({ spawn }).runTurn({ prompt: "hello", workingDirectory: "/work" }), /provider failed/u);
});

test("executor times out and terminates a hung child", async () => {
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
    return child;
  };
  await assert.rejects(createOpenCodeExecutor({ spawn, timeoutMs: 5 }).runTurn({ prompt: "hello", workingDirectory: "/work" }), /timed out/u);
  assert.equal(killed, true);
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
