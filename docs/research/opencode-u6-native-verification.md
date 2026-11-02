# U6: packaged CLI and detached restart qualification

Verified on 2026-10-15, macOS ARM64, candidate Pipa 0.5.4 with
`@opencode/client` 2.0.29. Builds on pushed U5 checkpoint `3881822` on
`feat/opencode-v1-v2`. U6 changes are local and uncommitted at this report.

Scope: U6 and its R1/R3/R4/R10 requirements in
`docs/plans/2026-10-13-1517-refactor-opencode-v2-migration-plan.md`.
The U8 prerequisite infrastructure is present: private runtime fixtures, ownership
supervision, native wire contracts and the external restart observer. U6 exercised
these without modifying the plan or the live Pipa profile.

## Changes and evidence boundaries

- `scripts/pack-smoke.mjs` now privately packs/installs the candidate and verifies
  both adapters/client plus CLI/init/routine preview/Managed behavior using both
  generation contracts. It uses existing isolated fixtures and verifies intended
  integration environment inheritance and exclusion of synthetic Slack secrets.
- `test/cli.test.mjs` exercises detached Managed restart for both generations:
  ready, unready, startup failure, authentication failure and wrong-generation IPC.
  An observable workspace barrier proves authenticated identity alone cannot
  complete a restart. Successful replacement outlives the worker; failures retain
  configuration and clean up owned runtime/locks. Existing bounded timeout and
  unconfirmed-outcome tests remain in the restart suite.
- `test/restart.test.mjs` strengthens integration-variable inheritance and
  synthetic-secret exclusion across watcher/worker/replacement boundaries.
- `scripts/verification/opencode-release-cases.mjs` adds a required Socket/attached
  installed-CLI restart case and strengthens Managed post-restart native tool
  execution. Gate self-checks reject missing/failed restart evidence in each
  applicable mode.
- New `scripts/verification/socket-cli-fixture.mjs` is a private deterministic
  preload. It supplies fake Chat/auth to the **installed candidate's** app; CLI,
  watcher, worker, facade, scheduler and native engine remain actual code. It is
  explicitly injected only into owned disposable test processes. This is not
  real Slack Socket transport or human-client qualification.

No production lifecycle fix was necessary. No runtime preference, release version,
live process or user configuration changed.

## Characterization, proof-first review correction and simplification

Before implementation, installed native Managed cells on 1.19.0 and 2.0.29 passed
restart, bind-failure/unready cleanup and follow-up characterization. Initial
fixture-development failures involved a relative working directory and missing v1
status route; they were corrected and are not production red/fix evidence.

Code review: harness-native fallback. A dedicated `ce-code-review` invocation
could not dispatch nested reviewers/validators; its failed receipt is not a
completed dedicated review. A separate read-only review traced the actual diff
and installed process paths, and found a verification false positive: stored
routine bytes were exact, but provider substring matching could hide trimming at
dispatch after restart.

The fixture now observes real native admission requests inside the restarted
process and forwards requests/responses unchanged. Sanitized receipts contain
method, route, exact prompt and response status, without credentials/headers.
Assertions require one nonce-matched admission, replacement PID, successful
status, exact prompt equality and a native session matching the delivered result's
persisted mapping. A deliberately injected `snapshot.prompt.trim()` at scheduler
dispatch made the installed 2.0.29 Socket-owned case fail specifically with
`prompt fidelity: exact prompt bytes`, despite completed model execution and
successful cleanup. The injected mutation was removed before final checks.

A small self-check covers both native payload shapes and rejects mutated prompts,
wrong PID/session, rejected admissions and duplicates. Independent follow-up
review confirmed the correction and reported no actionable residual findings.
It ran 22 self-checks; no cross-model corroboration was performed.

Simplification reused the existing applicability-assertion loop and narrowed one
mutable lock variable to a local constant. Safety, readiness and two-tick scheduler
barriers were retained.

## Final local checks

| Command | Observed result |
| --- | --- |
| `npm test -- --test-reporter=dot` | PASS, 326 tests |
| `npm run test:pack` | PASS, installed candidate with both 1.19.0 and 2.0.29 CLI contracts |
| `node --test --test-reporter=spec scripts/verification/self-check.mjs` | PASS, 22 checks |
| Focused restart plus harness checks after admission correction | PASS, 46 tests |
| `git diff --check` | PASS |
| Separate lint/typecheck | Not configured |

## Installed-package real-native matrix

The final run used one privately packed/installed candidate across all cells.
The runner verified each executable's reported version. It used isolated homes,
workspaces and profiles, a deterministic provider, and owned resource teardown.

| Engine | Managed | Socket-owned | Attached |
| --- | --- | --- | --- |
| 1.18.35 | 8/8 PASS | 6/6 PASS | 6/6 PASS |
| 1.19.0 | 8/8 PASS | 6/6 PASS | 6/6 PASS |
| 2.0.29 | 8/8 PASS | 6/6 PASS | 6/6 PASS |

**Total: 9/9 cells, 60/60 selected cases passed.** All cell and outer-package
cleanup checks passed. No common scenario was waived as native N/A.

All cells cover installed version/help/preview, init identity, authenticated
startup readiness, exact-prompt/history continuation and ownership-sensitive stop.
Managed cells additionally cover real detached restart, startup failure and
unready cleanup. Socket/attached cells cover the new detached restart sequence:

1. Establish a real native session and persist a whitespace-sensitive routine.
2. Request restart twice concurrently; both requests join the old generation.
3. Independently observe durable completed state, a new PID/generation, old process
   clearance and worker exit; replacement remains alive afterward.
4. Observe exactly one ready notice in the requested fake-Chat thread.
5. Continue the original session/history and settle a real native tool permission.
   The tool verifies intended integration variables and absent synthetic Slack
   secret variables.
6. Resume the persisted routine through the production scheduler; verify exact
   native admission bytes and attribution, scheduled trigger, one routed result
   and no duplicate after further scheduler reconciliation.
7. Stop the replacement and verify owned port/process/lock cleanup. For attached
   mode, independently owned engine PID/health survive restart and stop until
   fixture teardown.

Private OS-temporary execution recipe:

```sh
U6_PHASE=final U6_PINS=1.18.35,1.19.0,2.0.29 \
U6_MODES=managed,socket-owned,attached \
node /var/folders/5b/6vzm3bpx4yg089ybmp5kqhph0000gn/T/opencode/u6-packed.mjs
```

Private diagnostics in the same temporary directory:
`u6-final-<pin>-<mode>.json` for all nine cells;
`u6-characterization-{1.19.0,2.0.29}-managed.json` for pre-change characterization;
`u6-red-trim-2.0.29-socket-owned.json` for deliberate-defect proof. These contain
disposable identities/paths and remain private. Checked-in harness cases and this
sanitized report provide the durable evidence.

## Next unit and remaining release qualification

U6 is locally complete. Next is U7: operator compatibility, migration/rollback
documentation and real Slack evaluation, following its plan section and the
current verification reports. Release-wide requirements still include remaining
matrix scenarios, Linux/Windows native execution, actual Slack Socket transport
and human-client evidence, separately hosted attached-server coverage, and private
operator integration/plugin qualification. Local Windows descendant-cleanup
tests remain passing but are not native Windows evidence.

No live installation/restart, merge or release occurred. The U5 checkpoint was
committed and pushed; this U6 report does not imply that U6 changes were pushed.
