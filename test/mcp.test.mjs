import assert from "node:assert/strict";
import test from "node:test";
import { createMcpBridge } from "../src/mcp.mjs";

// Minimal schemas in the shapes the Chat SDK provides: Standard Schema style
// (~standard.validate plus a JSON Schema) and zod style (safeParse).
const userSchema = {
  jsonSchema: { type: "object", properties: { userId: { type: "string" } }, required: ["userId"] },
  "~standard": {
    validate: async (value) => (
      value && typeof value === "object" && typeof value.userId === "string" && value.userId
        ? { value: { userId: value.userId } }
        : { issues: [{ message: "userId is required" }] }
    ),
  },
};

const echoSchema = {
  safeParse: (value) => (
    value && typeof value === "object" && typeof value.text === "string"
      ? { success: true, data: { text: value.text } }
      : { success: false, error: { message: "text is required" } }
  ),
};

const directory = new Map([["U123", { userId: "U123", userName: "ada", fullName: "Ada", isBot: false }]]);

const createTools = ({ executeCalls = { count: 0 } } = {}) => ({
  getUser: {
    description: "Look up a user.",
    inputSchema: userSchema,
    execute: async ({ userId }) => directory.get(userId) ?? null,
  },
  fetchMessages: {
    description: "Fetch messages.",
    inputSchema: echoSchema,
    execute: async ({ text }) => {
      executeCalls.count += 1;
      return { text };
    },
  },
  postMessage: { // Non-reader tool: present in the input object but never exposed.
    description: "Post a message.",
    execute: async () => ({ posted: true }),
  },
});

const call = (bridge, method, params, id = 1) => bridge.handleMessage({ jsonrpc: "2.0", id, method, params });

test("initialize negotiates the protocol and advertises tools capability", async () => {
  const bridge = createMcpBridge({ tools: createTools() });
  const response = await call(bridge, "initialize", { protocolVersion: "2024-11-05" });
  assert.equal(response.jsonrpc, "2.0");
  assert.equal(response.result.protocolVersion, "2024-11-05");
  assert.deepEqual(response.result.capabilities, { tools: {} });
  assert.equal(response.result.serverInfo.name, "pipa-reader");
  assert.match(response.result.serverInfo.version, /^\d+\.\d+\.\d+$/u);
});

test("tools/list exposes only reader tools with their source schema", async () => {
  const bridge = createMcpBridge({ tools: createTools() });
  const response = await call(bridge, "tools/list", {});
  const names = response.result.tools.map((tool) => tool.name);
  assert.deepEqual(names, ["fetchMessages", "getUser"]);
  assert.equal(response.result.tools[1].description, "Look up a user.");
  assert.deepEqual(response.result.tools[1].inputSchema, userSchema.jsonSchema);
});

test("tools/call executes with validated input and returns text content", async () => {
  const executeCalls = { count: 0 };
  const bridge = createMcpBridge({ tools: createTools({ executeCalls }) });
  const response = await call(bridge, "tools/call", { name: "fetchMessages", arguments: { text: "hello" } });
  assert.deepEqual(response.result, { content: [{ type: "text", text: "{\"text\":\"hello\"}" }] });
  assert.equal(executeCalls.count, 1);
});

test("tools/call validates before execute and reports invalid input", async () => {
  const executeCalls = { count: 0 };
  const bridge = createMcpBridge({ tools: createTools({ executeCalls }) });
  for (const params of [{ name: "getUser", arguments: {} }, { name: "fetchMessages", arguments: { text: 42 } }]) {
    const response = await call(bridge, "tools/call", params);
    assert.equal(response.result.isError, true);
    assert.match(response.result.content[0].text, /Invalid arguments/u);
  }
  assert.equal(executeCalls.count, 0);
});

test("tools/call rejects unknown and non-reader tools", async () => {
  const bridge = createMcpBridge({ tools: createTools() });
  for (const name of ["nope", "postMessage"]) {
    const response = await call(bridge, "tools/call", { name, arguments: {} });
    assert.equal(response.error.code, -32602);
  }
});

test("tool failures and results never expose Slack tokens", async () => {
  const bridge = createMcpBridge({
    tools: {
      ...createTools(),
      fetchThread: {
        description: "Fetch a thread.",
        execute: async () => { throw new Error("Slack api failed for xoxb-secret-token"); },
      },
      getChannelInfo: {
        description: "Channel info.",
        execute: async () => ({ token: "xapp-secret-token" }),
      },
    },
  });
  const failure = await call(bridge, "tools/call", { name: "fetchThread", arguments: {} });
  assert.equal(failure.result.isError, true);
  assert.doesNotMatch(failure.result.content[0].text, /secret-token/u);
  assert.match(failure.result.content[0].text, /\[redacted\]/u);
  const leaked = await call(bridge, "tools/call", { name: "getChannelInfo", arguments: {} });
  assert.doesNotMatch(leaked.result.content[0].text, /secret-token/u);
});

test("oversized results are bounded with a truncation marker", async () => {
  const bridge = createMcpBridge({
    tools: { listThreads: { description: "List threads.", execute: async () => ({ blob: "x".repeat(100_000) }) } },
  });
  const response = await call(bridge, "tools/call", { name: "listThreads", arguments: {} });
  assert.ok(response.result.content[0].text.length < 100_000);
  assert.match(response.result.content[0].text, /\[truncated\]$/u);
});

test("protocol errors follow JSON-RPC and notifications stay silent", async () => {
  const bridge = createMcpBridge({ tools: createTools() });
  assert.equal((await call(bridge, "unknown/method", {})).error.code, -32601);
  assert.equal((await bridge.handleMessage({ jsonrpc: "2.0", id: 9, method: 42 })).error.code, -32600);
  assert.equal(await bridge.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" }), undefined);
  assert.equal(await bridge.handleMessage({ jsonrpc: "2.0", method: "tools/list" }), undefined);
});

test("createMcpBridge requires a tools object", () => {
  assert.throws(() => createMcpBridge(), /tools object/u);
  assert.throws(() => createMcpBridge({ tools: null }), /tools object/u);
});
