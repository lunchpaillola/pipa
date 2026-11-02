# Native integration blockers: diagnosis and corrected qualification

Date: 2026-10-15. Starting checkpoint: `1808c6f`, clean branch
`feat/opencode-v1-v2`, draft [PR 39](https://github.com/lunchpaillola/pipa/pull/39).
This supersedes U7 integration observations only where new evidence is provided.
It does not qualify a release.

## Outcome

The synthetic v2 plugin, MCP, skill and command checks now pass. Previous failures
mixed obsolete fixture configuration/API assumptions with an independent MCP
discovery race. Two v1 upstream limitations remain reproducible, with isolated
alternatives verified. Actual installed operator plugins still block v2 cutover.

No live Pipa restart, installation, configuration conversion, Socket takeover,
paid-provider request or real Slack evaluation occurred. Production Pipa modules
were not changed.

## Causal findings and fixes

### V2 plugin and MCP registration

`writeDefinitions` emitted v1 `plugin`, `mcp.matrix` and a function returning
`tool.execute.before` for every engine. V2 instead reads
[`plugins`](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/config/plugin/source.ts)
and [`mcp.servers`](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/config/plugin/mcp.ts).
Local plugin entries must resolve to a directory with a server entrypoint. Its
[promise plugin contract](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/plugin/src/promise/plugin.ts)
is an object with `id` and `setup(ctx)`, registering
[`ctx.tool.hook("execute.before", ...)`](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/plugin/src/promise/tool.ts).
The fixture now emits generation-specific implementations/configuration.

The MCP fixture explicitly selects `codemode:false` for direct native tool calls.
Default Code Mode execution/discovery is separate, unqualified coverage. No
operator plugin is implicitly wrapped or ported by this change.

### V2 skill argument and plugin/MCP lifecycle isolation

After MCP registration was fixed, the skill check exposed another v1 assumption:
v1 uses `name`, while the
[v2 tool schema](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/tool/plugin/skill.ts)
requires `id`. The check now uses the actual schema and still requires returned
skill bytes.

Immediately after location reload, v2 can advertise a catalog without the MCP
tool, then advertise it on a subsequent provider step. The plugin test now uses
the built-in read tool against the marker-bearing fixture file, isolating plugin
lifecycle from MCP discovery. It still requires exactly one version-2 hook and
the real read result. The separate MCP/skill check waits for native MCP connected
status and verifies both tool results.

### V1 plugin reload: process module cache

Both v1 pins still execute version 1 after successful location disposal/reload.
The [v1 loader](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/plugin/loader.ts)
uses `import(row.entry)` on the same entry URL; instance disposal does not
invalidate the process module cache. A separately launched native process loaded
version 2 in every v1 cell. This proves fresh-process loading, not hot-reload
support or a production restart rehearsal. The original hot-reload gate stays FAIL.

### File commands: native interfaces and completed output

For both v1 pins, attached `run --command` expands the file and reaches inference
but can lose text before returning through the production bash tool. In the
[v1 run implementation](https://github.com/anomalyco/opencode/blob/v1.19.0/packages/opencode/src/cli/cmd/run.ts),
the command starts its event loop and calls `finish()`, which immediately returns
when `args.attach` is set instead of awaiting output. This is a completion/output
race: all six broad-run v1 cells lost output, while a later 1.19.0 Socket-owned
recheck returned it. That success does not repair the missing wait. The same command without
`--attach`, in a new isolated native process, returns the expected text. The
harness records this comparison and fresh plugin loading, then preserves the
attached-command FAIL. Standalone execution uses a separate session/process; it
does not prove attached-session continuity.

V2 removed `run --command` but supports file commands through native
[`session.command`](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/server/src/handlers/session.ts)
and [`opencode api`](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/cli/src/commands/handlers/api.ts).
The corrected case executes that pinned CLI through the production shell tool:
create a private session, invoke its actual file command, then collect the native
completed assistant projection. Acceptance alone cannot pass. Assertions still
require actual file expansion at the provider and returned command text in the
enclosing tool. This is a native CLI equivalent, not template expansion in Pipa.

## Final targeted native results

One privately packed/installed candidate, integrity-checked native binaries,
Node 22.23.2, macOS ARM64. Real engines/tools/configuration, deterministic provider
and fake Chat. Nine selected cases per cell:

| Case | 1.18.35, all three modes | 1.19.0, all three modes | 2.0.29, all three modes |
| --- | --- | --- | --- |
| package-cli | PASS | PASS | PASS |
| init-identity | PASS | PASS | PASS |
| startup-readiness | PASS | PASS | PASS |
| exact-prompt-continuation | PASS | PASS | PASS |
| reload-location | PASS | PASS | PASS |
| plugin-reload-contract | FAIL: cached bytes | FAIL: cached bytes | PASS |
| definitions-mcp-skill | PASS | PASS | PASS |
| definitions-command | FAIL: attached output absent | FAIL: attached output absent | PASS: native CLI API |
| stop-ownership | PASS | PASS | PASS |
| Owned-resource cleanup | PASS | PASS | PASS |

Modes: Socket-owned, attached, Managed. **81 case observations: 69 PASS, 12 FAIL,
0 BLOCKED**, plus nine passing cell cleanups and passing outer cleanup. All six
v1 cells also verified standalone command output and fresh-process plugin version
2 loading. These comparisons do not waive the twelve failures.

After final inline simplification and an added permission-type assertion, a
two-cell Socket-owned recheck (1.19.0 and 2.0.29) produced **17 PASS, 1 FAIL**:
only v1 hot reload failed; the v1 command happened to return its output. Both
cleanups passed. This confirms the command race can produce a passing observation
without establishing reliable completion. It does not retroactively change the
broader 81-observation run or qualify v1 attached commands.

Local checks: **333 tests passed**, package smoke passed for both generation
contracts, and **22 harness self-checks passed**. Earlier isolated migration and
rollback checks were reproduced during diagnosis; the final nine-case/mode
collection did not rerun that separate journey.

A separate quick read-only code review found no actionable findings. Its coverage
was static source inspection; it did not independently execute Git or tests.

Runnable cases remain in `scripts/verification/`. The full standard runner is
`npm run test:engines -- --migration --gate=deterministic`. Targeted diagnostics
use `runCell({ candidate, pin, mode, caseIds })` in an isolated worker with the
installed candidate and verified pin in its private PATH. A selected green v2
subset cannot pass the full gate. Raw reports remain private OS-temporary files.

## Actual operator impact

A read-only, secret-excluding inventory found five enabled MCP servers, thirteen
configured agent entries and three plugin packages in the host's global v1-style
configuration. Credential values, server commands/URLs and the populated
inventory are omitted. This is not an inventory of every project override,
runtime environment or remotely attached host.

Installed package sources establish concrete v2 blockers:

- `opencode-goal-plugin` **0.8.1** declares OpenCode `>=1.17.15 <2`.
- `@dietrichgebert/ponytail` **4.8.4** exports a v1 function with `config`,
  `experimental.chat.system.transform` and `command.execute.before` hooks.
- `compound-engineering` **3.23.4** exports a v1 function/config hook to add
  skills and commands.

These are installed-source/metadata findings, not live execution or claims about
newer upstream versions. Renaming `plugin` to `plugins` does not port these
behaviors. A required package without a verified v2 port blocks cutover. The
synthetic plugin port does not qualify these packages.

MCP configuration needs the v2 schema; direct calls require `codemode:false`,
otherwise the native default is Code Mode. Credentials/providers, agents,
commands and local overrides need a private operator-profile rehearsal after
compatible ports/configuration are chosen. Never copy credentials into fixtures
or mutate the live profile as a qualification shortcut.

## Remaining work before cutover

### Follow-up: installed skill check requested by the operator

The operator excluded goal-plugin capability from scope and requested a small
actual-package check rather than speculative porting. In a fresh isolated
OpenCode 2.0.29 server, with a deterministic provider and no live credentials:

- The installed Ponytail `ponytail` and Compound Engineering `ce-plan` skill
  directories were exposed through native `.opencode/skills` symlinks. Both were
  discovered and both actual skill bodies returned successfully through the
  native skill tool. **No skill-content port is required.**
- With only the installed package directories in native `plugins`, neither
  registered package skills/commands after inference activated the location;
  Ponytail's automatic system-prompt marker was absent. Native skill loading
  works independently of those package wrappers.
- The private server/processes were cleaned up. No live profile or Pipa runtime
  was changed. The test does not execute the loaded skill's downstream workflow.

The earlier wording about whole integrations blocking cutover was too broad:
the tested skills work on v2. Only preserving package-provided automatic
registration/injection requires further configuration or wrapper work if those
behaviors are required. This is not a reason to port the Markdown skills or add
production Pipa code. The goal-plugin item above is historical inventory, not
remaining requested work.

The original remaining-gate list below predates that clarification; its plugin
item applies only to automatic plugin behaviors the operator actually requires.

1. Obtain/implement compatible versions of required operator plugins and qualify
   their actual hooks, definitions and state semantics in a private profile.
2. Resolve v1 upstream hot-reload/attached-command limitations, or obtain an
   explicit compatibility decision accepting their documented alternatives.
   Original gates remain failed until then.
3. Complete remaining native feature/OS coverage, operator/provider checks and
   separately authorized real Slack/client/restart qualification. The existing
   release gates and no-restart constraint remain in force.
