# Pipa 0.6.0-beta.1

Preparation notes for an opt-in beta. This document does not mean the version has
been published. Normal npm installs must continue to receive stable `0.5.6`
unless the owner separately approves a stable release.

## Changes from 0.5.6

- Pipa detects OpenCode v1/v2 and selects the matching API adapter. Updating Pipa does not install or upgrade OpenCode.
- Ordinary startup waits for OpenCode and Slack without a default overall deadline or migration-status check. Ctrl+C cancels startup; attached servers are not stopped.
- The v2 adapter preserves thread sessions and handles turn cancellation, questions, permissions and recovery of Pipa-owned work.
- Incoming files are limited to 10 MiB per file. Outgoing artifacts keep their separate 10-file/100 MB total limit.
- Windows stop uses native process-tree termination and retains the instance lock when termination cannot be confirmed.

## Trial and limits

This is a controlled daily-use trial, not stable certification of every platform,
provider, plugin or client. Local macOS smoke at implementation commit
`a9a5d7ed02dbad34c57f713b9016ac9cb1b92a9b` passed 24 real-engine observations
using OpenCode 1.19.0 and 2.2.5 in Socket-owned, attached and Managed modes. That
smoke uses scripted provider/Chat fixtures, not live Slack or paid inference.
Windows smoke passed on an earlier head, not on the latest startup-policy change.
Historical hosted startup failures remain recorded; they are not fresh results
for this beta. Full/manual qualification remains separate and `releaseQualified`
remains false. See [compatibility evidence](opencode-compatibility.md).

Once published, install the exact first beta with:

```sh
npm install --global @usepipa/pipa@0.6.0-beta.1
```

For an existing daily installation, schedule a separate maintenance window:

1. Stop/drain Pipa on its actual host and back up the existing profile (normally `~/.pipa`, or `.pipa` beneath `PIPA_HOME`). Keep the backup private.
2. Install the beta and keep the current OpenCode version. Do not rerun `pipa init`, recreate the Slack app or run competing listeners.
3. Start with the same profile, working directory and launch environment. Managed external clients require a shared explicit password; follow the [upgrade notice](../README.md#install).
4. Try conversations, same-thread history, questions/approvals, file input/output, routines and restart. Record the Pipa/OpenCode versions and a minimal reproduction for failures; never include tokens or private profile data.
5. If the trial fails, stop the beta before reinstalling the recorded stable version (`npm install --global @usepipa/pipa@0.5.6`). Preserve recovery evidence and inspect partial side effects before retrying work. Restore profile data only from a known stopped backup when needed; do not delete recovery journals to bypass cleanup.

Reinstalling Pipa does not reverse an OpenCode data upgrade. An engine upgrade
needs a separate matched-snapshot backup/rollback plan; see
[OpenCode compatibility](opencode-compatibility.md).

## Publisher checklist

Preparation can be committed and pushed to PR #39. Merge, release tags, GitHub
release creation, npm publication and daily installation require separate owner
authorization. Final npm publication is reserved for the owner.

1. Recheck PR feedback and required CI for the exact beta commit. Run the [controlled-beta checks](../CONTRIBUTING.md#controlled-beta), including the installed-package smoke and publish dry-run. Record limitations separately from passing checks.
2. Immediately before publication, run `npm view @usepipa/pipa dist-tags versions --json`. Confirm `0.6.0-beta.1` is still unused and record `latest` (it was `0.5.6` during preparation). Stop if the registry changed unexpectedly.
3. After owner approval, merge PR #39, check out the actual merged commit in a clean release checkout, verify both package files say `0.6.0-beta.1`, and rerun the package checks/dry-run there. Tag that merged commit `v0.6.0-beta.1`; never tag the old feature head by mistake.
4. The owner publishes from that release checkout:

```sh
npm publish --tag beta --access public
npm view @usepipa/pipa dist-tags --json
```

5. Verify `beta` is `0.6.0-beta.1` and `latest` matches the value recorded before publishing. Verify the published version and create the authorized matching GitHub release as **Pre-release**, using the changes and limits above as its notes. Do not mark it stable/latest.
6. Arrange the daily-installation cutover separately. Later beta fixes increment the prerelease number; do not overwrite a published version.
