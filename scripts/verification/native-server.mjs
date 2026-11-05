import { OpenCode } from "@opencode/client";
import { bounded } from "../../test/helpers/runtime-fixture.mjs";

export async function startNativeServer(runtime) {
  const password = "isolated-native";
  const headers = { authorization: `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}` };
  const server = runtime.spawn("opencode", ["serve", "--hostname", "127.0.0.1", "--port", "0", "--log-level", "error"], {
    env: { ...runtime.env, OPENCODE_PASSWORD: password, OPENCODE_DISABLE_DEFAULT_PLUGINS: "1", OPENCODE_DISABLE_EXTERNAL_SKILLS: "1", OPENCODE_DISABLE_CLAUDE_CODE_SKILLS: "1", BUN_JSC_maxRegExpStackSize: "536870912" },
  });
  const baseUrl = await bounded(new Promise((resolve, reject) => {
    let output = "";
    server.child.stdout.on("data", chunk => {
      output += chunk;
      const match = output.match(/https?:\/\/(?:127\.0\.0\.1|localhost):\d+/u);
      if (match) resolve(match[0]);
    });
    server.exited.then(() => reject(new Error("Native server exited during startup")), reject);
  }), { timeoutMs: 30_000, signal: runtime.signal });
  const client = OpenCode.make({ baseUrl, headers });
  const info = await client.server.info({ signal: runtime.signal });
  return { server, client, baseUrl, headers, version: info.version };
}
