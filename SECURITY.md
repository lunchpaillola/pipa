# Security

## Reporting a vulnerability

Do not open a public issue for a security problem. Email [help@lunchpaillabs.com](mailto:help@lunchpaillabs.com) with `Pipa security` in the subject, a description, reproduction steps, and the affected version. We will acknowledge the report and coordinate a fix and disclosure.

## Security model

Pipa is a local runtime. It has no hosted relay, database, public HTTP endpoint, or sandbox.

- The owned local OpenCode server binds to `127.0.0.1` on an operating-system-assigned port.
- Local mode starts and owns that server. An attached non-loopback server is externally owned and returns inline text instead of artifacts.
- Slack access is controlled by channel, human user, and bot allowlists. Every turn, interaction, and delivery rechecks the relevant limits.
- Slack tokens stay in the local profile under `~/.pipa` (or `PIPA_HOME`) with private file permissions. OpenCode manages provider credentials through its own credential store or provider environment variables. Credentials are not posted to Slack.
- Pipa reads generated files only from a private per-turn directory under `.pipa/artifacts` in the configured working directory. It validates path, type, identity, and size, limits delivery to 10 files and 100 MB, and attempts removal after delivery.
- Incoming attachments are copied to a temporary directory for the turn, and Pipa attempts to remove it on every terminal path.
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
