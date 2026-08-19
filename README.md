# Pipa

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

`pipa init` asks for a bot name and working directory, prints the Slack app manifest, validates OpenCode and the Slack bot token, then stores configuration in `~/.pipa/config.json`. Slack credentials remain local.

In Slack, invite the app to a trusted public or private channel and mention it. Pipa replies in that thread. Later replies in the same thread do not need another mention. The Slack-thread-to-OpenCode-session mapping in `~/.pipa/sessions.json` keeps that conversation connected after Pipa restarts.

## Commands

```text
pipa init       Configure Slack and the local working directory
pipa start      Connect Slack Socket Mode to local OpenCode
pipa --version  Print the installed version
```

Pipa v0.1 is text-only. File handling, DMs, interactive questions, schedulers, and hosted fallback are not included.
