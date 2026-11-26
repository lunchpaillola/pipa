# Contributing

Issues and focused pull requests are welcome. Open an issue before starting a large change so the approach can be agreed on first.

## Development

Pipa requires Node.js 22 or newer.

```sh
npm ci
npm test
npm run test:pack
```

Keep changes small, include a regression test for behavior changes, and never commit Slack tokens or files from `~/.pipa`.

Pull requests run one Linux CI job covering state, Slack actions, routines, and
the OpenCode v2 adapter. There is no repeat run on `main` or before npm publish.
`npm test` and `npm run test:pack` remain available for local verification. Add
focused regression tests for behavior changes.

For optional runtime compatibility checks, run `node --test scripts/verification/self-check.mjs`
and `npm run test:beta -- --report=beta-smoke.json`: real 1.19.0 / 2.2.5 engines,
three modes, six cells and 24 applicable case observations per host, with scripted
local provider/Chat fixtures and no credentials or paid-provider quota.
The **OpenCode compatibility** workflow is manual-only. Its default runs this
smoke on Linux and macOS (12 cells total); Windows native harness runs are outside
the current release scope and shown as `—` (not run), not a passing result.
Windows unit/package checks can be run locally on Windows.
Select `full_qualification` or use
`npm run test:engines -- --migration` for the broad matrix. Smoke covers basic
startup, prompts/history, applicable restart and stop ownership. Richer files,
approvals and routines stay in retained unit tests and the broad manual matrix,
not the native beta promise; the existing Socket restart case retains its routine
flow. Deep crash/plugin/model/migration and live-client qualification stay separate.
It skips external restart worker-PID observation only, records that gap, and
keeps all selected failures and cleanup diagnostics strict. `releaseQualified`
remains false; no smoke or targeted subset authorizes publish or production changes.
Keep the no-secret PR lane separate from opt-in real Slack/provider execution.
See [testing](docs/pipa-testing.md) and [compatibility/rollback](docs/opencode-compatibility.md).
No supported minimum or release qualification is implied by a subset of native passes.

For session-form changes, run `node scripts/verification/slack-forms-native.mjs`
with the target v2 `opencode` on PATH. An optional positional filename saves the
JSON report. This starts a disposable native server with isolated HOME/XDG and
database storage, drives real forms through Pipa's Slack callbacks, and asserts
the native answers, cancellation, rejection/retry and Slack payload-size limits.
It also runs a native question tool with a scripted loopback provider. It needs
no Slack tokens or paid-provider credentials. Captured Slack transport does not
verify visual rendering or real file uploads; those still need a test Slack app.

For missing-location recovery, run `node scripts/verification/slack-location-native.mjs`
with the target v2 engine on PATH. It uses disposable native storage and a scripted
local provider, preserves idle/queued session history across a test-only engine
restart, removes only empty test-owned folders, and verifies one native completion
of both the rejected current request and any previously queued work. An optional
positional filename saves the JSON report; no Slack or paid-provider tokens are used.

The current native v2 target to qualify is **2.2.5**, alongside historical v2 **2.0.29** and v1 pins **1.18.35 / 1.19.0**. The SDK remains pinned to `@opencode/client@2.0.29` until qualified; its version is not the native engine target. These are qualification inputs, not passing compatibility results or a release recommendation.

For model-selection changes, iterate with `node --test test/state.test.mjs test/opencode.test.mjs test/models.test.mjs test/app.test.mjs test/routines.test.mjs test/cli.test.mjs`, then run both required checks above.

### Isolated Slack model smoke

Use a distinct Slack test app and a separate `PIPA_HOME` (the parent of `.pipa`), with its own app/bot tokens, working directory, and channel/user allowlists. Install the slash command derived from its configured `botName` (for example, `Chopper` -> `/chopper`) and grant `commands`. The generated manifest also suggests `/pipa`; omit that alias when another app already owns it, unless intentionally transferring that command. Enable Socket Mode and interactivity, reinstall or reauthorize, and invite the test app to the allowed channel. The generated manifest and runtime must use the same normalized name; a Slack app/bot rename alone does not update command registration or local config. Never run a second Socket listener with production credentials or restart production Pipa for a smoke test.

Isolate OpenCode HOME/XDG, database, configuration, and supported platform-specific storage paths separately; `PIPA_HOME` isolates only Pipa state. Migration rehearsals use stopped, matched Pipa/OpenCode snapshots and disposable copies, never the only copy of a real profile. Preserve existing profile files; v2 no longer uses the old recovery journal or gates intake on it.

1. Open the installation's model command (for example `/chopper model`), verify the loading window becomes a searchable picker, search by name/ID/provider and save model A, wait for the private saved confirmation, then reopen to verify the selection. With a large catalog, verify a model beyond the first 100 matches is searchable and remains selected on reopen. Closing the loading window must not reopen it when discovery finishes.
2. Send an ordinary request and inspect the completed OpenCode assistant message's provider/model metadata. HTTP acceptance or asking the model which model it is does not prove selection.
3. Save model B and reply in that same Slack thread. Verify completed metadata still names A and the session/history is retained. Start a new thread and verify it uses B. Restart the test profile and verify both threads retain their models.
4. Cancel another picker and verify no setting changed. Restart only the test profile and reopen to verify persistence.
5. Record selected IDs, completed metadata, and a short existing Slack conversation link separately from automated outcomes. Clean up only test-owned processes/state. Without the isolated app/profile, record the live-smoke gap rather than presenting adapter tests as live evidence.

Also check `mentionOnly`: unmentioned replies in subscribed threads are ignored when enabled and accepted when disabled; mentions still continue the same session. Routine create/preview must snapshot the selected default, and later default changes must not rewrite that saved model. During shutdown, pending model saves drain before Slack disconnects; accepted Socket event acknowledgments have a bounded drain after ingress detaches. Verify restart readiness and recovery separately from model-save confirmation.

For an existing profile, test `pipa manifest` as a read-only local-template export: credentials must be absent and config, sessions, routines, and cached manifest must remain unchanged. It must not contact Slack or claim to preserve unknown remote app settings. Use the README's existing-installation upgrade path instead of rerunning `pipa init`. Native adapter tests cover both named/alias entry points with the same user/channel authorization; inspect the installation identity in the modal before saving via a shared alias.

## Releases

Pipa follows Semantic Versioning:

- New backward-compatible capability: minor release (`0.1.0` to `0.2.0`)
- Backward-compatible fix: patch release (`0.2.0` to `0.2.1`)
- Breaking change: discuss the version before release

Prepare the release PR with matching versions in `package.json` and
`package-lock.json` and the release notes. Merging does not publish the package.

1. With owner approval, confirm the npm version is unused and record the current
   `latest` and `beta` tags. Tag the actual merge commit as `v<version>`.
2. From a clean checkout of that commit, run `npm pack --json` into a private
   directory. Inspect the package contents for private files and record the
   integrity of the exact archive. There is no second test run for publication.
3. The authorized publisher runs `npm publish "$TARBALL" --tag "$NPM_TAG" --access public`
   with `latest` for stable or `beta` for a prerelease. Keep the other tag unchanged.
4. Verify the public npm version, integrity and tags, then create the matching
   GitHub release (marked pre-release for `beta`). Installing or restarting a
   running instance is a separate owner-approved operation.

Historical release procedures are in the [0.6.0 notes](docs/release-0.6.0.md)
and the [beta.5 notes](docs/beta-release.md).
