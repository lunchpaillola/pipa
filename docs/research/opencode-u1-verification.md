# U1: authenticated runtime detection and lifecycle

Observed 2026-10-14 on macOS ARM64, Node 22.23.2, packed Pipa 0.5.4.
Scope: U1 in the [migration plan](../plans/2026-10-13-1517-refactor-opencode-v2-migration-plan.md).

**U1 is implemented and locally verified. The migration is not release-qualified.**
V2 turn execution remains U2 work. Preserve the original
[Part 1 baseline](opencode-harness-baseline.md) as pre-port evidence.

## Implementation

- Parse supported v1/v2 semver identity, including prefixed CLI output. Owned
  startup preflights the executable and checks its identity against the server.
- Attached startup identifies the selected server without inspecting a local
  executable. Validate native identity contracts, authentication, migration
  completion, and the configured absolute workspace before Socket intake.
- Preserve configurable v1 Basic username; v2 uses `opencode` with
  `OPENCODE_PASSWORD` taking precedence over `OPENCODE_SERVER_PASSWORD`.
  Credential failures never downgrade to an unauthenticated connection.
- Owned servers receive a private password through the cleaned child environment
  and generation-correct launch settings. Negotiated authentication metadata
  reaches the executor; Slack credentials remain excluded from children.
- Preserve external ownership, cancellation and child cleanup. Ordinary Managed
  startup can retain its lifetime on temporary readiness failure without claiming
  cooperative-restart readiness; permanent auth/protocol failures are fatal.
  Detached replacements retain strict bounded readiness and failure cleanup.

## Reproduce

```sh
npm test
npm run test:pack
node --test scripts/verification/self-check.mjs
npm run test:engines -- --baseline --migration --gate=deterministic
```

The engine command labels baseline collection; its expected nonzero exit does
not waive compatibility failures. The final private report is named
`pipa-engines-1792011039871.json` in the OS temporary directory printed by the
runner. Raw evidence remains private and is subject to OS cleanup.

## Final observed verification

| Check | Result |
|---|---|
| Full suite | 227 passed, zero failed |
| Installed-package smoke | Passed |
| Harness self-checks | 20 passed, zero failed |
| Diff whitespace check | Passed |
| Real-engine startup/readiness | 9/9 PASS |
| Stop/ownership | 9/9 PASS; attached servers survived Pipa stop |
| Managed detached restart lifecycle | 3/3 PASS |
| Managed bind/configuration fault cleanup | 6/6 PASS |
| Cell and outer-supervisor cleanup | All PASS |
| Full deterministic compatibility gate | Nonzero; FAIL/BLOCKED observations retained |

Native cells used installed candidate production entry points and pins
**1.18.35, 1.19.0, 2.0.29** in Socket-owned, attached and Managed modes.
V2 Managed restart has passing lifecycle evidence but its overall case remains
**FAIL** because the required post-restart prompt still returns HTTP 405. This
is not a passing end-to-end restart/continuation claim.

## Evidence and review

Before production edits, focused U1 tests recorded 12 expected failures for
version handling, missing connection metadata and misclassified startup errors.
Independent review subsequently found that relative/empty location responses
could borrow Pipa's local CWD. New v2 regressions failed before the fix; both
generations now require absolute reported directories before comparison.

Simplification applied redundant fetch-option removal, failed-response body
cancellation and temporary initialization-test cleanup. No lint/typecheck
scripts are configured; the project uses plain ESM and Node's test runner.

Code review: harness-native fallback — the dedicated review worker lacked its
required nested reviewer dispatch capability. The fallback review identified
the location-validation defect; follow-up confirmed its resolution and no
remaining actionable U1 findings. It inspected files and report evidence;
authoritative command execution was performed by the parent session.

## Harness corrections

- Startup observers now verify the negotiated generation, exact native pin,
  migration/workspace readiness and authentication enforcement. Legacy v1
  readiness routes are no longer used to judge v2 startup.
- Shutdown verifies the app's owned URL; a diagnostic independent engine cannot
  replace the URL under observation after successful app startup.
- Native 2.0.29 tolerates malformed JSON configuration documents. Its unready
  restart fixture instead makes a discovered, privately contained configuration
  directory unusable, preserving the actual failure/cleanup assertion.
- Targeted diagnostics validate case selection and cannot qualify the full gate.
  The final full matrix was rerun after these corrections.
- The package smoke fixture uses an ephemeral port to avoid an unrelated local
  server on the former hard-coded port influencing identity checks.

## Remaining work

U2 must implement prepared-turn adapters, exact prompt/history attribution,
owned instruction/admission recovery and separate incoming/outgoing limits.
U3–U7 retain their interaction, cancellation, model and qualification work.
Existing supersession-reaction, incoming-size, plugin-reload, background-result
and file-command baseline observations remain visible; U1 does not resolve them.

Linux/Windows native execution, separately hosted attachment and live Slack,
human controls, providers and private integrations remain unqualified. The
running Pipa was not deployed or restarted.
