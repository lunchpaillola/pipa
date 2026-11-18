import { link, lstat, mkdir, mkdtemp, realpath, rmdir, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { MAX_ATTACHMENT_BYTES, readArtifacts, sanitizeFilename, validArtifactPath } from "./opencode.mjs";

const channelPattern = /^[CG][A-Z0-9]+$/u;
const tsPattern = /^\d{10}\.\d{6}$/u;

function threadTarget(link) {
  let url;
  try { url = new URL(link); } catch { /* Invalid links are rejected below. */ }
  const match = url && /^\/archives\/([CG][A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/u.exec(url.pathname);
  if (!match || url.protocol !== "https:" || !url.hostname.endsWith(".slack.com") || url.username || url.password || url.port) {
    throw new Error("Provide a valid Slack message link.");
  }
  const ts = url.searchParams.get("thread_ts") ?? `${match[2]}.${match[3]}`;
  if (!tsPattern.test(ts) || (url.searchParams.has("cid") && url.searchParams.get("cid") !== match[1])) {
    throw new Error("Provide a valid Slack message link.");
  }
  return { channel: match[1], ts };
}

export function slackActions(client, { profileDirectory, botToken, fetchFile = fetch } = {}) {
  async function transferDirectory() {
    const profile = await lstat(profileDirectory);
    if (!profile.isDirectory() || (process.getuid && (profile.uid !== process.getuid() || (profile.mode & 0o022)))) throw new Error("Slack file transfers require a private Pipa profile directory.");
    const root = await realpath(profileDirectory);
    const directory = path.join(root, "slack-files");
    await mkdir(directory, { mode: 0o700 }).catch((error) => { if (error.code !== "EEXIST") throw error; });
    const stat = await lstat(directory);
    if (!stat.isDirectory() || (await realpath(directory)) !== directory || (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o077)))) throw new Error("The Slack transfer folder must be a private profile directory.");
    return directory;
  }
  function target(channel, ts) {
    if (!channelPattern.test(channel) || (ts !== undefined && !tsPattern.test(ts))) throw new Error("Provide a Slack channel ID and a valid message timestamp when needed.");
    return { channel, ...(ts === undefined ? {} : { ts }) };
  }
  async function call(request) {
    try { return await request(); }
    catch (error) {
      const code = error?.data?.error;
      if (code === "missing_scope") throw new Error("The Pipa bot is missing a Slack permission for this action. Check the installed app grants.");
      if (["not_in_channel", "channel_not_found", "no_permission", "access_denied"].includes(code)) throw new Error("The Pipa bot cannot access that Slack conversation. Check its membership and permissions.");
      if (["cant_update_message", "edit_window_closed", "message_not_found", "thread_not_found", "user_not_found", "no_reaction"].includes(code)) throw new Error("Slack could not find or modify that item as the Pipa bot.");
      throw new Error("The Slack action failed for the Pipa bot. Check the selected profile and app access.");
    }
  }
  return {
    read_thread: { async run({ link, cursor }) {
      const { channel, ts } = threadTarget(link);
      const response = await call(() => client.conversations.replies({ ...target(channel, ts), limit: 15, ...(cursor ? { cursor } : {}) }));
      return { messages: (response.messages ?? []).map(({ text, user, bot_id, ts, files }) => ({ text, user, botId: bot_id, ts, files: files?.map(({ id, name, size }) => ({ id, name, size })) })), nextCursor: response.response_metadata?.next_cursor || null };
    } },
    lookup_user: { async run({ user }) {
      const response = await call(() => client.users.info({ user }));
      return { id: response.user?.id, name: response.user?.name, realName: response.user?.real_name, displayName: response.user?.profile?.display_name };
    } },
    post_message: { async run({ channel, threadTs, text }) {
      const checked = target(channel, threadTs);
      const response = await call(() => client.chat.postMessage({ channel: checked.channel, text, ...(threadTs ? { thread_ts: threadTs } : {}), unfurl_links: false, unfurl_media: false }));
      return { channel: response.channel, ts: response.ts };
    } },
    edit_message: { async run({ channel, ts, text }) {
      const checked = target(channel, ts);
      const response = await call(() => client.chat.update({ ...checked, text }));
      return { channel: response.channel, ts: response.ts };
    } },
    add_reaction: { async run({ channel, ts, name }) {
      const checked = target(channel, ts);
      await call(() => client.reactions.add({ channel: checked.channel, timestamp: checked.ts, name }));
      return { ok: true };
    } },
    remove_reaction: { async run({ channel, ts, name }) {
      const checked = target(channel, ts);
      await call(() => client.reactions.remove({ channel: checked.channel, timestamp: checked.ts, name }));
      return { ok: true };
    } },
    upload_file: { async run({ channel, threadTs, filename }) {
      const checked = target(channel, threadTs);
      if (!validArtifactPath(filename)) throw new Error("Provide one filename in the Slack transfer folder, not a path.");
      const [file] = await readArtifacts(await transferDirectory(), [filename]);
      if (!file) throw new Error("The upload could not be read safely or exceeds the file size limit.");
      await call(() => client.files.uploadV2({ channel_id: checked.channel, ...(threadTs ? { thread_ts: threadTs } : {}), file: file.data, filename: file.filename }));
      return { filename: file.filename, uploaded: true };
    } },
    download_file: { async run({ fileId }) {
      const { file } = await call(() => client.files.info({ file: fileId }));
      if (!Number.isSafeInteger(file?.size) || file.size < 0 || file.size > MAX_ATTACHMENT_BYTES) throw new Error("Slack downloads must be at most 10 MiB.");
      let url;
      try { url = new URL(file.url_private_download ?? file.url_private); } catch { /* Reject missing or invalid Slack URLs. */ }
      if (url?.origin !== "https://files.slack.com" || url.username || url.password) throw new Error("Slack did not provide a supported private download URL.");
      const data = await call(async () => {
        const response = await fetchFile(url, { headers: { Authorization: `Bearer ${botToken}` }, redirect: "error", signal: AbortSignal.timeout(15_000) });
        if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error("Download rejected"); }
        const reader = response.body.getReader();
        const chunks = [];
        let size = 0;
        try {
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > MAX_ATTACHMENT_BYTES || size > file.size) throw new Error("Download exceeds limit");
            chunks.push(value);
          }
          if (size !== file.size) throw new Error("Incomplete download");
          return Buffer.concat(chunks, size);
        } finally { await reader.cancel().catch(() => undefined); }
      });
      const filename = `${fileId}-${sanitizeFilename(file.name || "attachment")}`;
      const directory = await transferDirectory();
      const temporary = await mkdtemp(path.join(directory, ".download-"));
      const staged = path.join(temporary, "file");
      try {
        await writeFile(staged, data, { flag: "wx", mode: 0o600 });
        await link(staged, path.join(directory, filename));
      } catch {
        throw new Error("Could not save the Slack download safely. The destination may already exist.");
      } finally {
        await unlink(staged).catch(() => undefined);
        await rmdir(temporary).catch(() => undefined);
      }
      return { path: path.join(directory, filename), size: data.length };
    } },
  };
}
