# Pipa 0.6.1 stable release preparation

**Draft only; not published.** The owner selected stable `0.6.1`, not beta.
The GitHub draft must have `draft: true` and `prerelease: false`.
Neither a draft nor this version-bump PR authorizes tagging, npm publication,
installation, or restart. npm `latest` was `0.6.0` and `beta` was
`0.6.0-beta.5` at preparation; recheck before any separately approved publication.

GitHub draft: [Pipa 0.6.1](https://github.com/lunchpaillola/pipa/releases/tag/untagged-7b86c2cf25104c663eb4),
release ID `447679446`. Its provisional target is the feature merge below, not
a merged `0.6.1` version-bump commit.

## Changes

[PR #74](https://github.com/lunchpaillola/pipa/pull/74) was squash-merged as
`1ab406823e9436698ffccd70e9678d5ee86d1014`, with the same tree as tested head
`ca67d67293af5e24237b0f6a1befad102cb42067`.

- Init/start notices explain which Slack capability is unavailable and connect
  it to the permission needed to enable it. Healthy grants stay silent.
- Generated scopes, typing/status behavior and silent handling of unavailable
  grant metadata remain unchanged. `chat:write` currently suffices for status;
  missing the transitional alternative `assistant:write` alone produces no notice.
- Permission rules/copy live in a focused internal module, not the app orchestrator.
- Reaction rejections are caught, but a slow/pending receipt reaction can delay
  replies because it is awaited before enqueueing. Scheduling is unchanged.

## Evidence and limits

### Slack history removal

[PR #76](https://github.com/lunchpaillola/pipa/pull/76) was squash-merged into
the release branch as `5906b29095ec60e796b3d1fad647f913ef5d29d9`.
Pipa no longer fetches or injects prior Slack messages when assembling any turn.
The current request, attachments/full links, channel/thread identity, explicit
Slack tools and authorization remain available. Agents receive a short
read-on-demand instruction. Existing OpenCode history is not cleared or rewritten.

The fix head passed 557 full-suite tests, installed-package checks and Linux CI.
The test count fell because tests for the removed history loader were removed;
authorization, cancellation and queue coverage were retained. Fresh and existing
session regressions failed before the fix and pass afterward.

Fresh release-branch checks passed the 28 verification self-checks and installed
package smoke for all three existing engine contracts. Stable publish dry-run
contains 15 expected public files, reports `0.6.1`, and includes the history fix.
All three package/lock version fields match. No package was published.

Fresh Linux/macOS native matrix and migration collection was dispatched in
[this workflow](https://github.com/lunchpaillola/pipa/actions/runs/43984076115).
Dispatch is not a passing result or whole-release qualification. Live Slack and
operator/client gates remain separate; the running profile was not changed.
npm authentication returned E401; the publisher must sign in before publication.
Registry checks still show `latest: 0.6.0`, `beta: 0.6.0-beta.5`, and no `0.6.1`.
The fresh audit still reports two high-severity transitive findings (`axios` and
`follow-redirects`); dependency changes were not mixed into this fix.

### Prior permission-guidance evidence

The exact feature head passed 171 focused tests, 569 full tests, package smoke
for the existing 1.19.0/2.0.29/2.2.5 contracts and
[Linux CI](https://github.com/lunchpaillola/pipa/actions/runs/43956882603).
Executed isolated init/start capture covered healthy, missing-reply-permission
and optional/private-channel losses, plus delivery through rejected status/reactions.
Those are deterministic fixtures, not Slack enforcement or native qualification.

The authorized healthy-grant live Slack check verified real Socket ingress,
zero startup notices, accepted status API calls and receipt/result reactions.
One [scripted retry reply](https://lunchpaillabs.slack.com/archives/C0CB4GFH6HG/p1794866032914469)
succeeded. Earlier strict-input and turn-limit scratch-executor failures remain
failures; this was not two successful scripted exchanges. Visual typing rendering
and live missing-scope enforcement were not verified. The test-owned listener
and executor stopped at 21:54:17 UTC; process exit and isolated-state cleanup
were verified. No paid inference or production installation was used.

The `0.6.1` preparation tree passed 569 full tests, installed-package smoke
(packed CLI reported `0.6.1` for all three contract pins), and 28 verification
self-checks. The stable publish **dry-run only** reported `0.6.1` with 15 expected
public files, including the new internal permissions module and no profile data.
All three version fields match; the dependency graph and other package metadata
are unchanged. Preparation-PR CI and clean merged-release checks remain separate.

The existing stable-release qualification requirements still apply; the
`0.6.0` metadata-only evidence exception does not extend to this runtime change.
No fresh native/platform matrix, migration/rollback or full live-client
qualification is claimed. Stale-lock/PID-reuse and dependency-security follow-ups
remain unresolved; see [the prior release notes](release-0.6.0.md).

## Remaining release gates

1. Review the combined release PR and its exact-version checks/CI. The owner
   authorized squash-merging the fix and preparing publication. The main-branch package
   remains `0.6.0` until this version bump is merged.
2. Resolve the stable qualification requirements in
   [then-current CONTRIBUTING guide](https://github.com/lunchpaillola/pipa/blob/db0b55f/CONTRIBUTING.md#stable-release); retain every missing or failed
   observation. Preparation is not whole-release qualification.
3. After the version-bump PR is merged, retarget the GitHub draft to that actual
   merged release commit. Recheck all three package/lock version fields, package
   smoke and stable publish dry-run from a clean checkout. Do not tag the feature
   merge while it still says `0.6.0`.
4. Obtain explicit tag/npm/public-release approval. Recheck the unused version/tag,
   npm identity/rights and current dist-tags. The human publisher uses the stable
   `latest` channel, never `beta`; verify version/integrity and preserve `beta`.
5. Publish GitHub notes only after verified npm publication and explicit approval.
   Production upgrade remains a separate backup/cutover; follow the existing
   [upgrade guide](../README.md#upgrading-an-existing-installation) and
   [compatibility/rollback guide](opencode-compatibility.md). Do not rerun init.
