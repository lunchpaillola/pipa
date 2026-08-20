# Pipa

[![CI](https://github.com/lunchpaillola/pipa/actions/workflows/ci.yml/badge.svg)](https://github.com/lunchpaillola/pipa/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Pipa connects Slack to the OpenCode already installed on your computer. It runs locally: no hosted relay, database, public endpoint, or sandbox is involved.

## Requirements

- Node.js 22 or newer
- [OpenCode](https://opencode.ai) installed and authenticated
- A Slack workspace where you can create an app

Invite the Slack app only to channels whose members may use OpenCode in the configured working directory.

## Install

```sh
npm install --global @usepipa/pipa
pipa init
pipa start
```

Run `pipa init` from the folder where Pipa should work. It confirms that folder, opens Slack with a pre-filled app manifest, and guides you through creating and installing the app. It validates OpenCode and the Slack bot token before storing configuration in `~/.pipa/config.json`. Slack credentials remain local.

For non-interactive setup, provide `PIPA_BOT_NAME`, `PIPA_SLACK_APP_TOKEN`, and `PIPA_SLACK_BOT_TOKEN` when running `pipa init`.

In Slack, invite the app to a trusted public or private channel and mention it. Pipa replies in that thread. Later replies in the same thread do not need another mention. The Slack-thread-to-OpenCode-session mapping in `~/.pipa/sessions.json` keeps that conversation connected after Pipa restarts.

## Commands

```text
pipa init       Configure Slack and the local working directory
pipa start      Connect Slack Socket Mode to local OpenCode
pipa --version  Print the installed version
```

Pipa v0.1 is text-only. File handling, DMs, interactive questions, schedulers, and hosted fallback are not included.

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
