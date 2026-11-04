# Security

## Reporting a vulnerability

Do not open a public issue for a security problem. Email [help@lunchpaillabs.com](mailto:help@lunchpaillabs.com) with `Pipa security` in the subject, a description, reproduction steps, and the affected version. We will acknowledge the report and coordinate a fix and disclosure.

## Security model

Pipa is a local runtime. It has no hosted relay, database, public HTTP endpoint, or sandbox.

- The owned local OpenCode server binds to `127.0.0.1` on an operating-system-assigned port.
- Local mode starts and owns that server. An attached non-loopback server is externally owned and returns inline text instead of artifacts.
- Slack access is controlled by channel, human user, and bot allowlists. Every turn, interaction, and delivery rechecks the relevant limits.
- Slack tokens stay in the local profile under `~/.pipa` (or `PIPA_HOME`) with private file permissions. OpenCode manages provider credentials through its own credential store or provider environment variables. Pipa does not add credentials to Slack messages; upstream message text follows the boundary described below.
- Pipa reads generated files only from a private session directory under `.pipa/artifacts` in the configured starting directory. It validates path, type, identity, and size and limits delivery to 10 files and 100 MB. V2 retains that directory for background responses; v1 attempts removal after each turn. Native session moves do not relocate or widen this publication boundary.
- Incoming attachments are copied to a temporary directory for the turn, and Pipa attempts to remove it on every terminal path.
- Native v2 execution failures show OpenCode's message text, without provider-specific rewrites or an additional sanitization layer. OpenCode controls that upstream text; Pipa does not serialize attached response bodies or stacks into Slack messages. Existing Slack-token protection remains in the delivery path.
- Pipa never silently switches models.
- The agent has the permissions of the OpenCode profile. In v2, the configured directory is a starting location, not a sandbox: native clients and agents can move sessions, including outside it. Pipa follows the mapped session and its descendants, never unrelated sessions. Invite the Slack app only to channels whose members may use that profile's full access.

## Supported versions

Security fixes target the latest published minor release. Upgrade with:

```sh
npm install --global @usepipa/pipa@latest
```

## Scope

In scope: token leakage, authorization bypass in Slack routing, path traversal or arbitrary file reads in artifact handling, command injection in the CLI or restart worker, and privilege escalation through the local profile.

Out of scope: the security of your OpenCode provider or model, your Slack workspace configuration, and the permissions you grant the agent in your own working directory.
