# U3 interaction implementation and verification

Date: 2026-10-15. Branch: `feat/opencode-v1-v2`, based on U2 commit
`775a4ac`. This report accompanies the U3 implementation checkpoint; its
containing commit is the durable code/evidence reference.

## Implemented behavior

- Native v2 question forms retain their request IDs and ordered field keys,
  normalize into existing Slack choice/multiselect/custom-answer controls, and
  encode labels back to native keyed values. V1 keeps positional answer arrays.
- Native permissions preserve action, resources and source/tool detail; decisions
  use each generation's native payload. Parent/child ownership and workspace
  checks keep unrelated requests out of the thread.
- Optional `interaction.submit(decision)` and `interaction.settled` coordinate
  native acceptance with existing controls. Rejected answers keep the same card
  and token editable. Legacy callbacks still work without double submission.
- External settlement removes stale controls without resubmitting a decision.
  Lost acknowledgements reconcile authoritative native state before retry;
  disappearance alone is not attributed to confirmed local acceptance.
- Unsupported generic, numeric, conditional and external forms display an
  OpenCode-client-required notice rather than fabricated Slack answer controls.
- Existing fresh responder/routine authorization, exact-thread checks, queued
  interactions, cancellation and duplicate suppression remain covered.

## Native findings resolved

The first packed native run found two v2 failures:

1. The reload harness used v1's `/instance/dispose`; v2 requires
   `/api/location/reload`. V2 can also append a specific synthetic Code Mode
   catalog update. The deterministic provider now recognizes that envelope while
   still rejecting unregistered actual user prompts. Plugin-reload qualification
   remains separate from reload/history verification.
2. Root question dismissal can finish with aborted assistant/tool messages and
   execution shutdown without a projected idle. Pipa now journals the exact
   dismissal identity before cancellation, and requires its exact aborted
   question tool/assistant, cancelled or verified-absent form, empty inbox,
   no foreign input and no active root execution before considering this
   dismissal settled. This is not a general terminal-success fallback.

The initial v2 dismissal timeout also caused the subsequent stop case to time
out. Final packed runs pass both dismissal and stop ownership.

## Review and regression evidence

Code review: harness-native fallback — the dedicated `ce-code-review` invocation
failed before dispatch because its subagent session lacked nested reviewer tools.
A separate harness-native read-only review found three P2 defects, all fixed:

- V1 now retains external settlement events received during an uncertain reply,
  so a delayed stale pending snapshot cannot erase the newer event.
- V2 tracks outstanding submission promises and awaits bounded acknowledgement
  or reconciliation before terminal-result evaluation/finalization. An accepted
  local response is not prematurely labelled external; acknowledged permission
  rejection is recorded before evaluating an empty-text completion.
- Optional v1 tool hydration falls back to basic permission details on lookup
  failure and evicts failed cached promises, rather than losing the approval.

Barrier regressions failed before their production fixes, then passed. They cover
both v1 question settlement events, hydration 503/reconnect, and delayed, lost and
timed-out v2 question/permission-rejection replies with terminal state exposed
before acknowledgement. Negative dismissal checks reject wrong tool identity,
still-active execution and pending forms. A focused follow-up review confirmed
all three original findings resolved by inspection with no new blocking finding.
The reviewer could read files but not execute checks; test execution was owned
by the implementation agent and main session.

The simplification pass consolidated repeated v1 pending-reconciliation logic.
Cross-suite test-helper extraction, nesting-only rewrites, and additional polling
caches/concurrency coordination were skipped as unnecessary changes for U3.

## Final observed checks

Environment: macOS ARM64; installed package candidate version 0.5.4; native client
2.0.29. Native engines were separately version-checked. No global binary replaced.

| Check | Result |
| --- | --- |
| `npm test -- --test-reporter=dot` | PASS, 305 tests |
| `npm run test:pack` | PASS |
| `node --test --test-reporter=spec scripts/verification/self-check.mjs` | PASS, 21 checks |
| Focused app/executor/contract suites plus harness self-check | PASS, 250 checks |
| `git diff --check` | PASS |

The final candidate was packed, installed in a private fixture and tested using
the existing production-path native harness:

| Native engine | Attached | Socket-owned | Resource cleanup |
| --- | --- | --- | --- |
| 1.19.0 | 9/9 PASS | 9/9 PASS | PASS |
| 2.0.29 | 9/9 PASS | 9/9 PASS | PASS |

Each cell includes startup readiness, exact prompt/history continuation, question
and protected-tool permission controls, event reconnect, location reload,
multiselect/custom/dismissal, rejected-answer submission seam/retry, delegated
child question/permission routing, and stop ownership. Question variants assert
one admission and one control each. These are real engines with deterministic
model and fake Chat transport; they do not prove visible Slack client behavior.

Machine-local diagnostic runner and final raw reports are under
`/var/folders/5b/6vzm3bpx4yg089ybmp5kqhph0000gn/T/opencode/`:

- `u3-review-packed.mjs`
- `u3-review-native-1.19.0-attached.json`
- `u3-review-native-1.19.0-socket-owned.json`
- `u3-review-native-2.0.29-attached.json`
- `u3-review-native-2.0.29-socket-owned.json`

Those OS-temporary diagnostics are not durable repository dependencies. Keep raw
reports private; they contain disposable paths and process identities. Earlier
`u3-native-*` reports preserve the initial failures; `u3-fixed-native-*` reports
precede the final review-race fixes.

## Qualification boundary

U3's implementation and targeted local verification are complete. This is not
full migration/release approval: native 1.18.35, Managed interaction cells,
Linux/Windows, a separately hosted remote server, and human-operated real Slack
controls were not exercised in this U3 run. Plugin/configuration compatibility,
broader approval migration, full crash/restart journeys and later U4–U7 work
retain their separate gates. No live installation or Pipa restart occurred.
