# U4 orchestration implementation and verification

Date: 2026-10-15. Branch: `feat/opencode-v1-v2`, based on U3 checkpoint
`fb1aa6e`. Scope: U4, R4/R10/R11 and AE2/AE4 in
`docs/plans/2026-10-13-1517-refactor-opencode-v2-migration-plan.md`.

## Implemented behavior

- Superseded Slack messages lose their pending receipt reaction when the latest
  turn finishes, without receiving a stale success checkmark. Only the latest
  message receives its outcome reaction.
- V1 cancellation now belongs to the prepared execution lifetime, as it does for
  v2. The facade retains the active writer until native cleanup finishes. This
  covers signal cancellation and `stopAll`, not only explicit `abortTurn` calls.
- V1 prompt admission has an independently bounded five-second acknowledgement.
  A cancelled HTTP request must not allow late admission after an early native
  abort. Cancellation waits for acknowledgement before aborting native work.
  The deadline applies to admission HTTP only, not model/tool execution.
- Uncertain v1 admission and failed cancellation block further adapter intake
  rather than silently replaying a prompt. The operator must reconcile native
  work before starting a fresh executor; this is not durable crash replay.
- V1 native abort leaves pending questions behind. Cancellation therefore aborts
  the root, reconciles pending requests with an independent cleanup signal,
  verifies child ancestry and workspace, aborts verified children, and rejects
  only owned questions/permissions. Previously cancelled ancestry lookups cannot
  poison cleanup. Pending requests created while admission acknowledgement is
  delayed are included even if the original watcher never saw the child.
- Scheduler and v2 production code needed no changes. Existing scheduling,
  authorization, context recovery and delivery rules remain shared across engines.

## Harness corrections and new coverage

Targeted startup now saves the private config it needs rather than depending on
the earlier package-CLI case. Initial targeted routine failures came from that
missing setup, not a production scheduler defect.

The background case now characterizes the real v1 behavior and compares v2 to it:
the parent foreground result returns while a deliberately held native background
child is pending. After the child is released, its result reaches parent history
and is retained on an ordinary continuation. Pipa adds no late-result delivery or
background notification policy. The former assertion that foreground completion
must wait for the background child contradicted this measured v1 baseline and
the plan's KTD10 compatibility boundary.

The new `shutdown-active-work` production-path case separately covers a root
question, child question, child permission, quiet root tool, and quiet child tool.
Shutdown removes controls, prevents success delivery/reactions, rejects new work,
terminates actual tool processes, and drains attached native pending requests and
active execution while preserving the independently owned server.

## Regression and review evidence

Proof-first failures were observed for:

1. The superseded-message reaction expectation.
2. Native child cancellation and pending request draining.
3. Cancellation of a delayed admission acknowledgement.
4. A child permission first discovered after cancellation, alongside an unrelated
   wrong-workspace request that must receive no native mutation.

The last race was found in review, reproduced as a failing barrier regression,
then fixed. Successful cleanup permits readiness; uncertain admission blocks
readiness and a second prompt admission. Existing attachment/artifact cancellation
tests now explicitly release the held HTTP acknowledgement before checking file
cleanup, instead of treating cancellation of the admission request as settlement.

Simplification reviewed reuse, quality and efficiency. It removed obsolete
background polling/probe state and parallelized independent cleanup operations.
No new dependency or scheduler/protocol abstraction was introduced.

Code review: harness-native fallback — the dedicated `ce-code-review` invocation
could not dispatch its nested reviewers. A separate read-only reviewer inspected
the exact uncommitted patch and caller paths. Follow-up review confirmed the
late-child fix and reported no actionable findings. That reviewer could not run
commands; verification was executed by the implementation session.

## Final observed checks

Host: macOS ARM64. Installed candidate package: 0.5.4. Client: 2.0.29.
Native binaries were separately version-checked; each cell used private profiles,
workspaces, configuration and process ownership with a deterministic provider.

| Check | Result |
| --- | --- |
| Pre-change `npm test -- --test-reporter=dot` | PASS, 305 tests |
| Final `npm test -- --test-reporter=dot` | PASS, 309 tests |
| Focused executor/contract/app suites | PASS, 233 tests |
| `npm run test:pack` | PASS |
| `node --test --test-reporter=spec scripts/verification/self-check.mjs` | PASS, 21 checks |
| `git diff --check` | PASS |

No separate lint/typecheck command is configured in this plain-ESM project.

| Engine | Attached | Socket-owned | Cleanup |
| --- | --- | --- | --- |
| 1.19.0 | 14/14 PASS | 14/14 PASS | PASS |
| 2.0.29 | 14/14 PASS | 14/14 PASS | PASS |

The installed-package checks use the exported `runCell` targeted diagnostic seam
in `scripts/verification/opencode-release-cases.mjs`, with these case IDs:

```text
startup-readiness, chat-continuation, supersession-concurrency,
supersession-reaction-contract, routine-once, routine-recurring,
routine-revocation, routine-overlap-recovery, routine-deactivate-delete,
shutdown-active-work, delegated-child, background-child,
background-result-attribution, stop-ownership
```

Routine evidence includes actual due scheduler dispatch of exact saved prompt
bytes, channel/existing-thread result mapping and session continuation, destination
revocation, overlap prevention, another routine proceeding independently, pending
run-request preservation across app shutdown/start, missed-occurrence handling,
and deactivation/deletion cancellation. Existing deterministic suites retain
edit/merge, strict-future, DST and long-horizon scheduling coverage.

Raw `u4-native-<pin>-<mode>.json` reports and the `u4-packed.mjs` runner are private
machine-local OS-temporary diagnostics. The committed harness cases and this
sanitized report are the durable references; raw reports contain disposable
paths/process identities and should stay private.

## Qualification boundary and continuation

U4 implementation and targeted local qualification are complete. These four
cells do not establish the full release matrix: native 1.18.35, Managed native
qualification, Linux/Windows, separately hosted servers, migration/plugin and
human-operated real Slack gates retain their separate release requirements.
The native transport here uses fake Chat, not a visible Slack client.

The next implementation unit is U5: connected-model/variant/default discovery
and native v2 live switching, preserving history and honest v1 capabilities.
U6/U7 and release qualification follow. No live installation, deployment or
restart occurred. The delivery handoff records the eventual commit/push checkpoint.
