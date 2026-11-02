# OpenCode harness baseline — Part 1

Observed 2026-10-14 on macOS ARM64, Node 22.23.2, installed Pipa 0.5.4.
Branch: `feat/opencode-v1-v2`. Scope: U8/U9 testing environment and harness.

**The harness is implemented and locally verified. The migration is not
release-qualified.** Production runtime files have not been ported yet.

## Reproduce

```sh
npm test
npm run test:pack
node --test scripts/verification/self-check.mjs
npm run test:engines -- --baseline --migration --gate=deterministic
```

See [`scripts/verification/README.md`](../../scripts/verification/README.md) for
selection options, private evidence paths, gate semantics and cleanup behavior.
The baseline label never converts compatibility failures into success.

## Observed verification

| Check | Result |
|---|---|
| Full suite before harness changes | 169 passed |
| Full suite after harness changes | 196 passed |
| Installed-package smoke check | Passed before and after changes |
| Final focused contract + harness self-checks | 41 passed |
| Real engines | All 3 pins × 3 modes collected on macOS ARM64 |
| Cleanup | Passed in all 9 cells and the outer supervisor |
| Compatibility command | Exit 1; failures and blocked coverage retained |
| Linux/Windows native execution | Not executed on this host; blocked qualification |

The final engine collection contains 54 named cases per cell: **164 PASS,
80 FAIL, 227 BLOCKED, 15 native NOT_APPLICABLE** observations. These are case
observations, not 486 independent product features or passing release tests.
Counts include mode-inapplicable/live rows retained for transparency.
Subsequent pure gate-selection tests verified deterministic/release selection
against this same collected evidence; engine cases were not rerun for metadata
selection alone. Both gates remain nonzero.

## Working v1 behavior characterized

Both 1.18.35 and 1.19.0 passed the applicable executed checks for exact prompts,
session/history continuation, independent threads and cancellation/replacement
delivery; real questions and protected tools; local/data-URI image/document
bytes; outgoing artifacts above 20 MiB and upload fallback; actual due one-time
and recurring routines, destination revocation and result-thread continuation;
overlap/deactivation/deletion; attached ownership; and Managed detached restart,
bind-failure and unready-replacement cleanup.

Real stdio MCP, file-based skills/agents and plugin loading also ran. These
synthetic definitions do not qualify an operator's private integrations.

For each v1 pin, synthetic histories, mappings, three routine states, configured
denial and a remembered approval were seeded. Stopped whole-profile snapshots
and matched v1 rollback passed in all six v1 cells. V2 upgrade attempts failed
at existing production startup; actual successful cross-version history
migration remains unproven. V1 remembered approvals also reset across service
restart in the observed journey; Pipa did not reconstruct grants.

## Baseline failures retained for implementation

- **V2 identity/startup:** current init rejects v2; owned/Managed launch uses
  uppercase `ERROR`, which v2 rejects. Attached readiness uses the legacy route.
- **V2 execution:** the current facade sends v1 requests and receives HTTP 405.
  Dependent file, interaction and migration failures are recorded, not hidden.
- **Incoming limit:** current v1 behavior accepts 20 MiB + 1 decoded bytes and
  downloads files whose metadata exceeds the approved new limit. These are
  expected pre-port R8 gaps, not regressions introduced by the harness.
- **Supersession reactions:** replaced messages receive a success reaction after
  replacement settlement even though stale result delivery is suppressed.
- **Native plugin reload:** modified private plugin code retains old module bytes
  in the tested v1 reload sequence.
- **Background completion:** the public executor can return while a deliberately
  held native background child is unfinished. This is a characterization result;
  it does not authorize a new background UX or completion-policy change.
- **File command output:** native file-command expansion reached the provider,
  but its result was absent from the parent tool stdout in this probe. Diagnose
  that integration expectation before classifying it as a Pipa runtime defect.

## Harness validation and review fixes

Mutation/self-checks reject wrong versions, unexpected provider requests,
malformed wire envelopes/events, forbidden or duplicate v1/v2 admissions,
incorrect output/session/file bytes and failed cleanup. Killed nested workers,
detached replacements, exited group leaders, unrelated sibling processes and
changed PID identities have focused cleanup regressions.

Code review found and the implementation fixed: supervisor/cell deadline and
nested-process ownership gaps; v2 `body.text` omissions in negative admission
assertions; and missing named crash-boundary evidence. Scheduler observation
uses actual reconciliation barriers rather than fixed 250 ms sleeps. Crash
barriers keep the worker alive until the observer deliberately kills it.

## Explicit remaining coverage

- Instruction registration and abandoned admission/context startup recovery
  require the later adapter/recovery seams. Real abrupt death was exercised at
  admission, approval and completion, but those partial probes remain BLOCKED
  for full recovery qualification rather than counting as passes.
- Native reply acceptance/retry, editable real Slack controls, and native model
  discovery/switching/variant/default/reset semantics remain unqualified.
- Full Socket CLI restart, actual Slack/client controls/uploads, real-provider
  inference, separately hosted servers and private integrations require the live
  lane and operator inputs.
- Linux/Windows native matrix evidence remains outstanding. The added workflow
  defines no-secret OS jobs; adding that file is not evidence those jobs ran.

The next implementation dependency is **U1: authenticated runtime detection and
lifecycle**, followed by the adapters in the existing plan. Preserve these
baseline observations and rerun the identical cases during the port.
