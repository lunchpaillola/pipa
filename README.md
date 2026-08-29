# Pipa

[![CI](https://github.com/lunchpaillola/pipa/actions/workflows/ci.yml/badge.svg)](https://github.com/lunchpaillola/pipa/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Pipa runs Slack through one persistent private OpenCode server with no hosted relay, database, public endpoint, or sandbox.

[View Pipa on GitHub](https://github.com/lunchpaillola/pipa). If it is useful, star the repo so more people can find it.

**Pipa is in early preview. Features may break unintentionally, and CLI commands, configuration, and Slack behavior may continue to change.**

## Pipa Managed

Want someone to configure, run, and manage agent workflows for your company? Check out [Pipa Managed](https://usepipa.com/managed). We set up a Slack-native operations agent around how your team works, then keep its workflows running and improving over time.

## Local Socket Mode

Profiles created by `pipa init` use Socket Mode. Profiles written before mode support continue to load as Socket Mode.

### Requirements

- Node.js 22 or newer
- [OpenCode](https://opencode.ai) installed and authenticated
- A Slack workspace where you can create an app

Invite the Slack app only to channels whose members may use OpenCode in the configured working directory.

### Install

1. Install Pipa:

```sh
npm install --global @usepipa/pipa
```

2. From the folder where you want Pipa to work, run:

```sh
pipa init
```

`pipa init` guides you through creating and installing the Slack app and saving its local configuration. The generated manifest includes `channels:read` and `assistant:write`. If an existing installation has not granted a recommended scope, `pipa init` and `pipa start` print reauthorization guidance but continue running.

3. Start Pipa:

```sh
pipa start
```

Keep `pipa start` running, invite Pipa to a trusted public or private Slack channel, and mention it there. Pipa starts one OpenCode server bound to `127.0.0.1` on an operating-system-assigned port and reuses it for every Slack turn. Port `0` asks the operating system for an available port; no port configuration is required. Pipa replies in a thread, and follow-up messages in that thread reuse the same OpenCode session without another mention. A newer follow-up interrupts an active turn in the same thread, while other threads continue independently. While a turn is active, Pipa shows a typing status in its Slack thread.

Pipa keeps naturally short answers inline. For deeper work, OpenCode can return a concise summary with suitable generated files, such as documents, spreadsheets, PDFs, or images. Files are read only from a private session directory under `.pipa/artifacts` in the configured working directory. The directory is cleared before each turn, files are validated and limited to 10 files and 100 MB per file or response, and the directory is deleted locally after delivery. If file delivery fails, Pipa retries the declaration-free summary without the files. Attached OpenCode servers on non-loopback hosts use inline text fallback instead of local artifact delivery.

Incoming messages can include up to Slack's 10-file limit, with a maximum size of 100 MB per file. Attachments require a text prompt and are copied to a temporary directory only for the duration of the turn.

### Access control

By default Pipa answers anyone who mentions it in a channel it can see. In a shared workspace, restrict who can use it by listing the allowed Slack channel and user IDs. `pipa init` asks for these, and they are stored in the config:

```json
{
  "botName": "Pipa",
  "workingDirectory": "/work",
  "slackAppToken": "xapp-...",
  "slackBotToken": "xoxb-...",
  "allowedSlackChannelIds": ["C0BSE2JTYPR"],
  "allowedSlackUserIds": ["UFWBSCZ54"]
}
```

A mention is only handled when the channel ID is in `allowedSlackChannelIds` **and** the author's user ID is in `allowedSlackUserIds`. Leave a list empty to allow any channel or any user. You can also set them non-interactively during setup with `PIPA_ALLOWED_CHANNEL_IDS` and `PIPA_ALLOWED_USER_IDS` (comma-separated).

To use an existing OpenCode server instead, set its URL before starting Pipa. Pipa health-checks the server but does not start or stop it. If the server uses authentication, also set `OPENCODE_SERVER_USERNAME` and `OPENCODE_SERVER_PASSWORD`:

```sh
export PIPA_OPENCODE_ATTACH_URL=http://localhost:5555
pipa start
```

## Commands

```text
pipa init       Configure Slack and the local working directory
pipa start      Start the configured Slack runtime
pipa --version  Print the installed version
```

## Development

```sh
npm ci
npm test
npm run test:pack
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

See the [repository overview](docs/repository-overview.md) for a file-by-file explanation of how Pipa works.

## Releases

Pipa follows [Semantic Versioning](https://semver.org/). Release notes are published on [GitHub Releases](https://github.com/lunchpaillola/pipa/releases).

## License

Licensed under the [Apache License 2.0](LICENSE).
