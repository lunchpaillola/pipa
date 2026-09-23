import { createRequire } from "node:module";

const { version: PIPA_VERSION } = createRequire(import.meta.url)("../package.json");

// Reader preset of createChatTools({ preset: "reader" }) in chat 4.38.1.
// Only these names are exposed so a mis-wired tools object cannot leak
// mutating tools through this transport.
const READER_TOOL_NAMES = [
  "fetchMessages",
  "fetchChannelMessages",
  "fetchThread",
  "listThreads",
  "getThreadParticipants",
  "getChannelInfo",
  "getUser",
];

const MCP_PROTOCOL_FALLBACK = "2025-06-18";
// MCP results stay small enough for one model turn; oversized payloads are
// truncated with a marker instead of failing the call.
const MAX_MCP_TEXT_CHARS = 32_000;

const redactCredentials = (value) => String(value).replace(/xox[baprs]-[^\s]+|xapp-[^\s]+/gu, "[redacted]");

const truncateText = (text) => text.length <= MAX_MCP_TEXT_CHARS ? text : `${text.slice(0, MAX_MCP_TEXT_CHARS)}…[truncated]`;

// Pipa-process MCP transport around createChatTools({ preset: "reader" })
// output. Pass the tools object in; this module never imports chat/ai, so
// Pipa gains no new runtime dependency. Schemas are consumed through the
// shape the Chat SDK already provides (Standard Schema or zod-style
// safeParse/parse plus an optional JSON Schema), never redeclared here.
export function createMcpBridge({ tools } = {}) {
  if (!tools || typeof tools !== "object") throw new Error("createMcpBridge requires the createChatTools({ preset: \"reader\" }) tools object.");
  const reader = {};
  for (const name of READER_TOOL_NAMES) {
    if (tools[name]) reader[name] = tools[name];
  }
  const ok = (id, result) => ({ jsonrpc: "2.0", id, result });
  const fail = (id, code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });
  const toolError = (id, text) => ok(id, { content: [{ type: "text", text: truncateText(redactCredentials(text)) }], isError: true });

  const handleMessage = async (message) => {
    if (!message || typeof message !== "object" || message.id === undefined) return undefined;
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") return fail(message.id, -32600, "Invalid Request.");
    if (message.method === "initialize") {
      const requested = message.params && typeof message.params === "object" ? message.params.protocolVersion : undefined;
      return ok(message.id, {
        protocolVersion: typeof requested === "string" && requested ? requested : MCP_PROTOCOL_FALLBACK,
        capabilities: { tools: {} },
        serverInfo: { name: "pipa-reader", version: PIPA_VERSION },
      });
    }
    if (message.method === "tools/list") {
      return ok(message.id, {
        tools: Object.entries(reader).map(([name, tool]) => ({
          name,
          description: tool.description ?? "",
          inputSchema: inputJsonSchema(tool.inputSchema),
        })),
      });
    }
    if (message.method === "tools/call") {
      if (!message.params || typeof message.params !== "object" || typeof message.params.name !== "string") {
        return fail(message.id, -32602, "Invalid params: tools/call requires { name, arguments }.");
      }
      const tool = reader[message.params.name];
      if (!tool || typeof tool.execute !== "function") {
        return fail(message.id, -32602, truncateText(redactCredentials(`Unknown tool: "${message.params.name}".`)));
      }
      const args = message.params.arguments === undefined ? {} : message.params.arguments;
      const validated = await validateToolInput(tool.inputSchema, args);
      if (!validated.ok) return toolError(message.id, `Invalid arguments for "${message.params.name}": ${validated.detail}`);
      let raw;
      try {
        raw = await tool.execute(validated.value);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return toolError(message.id, `Tool "${message.params.name}" failed: ${detail || "unknown error"}`);
      }
      let text;
      try {
        text = JSON.stringify(raw) ?? "null";
      } catch {
        text = "\"[unserializable result]\"";
      }
      return ok(message.id, { content: [{ type: "text", text: truncateText(redactCredentials(text)) }] });
    }
    return fail(message.id, -32601, `Method not found: "${message.method}".`);
  };
  return { handleMessage };
}

// Expose the source schema as JSON Schema for tools/list without importing a
// validator: AI SDK schemas carry jsonSchema, zod v4 schemas convert via
// toJSONSchema, anything else falls back to a generic object shape.
function inputJsonSchema(schema) {
  if (schema && typeof schema === "object") {
    if (schema.jsonSchema && typeof schema.jsonSchema === "object") return schema.jsonSchema;
    if (typeof schema.toJSONSchema === "function") {
      try {
        const converted = schema.toJSONSchema();
        if (converted && typeof converted === "object") return converted;
      } catch {}
    }
  }
  return { type: "object" };
}

// Validate arguments before execute through whichever interface the source
// schema provides. Returns { ok: true, value } or { ok: false, detail }.
async function validateToolInput(schema, args) {
  if (!schema || typeof schema !== "object") return { ok: true, value: args };
  const standard = schema["~standard"];
  if (standard && typeof standard.validate === "function") {
    const outcome = await standard.validate(args);
    if (outcome && typeof outcome === "object" && outcome.issues) return { ok: false, detail: issueDetail(outcome.issues) };
    return { ok: true, value: outcome && typeof outcome === "object" && "value" in outcome ? outcome.value : args };
  }
  if (typeof schema.safeParseAsync === "function") {
    const parsed = await schema.safeParseAsync(args);
    if (!parsed.success) return { ok: false, detail: issueDetail(parsed.error) };
    return { ok: true, value: parsed.data };
  }
  if (typeof schema.safeParse === "function") {
    const parsed = schema.safeParse(args);
    if (!parsed.success) return { ok: false, detail: issueDetail(parsed.error) };
    return { ok: true, value: parsed.data };
  }
  if (typeof schema.parse === "function") {
    try {
      return { ok: true, value: await schema.parse(args) };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
  return { ok: true, value: args };
}

function issueDetail(error) {
  const issues = Array.isArray(error) ? error : error?.issues;
  const first = Array.isArray(issues) ? issues[0]?.message : undefined;
  if (typeof first === "string" && first) return first;
  if (typeof error?.message === "string" && error.message) return error.message;
  return "input failed schema validation";
}
