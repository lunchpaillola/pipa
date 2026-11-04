# Pipa 0.6.2 (beta channel)

Preparation notes for an opt-in beta. This document does not mean the version has
been published. Normal npm installs must continue to receive stable `0.5.6`
unless the owner separately approves a stable release.

The owner selected the exact version `0.6.2`, replacing the unpublished `0.6.3`
preparation version. Despite the version having no
prerelease suffix, publish only to npm's `beta` tag and mark the GitHub release
**Pre-release**. Do not move `latest` or treat the version as stable qualification.

## Changes from 0.6.0-beta.2

- OpenCode v2 execution failures retain OpenCode's own message instead of Pipa classifying provider errors or substituting recovery advice.
- Remove Pipa-added v2 request/discovery deadlines and read-recovery loops. Native calls retain caller cancellation; readiness, shutdown and Slack lifecycle checks remain separate.
- Closing the model picker cancels pending discovery and prevents a late update. V1 retains a 30-second discovery limit, starting only after readiness; v2 has no Pipa-added discovery deadline. Cached search and Save do not rediscover the catalog.
- Explicitly selected routine prompt files may live outside the configured working directory, including symlinked files. Regular-file, identity, size and concurrent-change checks remain.
- OpenCode v2 web-search setup can be answered in Slack: Allow, Disable and Choose another provider, followed by the provider picker when needed.
- Simple visible text and multiselect forms use Slack question controls regardless of their metadata kind or field names. Unsupported shapes still require an OpenCode client; native validation and session/workspace authorization remain in place.
- Large model-search results stay within Slack's response-size limit. Models omitted from the initial results remain searchable.

Known form edge cases from review remain: duplicate option labels can map to the
first option's native value; custom text matching an option label can be mapped
to that value; optional fields cannot be submitted empty through Slack. Use an
OpenCode client for these cases. These are not covered by a live Slack form smoke.

## Retained changes from 0.6.0-beta.1

- OpenCode v2 live responses keep returning to the same Slack thread after the first reply, including responses when native background work resumes. New follow-ups use native steering instead of cancelling the current execution. V1 retains interrupt-and-replace behavior.
- Remove v2's foreign-writer attribution guard, recovery journal, temporary instruction cleanup and installation-wide blocked-intake policy. Old journal files are left untouched and ignored. Slack and artifact context stays in a stable native session instruction entry; the restart lecture is no longer repeated.
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

### Current 0.6.2 preparation

The owner selected `0.6.2` on November 4, 2026. The earlier `0.6.3` metadata was
never published; its results above are historical, not checks of this versioned
candidate. At preparation, npm `beta` was `0.6.0-beta.2`, `latest` was `0.5.6`,
and neither npm version `0.6.2` nor Git tag `v0.6.2` existed.

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

On November 4, the versioned `0.6.2` release-only update passed:
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

Once published, install this exact beta with:

```sh
npm install --global @usepipa/pipa@0.6.2
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

PR #64 contains the runtime changes and this release preparation. The release
metadata update changes no routine model-selection behavior: a saved routine
model is passed explicitly; an unset model is left to OpenCode's native default.
The owner merges the PR and publishes to npm. Release tagging and GitHub
prerelease creation must target the actual merged commit, never the unmerged
feature head. Installation remains a separate cutover.

1. Recheck PR feedback and required CI for the exact beta commit. Run the [controlled-beta checks](../CONTRIBUTING.md#controlled-beta), including the installed-package smoke and publish dry-run. Record limitations separately from passing checks.
2. Immediately before publication, run `npm view @usepipa/pipa dist-tags versions --json`. Confirm `0.6.2` is still unused. At preparation on November 4, 2026, `beta` was `0.6.0-beta.2` and `latest` was `0.5.6`. Stop if the registry changed unexpectedly.
3. After PR #64 is merged and required CI passes, check out the actual merged commit in a clean release checkout, verify both package files say `0.6.2`, and rerun the package checks/dry-run there. Tag that merged commit `v0.6.2`; never tag the old feature head by mistake. Create its GitHub release as **Pre-release**, not latest, using these changes and limits as the notes. Tagging and GitHub release creation do not publish to npm.
4. The owner publishes from that release checkout:

```sh
npm publish --tag beta --access public
npm view @usepipa/pipa dist-tags --json
```

5. Verify `beta` is `0.6.2` and `latest` matches the value recorded before publishing. Verify the published version and matching GitHub prerelease. Do not mark it stable/latest.
6. Arrange the daily-installation cutover separately. Later beta fixes need a new unused version; do not overwrite a published version.
