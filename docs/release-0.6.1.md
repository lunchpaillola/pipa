# Pipa 0.6.1 stable release preparation

**Draft only; not published.** The owner selected stable `0.6.1`, not beta.
The GitHub draft must have `draft: true` and `prerelease: false`.
Neither a draft nor this version-bump PR authorizes tagging, npm publication,
installation, or restart. npm `latest` was `0.6.0` and `beta` was
`0.6.0-beta.5` at preparation; recheck before any separately approved publication.

GitHub draft: [Pipa 0.6.1](https://github.com/lunchpaillola/pipa/releases/tag/untagged-a2f9159b3380de63506d),
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

1. Review this metadata/docs PR and its exact-version checks/CI. Merge requires
   approval separate from the already-merged feature PR. The main-branch package
   remains `0.6.0` until this version bump is merged.
2. Resolve the stable qualification requirements in
   [CONTRIBUTING](../CONTRIBUTING.md#stable-release); retain every missing or failed
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
