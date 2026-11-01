# U5: model discovery and native v2 switching

Verified on 2026-10-15, macOS ARM64, candidate Pipa 0.5.4 with
`@opencode/client` 2.0.29. Changes build on U4 commit `65d8a7f` on
`feat/opencode-v1-v2` and remain uncommitted.

Scope: R12, AE5, KTD8 and U5 of
`docs/plans/2026-10-13-1517-refactor-opencode-v2-migration-plan.md`.

## Implemented contract

- `executor.capabilities` is unknown before authenticated negotiation. V2
  advertises `modelDiscovery` and `liveModelSwitch`; v1 advertises neither.
  Capability metadata is not a readiness guarantee: operations still await
  readiness and reject blocked recovery or shutdown.
- `listModels({ workingDirectory, signal? })` returns enabled, provider-qualified
  models with variant IDs and the current native default. Catalog/default workspace
  identities are checked. Only public identifiers, names and variants are exposed;
  provider settings, headers and bodies are excluded.
- `switchModel({ sessionId, model, workingDirectory, signal? })` selects a native
  model on the existing session. A selection is `{ providerID, id, variant? }`.
  Availability, variant and session workspace are checked before mutation. A
  missing session is rejected, never replaced. Uncertain mutations are not retried.
- Both model operations participate in executor cancellation/shutdown and abort
  outstanding sibling discovery reads before releasing controller ownership.
- V1 normal execution is unchanged. No preference store or Slack picker/help UI
  was introduced.

## Measured semantics and boundaries

Native 2.0.29 accepts invalid model references without validating availability;
the facade validates against fresh discovery before sending a switch. Models with
identical IDs on separate providers remain distinct. The native harness covers
excluded providers, disabled models and unavailable variants.

Switching preserves session ID/history. An already-issued provider request stays
on its original model; the next provider step, including another step within the
same running tool loop, uses the new provider/model. The harness holds an actual
provider request at an observable barrier, switches through the production facade,
then verifies both provider receipts.

Omitted variants explicitly select `default`. A synthetic `measured` variant's
temperature reaches the provider; omitted and explicit default remove it.

**Reset is a snapshot selection, not inheritance.** Native 2.0.29 rejects a null
model and has no qualified clear-override operation. Facade `model: null` resolves
the current native default at request time and explicitly selects its default
variant. It does not clear an upstream override or promise to follow future
default changes. No available native default means reset rejects without mutation.

## Proof-first changes and review

Initial contract tests failed because the capability descriptor and discovery
method were absent. Focused assertions then covered provider identity, variants,
default/reset payloads, invalid choices, wrong workspace, missing sessions,
cancellation/shutdown and blocked recovery.

Code review: harness-native fallback. The dedicated `ce-code-review` invocation
could not dispatch its reviewers/validators in the child session; its failed
receipt is not counted as completed dedicated coverage. A separate read-only
review examined the actual diff, caller paths and error behavior and reproduced:

1. Discovery was not registered for shutdown cancellation. Two fetch-barrier
   regressions failed with missing rejection before the fix. Discovery now aborts
   both requests and rejects late valid responses after shutdown/caller cancellation.
2. When one parallel discovery read failed, its pending sibling lost cancellation
   ownership. Regressions for discovery and switching failed before the fix. Both
   operations now abort their controller in `finally` before unregistering it,
   retaining the original HTTP 401 error and preventing any switch mutation.

Independent follow-up review confirmed both fixes and reported no remaining
actionable findings in the bounded review. Its final focused model check passed
10 tests. Simplification reviewed reuse, quality and efficiency; no worthwhile
behavior-preserving change was needed. No cross-model corroboration was performed.

## Final verification

| Check | Observed result |
| --- | --- |
| `npm test -- --test-reporter=dot` | PASS, 319 tests |
| `npm run test:pack` | PASS: installed archive loads runtimes and exercises CLI/init/Managed smoke |
| Executor/contract plus harness self-check suites | PASS, 199 tests |
| `node --test --test-reporter=spec scripts/verification/self-check.mjs` | PASS, 21 checks |
| `git diff --check` | PASS |
| Separate lint/typecheck | Not configured |

The worker reran installed-package native qualification after the final cleanup
fix. Each cell uses a privately packed/installed candidate, a version-checked real
binary, disposable profile and deterministic local provider; it does not use the
live Pipa profile or visible Slack.

| Engine | Mode | Result |
| --- | --- | --- |
| 2.0.29 | Attached | 7/7 PASS |
| 2.0.29 | Socket-owned | 7/7 PASS |
| 1.19.0 | Attached | 3 PASS; 4 v2-only model cases native NOT_APPLICABLE |
| 1.19.0 | Socket-owned | 3 PASS; 4 v2-only model cases native NOT_APPLICABLE |

Selected cases: startup-readiness, exact-prompt-continuation, models-switch,
models-variants, models-default, models-reset and stop-ownership. All cell and
outer-package cleanup checks passed; attached engines survived Pipa shutdown.
The harness gate now requires the four model cases on v2 and permits only their
documented native non-applicability on v1.

Private, OS-temporary diagnostics are under
`/var/folders/5b/6vzm3bpx4yg089ybmp5kqhph0000gn/T/opencode/`:
`u5-packed.mjs`, `u5-native-<pin>-<mode>.json`, and the separate direct-native
characterization files `u5-characterize.mjs` / `u5-characterization.json`.
Direct characterization is distinct from the installed-package proof. Checked-in
release cases and this sanitized report are the durable evidence.

## Next unit and release status

U5 is locally complete. Next is U6: packaged CLI and detached restart
qualification, including the ownership/readiness boundary for both generations.
See its plan section and the existing restart/CLI harness before implementation.

These targeted cells are not full release qualification. Managed native cells,
1.18.35, Linux/Windows, separately hosted servers, remaining migration/operator
integration gates and real Slack/human-client/provider evidence remain outside
this U5 run. No commit, push, deployment, live installation, restart, merge or
release was performed.
