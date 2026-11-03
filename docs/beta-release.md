# Pipa 0.6.0-beta.2

Preparation notes for an opt-in beta. This document does not mean the version has
been published. Normal npm installs must continue to receive stable `0.5.6`
unless the owner separately approves a stable release.

## Changes from 0.6.0-beta.1

- OpenCode v2 live responses keep returning to the same Slack thread after the first reply, including responses when native background work resumes. New follow-ups use native steering instead of cancelling the current execution. V1 retains interrupt-and-replace behavior.
- Remove v2's foreign-writer attribution guard, recovery journal, temporary instruction cleanup and installation-wide blocked-intake policy. Old journal files are left untouched and ignored. Slack and artifact context stays in a stable native session instruction entry; the restart lecture is no longer repeated.
- Forward live responses only. Missed replies are not replayed after disconnection or restart, and startup does not reattach old background observers. A new Slack message reattaches its thread to the saved native session.
- Slow model discovery has a 30-second allowance, and the searchable Slack picker handles large catalogs without a size-limited dropdown. Authorization and live Save validation remain in place.
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

Once published, install this exact beta with:

```sh
npm install --global @usepipa/pipa@0.6.0-beta.2
```

For an existing daily installation, schedule a separate maintenance window:

1. Stop/drain Pipa on its actual host and back up the existing profile (normally `~/.pipa`, or `.pipa` beneath `PIPA_HOME`). Keep the backup private.
2. Install the beta and keep the current OpenCode version. Do not rerun `pipa init`, recreate the Slack app or run competing listeners.
3. Start with the same profile, working directory and launch environment. Managed external clients require a shared explicit password; follow the [upgrade notice](../README.md#install).
4. Try conversations, same-thread history, questions/approvals, file input/output, routines and restart. Record the Pipa/OpenCode versions and a minimal reproduction for failures; never include tokens or private profile data.
5. Record the installed version before the trial. If it fails, stop the candidate and reinstall that exact previous version (for a first-beta installation, `npm install --global @usepipa/pipa@0.6.0-beta.1`). Stable `0.5.6` remains available but predates the v2 adapter; it is not a drop-in rollback for a v2-only setup. Preserve profile files and inspect partial side effects before retrying. Restore profile data only from a known stopped backup when needed.

Reinstalling Pipa does not reverse an OpenCode data upgrade. An engine upgrade
needs a separate matched-snapshot backup/rollback plan; see
[OpenCode compatibility](opencode-compatibility.md).

## Publisher checklist

Preparation can be committed and pushed to PR #58. Merge, release tags, GitHub
release creation, npm publication and daily installation require separate owner
authorization. Final npm publication is reserved for the owner.

1. Recheck PR feedback and required CI for the exact beta commit. Run the [controlled-beta checks](../CONTRIBUTING.md#controlled-beta), including the installed-package smoke and publish dry-run. Record limitations separately from passing checks.
2. Immediately before publication, run `npm view @usepipa/pipa dist-tags versions --json`. Confirm `0.6.0-beta.2` is still unused. At preparation on November 3, 2026, `beta` was `0.6.0-beta.1` and `latest` was `0.5.6`; neither `0.6.1` nor `0.6.2` was published. Stop if the registry changed unexpectedly.
3. After owner approval, merge PR #58, check out the actual merged commit in a clean release checkout, verify both package files say `0.6.0-beta.2`, and rerun the package checks/dry-run there. Tag that merged commit `v0.6.0-beta.2`; never tag the old feature head by mistake.
4. The owner publishes from that release checkout:

```sh
npm publish --tag beta --access public
npm view @usepipa/pipa dist-tags --json
```

5. Verify `beta` is `0.6.0-beta.2` and `latest` matches the value recorded before publishing. Verify the published version and create the authorized matching GitHub release as **Pre-release**, using the changes and limits above as its notes. Do not mark it stable/latest.
6. Arrange the daily-installation cutover separately. Later beta fixes increment the prerelease number; do not overwrite a published version.
