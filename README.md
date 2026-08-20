# Pipa

[![CI](https://github.com/lunchpaillola/pipa/actions/workflows/ci.yml/badge.svg)](https://github.com/lunchpaillola/pipa/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Pipa connects Slack to the OpenCode already installed on your computer. It runs locally: no hosted relay, database, public endpoint, or sandbox is involved.

**Pipa is in early preview. Features may break unintentionally, and CLI commands, configuration, and Slack behavior may continue to change.**

## Requirements

- Node.js 22 or newer
- [OpenCode](https://opencode.ai) installed and authenticated
- A Slack workspace where you can create an app

Invite the Slack app only to channels whose members may use OpenCode in the configured working directory.

## Install

1. Install Pipa:

```sh
npm install --global @usepipa/pipa
```

2. From the folder where you want Pipa to work, run:

```sh
pipa init
```

`pipa init` guides you through creating and installing the Slack app and saving its local configuration.

3. Start Pipa:

```sh
pipa start
```

Keep `pipa start` running, invite Pipa to a trusted public or private Slack channel, and mention it there. Pipa replies in a thread, and follow-up messages in that thread do not need another mention.

To use an existing OpenCode server instead of starting standalone OpenCode runs, set its URL before starting Pipa:

```sh
export PIPA_OPENCODE_ATTACH_URL=http://localhost:5555
pipa start
```

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
