# Pipa

[![CI](https://github.com/lunchpaillola/pipa/actions/workflows/ci.yml/badge.svg)](https://github.com/lunchpaillola/pipa/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

Pipa runs OpenCode in one of two profile modes: local Slack Socket Mode or a Managed OpenCode server. Local mode uses no hosted relay, database, public endpoint, or sandbox.

**Pipa is in early preview. Features may break unintentionally, and CLI commands, configuration, and Slack behavior may continue to change.**

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

`pipa init` guides you through creating and installing the Slack app and saving its local configuration.

3. Start Pipa:

```sh
pipa start
```

Keep `pipa start` running, invite Pipa to a trusted public or private Slack channel, and mention it there. Pipa replies in a thread, and follow-up messages in that thread do not need another mention. Messages can include up to Slack's 10-file limit, with a maximum size of 100 MB per file. Attachments require a text prompt and are copied to a temporary directory only for the duration of the turn.

To use an existing OpenCode server instead of starting standalone OpenCode runs, set its URL before starting Pipa:

```sh
export PIPA_OPENCODE_ATTACH_URL=http://localhost:5555
pipa start
```

## Managed Mode

Managed mode starts exactly one persistent `opencode serve` child and does not connect to Slack or require Slack tokens. Create `~/.pipa/config.json` (or `$PIPA_HOME/.pipa/config.json`) with a private hostname and TCP port:

```json
{
  "botName": "Pipa",
  "workingDirectory": "/workspace",
  "slackMode": "managed",
  "openCodeHostname": "127.0.0.1",
  "openCodePort": 4096
}
```

Then run `pipa start`. The OpenCode child inherits the working process environment, so runtime credentials and service configuration should remain in environment variables rather than the profile. `SIGINT` and `SIGTERM` are forwarded to the child.

## Commands

```text
pipa init       Configure Slack and the local working directory
pipa start      Start the configured Socket or Managed runtime
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
