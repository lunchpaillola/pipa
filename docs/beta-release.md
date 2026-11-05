# Pipa 0.6.0-beta.5 (beta channel)

Preparation notes for an opt-in beta. This document does not mean the version has
been published. Normal npm installs must continue to receive stable `0.5.6`
unless the owner separately approves a stable release.

This candidate increments `0.6.0-beta.4` to `0.6.0-beta.5`.
Earlier preparation versions `0.6.2` and `0.6.3` were never published and are
superseded. Publish only to npm's `beta` tag and mark the GitHub release
**Pre-release**. Do not move `latest` or treat the version as stable qualification.

## Changes from 0.6.0-beta.4

- Read preceding Slack thread discussion directly with Pipa's bot token. No Composio dependency or adapter history reader is used. New top-level requests skip the read; partial or unavailable context is identified. Historical messages are context, not new action permission.
- Before sending a v2 request, narrowly repair a missing working folder by moving the same native conversation back to the configured starting folder when the native checks permit it. Confirm the move and notify the thread before continuing; do not replay prompts or restore missing files.
- Keep current server ownership and start/stop/restart behavior, selected models, attachment handling, and artifact publication boundaries.

Actual bot-token access and isolated native recovery require qualification before publication. Preparation alone does not approve tagging, publishing, or installing this candidate.

## Retained changes from 0.6.0-beta.3

- Restore the restart instructions that preserve the Slack channel/thread for the replacement process's ready notification. Instructions retain the correct Pipa host/profile and durable status check; the restart worker and native background-response behavior are unchanged.
- Regression coverage includes threaded and channel-only Slack requests, non-Slack fallback, remote attached-host guidance and isolated profile-home instructions. Live Slack restart delivery has not been rerun.

## Retained changes from 0.6.0-beta.2

- OpenCode v2 execution failures retain OpenCode's own message instead of Pipa classifying provider errors or substituting recovery advice.
- Remove Pipa-added v2 request/discovery deadlines and read-recovery loops. Native calls retain caller cancellation; readiness, shutdown and Slack lifecycle checks remain separate.
- Closing the model picker cancels pending discovery and prevents a late update. V1 retains a 30-second discovery limit, starting only after readiness; v2 has no Pipa-added discovery deadline. Cached search and Save do not rediscover the catalog.
- Explicitly selected routine prompt files may live outside the configured working directory, including symlinked files. Regular-file, identity, size and concurrent-change checks remain.
- OpenCode v2 web-search setup can be answered in Slack: Allow, Disable and Choose another provider, followed by the provider picker when needed.
- Simple visible text and multiselect forms use Slack question controls regardless of their metadata kind or field names. Unsupported shapes still require an OpenCode client; native validation and session/workspace authorization remain in place.
- Large model-search results stay within Slack's response-size limit. Models omitted from the initial results remain searchable.

- Slack choices preserve native option values even when labels repeat; typed custom answers are no longer interpreted as option labels. Optional text fields accept an empty string, optional multiselects accept an empty selection, and Skip omits the field from the native answer. Native validation can still reject an answer that violates field constraints. Automated Slack-to-native HTTP fixtures cover these cases; a live Slack form smoke has not run.
- An empty model picker explains the terminal provider-connection command and directs attached-server users to their operator.

Unsupported numeric, boolean, hidden, conditional and external-action forms still
have a dead-end OpenCode-client notice. This is an unresolved Slack UX gap, not an
acceptable end-user workaround. See the [redirect audit and renderer research](research/slack-forms-and-opencode-redirects.md).

## Retained changes from 0.6.0-beta.1

- OpenCode v2 live responses keep returning to the same Slack thread after the first reply, including responses when native background work resumes. New follow-ups use native steering instead of cancelling the current execution. V1 retains interrupt-and-replace behavior.
- Remove v2's foreign-writer attribution guard, recovery journal, temporary instruction cleanup and installation-wide blocked-intake policy. Old journal files are left untouched and ignored. Slack and artifact context stays in a stable native session instruction entry. Focused restart guidance is restored in beta.4.
- Forward live responses only. Missed replies are not replayed after disconnection or restart, and startup does not reattach old background observers. A new Slack message reattaches its thread to the saved native session.
- The searchable Slack picker handles large catalogs without a size-limited dropdown. Authorization and live Save validation remain in place; current discovery timing is described above.
- Native interaction work is queued per observer so it cannot stall other sessions' responses. Failed Slack delivery is reported when possible, not replayed. Shutdown drains local callbacks without interrupting attached native v2 sessions.
- Incoming files retain their 10 MiB per-file limit and output artifacts retain containment, symlink, identity, type, count and size checks (10 files / 100 MB per file or response). Background input uses data URIs; v2 artifact directories stay available for later output and may accumulate files.

The dual v1/v2 adapters, startup policy and Windows process handling from the first beta remain. Updating Pipa does not install or upgrade OpenCode.

## Trial and limits

This is a controlled daily-use trial, not stable certification of every platform,
provider, plugin or client. On implementation commit `5785e2d`, 439 automated
tests, package checks and 26 verification self-checks passed. Six targeted real
OpenCode 2.2.5 cases passed on macOS in attached mode, including automatic native
background follow-through, delegated interactions and process cleanup.

A fixed snapshot of that commit also passed live Slack checks on macOS with
OpenCode 2.2.5 and the isolated `opencode/deepseek-v4.1-flash-free` model:
- [Automatic first and later replies](https://lunchpaillabs.slack.com/archives/C0BNJJ9RDB2/p1793722962951789), with no extra user message between them.
- [Completed A/B/C steering](https://lunchpaillabs.slack.com/archives/C0BNJJ9RDB2/p1793723351868719), preserving all follow-ups through active native work. Earlier short attempts finished before B/C were sent; the final 90-second retry completed all three values.
- [File output](https://lunchpaillabs.slack.com/archives/C0BNJJ9RDB2/p1793723385962689), downloaded from Slack and checked against the exact expected bytes.

Installed Chopper was restored after the tests. This does not qualify the daily
GPT model, incoming-upload or question-form UI, other platforms, or the complete
OS/mode/engine matrix. Historical 2.0.29 native checking was blocked by a local
executable-version mismatch. Package checks against contract fixtures are not
real-engine certification. Full/manual qualification remains separate and
`releaseQualified` remains false. See [compatibility evidence](opencode-compatibility.md).

### Historical unpublished 0.6.3 preparation checks

On macOS on November 3, 2026, the versioned candidate passed all 444 tests in
`npm test`, `npm run test:pack` against the 1.19.0, 2.0.29 and 2.2.5 contract fixtures,
and all 26 `scripts/verification/self-check.mjs` tests. The beta publish dry-run
contained only the expected 12 files: the CLI, runtime sources, README, license
and package metadata. No profile data or credentials were included.

On candidate `1f22e92`, [unit/package CI passed on Linux, macOS and Windows](https://github.com/lunchpaillola/pipa/actions/runs/41729270963).
The [native beta smoke](https://github.com/lunchpaillola/pipa/actions/runs/41729271447)
passed on Linux and macOS. Windows failed the OpenCode 1.19.0 Socket-owned restart
case because fixture cleanup was not confirmed; its private root was retained.
The other 23 Windows journey observations passed, including all 2.2.5 cases.
This failure is unresolved, not waived by the passing unit/package CI.

These native checks do not exercise the new Slack form UI. Historical live
Slack results above have not been rerun for 0.6.3. CodeRabbit's automated review
of the preparation PR was rate-limited, not approved. No production installation
was changed; full release qualification remains false.

### Historical 0.6.0-beta.3 preparation

The owner clarified on November 4, 2026 that this release must increment the
published beta, not use a stable-shaped version. npm `beta` was `0.6.0-beta.2`
and `latest` was `0.5.6`. The new target is `0.6.0-beta.3`; earlier unpublished
version metadata and its verification below are historical evidence, not
checks of this exact version string.

Before the metadata update, PR #64 implementation `4233c325eec17276c3183d528aed097ebfd332db`
passed full tests and installed-package smoke. Its Linux CI, CodeRabbit and
GitGuardian checks passed. An isolated macOS/OpenCode 2.2.5 live Slack trial
verified picker Cancel/search/Save and private confirmation, native error
delivery, and a successful `openai/gpt-6.1-sol` reply with same-session recall:
[GPT reply and recall](https://lunchpaillabs.slack.com/archives/C0BNJJ9RDB2/p1793782422929739).
The initial GPT test used the wrong native authentication method; correcting
only the isolated test setup made it pass. Existing installation credentials
were unchanged and test processes/profiles were cleaned up.

This does not resolve the historical Windows cleanup failure or qualify every
platform, form, provider or native journey. Full release qualification remains
false.

Before the version-name correction, the unpublished `0.6.2` release-only update passed:
- All 476 tests in `npm test -- --test-concurrency=1` on macOS (0 failures).
- Installed-package smoke for the 1.19.0, 2.0.29 and 2.2.5 contract fixtures.
- All 26 verification self-checks.
- `npm publish --dry-run --tag beta --access public`: 13 expected public files,
  no profile data or credentials, version `0.6.2`.
- Matching package/lockfile versions and `git diff --check`.

The initial full-suite command reached its 120-second host limit during the
intentional long restart tests. Only that run's isolated test processes were
stopped; the rerun with a longer allowance completed in about 181 seconds.
Required PR CI must still pass for the final preparation commit before merge.

After correcting the version to `0.6.0-beta.3`, all 476 tests passed again on
macOS (0 failures, about 182 seconds), as did the three installed-package
contract fixtures and beta publish dry-run (13 expected public files). The
release Git tag was confirmed absent. No runtime code changed in the version
correction; no package or GitHub release has been published.

### Historical 0.6.0-beta.4 preparation

On November 4, 2026, npm `beta` was `0.6.0-beta.3`, `latest` was `0.5.6`,
and `0.6.0-beta.4` and its Git tag were unused. PR #66 contains the restart fix
and this version update. The owner will tag and publish after handoff. No running
installation is changed by release preparation.

Exact-version checks on macOS arm64 with Node 22.23.2:

- All 484 tests passed, with no failures or skips.
- Installed-package smoke passed against the 1.19.0, 2.0.29 and 2.2.5 contract fixtures.
- All 26 verification self-checks passed.
- Native beta smoke passed all 24 applicable journey observations across six cells: OpenCode 1.19.0 and 2.2.5 in Socket-owned, attached and Managed modes. Every cell and report cleanup passed. The harness uses scripted provider/Chat fixtures, not live Slack or a paid provider.
- Beta publish dry-run contained 13 expected public files, with matching package/lockfile versions and no profile data or credentials.

This host did not rerun Linux or Windows native smoke. The historical Windows
cleanup failure remains unresolved. External restart worker-PID observation is
excluded by the beta smoke contract. Full release qualification remains false.

### Current 0.6.0-beta.5 preparation

On November 5, 2026, the registry reported `beta` as `0.6.0-beta.4` and
`latest` as `0.5.6`. The `0.6.0-beta.5` registry entry returned not found, and
the matching Git tag was absent. Recheck both immediately before publication.
This candidate does not change the running installation or either npm tag.

Preparation checks on macOS with Node 22.23.2:

- All 532 tests passed with no failures or skips. The first full run exposed five native model-picker test fixtures missing the new direct-history response; supplying that fixture preserved their existing reply assertions. The complete suite then passed.
- Installed-package smoke passed for the 1.19.0, 2.0.29 and 2.2.5 contract fixtures.
- All 26 verification self-checks passed.
- A credential-clean OpenCode 2.2.5 check confirmed same-session relocation after removing an empty test-owned folder, a confirmed applied target, and one `resume:false` prompt in the repaired session's inbox. A second session with queued work was refused recovery and kept its location and queued request. Test processes and storage were removed successfully.
- The macOS native beta smoke passed all 24 applicable observations across OpenCode 1.19.0 and 2.2.5 in Socket-owned, attached and Managed modes. Startup, exact prompt/history, applicable restart and stop ownership passed; report cleanup passed. This uses a scripted local provider and fake Chat, not live Slack.
- `npm publish --dry-run --tag beta --access public` contained 13 expected public files at `0.6.0-beta.5`, with no profile data or credentials. No package was published.

The targeted native check did not execute a model task or use an external provider.
Live Slack bot-token access, provider-backed continuation, Linux/Windows native
behavior, and whole-release qualification remain separate. No current production
session was repaired or restarted.

Once published, install this exact beta with:

```sh
npm install --global @usepipa/pipa@0.6.0-beta.5
```

For an existing daily installation, schedule a separate maintenance window:

1. Stop/drain Pipa on its actual host and back up the existing profile (normally `~/.pipa`, or `.pipa` beneath `PIPA_HOME`). Keep the backup private.
2. Install the beta and keep the current OpenCode version. Do not rerun `pipa init`, recreate the Slack app or run competing listeners.
3. Start with the same profile, working directory and launch environment. Managed external clients require a shared explicit password; follow the [upgrade notice](../README.md#install).
4. Try conversations, same-thread history, questions/approvals, file input/output, routines and restart. Record the Pipa/OpenCode versions and a minimal reproduction for failures; never include tokens or private profile data.
5. Record the installed version before the trial. If it fails, stop the candidate and reinstall that exact previous version (for a beta.2 installation, `npm install --global @usepipa/pipa@0.6.0-beta.2`). Stable `0.5.6` remains available but predates the v2 adapter; it is not a drop-in rollback for a v2-only setup. Preserve profile files and inspect partial side effects before retrying. Restore profile data only from a known stopped backup when needed.

Reinstalling Pipa does not reverse an OpenCode data upgrade. An engine upgrade
needs a separate matched-snapshot backup/rollback plan; see
[OpenCode compatibility](opencode-compatibility.md).

## Publisher checklist

This candidate adds thread context and missing-folder recovery on top of PR #66's
restart fix. Routine model selection is unchanged: a saved routine model is
passed explicitly; an unset model is left to OpenCode's native default.
The agent may merge after owner approval and passing CI; the owner tags and publishes to npm. Release tagging and GitHub
prerelease creation must target the actual merged commit, never the unmerged
feature head. Installation remains a separate cutover.

1. Recheck PR feedback and required CI for the exact beta commit. Run the [controlled-beta checks](../CONTRIBUTING.md#controlled-beta), including the installed-package smoke and publish dry-run. Record limitations separately from passing checks.
2. Immediately before publication, run `npm view @usepipa/pipa dist-tags versions --json`. Confirm `0.6.0-beta.5` is still unused and record the current `beta` and `latest` tags. Stop if the registry changed unexpectedly.
3. After this candidate PR is merged and required CI passes, check out the actual merged commit in a clean release checkout, verify both package files say `0.6.0-beta.5`, and rerun the package checks/dry-run there. Tag that merged commit `v0.6.0-beta.5`; never tag the unmerged feature head. Create its GitHub release as **Pre-release**, not latest, using these changes and limits as the notes. Tagging and GitHub release creation do not publish to npm.
4. The owner publishes from that release checkout:

```sh
npm publish --tag beta --access public
npm view @usepipa/pipa dist-tags --json
```

5. Verify `beta` is `0.6.0-beta.5` and `latest` matches the value recorded before publishing. Verify the published version and matching GitHub prerelease. Do not mark it stable/latest.
6. Arrange the daily-installation cutover separately. Later beta fixes need a new unused version; do not overwrite a published version.
