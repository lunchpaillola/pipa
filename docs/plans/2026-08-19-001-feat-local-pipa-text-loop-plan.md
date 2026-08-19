---
title: "feat: Ship text-complete Local Pipa"
status: completed
date: 2026-08-19
origin: https://linear.app/lunchpaillabs/document/implementation-plan-local-first-pipa-core-971f47d85312
---

# Text-Complete Local Pipa

## Problem Frame

Ship the first useful local-only Pipa slice: one Node 22 CLI configures a Slack Socket Mode app, sends mentions and subscribed thread replies to the user's installed OpenCode CLI, and posts results back to the source thread. It must need no hosted relay, database, public endpoint, billing, sandbox, or Managed Pipa changes.

## Requirements

- Expose `pipa init`, `pipa start`, and `pipa --version` from one installable npm package.
- Pin `chat`, `@chat-adapter/slack`, and `@chat-adapter/state-memory` exactly to `4.38.1`.
- Accept a mention immediately and queue same-thread follow-ups behind active work without a busy rejection; allow different threads to overlap.
- Persist only Slack conversation key to OpenCode session ID and restore subscribed threads after restart.
- Invoke stable OpenCode v1 with an argument array, preserve assistant text and session ID, and remove Slack credentials from the child environment.
- Support macOS, Linux, and Windows through platform-aware command resolution and CI.
- Preserve the approved Slack manifest, replacing `Pippette` with the selected name and adding `message.channels` and `message.groups` beside `app_mention`.

## Scope Boundaries

PR 1 is text-only. Files, DMs, interactive questions, user allowlists, SQLite, generic queue infrastructure, retries, daemons, schedulers, multiple working directories, pending-work recovery, a public Core API, and Managed Pipa changes are deferred.

## Key Decisions

- Plain JavaScript ESM on Node 22, Node's test runner, and no build step or CLI framework.
- One removable Promise tail per Slack conversation rather than a queue service.
- Atomic JSON state under `~/.pipa`; OpenCode remains the conversation-history source of truth.
- Chat SDK memory state is rehydrated from persisted conversation keys after restart.
- The OpenCode child inherits the user's normal environment except Pipa's Slack token variables.

## Output Structure

```text
bin/pipa.mjs
src/app.mjs
src/opencode.mjs
src/state.mjs
test/app.test.mjs
test/opencode.test.mjs
test/state.test.mjs
.github/workflows/ci.yml
package.json
README.md
LICENSE
```

## Implementation Units

### U1. Package, CLI, and setup

**Goal:** Install the package and write a validated local configuration.

**Dependencies:** None.

**Files:** `package.json`, `package-lock.json`, `bin/pipa.mjs`, `src/app.mjs`, `src/state.mjs`, `test/app.test.mjs`, `test/state.test.mjs`, `README.md`, `LICENSE`

**Approach:** Implement the three CLI commands directly. `init` collects bot name, canonical working directory, app token, and bot token; validates the directory, installed OpenCode, and Slack `auth.test`; then atomically replaces config. Generate the approved manifest without trimming future capabilities.

**Patterns to follow:** `apps/pipa-chat-gateway/prototypes/public-pipa-cli.ts` and the approved Slack manifest in the source discussion.

**Test scenarios:**

- Valid inputs produce a private config and parseable manifest with the selected name and all approved scopes, features, and events.
- Invalid cwd, missing OpenCode, or rejected bot token leaves existing config unchanged.
- CLI output and errors never include Slack tokens.
- `--version` reports the package version.

**Verification:** A packed artifact installs in an empty directory and completes setup without a source checkout.

### U2. OpenCode turn and persistent routing

**Goal:** Run and continue text conversations through installed OpenCode.

**Dependencies:** U1.

**Files:** `src/opencode.mjs`, `src/app.mjs`, `src/state.mjs`, `test/opencode.test.mjs`, `test/state.test.mjs`

**Approach:** Spawn `opencode run --format json --dir <cwd> [--session <id>] -- <prompt>` without a shell. Parse assistant text and the returned session ID defensively. Persist the mapping before releasing the conversation tail. Fail once, release the tail, and do not retry.

**Patterns to follow:** `apps/local-slack-opencode/src/index.mjs` and the Promise-tail pattern in `apps/pipa-chat-gateway/src/local-cloud-service.ts`.

**Test scenarios:**

- A first turn saves its session ID and a follow-up passes it back with literal shell metacharacters.
- Same-conversation follow-ups execute in arrival order; different conversations overlap.
- A failed turn releases the tail and is not retried.
- Restart reloads the stored mapping.
- Slack tokens are absent from the child environment and Windows command resolution is supported.

**Verification:** Direct fake-OpenCode turns continue across a fresh process and all focused tests pass.

### U3. Slack Socket Mode composition

**Goal:** Route Slack mentions and subscribed replies through U2 and back to the correct thread.

**Dependencies:** U1, U2.

**Files:** `src/app.mjs`, `src/state.mjs`, `test/app.test.mjs`, `.github/workflows/ci.yml`, `README.md`

**Approach:** Compose Chat SDK 4.38.1 Slack and memory adapters in Socket Mode with concurrent delivery. Register mention and subscribed-message handlers before initialization. Subscribe on mention, restore subscriptions from persisted keys, ignore bot/unsupported/DM/Slack Connect traffic, and shut down Chat plus active direct children gracefully.

**Patterns to follow:** Mention and subscribed-message routing in `apps/pipa-chat-gateway/src/bot.ts`.

**Test scenarios:**

- A mention subscribes once and posts exactly one result to its source thread.
- An unmentioned follow-up routes to the same OpenCode conversation, including while a prior turn is active.
- Restart restores the subscription and session mapping.
- Bot, unsupported subtype, DM, and Slack Connect messages do not execute.
- Shutdown disconnects Chat and terminates active direct children on supported platforms.
- Ubuntu, macOS, and Windows CI install the packed package and pass tests.

**Verification:** Automated tests pass and one real Slack nonce demo proves mention, active-run follow-up, threaded delivery, restart, and continuation without any hosted Pipa call.

## Risks

- Chat SDK test seams may differ from Managed's older version; test against the exact pinned API rather than copying old constructors blindly.
- Windows `.cmd` resolution and shutdown differ; isolate those differences in the OpenCode launcher and exercise them in Windows CI.
- Channel members effectively receive agent access to the configured local workspace; document that the app belongs only in trusted channels.

## Deferred Follow-Up Work

- PR 2 adds inbound Slack files, eval corpus, clean-install acceptance, and beta publication.
- PR 3 extracts public Core only after Local and Managed are two real consumers, then adopts it in Managed without changing private billing, authorization, execution, or delivery behavior.
