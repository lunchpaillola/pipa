<p align="center">
  <a href="https://www.usepipa.com/opencode-slack?utm_source=github&utm_medium=repo_readme&utm_campaign=signup&utm_content=readme_banner">
    <img src="docs/assets/banner.png" alt="Pipa: run OpenCode from Slack" width="100%">
  </a>
</p>

<p align="center">
  <a href="https://github.com/lunchpaillola/pipa/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/lunchpaillola/pipa/ci.yml?branch=main&style=flat-square&label=CI"></a>
  <a href="https://www.npmjs.com/package/@usepipa/pipa"><img alt="npm" src="https://img.shields.io/npm/v/@usepipa/pipa?style=flat-square&color=2437F5&label=npm"></a>
</p>

<p align="center">
  <strong>Pipa turns a Slack thread into a durable OpenCode session on one private server, local by default.</strong><br>
  No relay, no database, no public endpoint.
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=rlTMdkPWPcA"><strong>Watch the 3-minute setup</strong></a>
  ·
  <a href="https://www.usepipa.com/opencode-slack?utm_source=github&utm_medium=repo_readme&utm_campaign=signup&utm_content=readme_how_it_works">How it works</a>
  ·
  <a href="CONTRIBUTING.md">Contributing</a>
  ·
  <a href="https://github.com/lunchpaillola/pipa/issues">Issues</a>
</p>

> **Early preview.** Features may break unintentionally, and CLI commands, configuration, and Slack behavior may continue to change.

## Why Pipa

| What it does | What that means |
| --- | --- |
| **One server** | In local mode, Pipa starts one private OpenCode server on `127.0.0.1` and reuses it for every Slack turn. Attached servers follow their own network controls. |
| **Thread sessions** | A mention starts a session; replies continue it. On OpenCode v2, messages steer native work and later background responses return to the same Slack thread. |
| **Routines** | Schedule timezone-aware work that runs through the same agent and delivers to an exact channel or thread. |
| **Generated files** | In local mode, long work returns as a concise summary with generated files from a private per-turn directory. Attached non-loopback servers return inline text. |
| **Access control** | Restrict by Slack channel, human user, and bot. Allowlists are rechecked on every turn, interaction, and delivery. |
| **Restart** | `pipa restart` hands off to a detached worker and reports a durable status. |

If Pipa is useful, [star the repo](https://github.com/lunchpaillola/pipa).

## Quickstart

**Runs on** macOS, Linux, and Windows. **Requires** Node.js 22 or newer, [OpenCode](https://opencode.ai) installed and authenticated, and a Slack workspace where you can create an app.

```sh
npm install --global @usepipa/pipa
pipa init
pipa start
```

`pipa init` creates the Slack app manifest, opens the install flow, and saves the profile under `~/.pipa`. Invite Pipa to a channel and mention it. The [3-minute setup video](https://www.youtube.com/watch?v=rlTMdkPWPcA) shows the flow, and the [OpenCode Slack integration guide](https://www.usepipa.com/opencode-slack?utm_source=github&utm_medium=repo_readme&utm_campaign=signup&utm_content=readme_install_guide) is the current written path.

### Opt-in 0.6 beta

`0.6.0-beta.3` is being prepared for controlled testing on npm's `beta` channel, not stable release.
Once published, opt in with:

```sh
npm install --global @usepipa/pipa@0.6.0-beta.3
```

Normal installs keep using npm's `latest` tag; subsequent betas use `@beta`.
This updates Pipa only, not OpenCode. For an existing installation, arrange a
maintenance window, stop Pipa and back up its profile before installing. Keep
your current OpenCode version initially; do not rerun `pipa init` or create a
second listener. See the [beta release notes](https://github.com/lunchpaillola/pipa/blob/main/docs/beta-release.md)
for changes, limitations, and trial/rollback guidance.

## Security model

In local mode, Pipa runs on your machine, not behind a relay. The local OpenCode server binds to `127.0.0.1` on an operating-system-assigned port; attached servers follow their own network controls. Slack access is limited by channel, user, and bot allowlists, rechecked on every turn. Tokens stay in the local profile with private file permissions, and OpenCode manages provider credentials.

Read [SECURITY.md](SECURITY.md) for the full model and reporting path.

## Pipa Managed

Want Lunch Pail Labs to configure, run, and manage agent workflows for your company? Check out [Pipa Managed](https://usepipa.com/managed?utm_source=github&utm_medium=repo_readme&utm_campaign=signup&utm_content=readme_footer). We set up a Slack-native operations agent for your team, then keep the workflows running.

## Local Socket Mode

Profiles created by `pipa init` use Socket Mode. Profiles written before mode support continue to load as Socket Mode.

### Requirements

- Node.js 22 or newer
- [OpenCode](https://opencode.ai) installed and authenticated; the dual-adapter candidate selects native v1/v2 automatically (current native v2 qualification target: 2.2.5; historical v2 pin: 2.0.29; v1 pins: 1.18.35, 1.19.0; release-qualified minimums pending)
- A Slack workspace where you can create an app

Invite the Slack app only to channels whose members may use the OpenCode profile's full access. The configured directory is a starting location, not a sandbox. In v2, native session moves (including into external worktrees) keep the same Slack conversation, replies and pending approvals. Artifact delivery remains restricted to the original private artifact directory.

See [OpenCode compatibility](docs/opencode-compatibility.md) for remaining-on-v1 and deliberate-v2 upgrade paths, matched-snapshot rollback, capability differences and remaining release gates. Upgrading Pipa preserves the existing Slack profile; it does not require recreating the Slack app or upgrading OpenCode.

### Install

1. Install Pipa:

```sh
npm install --global @usepipa/pipa
```

2. From the folder where you want Pipa to work, run:

```sh
pipa init
```

`pipa init` guides you through creating and installing the Slack app and saving its local configuration. The generated manifest includes `channels:read`, `assistant:write`, and `commands`, plus a slash command derived from your configured bot name (`Chopper` gets `/chopper`) and a `/pipa` compatibility alias. For `Pipa`, these are the same command and appear only once. Review the alias collision guidance below before installing multiple apps in one workspace. Known missing scopes produce upgrade guidance without blocking startup.

3. Start Pipa:

```sh
pipa start
```

Keep `pipa start` running, invite Pipa to a trusted public or private Slack channel, and mention it there. In owned local mode, Pipa starts one OpenCode server bound to `127.0.0.1` on an operating-system-assigned port and reuses it for every Slack thread. Port `0` asks the operating system for an available port; no port configuration is required. Follow-up messages reuse the same OpenCode session without another mention. On v2, they enter OpenCode's native steering queue without Pipa cancelling the current execution. V1 retains its interrupt-and-replace behavior. Different threads remain independent.

For v2, Pipa keeps following live native session events after the first reply. The agent can say a render is running, resume when it finishes, and send the result into the same Slack thread without another message from you. Replies missed during a disconnect or restart are not recovered. Restarting preserves the conversation mapping, but background forwarding starts again only when you send another message in that thread. Pipa does not scan response history or maintain a second execution or delivery journal. Failed Slack deliveries are reported when possible, not replayed; later live replies can still arrive.

Ordinary startup detects OpenCode v1/v2 and waits for listening, workspace readiness and Slack initialization without a default overall timeout or migration-status gate. OpenCode owns schema/data upgrades; Pipa never converts that data. Ctrl+C cancels startup and stops owned children, never attached servers. See the [startup contract](docs/opencode-compatibility.md#startup-contract) for retry, failure and explicit-deadline behavior.

**Managed external-client upgrade notice:** Before upgrading a Managed profile used by external OpenCode clients, set a shared explicit `OPENCODE_SERVER_PASSWORD` in the Pipa server/restart launch environment and configure that password in every external client. For v2, `OPENCODE_PASSWORD` takes precedence; match it to the shared password or remove conflicting values from the server/restart and client environments. If no explicit password is set, Pipa generates a private per-launch password unavailable to external clients, and unauthenticated clients no longer connect. Keep generated passwords private; use an explicit shared password for external access. See [OpenCode compatibility](docs/opencode-compatibility.md).

Pipa keeps naturally short answers inline. For deeper work, OpenCode can return a concise summary with generated files. Files are read only from a private session directory under `.pipa/artifacts` in the configured working directory and validated against the existing path, type, identity, count, and size limits. V2 keeps that directory available for later background responses; v1 clears it around each turn. If file delivery fails, Pipa retries the declaration-free summary without the files. Attached OpenCode servers on non-loopback hosts use inline text fallback instead of local artifact delivery.

Incoming messages can include up to Slack's 10-file limit, with a maximum size of 10 MiB (10,485,760 bytes) per file. Pipa checks both declared size and downloaded bytes before sending the prompt. Attachments require a text prompt and are copied to a temporary directory only for the duration of the turn. Outgoing artifact limits remain 10 files and 100 MB per file or response.

For owned OpenCode v2 servers, Pipa defaults `BUN_JSC_maxRegExpStackSize` to `536870912` (a 512 MiB on-demand regular-expression stack ceiling), preserving any explicit override. This works around native 2.0.29 rejecting valid large base64 attachments. An independently launched attached v2 server needs the same setting in **its server process**, for example `BUN_JSC_maxRegExpStackSize=536870912 opencode serve`; setting it only on the attaching Pipa client cannot configure that server. The model's context/media capabilities still determine which admitted files it can process.

### Native v2 session context

Slack routing and attachment guidance live in a stable native session instruction entry. They remain available when background work resumes; Pipa no longer installs and removes temporary instructions around each response. Restart instructions are not repeated in every turn—an agent can use `pipa restart` and its CLI help like any other command.

Pipa no longer reads or writes `~/.pipa/opencode-recovery.json`, rejects native activity as a competing writer, or blocks unrelated threads after one session fails. Old journal files are left untouched. Existing Slack-to-session mappings are preserved.

### Access control

By default Pipa answers any human user who mentions it in a channel it can see, excluding DMs and external channels. In a shared workspace, restrict who can use it by listing the allowed Slack channel and user IDs. `pipa init` asks for these, and they are stored in the config:

```json
{
  "botName": "Pipa",
  "workingDirectory": "/work",
  "slackAppToken": "xapp-...",
  "slackBotToken": "xoxb-...",
  "allowedSlackChannelIds": ["C0BSE2JTYPR"],
  "allowedSlackUserIds": ["UFWBSCZ54"],
  "allowedSlackBotIds": ["B0C6Q27E82X"]
}
```

A human user's mention is only handled when the channel and user pass their respective allowlists. An absent or empty `allowedSlackChannelIds` allows any otherwise eligible channel; an absent or empty `allowedSlackUserIds` allows any human user. You can also set them non-interactively during setup with `PIPA_ALLOWED_CHANNEL_IDS` and `PIPA_ALLOWED_USER_IDS` (comma-separated).

By default Pipa ignores messages sent by other Slack apps. Unlike the human user and channel lists, an absent or empty `allowedSlackBotIds` disables all other bots. List their bot IDs to let those messages through; an allowed bot only needs its bot ID (e.g. `B0C6Q27E82X`), not an entry in `allowedSlackUserIds`. Bots still must pass the channel allowlist. Bots not on the list stay ignored even when `allowedSlackUserIds` is empty. Set it non-interactively during setup with `PIPA_ALLOWED_BOT_IDS` (comma-separated).

#### Mention-only mode

By default, once Pipa is mentioned in a thread it subscribes to that thread and answers every later message in it without another mention. Set `mentionOnly` to `true` to require a direct @-mention for every turn, including in threads Pipa is already in:

```json
{
  "mentionOnly": true
}
```

`pipa init` asks for this, and you can set it non-interactively with `PIPA_MENTION_ONLY` (`1`, `true`, or `yes`). An absent or `false` value keeps the default thread-following behavior. Routines are unaffected.

#### Find the sender's bot ID

Use the message event's `bot_id` (`B…`), not the app ID (`A…`) or bot user ID (`U…`). To look up the sender app's OAuth bot ID:

1. Open the **sender app** at [Slack Apps](https://api.slack.com/apps), not Pipa's app.
2. Under **OAuth & Permissions**, copy its **Bot User OAuth Token** (`xoxb-…`). If needed, install the app in the workspace via **Install App** first.
3. Set that token locally in `SLACK_SENDER_BOT_TOKEN`, then call [Slack `auth.test`](https://docs.slack.dev/reference/methods/auth.test/):

```sh
curl --silent --show-error --request POST \
  --header "Authorization: Bearer ${SLACK_SENDER_BOT_TOKEN}" \
  https://slack.com/api/auth.test
```

No Slack CLI is needed. Keep the token out of config examples, shared output, and commits. A successful response includes fields like:

```json
{
  "ok": true,
  "user_id": "U0123456789",
  "bot_id": "B0123456789"
}
```

Use `bot_id` (`B0123456789`) in `allowedSlackBotIds`; `user_id` identifies the bot's user account and is not the bot allowlist ID.

**Incoming webhooks:** the posted message's `bot_id` can differ from the sender app's OAuth `bot_id` returned by `auth.test`. Allow the actual incoming message/event's `bot_id`. If you do not have the event payload, find the posted message with [Slack `conversations.history`](https://docs.slack.dev/reference/methods/conversations.history/) (or [`conversations.replies`](https://docs.slack.dev/reference/methods/conversations.replies/) for a thread reply), using a token with access to that conversation and the required history scope, and read its `bot_id`.

After saving the config, restart Pipa to load the updated allowlist. The allowed bot can start a conversation by posting `<@PIPA_BOT_USER_ID> triage this alert` in an allowed channel, or continue one by replying in a thread Pipa has subscribed to. For an incoming webhook, send that mention in the payload's `text` field. Allowlisting a bot does not make Pipa handle every message it posts in the channel; the normal mention/thread routing still applies. Only allow bots whose messages you trust as requests to your agent.

To use an existing OpenCode server instead, set its URL before starting Pipa. Pipa checks that the server can serve the configured workspace but does not start or stop it. If the server uses authentication, also set `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`:

```sh
export PIPA_OPENCODE_ATTACH_URL=http://localhost:5555
pipa start
```

### Choosing a model

Type your installation's command followed by `model` in an allowed Slack channel: `/chopper model` for `Chopper`, `/pipwick model` for `Pipwick`, or the `/pipa model` compatibility alias when registered to that app. Both forms use the same private native modal, authorization checks, and setting. A loading window opens before catalog discovery, then becomes a searchable picker. Search by model name, ID or provider, choose a model, and Save. Save closes the window promptly; a private channel message confirms success only after fresh validation and persistence, or explains a failure. Wait for that confirmation before testing the new selection. Cancel leaves the setting unchanged. Existing channel and human-user allowlists are rechecked after discovery, on each search, on Save, during persistence, and before delivering the private result.

The command is computed from your configured `botName`, not a hardcoded list of bot names. Pipa decomposes accented Latin characters, removes combining marks, lowercases the name, replaces runs of spaces/punctuation/other non-ASCII characters with `-`, trims edge hyphens, and limits the part after `/` to 31 characters (trimming any resulting trailing hyphen). For example, `Workshop "Bot"` becomes `/workshop-bot` and `Café 🧪` becomes `/cafe`. A valid display name with no usable ASCII slug, such as `🤖` or `東京`, falls back to `/pipa` so this optional feature cannot prevent an old profile from starting. Existing display-name validation still applies. Generated commands use a conservative lowercase-letter/digit/hyphen subset within Slack's 32-character limit including `/`.

**Alias collision:** [Slack slash commands are not namespaced](https://docs.slack.dev/interactivity/implementing-slash-commands/#naming_your_command). If multiple apps register `/pipa`, Slack routes it to the most recently installed app; Pipa cannot redirect it to another installation. In a multi-app workspace, keep distinct named commands and omit the generic alias from other apps' Slack manifests, or assign `/pipa` to exactly one app. Fallback-only installations also share `/pipa`; use a name with an ASCII slug if you need a distinct command. Check the installation name shown in the modal before saving. Case, punctuation, or truncation can also make different names normalize identically; choose distinct resulting names.

The default for new threads is stored as optional `defaultModel: { "providerID": "openai", "modelID": "your-model-id" }` in the existing `.pipa/config.json`. It takes effect without restarting Pipa. Existing threads keep the model recorded in their OpenCode conversation history, including across restarts, so different threads can use different models. New or empty sessions use the current default; when unset, OpenCode chooses its default. If a saved OpenCode session is no longer available, its replacement is a new session and uses the current default. This setting does not select models for separate subagents or external clients.

New routines snapshot the selection when created; preview JSON shows that snapshot. Existing routines and their saved model are unchanged by later saves or routine edits. A routine with no saved model uses OpenCode's default, never the current installation setting. Human replies to routine results retain the model recorded in that conversation. If a thread's provider stops working, reconnect it in OpenCode and retry in that thread. To use another provider in v2, change that session's model in OpenCode; changing Pipa's default affects only new threads. An invalid unused default does not block existing conversations or access checks; it must be repaired before a new session can use it.

The picker loads the configured OpenCode model catalog once per window. V2 discovery has no Pipa-added deadline; legacy v1 keeps its 30-second catalog limit after server readiness. Closing the window cancels pending discovery. Searches and Save use that window's cached choices without contacting OpenCode again. Slack displays up to 100 matches at a time; type more specific terms to find models anywhere in a large catalog. Search is case-insensitive and matches all entered terms across model names, IDs and providers. The saved model remains selected even when it is outside the first 100 results. Empty catalogs get a private explanation. Save still rechecks current authorization before persisting. A listed model may later become unavailable or lack credentials or quota; OpenCode decides whether it can execute, and saving never runs inference to check it. The provider shown beneath each result identifies the connection: `opencode` and `openai` use separate credentials, even for similarly named models. Abandoned pickers expire after 30 minutes; reopen your installation's model command to continue.

Native v2 execution failures return OpenCode's own message text instead of Pipa-authored provider guidance. Pipa adds no new sanitization layer and does not serialize attached response bodies or stacks into Slack. Existing Slack-token protection remains unchanged, and Pipa never silently switches models.

Model-window failures show the original error message with the existing Slack-token redaction. Error bodies and stacks are not included. Opening the picker does not change the saved model.

### Upgrading an existing installation

**An npm upgrade updates local code only. It does not update the installed Slack app, register commands, or grant scopes.** Existing mentions and thread replies still work without model-command registration. Do not rerun `pipa init` or replace credentials to add this feature.

To upgrade to `0.5.6`, use the same `PIPA_HOME` as your existing installation (leave it unset for the default `~/.pipa` profile):

```sh
npm install --global @usepipa/pipa@0.5.6
pipa --version
pipa manifest > "$HOME/pipa-slack-manifest-0.5.6.json"
```

`pipa manifest` reads the existing profile and prints the current **local template** without tokens. It does not write config, sessions, routines, or the cached manifest, call Slack, or run inference. It is not an export of your app's current remote/custom configuration.

1. Open your **existing app** in [Slack App Management](https://api.slack.com/apps). Keep a copy of its current remote manifest.
2. In **App Manifest**, merge the generated `features.slash_commands` entries you want (the named command and optionally `/pipa`) and add `commands` to `oauth_config.scopes.bot`. Preserve unrelated remote settings, existing commands, scopes, Socket Mode, and interactivity. **Do not replace a customized remote manifest wholesale with the local template.** Alternatively, add the matching commands under **Slash Commands** and add the bot scope under **OAuth & Permissions**.
3. Save, then reinstall or reauthorize that same app. Retain your current tokens unless Slack rotates them; if it does, update the existing local config securely rather than reinitializing the profile.
4. Restart the same profile to load the upgraded runtime:

```sh
pipa restart
pipa restart --status
```

Restart reports **requested** first; inspect status for completion. Then try `/chopper model` (for configured `Chopper`) and `/pipa model` if the alias is registered to that app. Merely recognizing an alias in Pipa cannot bypass missing Slack registration. A known missing `commands` scope produces a warning at startup; scope metadata alone cannot verify command registration, and an absent warning does not prove it is installed.

Before npm publication, preview the feature branch from this repo without reinstalling or reinitializing your profile:

```sh
npm ci
node bin/pipa.mjs --version
node bin/pipa.mjs manifest > "$HOME/pipa-slack-manifest-preview.json"
```

For running the unpublished branch, use the separate test app/profile procedure in `CONTRIBUTING.md`; do not start a second Socket listener with a running installation's credentials. Renaming an app/bot in Slack alone does not update command registration or Pipa's local `botName`. A local name change needs matching Slack registration and an installation restart.

### Routines

Local Pipa can save timezone-aware work that runs through the same OpenCode agent and delivers to one exact Slack channel or existing thread. Replies to a routine result continue the OpenCode session that produced it. Routines use the configured working directory, tools, permissions, channel allowlist, and responder allowlist.

Preview agent-assisted changes first, inspect the normalized JSON, then create only after confirmation:

```sh
pipa routine create \
  --prompt "Send the daily brief" \
  --timezone America/New_York \
  --channel C0BSE2JTYPR \
  --every 1d \
  --times 05:00 \
  --preview \
  --json
```

Remove `--preview` to save the routine. Use `--prompt-file` when exact multiline text or shell-like characters must be preserved. Explicit prompt files can be outside the configured starting folder and can use ordinary symlinks; relative paths still resolve from that starting folder. This does not widen generated-file publication. Timezones must be IANA names such as `America/New_York` or `UTC`; aliases such as `EST` are not accepted.

Supported schedules:

```sh
# Every 30 minutes
pipa routine create --prompt "Check the queue" --timezone UTC --channel C0BSE2JTYPR --every 30m

# Once, five minutes from the CLI clock
pipa routine create --prompt "Follow up" --timezone UTC --channel C0BSE2JTYPR --in 5m

# Tuesday, Thursday, and Saturday at three local times
pipa routine create --prompt "Post status" --timezone America/New_York --channel C0BSE2JTYPR --every 1w --weekdays 2,4,6 --times 09:00,15:00,18:00

# Daily through the inclusive local date September 5
pipa routine create --prompt "Evening close" --timezone America/New_York --channel C0BSE2JTYPR --every 1d --times 19:00 --until 2030-09-05
```

Use `pipa routine list`, `show`, `edit`, `run`, and `delete` for the lifecycle. Deactivate or reactivate with `edit --status inactive|active`. Completed one-time and final recurring routines remain inspectable until deleted. `routine run` requests one execution without changing the saved schedule or status.

Routines run only while the Socket Mode `pipa start` process is running and the machine is awake. Restart skips missed scheduled occurrences instead of backfilling them. Explicit run requests survive restart, but can repeat if the process crashes after agent side effects or Slack delivery and before completion is saved. Managed profiles do not execute routines. Run `pipa routine --help` for the complete syntax and JSON contract.

### Restarting Pipa

Ask Pipa to restart, or run:

```sh
pipa restart
pipa restart --status
```

Anyone allowed by the existing Slack user and channel controls can request a restart; there is no separate restart approval. The first command reports **requested**, not completed. The read-only status command shows the latest request ID, state (`requested`, `running`, `completed`, `failed`, or `unconfirmed`), phase, and any failure guidance. An expired handoff is unconfirmed, never assumed successful. Private records under `.pipa/restarts` remain available after the initiating turn exits.

The running Pipa launches a detached worker before stopping intake, cleaning up, and releasing its instance lock. The worker waits for the original process and lock to disappear, then starts a detached replacement and confirms workspace readiness (and Slack readiness for Socket Mode). The replacement continues in the background without terminal output; use `pipa stop` to stop it. This works for Socket and Managed profiles on supported macOS, Linux, and Windows systems. Attached OpenCode servers remain externally owned and are never stopped by Pipa.

On Windows, `pipa stop` forcibly terminates Pipa's owned process tree and clears only its unchanged instance lock after exit. It can interrupt active work; `pipa restart` uses the cooperative restart handoff instead.

When a restart is requested from Slack, the bot reports that it is restarting and posts to the same thread after the replacement is ready. A manual stop instead reports that the bot will not respond until it starts again.

Do not chain `pipa stop` and `pipa start` inside an agent turn: stopping owned OpenCode also kills that turn. OpenCode's `/instance/dispose` disposes an instance; it does not restart the server.

Commands must use the same `PIPA_HOME` (the parent of `.pipa`) as the running profile. Pipa passes the resolved absolute home to its owned OpenCode and restart processes. With an attached server, ensure the agent's command environment uses that home; a remote server needs command access to the Pipa host. An older running Pipa needs one manual stop/start after upgrading. If status reports failure or an unconfirmed handoff, inspect the reported phase and current instance before attempting a manual start.

## Commands

```text
pipa init       Configure Slack and the local working directory
pipa start      Start the configured Slack runtime
pipa stop       Stop the running local Pipa process
pipa restart [--channel <id> [--thread <ts>]]  Request a detached restart
pipa restart --status  Inspect the latest durable restart outcome
pipa routine    Create and manage local scheduled routines
pipa manifest   Print the current local Slack manifest template for an existing profile
pipa --version  Print the installed version
```

## Development

```sh
npm ci
npm test
npm run test:pack
```

`npm run test:slack:routines` is a manual real-service smoke test. `npm run test:slack:release -- --plan` lists the shared live gates without contacting Slack. The opt-in `--run` collector requires an isolated running Socket candidate and private inputs from `.env.example`; see the testing guide. Human/client and integration evidence remain separate mandatory gates.

See the [testing strategy](docs/pipa-testing.md) for repeatable real-runtime and Slack validation, existing-app reuse, evidence, and cleanup.

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

See the [repository overview](docs/repository-overview.md) for a file-by-file explanation of how Pipa works.

## Releases

Pipa follows [Semantic Versioning](https://semver.org/). Release notes are published on [GitHub Releases](https://github.com/lunchpaillola/pipa/releases).

## License

Licensed under the [Apache License 2.0](LICENSE).
