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

For runtime compatibility changes, also run `node --test scripts/verification/self-check.mjs`
and the applicable pinned native cells (`npm run test:engines -- --migration`).
Keep the no-secret PR lane separate from opt-in real Slack/provider execution.
See [testing](docs/pipa-testing.md) and [compatibility/rollback](docs/opencode-compatibility.md).
No supported minimum or release qualification is implied by a subset of native passes.

The current native v2 target to qualify is **2.2.5**, alongside historical v2 **2.0.29** and v1 pins **1.18.35 / 1.19.0**. The SDK remains pinned to `@opencode/client@2.0.29` until qualified; its version is not the native engine target. These are qualification inputs, not passing compatibility results or a release recommendation.

For model-selection changes, iterate with `node --test test/state.test.mjs test/opencode.test.mjs test/models.test.mjs test/app.test.mjs test/routines.test.mjs test/cli.test.mjs`, then run both required checks above.

### Isolated Slack model smoke

Use a distinct Slack test app and a separate `PIPA_HOME` (the parent of `.pipa`), with its own app/bot tokens, working directory, and channel/user allowlists. Install the slash command derived from its configured `botName` (for example, `Chopper` -> `/chopper`) and grant `commands`. The generated manifest also suggests `/pipa`; omit that alias when another app already owns it, unless intentionally transferring that command. Enable Socket Mode and interactivity, reinstall or reauthorize, and invite the test app to the allowed channel. The generated manifest and runtime must use the same normalized name; a Slack app/bot rename alone does not update command registration or local config. Never run a second Socket listener with production credentials or restart production Pipa for a smoke test.

Isolate OpenCode HOME/XDG, database, configuration, and supported platform-specific storage paths separately; `PIPA_HOME` isolates only Pipa state. Migration rehearsals use stopped, matched Pipa/OpenCode snapshots and disposable copies, never the only copy of a real profile. Preserve recovery journals and verify owned-state reconciliation before new intake; do not delete journals to bypass a blocked recovery.

1. Open the installation's model command (for example `/chopper model`), verify the loading window becomes a populated provider-grouped list, choose and save model A, wait for the private saved confirmation, then reopen to verify the selection. Closing the loading window must not reopen it when discovery finishes.
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

To publish a release:

1. Update `package.json` and `package-lock.json` in the feature pull request.
2. Run `npm test` and `npm run test:pack`. For this dual-engine candidate, also collect the full required native OS/mode matrix, migration/rollback and private operator/live-client evidence. Missing required evidence blocks release; the automated Slack collector alone cannot certify it.
3. Merge after CI passes.
4. Tag the merge as `v<version>` and push the tag.
5. Run `npm publish --access public`.
6. Verify the published npm version, then create the matching GitHub release.
