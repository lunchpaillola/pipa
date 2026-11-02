# U7: compatibility guidance and operator qualification

Follow-up: [native blocker diagnosis and corrected qualification](opencode-native-blockers-verification.md)
supersedes the v2 synthetic integration failures below and characterizes the
remaining v1 limitations and installed operator-plugin blockers.

Date: 2026-10-15. Branch: `feat/opencode-v1-v2`. Starting/pushed checkpoint:
`dc997056766db7541791e4dc17e1142dd413a2a8` (U6). Candidate: Pipa 0.5.4,
client 2.0.29, Node 22.23.2, macOS ARM64.

**Local U7 documentation/tooling is implemented and checked. Operator/live and
release qualification remain blocked.** No live installation, cutover, Slack
posting, provider-backed live run, restart, merge or release was performed.
At verification time these changes were uncommitted; subsequent checkpoint and
push status is recorded in git. The plan body is unchanged.

## Delivered

- `docs/opencode-compatibility.md`: tested pins versus unqualified minimums;
  authenticated identity/readiness; remaining on v1 and deliberate v2 adoption;
  unchanged Slack/Pipa profile; complete matched snapshots and rollback;
  approvals/config/plugin implications; ownership/capability limitations and
  private operator/client checklist.
- README, contribution, repository overview, testing guide and harness README
  now distinguish delivered tooling from required unobserved release evidence.
- `scripts/slack-release-eval.mjs`: defaults to an inert shared-catalog checklist.
  Explicit `--run` collects real chat/history and both routine destinations;
  separately authorized `--restart` adds an outside-observer restart sequence.
  Human/client, operator integration and remote-host gates stay explicit.
- `scripts/slack-routine-eval.mjs`: reusable import-inert flow, exact saved
  prompt/schedule/timezone/destination, preview non-mutation, scheduled lifecycle,
  result-session continuation, subsequent-tick duplicate observation and
  nonce-only reconciliation.
- `scripts/verification/slack-eval.mjs`: authenticated private preflight,
  paginated/rate-limited Slack reads, no blind retry of ambiguous writes,
  credential-clean CLI environment, local app-scoped lock, durable generation/
  PID restart observation. Missing private inputs block before Slack access.
- `.env.example` lists implemented private inputs, with blank values and no
  operator-specific defaults; generated reports remain gitignored.

The live collector is deliberately not an aggregate release certifier. An
independent CLI/server probe is not proof of the running candidate's identity:
reported candidate package/engine/adapter remain null and `identityBinding` is
BLOCKED until external operator process/package/endpoint evidence binds them.
Mode is likewise an unverified operator selection. Observations must not be
attributed to a native cell merely because a different server passes preflight.

## Verification

| Check | Observed result |
| --- | --- |
| `npm test -- --test-reporter=spec` | PASS, **333/333** tests, no skips/failures |
| `npm run test:pack` | PASS, installed package loads both adapters/client and both generation CLI contracts |
| `node --test test/slack-eval.test.mjs scripts/verification/self-check.mjs` | PASS, **29/29** (7 live-tooling regressions + 22 harness checks) |
| `npm run test:slack:release -- --plan` | PASS, no network/mutation, applicable shared live gates listed BLOCKED |
| `env -u PIPA_HOME node scripts/slack-release-eval.mjs --run` | Expected nonzero BLOCKED; private report says `PIPA_HOME is required.`; no live calls |
| `git diff --check` | PASS |

No separate lint/typecheck script is configured. The first full-suite invocation
hit the terminal's 120-second deadline without a reported assertion failure;
the later full run used a sufficient deadline and passed in about 123 seconds.

Proof-first evidence: the initial new evaluator test failed with
`ERR_MODULE_NOT_FOUND` before helper implementation. Final focused tests cover
pagination/429 handling, refusal to retry an ambiguous write, incomplete pages,
exact saved routine input, durable restart identity, shared live checklist,
preview mutation, orchestration ordering, unbound metadata and lock retention.

## Native operator-transition rehearsal

One privately packed/installed candidate, integrity-checked exact native npm
binaries, isolated HOME/XDG/DB/config/workspace, synthetic provider only, real
production facade/state/engine, Socket-owned mode. The existing U9 cases and
migration journey were used unchanged. No live profiles or sole operator DBs
were read or migrated. The v1 seed/target/rollback copies were all disposable.

| Selected case | 1.18.35 | 1.19.0 | 2.0.29 |
| --- | --- | --- | --- |
| package-cli | PASS | PASS | PASS |
| init-identity | PASS | PASS | PASS |
| startup-readiness | PASS | PASS | PASS |
| exact-prompt-continuation | PASS | PASS | PASS |
| reload-location/history | PASS | PASS | PASS |
| plugin-reload-contract | FAIL | FAIL | FAIL |
| definitions-mcp-skill | PASS | PASS | BLOCKED |
| definitions-command | FAIL | FAIL | BLOCKED |
| migration-seed | PASS | PASS | Not selected: source-v1 journey |
| migration-upgrade | PASS | PASS | Target exercised through both source journeys |
| migration-rollback | PASS | PASS | Rollback uses pristine v1 copies, never v2-written data |
| stop-ownership | PASS | PASS | PASS |
| Cell/outer resource cleanup | PASS | PASS | PASS |

Final collection: **33 selected case observations: 26 PASS, 5 FAIL, 2 BLOCKED**.
All three cells and the outer package fixture cleaned up. The selected native
run correctly exited nonzero. This is not the full OS/mode/feature matrix.

Both source pins seeded actual history markers, thread mappings, active/inactive/
completed routines, configured deny rules and an in-service remembered approval.
After stopping writers, v2 continued mapped history on a copy before/after
restart and retained configured denial. Its approval reset was observed. Separate
pristine v1 rollback copies restored the original mappings/history/routines/rules;
remembered approvals reset across those service restarts too, without Pipa
inventing replacement grants. Pristine snapshot hashes remained unchanged.

### Concrete native release blockers

1. **V1 plugin reload (both pins):** location reload/history succeeded, but the
   hook still executed plugin version 1 after the private file was rewritten to
   version 2. The existing assertion failed `1 !== 2` rather than accepting stale
   module bytes as a successful reload.
2. **V1 file command (both pins):** the native CLI expanded the command into a
   provider request, but the enclosing production tool returned `(no output)`;
   the required command result was absent. The harness reports FAIL, not success
   based only on provider activity.
3. **V2 plugin/MCP port:** the legacy fixture configuration produced no plugin
   load log and no `matrix_nonce`/`mcp_matrix_nonce` tool. Plugin reload is FAIL;
   the MCP/skill combined case is BLOCKED at MCP, so **v2 skill execution is not
   proved by that row**. A required native port/configuration must be qualified.
4. **V2 file command:** actual `run --help` advertised `--server` but no
   `--command`; the legacy invocation cannot safely qualify that definition.

An initial diagnostic omitted `reload-location`, leaving plugin reload BLOCKED
on its prerequisite. Final collection included that prerequisite and exposed the
concrete failures above. No harness assertion or product requirement was relaxed.

Private OS-temporary diagnostics: `u7-packed.mjs`,
`u7-final-native-<pin>.json` under the session's preapproved OpenCode temp root.
They contain disposable paths/identities and are not durable dependencies.
The checked-in cases and `npm run test:engines -- --migration` are the reusable
execution path; this report is the sanitized result, not raw logs/config.

## Review and corrections

Simplification reviewed reuse, code quality and efficiency independently.
Applied: existing `slackDestinationId` reuse; shared reader authentication promise
instead of a duplicate Slack call; removed iteration-bound comment wording.

**Code review: harness-native fallback.** The dedicated review worker could not
complete the CE nested-dispatch/validator pipeline, so a separate read-only
review covered all current changed/untracked U7 files and relevant production
call paths. It identified three substantive issues, all corrected:

- Restart continuity now runs **before** an existing-thread routine intentionally
  remaps that thread to its fresh routine session.
- Failed observations do not report cleanup PASS from an empty routine listing.
  Agent settlement remains unconfirmed, the local app lock is retained, later
  cases stop, and operator drain/reconciliation is required.
- Independent server/CLI probes no longer claim the running candidate's engine,
  package or ownership identity; binding stays explicitly blocked.

Regression checks cover these changes. A read-only follow-up inspected the actual
files and reported no actionable residual correctness/security findings. No
cross-model corroboration was performed. Host full/focused/package checks are
the authoritative verification results above.

## Remaining work and release decision

U7 local tooling/documentation is ready for a checkpoint. Full operator/live
qualification is **not complete**. Resolve the native plugin/MCP/command failures
or qualify the required native ports, then collect a private operator inventory,
process-bound candidate identity and real Slack/provider/human-client evidence.
Actual Socket restart, post-restart scheduler recovery, required integrations,
separately hosted attached mode and the remaining Linux/Windows/full-matrix
evidence remain mandatory. Missing ports/evidence block release and affected
deployment claims. U1–U6 targeted passes are not substitutes for these gates.

Keep the current app/profile intact. Live app reuse, installation/cutover/restart,
commit/push and release require their own applicable current user instructions.
