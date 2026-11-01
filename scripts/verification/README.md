# OpenCode compatibility harness

Run from the repository with Node 22 or newer:

```sh
npm test
npm run test:pack
node --test scripts/verification/self-check.mjs
npm run test:engines -- --baseline --migration --gate=deterministic
```

The engine command installs one Pipa tarball and verifies private native binaries
for OpenCode **1.18.35, 1.19.0, 2.0.29, and 2.2.5**. It exercises Socket-owned, Managed,
and attached connections. Only the model and Chat transport are deterministic
fixtures; engine execution, tools, state, scheduler and Managed CLI restart are
real. No Slack or paid-provider credentials are required.

Native **2.2.5** is the current v2 qualification target; **2.0.29** remains a
historical comparison pin. The SDK stays pinned to `@opencode/client@2.0.29`
pending real qualification. Pin inclusion is not evidence of a passing native
run or release readiness, and historical reports retain their recorded versions.

The v2 crash cases SIGKILL a private runner/executor at instruction registration,
admission, pending approval, and completion before delivery. A separate replacement
reconciles the same recovery journal against the surviving native engine before
explicit follow-up. Assertions cover owned-only context cleanup, foreign context
retention, history, no replay/stale interactions, and one follow-up delivery.
These are executor recovery checks, not whole Socket application death or routine
crash-window proof. Unresolved or malformed journals prevent private-root cleanup.
Workers emit case IDs/statuses, and command timeouts retain bounded captured output
so a stalled full run identifies its last started case without logging prompts.
For v1, plugin changes use the approved full native-process restart, with the
attached engine restarted only by its independent test owner. V1 replacement
probes retain completed history and wait for surviving admitted work; they do
not claim startup cancellation of abandoned approvals or old Slack-card cleanup.
The existing questions/permissions case also rejects a native protected write on
both generations, requires the stopped notice and asserts its canary file was
never created. No new release-gate exclusions are used for rejection coverage.

`npm test` and `test:pack` do not download these engines. The engine lane needs
access to the npm registry. It uses private homes, databases, configuration,
workspaces and process ownership. Cleanup failures fail the run; uncertain
cleanup retains the private root for diagnosis.

## Options and evidence

- `--pins=1.18.35,2.2.5` and `--modes=attached` select a smaller matrix.
- `--migration` seeds each v1 pin, stops its writers, snapshots the entire private
  profile, attempts continuation on native **2.2.5** on a disposable copy, and tests rollback on
  a separate pristine v1 copy. Omitting it leaves required migration evidence
  blocked. No existing user database is read or migrated.
- `--report=<private-json-path>` chooses the report location; its parent must
  exist. By default the command prints a unique report path in the OS temp area.
- `--baseline` labels pre-port collection. It does **not** turn known failures
  into passes or suppress a failing exit code.
- `--gate=deterministic` is the default and the no-secret CI gate. It requires
  every applicable deterministic case and cleanup result. Reports also retain
  live and mode-inapplicable observations, with explicit gate exclusion reasons.
- `--gate=release` additionally requires applicable live/deployment and missing
  platform evidence. This runner alone cannot establish release qualification;
  the live evaluator and aggregate OS evidence remain separate work.

Each report preserves PASS/FAIL/BLOCKED/native NOT_APPLICABLE results, expected
and observed outcomes, engine integrity, package version, mode, platform,
sanitized evidence and cleanup. Keep reports private: they contain disposable
local paths and process identities. Never commit profile data or populated env
files.

## Live collection and current evidence

`npm run test:slack:release -- --plan` lists the same catalog's applicable live
gates without network calls. Real collection is explicitly `--run`; it reuses
the strengthened routine evaluator and can independently observe a separately
authorized `--restart`. It never promotes partial API smoke into human/client,
operator-plugin, remote-host or whole-release qualification. See
[`docs/pipa-testing.md`](../../docs/pipa-testing.md) for private inputs and cleanup,
and [`docs/opencode-compatibility.md`](../../docs/opencode-compatibility.md) for
upgrade/rollback and operator checks.

The historical pre-port package failed compatibility checks. See
[`docs/research/opencode-harness-baseline.md`](../../docs/research/opencode-harness-baseline.md)
for observed results and remaining qualification gaps. Rerun the same cases as
runtime selection and adapters land; do not weaken assertions to obtain green
output. Later unit reports, including
[`U7`](../../docs/research/opencode-u7-verification.md), supersede historical
baseline observations only where their actual recorded cases cover the behavior.
