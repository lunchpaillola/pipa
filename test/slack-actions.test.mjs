import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { slackActions } from "../src/slack-actions.mjs";

test("reads a linked thread by its parent timestamp and returns pagination", async () => {
  const actions = slackActions({ conversations: { replies: async (args) => {
    assert.deepEqual(args, { channel: "C123ABC", ts: "1795009397.468559", limit: 15 });
    return { messages: [{ text: "hello" }], response_metadata: { next_cursor: "next" } };
  } } });
  assert.deepEqual(JSON.parse(JSON.stringify(await actions.read_thread.run({ link: "https://example.slack.com/archives/C123ABC/p1795011093116729?thread_ts=1795009397.468559&cid=C123ABC" }))), {
    messages: [{ text: "hello" }], nextCursor: "next",
  });
  await assert.rejects(actions.read_thread.run({ link: "https://slack.com.example.com/archives/C123ABC/p1795011093116729" }), /Slack message link/);
});

test("file transfers stay in the staging directory, preserve bytes and refuse overwrites and symlinks", async (t) => {
  const workspace = await mkdtemp(path.join(os.tmpdir(), "pipa-slack-actions-"));
  t.after(() => rm(workspace, { recursive: true, force: true }));
  const contents = Buffer.from("test file");
  const uploads = [];
  const actions = slackActions({ files: {
    info: async () => ({ file: { name: "test.txt", size: contents.length, url_private_download: "https://files.slack.com/fake" } }),
    uploadV2: async (input) => { uploads.push(input); },
  } }, { profileDirectory: workspace, botToken: "synthetic", fetchFile: async (url, init) => {
    assert.equal(url.origin, "https://files.slack.com");
    assert.equal(init.redirect, "error");
    return new Response(contents);
  } });
  const result = await actions.download_file.run({ fileId: "FTEST" });
  const downloaded = result.path;
  assert.deepEqual(await readFile(downloaded), contents);
  await assert.rejects(actions.download_file.run({ fileId: "FTEST" }), /already exist/);
  await actions.upload_file.run({ channel: "CJOINED", filename: "FTEST-test.txt" });
  await writeFile(path.join(workspace, "outside.txt"), contents);
  await symlink(path.join(workspace, "outside.txt"), path.join(path.dirname(downloaded), "link.txt"));
  await assert.rejects(actions.upload_file.run({ channel: "CJOINED", filename: "link.txt" }), /safely/);
  await assert.rejects(actions.upload_file.run({ channel: "CJOINED", filename: "../outside.txt" }), /not a path/);
  assert.deepEqual(uploads, [{ channel_id: "CJOINED", file: contents, filename: "FTEST-test.txt" }]);
});

test("posts and edits through one client and never falls back on denial", async () => {
  const args = [];
  const actions = slackActions({ chat: {
    postMessage: async (input) => { args.push(input); return { channel: "C123ABC", ts: "1795009397.468559" }; },
    update: async () => { throw { data: { error: "missing_scope", detail: "private fixture detail" } }; },
  } });
  assert.deepEqual(await actions.post_message.run({ channel: "C123ABC", text: "hello" }), { channel: "C123ABC", ts: "1795009397.468559" });
  assert.deepEqual(args, [{ channel: "C123ABC", text: "hello", unfurl_links: false, unfurl_media: false }]);
  await assert.rejects(actions.edit_message.run({ channel: "C123ABC", ts: "1795009397.468559", text: "edit" }), {
    message: "The Pipa bot is missing a Slack permission for this action. Check the installed app grants.",
  });
});

test("cross-channel actions use Slack's bot permissions, not the inbound profile allowlist", async () => {
  const attempted = [];
  const actions = slackActions({ chat: { postMessage: async ({ channel }) => {
    attempted.push(channel);
    if (channel === "CNOTJOINED") throw { data: { error: "not_in_channel" } };
    return { channel, ts: "1795009397.468559" };
  } } });
  assert.deepEqual(await actions.post_message.run({ channel: "CJOINED", text: "requested cross-channel post" }), {
    channel: "CJOINED", ts: "1795009397.468559",
  });
  await assert.rejects(actions.post_message.run({ channel: "CNOTJOINED", text: "denied by Slack" }), /bot cannot access/);
  assert.deepEqual(attempted, ["CJOINED", "CNOTJOINED"]);
});
