import assert from "node:assert/strict";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Finite model scripts. Sessions, tools, permissions, forms and scheduling remain real.
export async function createProvider(runtime) {
  const scripts = new Map();
  const failures = [];
  const receipts = [];
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST", "Unexpected provider method");
      assert.equal(req.url, "/v1/chat/completions", "Unexpected provider route");
      let data = "";
      for await (const chunk of req) {
        data += chunk;
        assert.ok(data.length < 32 * 1024 * 1024, "Unexpected provider body size");
      }
      const body = JSON.parse(data);
      assert.ok(["matrix", "matrix-next"].includes(body.model), "Unexpected provider model");
      assert.ok(Array.isArray(body.messages), "Unexpected provider messages");
      // V2 may append this native synthetic user message after location reload/MCP
      // discovery. It is not another prompt and must not hide preceding tool results.
      const lastUser = body.messages.findLastIndex((message) => message.role === "user" && !(typeof message.content === "string"
        && message.content.startsWith("<system-update>\nThe Code Mode tool catalog has changed.\n") && message.content.endsWith("</system-update>")));
      const content = JSON.stringify(body.messages[lastUser]?.content);
      const direct = [...scripts.values()].filter((script) => content?.includes(script.prompt));
      const matches = direct.length ? direct : [...scripts.values()].filter((script) => script.match?.(body.messages));
      assert.equal(matches.length, 1, "Unexpected provider prompt (not a registered case)");
      const script = matches[0];
      assert.ok(++script.calls <= (script.maxCalls ?? 4), "Unexpected repeated provider request");
      const tools = (body.tools ?? []).map((tool) => tool.function ?? tool);
      const after = body.messages.slice(lastUser + 1);
      const toolResults = after.filter((message) => message.role === "tool");
      const receipt = { prompt: script.prompt, model: body.model, provider: req.headers["x-matrix-provider"], temperature: body.temperature, tools, toolResults, closed: false };
      receipts.push(receipt);
      if (script.hold && (!script.holdOnce || script.calls === 1)) {
        await new Promise((resolve) => {
          script.release = () => { receipt.released = true; resolve(); };
          res.once("close", () => { receipt.closed = true; resolve(); });
        });
        if (receipt.closed) return;
      }
      if (script.fail) {
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "Controlled matrix provider failure", type: "invalid_request_error" } }));
        return;
      }
      let call;
      const steps = script.steps ?? (script.tool ? [script.tool] : []);
      const step = script.toolOnce && script.calls > 1 ? undefined : steps[toolResults.length];
      if (step) {
        const tool = tools.find((tool) => step.names.includes(tool.name));
        if (!tool && script.allowMissingTool) receipt.missingTool = step.names;
        else {
          assert.ok(tool, `Unexpected tool catalog: missing ${step.names.join("/")}`);
          call = { name: tool.name, args: step.arguments(body.messages, tool) };
        }
      }
      for (const [index, result] of toolResults.entries()) steps[index]?.verify?.([result]);
      script.verify?.(body.messages);
      const text = receipt.missingTool ? `Native tool unavailable: ${receipt.missingTool.join("/")}` : typeof script.text === "function" ? script.text(body.messages) : script.text;
      const id = `chatcmpl-${randomUUID()}`;
      const toolCall = call && { id: `call_${randomUUID().replaceAll("-", "")}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.args) } };
      const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const frame = (delta, finish_reason = null) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta, finish_reason }] })}\n\n`);
        frame({ role: "assistant" });
        frame(toolCall ? { tool_calls: [{ index: 0, ...toolCall }] } : { content: text });
        res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: 1, model: body.model, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage })}\n\ndata: [DONE]\n\n`);
        res.end();
      } else {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id, object: "chat.completion", created: 1, model: body.model, choices: [{ index: 0, message: toolCall ? { role: "assistant", content: null, tool_calls: [toolCall] } : { role: "assistant", content: text }, finish_reason: call ? "tool_calls" : "stop" }], usage }));
      }
    } catch (error) {
      failures.push(error);
      if (!res.headersSent) res.writeHead(500, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: { message: "Unexpected deterministic provider request" } }));
    }
  });
  const base = await runtime.listen(server);
  return {
    url: `${base}/v1`, receipts,
    register(script) {
      assert.ok(script.prompt && !scripts.has(script.prompt), "Duplicate/empty provider script");
      scripts.set(script.prompt, { ...script, calls: 0 });
    },
    checkpoint: () => failures.length,
    release(prompt) { assert.ok(scripts.get(prompt)?.release, "Provider barrier has not been reached"); scripts.get(prompt).release(); },
    assertClean(from = 0) { if (failures.length > from) throw new AggregateError(failures.slice(from), failures.slice(from).map((error) => error.message).join("; ")); },
  };
}

export function providerConfig(url) {
  return {
    model: "matrix/matrix", small_model: "matrix/matrix", autoupdate: false, snapshot: false,
    enabled_providers: ["matrix"],
    agent: { title: { disable: true }, summary: { disable: true } },
    provider: { matrix: { npm: "@ai-sdk/openai-compatible", name: "Deterministic loopback", options: { baseURL: url, apiKey: "synthetic-local-only" }, models: Object.fromEntries(["matrix", "matrix-next"].map((id) => [id, { name: id, tool_call: true, limit: { context: 64000, output: 8000 }, modalities: { input: ["text", "image"], output: ["text"] } }])) } },
    permission: { bash: "ask" },
  };
}

export async function writeDefinitions(runtime, marker, pin) {
  const v2 = pin.startsWith("2.");
  const directory = path.join(runtime.workspace, ".opencode");
  await Promise.all(["skills/matrix-fixture", "agents", "commands", "plugins"].map((name) => mkdir(path.join(directory, name), { recursive: true })));
  await writeFile(path.join(directory, "skills/matrix-fixture/SKILL.md"), `---\nname: matrix-fixture\ndescription: Deterministic matrix skill\n---\nSkill bytes: ${marker}\n`);
  await writeFile(path.join(directory, "agents/matrix-fixture.md"), "---\ndescription: Deterministic matrix child\nmode: subagent\npermission:\n  bash: ask\n  question: allow\n---\nExecute the supplied synthetic child request.\n");
  await writeFile(path.join(directory, "commands/matrix-fixture.md"), `---\ndescription: Deterministic matrix command\n---\n${marker}\n`);
  const pluginLog = path.join(runtime.state, "plugin-loads.txt");
  const pluginDirectory = path.join(runtime.workspace, "matrix-plugin");
  await mkdir(pluginDirectory);
  const plugin = path.join(pluginDirectory, "index.js");
  await writeFile(path.join(pluginDirectory, "package.json"), JSON.stringify({ name: "matrix-plugin", type: "module", main: "index.js" }));
  const rewritePlugin = (version) => writeFile(plugin, `import {appendFileSync} from 'node:fs';\nconst log = item => appendFileSync(${JSON.stringify(pluginLog)}, JSON.stringify({version:${version},...item})+'\\n');\n${v2
    ? "export default {id:'matrix-fixture', async setup(ctx) { log({kind:'loaded'}); await ctx.tool.hook('execute.before', async input => log({kind:'hook',tool:input.tool})); }};"
    : "export const Matrix = async () => { log({kind:'loaded'}); return {'tool.execute.before': async input => log({kind:'hook',tool:input.tool})}; };"}\n`);
  await rewritePlugin(1);
  const mcp = path.join(runtime.workspace, "matrix-mcp.cjs");
  await writeFile(mcp, `const readline=require('node:readline');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const request=JSON.parse(line); if(request.id===undefined)return;
 let result;
 if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'matrix',version:'1'}};
 else if(request.method==='ping')result={};
 else if(request.method==='tools/list')result={tools:[{name:'nonce',description:'Return a synthetic matrix marker',inputSchema:{type:'object',properties:{},additionalProperties:false}}]};
 else if(request.method==='tools/call'&&request.params.name==='nonce')result={content:[{type:'text',text:${JSON.stringify(marker)}}]};
 else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Unexpected MCP request'}})+'\\n');return;}
 process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\\n');
});\n`);
  // V2 defaults MCP tools to Code Mode. This case explicitly qualifies direct
  // tool execution; Code Mode needs its own execution/catalog evidence.
  const server = { type: "local", command: [process.execPath, mcp], ...(v2 ? { codemode: false } : { enabled: true }) };
  const config = v2
    ? { mcp: { servers: { matrix: server } }, plugins: [pluginDirectory] }
    : { mcp: { matrix: server }, plugin: [pathToFileURL(plugin).href] };
  return { config, pluginLog, rewritePlugin, marker };
}
