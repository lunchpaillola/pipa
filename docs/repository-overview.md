# Repository overview

Pipa is a Node.js command-line application with Socket and Managed profile modes. Socket Mode connects Slack to one persistent private `opencode serve` process, or to an explicitly configured existing server. Managed mode owns one persistent `opencode serve` child without connecting to Slack. Configuration and Socket Mode session IDs are stored under `~/.pipa`.

## Request flow

1. `bin/pipa.mjs` handles `pipa init` or `pipa start`, loads the profile, and selects Socket or Managed mode.
2. During initialization, `src/app.mjs` validates OpenCode and Slack credentials, then `src/state.mjs` saves the configuration and generated Slack manifest under `~/.pipa`.
3. During Socket Mode startup, `src/app.mjs` health-checks `PIPA_OPENCODE_ATTACH_URL` or starts one owned OpenCode server on loopback port `0`, then creates the Slack connection and restores previously subscribed Slack threads from `~/.pipa/sessions.json`. During Managed startup, `src/opencode.mjs` starts one `opencode serve` child with the profile's working directory, hostname, and port.
4. A mention or thread reply, including any attachments, is queued per Slack thread. Different threads can run concurrently, but messages in one thread run in order.
5. `src/opencode.mjs` downloads attachments through Chat SDK into a temporary directory, sends the prompt, Slack context, and native file parts through OpenCode's session API, and polls authoritative status and message endpoints until completion. It removes temporary files after terminal state and returns the final assistant text and session ID.
6. `src/app.mjs` saves the session ID, posts the response back to Slack in safe-sized chunks, and updates the message reaction.

## Files and folders

### `.github/`

GitHub-specific automation.

- `.github/workflows/ci.yml`: Runs continuous integration for every pull request and every push to `main`. GitHub creates one job each for Ubuntu, macOS, and Windows. Each job checks out the repository, installs Node.js 22, installs the exact dependencies from `package-lock.json`, runs the unit and integration tests, then packs and smoke-tests the installable CLI. The operating-system matrix catches platform-specific problems before release.

### `bin/`

The public command-line entry point installed by npm.

- `bin/pipa.mjs`: Implements the `pipa` command. `pipa init` confirms the working directory, opens Slack's app-manifest setup, reads tokens without displaying them, and calls `initializePipa`. `pipa start` takes a single-instance lock, loads the profile once, and starts either the existing Slack application or the Managed OpenCode server. It forwards `SIGINT` and `SIGTERM` before releasing the lock. `pipa --version` reads the version from `package.json`.

### `docs/`

Long-form repository documentation.

- `docs/repository-overview.md`: This file. It explains the repository structure and how the application works.

### `scripts/`

Repository maintenance and release checks that are not part of the installed runtime.

- `scripts/pack-smoke.mjs`: Tests the package users will actually receive. It packs and installs the archive in a temporary directory, verifies version, Local initialization, and cancellation, then starts a Managed profile with a fake OpenCode executable that checks arguments, working directory, and inherited environment without Slack credentials. It removes the temporary artifact when finished.

### `src/`

The application implementation.

- `src/app.mjs`: Coordinates Slack, OpenCode, and persisted sessions. `initializePipa` validates input and credentials before saving configuration. `startPipa` creates the Slack adapter, restores thread subscriptions, filters unsupported messages, enforces the 100 MB per-file limit, sends prompts and attachment descriptors to OpenCode, posts responses, shows progress reactions, and handles startup and shutdown timeouts. `createConversationRunner` serializes work within each thread while allowing separate threads to run concurrently.
- `src/opencode.mjs`: Owns OpenCode server selection, the native session HTTP client, and child-process boundaries. Socket Mode health-checks an explicit attached server without owning it, or starts one private loopback server on an ephemeral port. Managed mode starts the configured server-only profile. Both owned modes inherit the runtime environment except Slack credentials. The module also handles attachment staging, status/message reconciliation, timeouts, exit propagation, and child termination. Windows process termination uses `taskkill` so descendant processes are also stopped.
- `src/state.mjs`: Owns local state and the Slack app manifest. It defaults profiles without `slackMode` to `socket`, validates shared and mode-specific fields, writes private JSON files atomically, loads sessions, serializes session writes, and uses a lock file to prevent two Pipa instances from controlling the same local state.

### `test/`

Tests run by Node's built-in test runner through `npm test`.

- `test/app.test.mjs`: Tests application orchestration: safe initialization, Slack token error handling, per-thread queueing, session continuity, attachment routing and limits, Slack filtering and delivery, reactions, secret redaction, chunked responses, and startup and shutdown cleanup.
- `test/opencode.test.mjs`: Tests owned and attached server selection, authentication, native session completion, stale-session recovery, attachment cleanup, secret removal, timeout behavior, and cross-platform child lifecycle.
- `test/state.test.mjs`: Tests state management: Socket and Managed profile validation, Slack manifest generation, private file permissions, separate configuration and session storage, malformed state errors, recovery after failed writes, and single-instance locking.

### Root files

- `.gitignore`: Keeps generated dependencies, package archives, local environment variables, macOS metadata, and local OpenCode state out of Git.
- `CONTRIBUTING.md`: Gives contributors the supported Node.js version, local verification commands, and expectations for focused changes and secret handling.
- `LICENSE`: Contains the Apache License 2.0 terms under which Pipa is distributed.
- `package-lock.json`: Locks the full npm dependency graph to exact versions so local development and CI install the same packages.
- `package.json`: Defines package metadata, the `pipa` executable, published files, npm scripts, supported Node.js version, dependencies, repository links, and license identifier.
- `README.md`: Provides the user-facing product description, requirements, installation and usage instructions, command reference, development commands, release policy, and license link.
