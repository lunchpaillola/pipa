# Pipa Agent Guide

Pipa is a small Node.js CLI that connects Slack Socket Mode to a persistent OpenCode server. Keep changes focused: this repository intentionally uses three runtime modules and Node's built-in test runner instead of a framework or internal abstraction layer.

## Setup and commands

- Requires Node.js 22+; install the lockfile exactly with `npm ci`.
- Run all tests with `npm test`; run one suite with `node --test test/app.test.mjs` (or `test/opencode.test.mjs` / `test/state.test.mjs`).
- Run `npm run test:pack` for changes affecting the CLI, package contents, startup, or release behavior. CI runs `npm test` then this smoke test on Linux, macOS, and Windows.
- Manual Socket Mode checks use `pipa init`, `pipa start`, and `pipa stop`. Use a disposable `PIPA_HOME` and test Slack app; never reuse production credentials.

## Change map

- `bin/pipa.mjs` is the published `pipa` executable and command dispatcher.
- `src/app.mjs` owns Slack Socket Mode, latest-turn coordination per thread, Slack delivery, interactions, and startup/shutdown orchestration.
- `src/opencode.mjs` owns `opencode serve`, its session HTTP client, attachment/artifact staging, timeouts, and child-process cleanup. Socket Mode may attach via `PIPA_OPENCODE_ATTACH_URL`; attached servers are not owned or stopped by Pipa.
- `src/state.mjs` owns persistent configuration, sessions, and the single-instance lock. State is under `~/.pipa` by default; set `PIPA_HOME` to isolate it in tests or manual checks.
- `test/app.test.mjs` covers Slack orchestration and concurrency, `test/opencode.test.mjs` covers the OpenCode boundary and files, and `test/state.test.mjs` covers persisted state and locking.
- `scripts/pack-smoke.mjs` validates the packed npm artifact rather than the source checkout.
- `docs/repository-overview.md` describes the complete request flow and file layout.

## Runtime invariants

- Pipa supports `socket` (default) and `managed` profiles. Socket mode requires Slack tokens; managed mode only starts OpenCode using its configured host and port.
- One Slack thread maps to one persisted OpenCode session. Different threads may overlap; a newer message in the same thread aborts and supersedes older work.
- Superseded turns must not persist stale state, post stale output, or add a success reaction. Preserve the generation checks around asynchronous persistence and delivery.
- Shutdown rejects new messages, aborts local and server-side turns immediately, then waits only for bounded cleanup before closing Slack and owned OpenCode processes.
- Owned Socket Mode servers bind to loopback port `0`. Explicitly attached servers are health-checked but are not process-owned by Pipa.
- Keep the runtime in plain ESM and use Node platform APIs or existing dependencies before adding packages.

## Security boundaries

- Keep Slack tokens out of child OpenCode environments and out of errors, logs, fixtures, and commits. Never commit `~/.pipa` state.
- Treat the configured working directory as a trust boundary. Pipa grants Slack users access to OpenCode there, so changes to access-list validation require security review and regression tests.
- Attachments are temporary, capped at 100 MB each, and removed on every terminal path. Preserve filename sanitization and cleanup on errors, cancellation, and timeout.
- Artifact delivery is only for filesystem-local OpenCode turns and is constrained to the configured working directory's `.pipa/artifacts` directory. Do not weaken its path, identity, type, or size checks.
- Do not expose local artifact paths to Slack. Deliver only declared top-level regular files after containment, symlink, identity, count, and aggregate-size validation.

## Change expectations

- Read the full caller path before editing shared orchestration. Concurrency fixes need coverage for same-thread replacement and cross-thread independence.
- Add a regression test for behavior changes. Prefer a focused test in the owning suite over new fixtures or helper layers.
- Keep user-facing documentation aligned when commands, configuration, Slack behavior, limits, or release behavior changes.
- Run `npm test`, `npm run test:pack`, and `git diff --check` before submitting a pull request.
- Do not bump versions unless the change is intended for release. When requested, update both `package.json` and `package-lock.json` and follow `CONTRIBUTING.md`.
