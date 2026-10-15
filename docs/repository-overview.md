# Repository overview

Pipa is a Node.js command-line application with Socket and Managed profile modes. Socket Mode connects Slack to one persistent private `opencode serve` process, or to an explicitly configured existing server. Managed mode owns one persistent `opencode serve` child without connecting to Slack. Configuration and Socket Mode session IDs are stored under `~/.pipa`.

## Request flow

1. `bin/pipa.mjs` handles `pipa init` or `pipa start`, loads the profile, and selects Socket or Managed mode.
2. During initialization, `src/app.mjs` validates OpenCode and Slack credentials, warns without blocking when granted-scope metadata omits a recommended Slack scope, then `src/state.mjs` saves the configuration and generated Slack manifest under `~/.pipa`. The manifest includes `channels:read` and `assistant:write` for channel metadata and Chat SDK typing status.
3. During Socket Mode startup, `src/app.mjs` checks that `PIPA_OPENCODE_ATTACH_URL` or one owned OpenCode server on loopback port `0` can serve the configured workspace, then creates the Slack connection, restores previously subscribed Slack threads from `~/.pipa/sessions.json`, reconciles `~/.pipa/routines.json`, and starts the local 30-second routine scheduler. During Managed startup, `src/opencode.mjs` starts one `opencode serve` child with the profile's working directory, hostname, and port; Managed mode does not execute routines.
4. A mention or thread reply, including any attachments, is queued per Slack thread. Different threads can run concurrently, but messages in one thread run in order. The active turn starts Chat SDK typing status once; status failures do not affect the turn.
5. `src/opencode.mjs` checks incoming attachment metadata and downloaded bytes against 10 MiB per file, stages them once, and selects the native v1/v2 adapter from the authenticated connection. Session callbacks run before artifact allocation or admission. V1 sends trusted context separately as prompt system instructions. V2 journals ownership before writing a session instruction entry, admits an exact-text prompt with a stable input ID, and reconciles all authoritative message pages and the inbox until the correlated assistant and subsequent terminal idle projection settle. Files declared by a filesystem-local turn are checked for path, type, identity, and size safety under `.pipa/artifacts`; outgoing limits remain 10 files and 100 MB per file or response. Non-loopback attached servers do not receive the local-artifact contract. Temporary files are removed on every terminal path.
6. `src/app.mjs` saves the session ID and posts naturally short text once. Generated files travel with their concise summary in one Chat SDK post; a failed file post receives one text-only retry. Longer inline fallback is split at readable boundaries while preserving fenced code. Existing message reactions still report receipt, success, and failure.
7. Due routines call the same executor with a fresh session, exact saved prompt, configured working directory, and saved Slack channel or thread. After delivery, Pipa binds and subscribes the result thread to that OpenCode session so replies continue it. The scheduler permits different routines to overlap but never overlaps one routine with itself. Every dispatch, interaction, response, and final delivery reloads the relevant authorization. Edits affect future work; deactivation and deletion abort active work. Destination revocation blocks a new run or result delivery at the next authorization check. Shutdown aborts active work and suppresses stale delivery.
8. After full readiness, the CLI watches generation-scoped restart requests. The running Pipa arms a detached worker before cooperative shutdown, awaits cleanup and ownership-aware lock release, and awaits the worker handoff before exiting naturally. The worker waits for the old lock and process, starts the absolute packaged CLI detached, and records success only after replacement readiness IPC. Managed replacements must pass a bounded workspace health check; startup failure stops their owned child and releases the lock before reporting failure. Ordinary Managed starts remain running if health is unavailable, but cannot accept restart requests. Existing Slack authorization is unchanged.

## Files and folders

### `.github/`

GitHub-specific automation.

- `.github/workflows/ci.yml`: Runs continuous integration for every pull request and every push to `main`. GitHub creates one job each for Ubuntu, macOS, and Windows. Each job checks out the repository, installs Node.js 22, installs the exact dependencies from `package-lock.json`, runs the unit and integration tests, then packs and smoke-tests the installable CLI. The operating-system matrix catches platform-specific problems before release.
- `.github/workflows/opencode-compatibility.yml`: No-secret pinned native-engine matrix, separate from default tests. Live Slack/client and operator gates remain external qualification evidence.
- `.github/workflows/stats.yml`: Runs daily and on manual dispatch to validate and update the committed npm-download statistics. It uses only `contents: write`, serializes runs, and commits `STATS.md` only when the generated file changed.

### `bin/`

The public command-line entry point installed by npm.

- `bin/pipa.mjs`: Implements the `pipa` command. `pipa init` confirms the working directory, opens Slack's app-manifest setup, reads tokens without displaying them, and calls `initializePipa`. `pipa start` takes a single-instance lock, loads the profile once, and starts either the existing Slack application or the Managed OpenCode server. `pipa routine` parses the six routine lifecycle commands, exact prompt input, schedules, previews, and stable JSON output. It forwards `SIGINT` and `SIGTERM` before releasing the lock. `pipa --version` reads the version from `package.json`. `pipa restart` requests an asynchronous detached restart, and `pipa restart --status` provides read-only inspection of its durable outcome.

### `docs/`

Long-form repository documentation.

- `docs/repository-overview.md`: This file. It explains the repository structure and how the application works.
- `docs/opencode-compatibility.md`: Version/capability policy, existing-profile upgrade, deliberate v2 migration, matched-snapshot rollback and private operator checklist.
- `docs/pipa-testing.md`: Deterministic/native/live lanes, isolated profiles, live evaluator inputs, evidence and cleanup.

### `scripts/`

Repository maintenance and release checks that are not part of the installed runtime.

- `scripts/pack-smoke.mjs`: Tests the package users will actually receive. It packs and installs the archive in a temporary directory, verifies version, routine help and side-effect-free preview, Local initialization, and cancellation, then starts a Managed profile with a fake OpenCode executable that checks arguments, working directory, and inherited environment without Slack credentials. It removes the temporary artifact when finished.
- `scripts/stats.mjs`: Fetches validated npm download data for `@usepipa/pipa` and appends one completed UTC-day snapshot to `STATS.md`. It fails without changing existing statistics when the source data or prior file is unsafe.
- `scripts/test-opencode-matrix.mjs`: Installs an integrity-checked candidate and exact native pins privately, runs shared semantic cases and optional migration/rollback, and records honest deterministic/release gates.
- `scripts/slack-release-eval.mjs`: Opt-in serial live collector reusing the semantic catalog and routine flow; new/existing thread continuation, both routine destinations, optional independently observed restart and explicit blocked human/integration gates.
- `scripts/slack-routine-eval.mjs`: Import-inert reusable preview/confirmation/scheduled-result flow; validates exact saved input, lifecycle, session continuation, duplicate observation and nonce-only cleanup.
- `scripts/verification/slack-eval.mjs`: Shared authenticated preflight, paginated/rate-limited Slack reads, credential-clean CLI calls, app-scoped local lock and durable restart observation. Candidate process ownership stays with the operator.

### `src/`

The application implementation.

- `src/app.mjs`: Coordinates Slack, OpenCode, persisted sessions, and local routine delivery. `initializePipa` validates input and credentials before saving configuration and reports recommended missing Slack scopes without blocking. `startPipa` creates the Slack adapter, restores thread subscriptions, filters unsupported messages, enforces file limits, sends prompts and attachment descriptors to OpenCode, starts active-turn typing status, posts inline or artifact-backed responses, starts Socket Mode routine execution, and handles startup and shutdown timeouts. Routine interactions and results reuse the same Slack helpers with fresh destination and responder authorization. `createConversationRunner` serializes work within each thread while allowing separate threads to run concurrently.
- `src/opencode.mjs`: Owns authenticated runtime selection, the shared executor/controller registry, attachment staging, trusted instruction construction, artifact safety/cleanup, and child-process boundaries. Socket Mode checks the configured workspace before connecting Slack; Managed mode starts the server-only profile. Owned children inherit the runtime environment except Slack credentials. Windows termination uses `taskkill` to stop descendants.
- `src/opencode-v1.mjs`: Owns native v1 session resolution, prompt/status/message reconciliation, event-driven questions and permissions, and server cancellation.
- `src/opencode-v2.mjs`: Uses pinned `@opencode/client@2.0.29` for native prepared turns, stable-ID admission/reconciliation, paginated projections, attribution checks, and bounded independent cleanup. Before Socket subscriptions or routine intake, it reconciles abandoned records from the private atomic `~/.pipa/opencode-recovery.json`, including routine sessions without a Slack mapping. It removes owned instruction keys and pending inputs, and interrupts active owned execution under the single-writer-during-turn contract, waiting for terminal settlement. Observed foreign input prevents interruption and delivery; uncertain settlement or failed cleanup retains recovery state and blocks new intake. Native question forms and permissions reuse authorized Slack controls, including linked child sessions in the configured location. Both adapters expose optional `interaction.submit(decision)` acknowledgement and `interaction.settled` external-settlement signals while retaining legacy decision-returning callbacks. Native rejection leaves the same controls editable; uncertain replies reconcile native state before retry. Generic, numeric, conditional, and external forms display an OpenCode-client notice instead of Slack answer controls, and external settlement removes the notice.
- `src/routines.mjs`: Owns routine validation, IANA timezone schedules, strict-future recurrence, private atomic state mutation, restart reconciliation, conditional outcome merges, per-routine overlap prevention, and the non-overlapping scheduler tick. `routines.json` and its short-held mutation lock live separately from Pipa's process lock and session state.
- `src/restart.mjs`: Owns immutable restart requests, read-only durable status, bounded worker IPC, and detached relaunch. `pipa restart` and `pipa restart --status` use this module; private records live in `.pipa/restarts`. Workers and owned OpenCode children inherit a credential-cleaned environment with the same resolved `PIPA_HOME`. Agent context advertises the CLI and its asynchronous outcome. Detachment survives the agent turn ending; `/instance/dispose` cannot substitute for a server restart. Attached servers stay unowned.
- `src/state.mjs`: Owns local state and the Slack app manifest. It defaults profiles without `slackMode` to `socket`, validates shared and mode-specific fields, writes private JSON files atomically, loads sessions, serializes session writes, and uses a lock file to prevent two Pipa instances from controlling the same local state.

### `test/`

Tests run by Node's built-in test runner through `npm test`.

- `test/app.test.mjs`: Tests application orchestration: safe initialization, Slack token and scope handling, per-thread queueing, typing lifecycle, session continuity, attachment routing and limits, Slack filtering and delivery, routine execution and cancellation, interaction authorization, artifact fallback, reactions, secret redaction, readable chunking, and startup and shutdown cleanup.
- `test/cli.test.mjs`: Tests the routine CLI lifecycle, side-effect-free preview, schedule normalization, exact prompt files, JSON output, and destination allowlist enforcement through isolated subprocesses.
- Restart CLI coverage also launches isolated Managed fake servers, verifies PID/generation replacement and survival after worker exit, and checks failed/unready replacement cleanup. `test/restart.test.mjs` covers orchestration and handoffs with controlled process boundaries. Package smoke verifies installed restart help/status and worker availability.
- `test/opencode.test.mjs`: Tests owned and attached server selection, authentication, native session completion, stale-session recovery, attachment and artifact cleanup, artifact parsing and file safety, Slack-only delivery guidance, secret removal, timeout behavior, and cross-platform child lifecycle.
- `test/routines.test.mjs`: Tests schedule and DST boundaries, private atomic routine state, mutation locking, restart recovery, conditional merges, run requests, scheduler overlap, cancellation, and shutdown races.
- `test/state.test.mjs`: Tests state management: Socket and Managed profile validation, Slack manifest generation, private file permissions, separate configuration and session storage, malformed state errors, recovery after failed writes, and single-instance locking.

### Root files

- `.gitignore`: Keeps generated dependencies, package archives, local environment variables, macOS metadata, and local OpenCode state out of Git.
- `STATS.md`: Public daily npm package download snapshots. Counts are not installs, users, active users, or conversions.
- `CONTRIBUTING.md`: Gives contributors the supported Node.js version, local verification commands, and expectations for focused changes and secret handling.
- `LICENSE`: Contains the Apache License 2.0 terms under which Pipa is distributed.
- `package-lock.json`: Locks the full npm dependency graph to exact versions so local development and CI install the same packages.
- `package.json`: Defines package metadata, the `pipa` executable, published files, npm scripts, supported Node.js version, dependencies, repository links, and license identifier.
- `README.md`: Provides the user-facing product description, requirements, installation and usage instructions, command reference, development commands, release policy, and license link.
