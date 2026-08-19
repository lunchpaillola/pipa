import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import test from "node:test";
import { buildRunArguments, cleanChildEnvironment, createOpenCodeExecutor, opencodeCommand, parseOpenCodeOutput } from "../src/opencode.mjs";

test("builds shell-free continuation arguments with a literal prompt", () => {
  const prompt = "summarize $(touch nope) && echo bad";
  assert.deepEqual(buildRunArguments({ prompt, sessionId: "ses_1", workingDirectory: "/work" }), [
    "run", "--format", "json", "--dir", "/work", "--session", "ses_1", "--", prompt,
  ]);
  assert.equal(opencodeCommand("win32"), "opencode.cmd");
});

test("removes Slack credentials from the child environment", () => {
  assert.deepEqual(cleanChildEnvironment({ PATH: "/bin", SLACK_BOT_TOKEN: "secret", PIPA_SLACK_APP_TOKEN: "secret" }), { PATH: "/bin" });
});

test("parses assistant text and session ID without exposing tool events", () => {
  const output = parseOpenCodeOutput([
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
