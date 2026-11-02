# OpenCode V1/V2 Review Checkpoint

Collected 2026-11-01. This candidate is ready for code review, not release or
production cutover. Keep the PR draft until the remaining support decisions and
required release evidence are resolved.

## Latest Fixes

- Native v2 can abort a rejected tool without emitting an idle event. Pipa now
  settles that turn with a stopped notice only after durable rejection
  acknowledgement and exact native tool/ownership/inactive-state confirmation.
  Unknown acknowledgement and failed persistence retain recovery state and block
  intake rather than claim success.
- Compressed native admission responses can leave body reads pending after a
  network abort. The existing adapter bounds body settlement and reconciles
  accepted input without replay.
- Recovery verification now exercises replacement executors at the existing
  crash boundaries. Changed v1 plugin bytes use the approved full native-process
  restart, not a new hot-reload implementation.

No new recovery subsystem, dependency upgrade or release version bump was added
for these fixes. The integrated package remains 0.5.6 and the SDK remains 2.0.29.

## Verification

The preserved local reports bind the installed archive to the candidate runtime
source. Native-engine tests use deterministic model/Chat fixtures unless noted.

| Check | Result |
| --- | --- |
| Serial default test suite | 426 passed |
| Focused harness/contracts | 184 passed, including 26 harness checks |
| Installed-package smoke | Passed |
| Native core on 1.18.35, 1.19.0, 2.0.29, 2.2.5 | Startup, history, questions, Allow once/Reject and owned stop passed |
| Full native v2, both pins/all three modes | 240 PASS observations, zero FAIL; deterministic gate and cleanup passed |
| Full native v1, both pins/all three modes | Core passed; `definitions-command` still FAIL; recovery/transition blockers retained |
| Independent migration and matched rollback from both v1 pins to 2.2.5 | Passed |
| Dedicated isolated Slack app with live Big Pickle | Mention/context, Reject/stopped/context recovery, exact outgoing file bytes and isolated restart/context passed |
| Small incoming text attachment, live native/model path | One 47-byte check passed on 1.19.0 and 2.2.5; not a new Slack end-to-end pass |

Immediately before committing, the existing rejection and admission-body
regressions were rerun: 18 passed. A focused static review found no actionable
new issue. No broad native matrix was repeated for the commit operation.

The attachment comparison found no reproducible v2-only defect. It does not
establish inline provider serialization: v2 used native read/glob tools. The
earlier failed Slack incoming-file attempt remains recorded as failed. Do not
expand attachment/model combinations without a concrete defect.

## Remaining Decisions

- V1 pending-approval recovery after executor death needs an explicit support
  decision. There is no durable v1 turn-owner journal; do not cancel foreign work.
- V1 has no separate durable instruction-registration boundary. Its applicability
  needs correction by agreement, not a fabricated passing result.
- Native v1 attached `run --command` has a missing-output race. Standalone commands
  passed on both v1 pins, but use separate sessions. Accepting that limitation as
  the supported alternative still needs approval.
- Required other-platform, private provider/operator, remaining live controls and
  bounded soak/final review evidence is incomplete. No existing gate is waived.

Private Slack credentials, profiles, databases, raw live receipts and the
machine-local qualification ledger are intentionally not committed. The test
consumer is stopped; its historical uncertain journal is preserved. Production
Pipa and other installed bots were not changed.

Public verification entry points and isolation requirements remain in
[`scripts/verification/README.md`](../../scripts/verification/README.md) and
[`CONTRIBUTING.md`](../../CONTRIBUTING.md).
