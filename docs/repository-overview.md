# Repository overview

Pipa is a Node.js command-line application that connects Slack to a local OpenCode installation. A Slack message enters through Socket Mode, becomes an `opencode run` command, and returns to the same Slack thread. Configuration and OpenCode session IDs are stored locally in `~/.pipa`.

## Request flow

1. `bin/pipa.mjs` handles `pipa init` or `pipa start`.
2. During initialization, `src/app.mjs` validates OpenCode and Slack credentials, then `src/state.mjs` saves the configuration and generated Slack manifest under `~/.pipa`.
3. During startup, `src/app.mjs` creates the Slack connection and restores previously subscribed Slack threads from `~/.pipa/sessions.json`.
4. A mention or thread reply is queued per Slack thread. Different threads can run concurrently, but messages in one thread run in order.
5. `src/opencode.mjs` starts `opencode run`, passes the Slack context, parses OpenCode's JSON event stream, and returns the final assistant text and session ID.
6. `src/app.mjs` saves the session ID, posts the response back to Slack in safe-sized chunks, and updates the message reaction.

## Files and folders

### `.github/`

GitHub-specific automation.

- `.github/workflows/ci.yml`: Runs continuous integration for every pull request and every push to `main`. GitHub creates one job each for Ubuntu, macOS, and Windows. Each job checks out the repository, installs Node.js 22, installs the exact dependencies from `package-lock.json`, runs the unit and integration tests, then packs and smoke-tests the installable CLI. The operating-system matrix catches platform-specific problems before release.

### `bin/`

The public command-line entry point installed by npm.

- `bin/pipa.mjs`: Implements the `pipa` command. `pipa init` confirms the working directory, opens Slack's app-manifest setup, reads tokens without displaying them, and calls `initializePipa`. `pipa start` takes a single-instance lock, starts the Slack application, and shuts it down cleanly on `SIGINT` or `SIGTERM`. `pipa --version` reads the version from `package.json`. The `bin` mapping in `package.json` makes this file available as the `pipa` executable after installation.

### `docs/`

Long-form repository documentation.

- `docs/repository-overview.md`: This file. It explains the repository structure and how the application works.

### `scripts/`

Repository maintenance and release checks that are not part of the installed runtime.

- `scripts/pack-smoke.mjs`: Tests the package users will actually receive. It runs `npm pack`, installs the resulting archive in a temporary directory, verifies `pipa --version`, runs non-interactive initialization with fake OpenCode and Slack responses, checks the saved configuration and manifest, confirms secrets were not printed, checks cancellation behavior, and removes the temporary files. This catches packaging mistakes that unit tests against source files would miss.

### `src/`

The application implementation.

- `src/app.mjs`: Coordinates Slack, OpenCode, and persisted sessions. `initializePipa` validates input and credentials before saving configuration. `startPipa` creates the Slack adapter, restores thread subscriptions, filters unsupported messages, sends prompts to OpenCode, posts responses, shows progress reactions, and handles startup and shutdown timeouts. `createConversationRunner` serializes work within each thread while allowing separate threads to run concurrently.
- `src/opencode.mjs`: Owns the OpenCode child-process boundary. It builds shell-free command arguments, removes Slack secrets from the child environment, starts `opencode`, enforces timeouts and output limits, parses newline-delimited JSON events, returns assistant text and session IDs, checks the installed OpenCode version, and terminates active children during shutdown. Windows process termination uses `taskkill` so descendant processes are also stopped.
- `src/state.mjs`: Owns local state and the Slack app manifest. It builds paths under `~/.pipa`, validates the working directory and bot name, writes private JSON files atomically, loads configuration and sessions, serializes session writes, and uses a lock file to prevent two Pipa instances from controlling the same local state. It also generates the encoded Slack manifest URL used by `pipa init`.

### `test/`

Tests run by Node's built-in test runner through `npm test`.

- `test/app.test.mjs`: Tests application orchestration: safe initialization, Slack token error handling, per-thread queueing, session continuity, Slack filtering and delivery, reactions, secret redaction, chunked responses, and startup and shutdown cleanup.
- `test/opencode.test.mjs`: Tests the OpenCode process boundary: literal shell-free arguments, secret removal, JSON event parsing, timeout and termination behavior, error propagation, active-process shutdown, and Windows command-shim safety.
- `test/state.test.mjs`: Tests state management: Slack manifest generation, private file permissions, separate configuration and session storage, malformed state errors, recovery after failed writes, and single-instance locking.

### Root files

- `.gitignore`: Keeps generated dependencies, package archives, local environment variables, macOS metadata, and local OpenCode state out of Git.
- `CONTRIBUTING.md`: Gives contributors the supported Node.js version, local verification commands, and expectations for focused changes and secret handling.
- `LICENSE`: Contains the Apache License 2.0 terms under which Pipa is distributed.
- `package-lock.json`: Locks the full npm dependency graph to exact versions so local development and CI install the same packages.
- `package.json`: Defines package metadata, the `pipa` executable, published files, npm scripts, supported Node.js version, dependencies, repository links, and license identifier.
- `README.md`: Provides the user-facing product description, requirements, installation and usage instructions, command reference, development commands, release policy, and license link.
