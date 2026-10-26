# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Email [help@lunchpaillabs.com](mailto:help@lunchpaillabs.com) with `Pipa security` in the subject, a description, reproduction steps, and the affected version. We will acknowledge the report and coordinate a fix and disclosure.

## Security model

Pipa is a local runtime. It does not include a hosted relay, database, public HTTP endpoint, or sandbox.

- The OpenCode server binds to `127.0.0.1` on an operating-system-assigned port.
- Local mode starts and owns that server. An explicitly attached server on a non-loopback host is externally owned and uses inline text fallback for artifacts.
- Slack access is controlled by channel, human user, and bot allowlists. Every turn, interaction, and delivery rechecks the relevant limits.
- Slack tokens and provider credentials stay in the local profile under `~/.pipa` (or `PIPA_HOME`) with private file permissions. They are not posted to Slack.
- Generated files are read only from a private per-turn directory under `.pipa/artifacts` in the configured working directory. Pipa validates path, type, identity, and size, limits delivery to 10 files and 100 MB, and deletes the directory after delivery.
- Incoming attachments are copied to a temporary directory for the duration of the turn and removed on every terminal path.
- Raw upstream errors and credentials are not posted to Slack.
- Pipa never silently switches models.
- The agent has the permissions of the OpenCode profile and the configured working directory. Invite the Slack app only to channels whose members may use that access.

## Supported versions

Security fixes target the latest published minor release. Upgrade with:

```sh
npm install --global @usepipa/pipa@latest
```

## Scope

In scope: token leakage, authorization bypass in Slack routing, path traversal or arbitrary file reads in artifact handling, command injection in the CLI or restart worker, and privilege escalation through the local profile.

Out of scope: the security of your OpenCode provider or model, your Slack workspace configuration, and the permissions you grant the agent in your own working directory.
