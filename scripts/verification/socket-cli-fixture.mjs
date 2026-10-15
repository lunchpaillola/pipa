// Private deterministic CLI preload. Never installed into or used by a live
// profile: the engine harness explicitly supplies this file via NODE_OPTIONS.
import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { fakeChat, observeNativeAdmissions } from "./opencode-release-cases.mjs";

const candidate = process.env.PIPA_FIXTURE_CANDIDATE;
assert.ok(candidate && process.env.PIPA_TEST_OWNERSHIP, "Socket fixture requires an isolated owned runtime");
const appUrl = pathToFileURL(path.join(candidate, "src", "app.mjs")).href;
registerHooks({
  load(url, context, next) {
    if (url !== appUrl) return next(url, context);
    return { format: "module", shortCircuit: true, source: `
      export { initializePipa } from ${JSON.stringify(`${appUrl}?actual`)};
      import { startPipa as actual } from ${JSON.stringify(`${appUrl}?actual`)};
      import { createFixtureChat } from ${JSON.stringify(import.meta.url)};
      import { createRoutineScheduler } from ${JSON.stringify(new URL("./routines.mjs", appUrl).href)};
      export const startPipa = async options => {
        const chat = createFixtureChat();
        const app = await actual({ ...options, chat, checkSlackToken: async () => ({ ok: true }), routineIntervalMs: 100,
          createRoutineScheduler: settings => (chat.scheduler = createRoutineScheduler(settings)) });
        chat.nativeUrl = app.server.baseUrl;
        return app;
      };
    ` };
  },
});

export function createFixtureChat() {
  const chat = fakeChat();
  const admissions = [];
  globalThis.fetch = observeNativeAdmissions(globalThis.fetch, admissions);
  const directory = process.env.XDG_STATE_HOME;
  let timer;
  let pending;
  let last;
  const poll = () => pending ??= (async () => {
    const input = await readFile(path.join(directory, "input.json"), "utf8").then(JSON.parse).catch(() => null);
    if (input && input.id !== last) {
      last = input.id;
      if (input.barrier) {
        await chat.scheduler.tick();
        await chat.scheduler.tick();
        chat.schedulerBarriers = (chat.schedulerBarriers ?? 0) + 1;
      } else if (input.action) await chat.handlers.action(input.action);
      else chat.send(input.thread, input.prompt, input.mention ?? true);
    }
    await writeFile(path.join(directory, "chat.json"), JSON.stringify({ ready: Boolean(chat.nativeUrl), nativeUrl: chat.nativeUrl, pid: process.pid, admissions, posts: chat.posts, reactions: chat.reactions, controls: chat.controls, schedulerBarriers: chat.schedulerBarriers ?? 0 }));
  })().finally(() => { pending = null; });
  chat.initialize = async () => {
    // Avoid replaying the pre-restart input when the replacement starts.
    last = await readFile(path.join(directory, "input.json"), "utf8").then(JSON.parse).then((input) => input.id).catch(() => null);
    await poll();
    timer = setInterval(() => { void poll().catch(() => {}); }, 25);
  };
  chat.shutdown = async () => { clearInterval(timer); await pending; };
  return chat;
}
