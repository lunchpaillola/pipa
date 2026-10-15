# OpenCode compatibility and operator transition

This guide describes the dual-adapter candidate on `feat/opencode-v1-v2`.
It is not a release-qualified upgrade recommendation. See the [native blocker follow-up](research/opencode-native-blockers-verification.md), [U7 evidence](research/opencode-u7-verification.md)
and [testing procedure](pipa-testing.md) before choosing a deployment pin.

## Versions and capabilities

Pipa requires Node 22 or newer and automatically selects a native v1 or v2 HTTP
adapter. The candidate pins `@opencode/client` to **2.0.29**. Native qualification
pins are **1.18.35, 1.19.0 and 2.0.29**, not a claim that all releases from those
versions onward are supported. No minimum version is release-qualified yet.
The parser accepts major 1 or 2, including newer patch versions, then validates
the actual connection's required contracts; other majors fail before intake.

| Surface | v1 | v2 candidate |
| --- | --- | --- |
| Identity | Authenticated `/global/health` | Authenticated `/api/info` |
| Workspace readiness | Configured directory and session status | Completed v1 migration and matching configured location |
| Prompts and sessions | Native prompt/system instructions | Stable input ID, scoped instruction journal, correlated terminal projections |
| Questions and permissions | Existing native controls | Native question fields/permission decisions normalized into the same Slack controls |
| Model discovery | Available through executor capability API | Connected providers, variants and native defaults |
| Live model switching | Explicitly unsupported | Existing-session native switch; affects subsequent provider work |
| Reset model | No live switch | Selects the current native default explicitly; does not inherit future default changes |
| Slack model picker | Deferred | Deferred |

Generic numeric, conditional or external forms require an OpenCode client.
Pipa displays a notice and reconciles external settlement rather than inventing
answers. Rejected native submissions leave supported controls editable.

Owned servers preflight the selected `opencode` executable and check the serving
identity agrees. Attached servers are identified from HTTP, independently of
the local executable. An authentication failure is never permission to downgrade
to another protocol or retry without authentication. V1 uses
`OPENCODE_SERVER_USERNAME` (default `opencode`) and `OPENCODE_SERVER_PASSWORD`.
V2 uses username `opencode` and `OPENCODE_PASSWORD`, falling back to
`OPENCODE_SERVER_PASSWORD`. Keep these values private. Pipa supplies owned
servers with a private password; do not extract one from startup logs.

Socket startup waits for native readiness before Slack subscriptions or routines.
Ordinary Managed startup can remain running without workspace readiness, but
cannot advertise cooperative restart readiness. A detached replacement must
pass its bounded readiness checks or report failure/unconfirmed status.

## Journey A: upgrade Pipa, remain on v1

1. Record the exact old Pipa/Node/OpenCode versions and executable paths. Retain
   the old package and engine pins. Review the qualification results for the
   intended candidate; a green package smoke alone is insufficient.
2. Stop/drain Pipa using commands on its host with the original `PIPA_HOME`.
   Confirm its owned server/writers have stopped before copying state. Attached
   servers are operator-owned and need their own writer coordination.
3. Snapshot the matched Pipa and OpenCode state as described below. Rehearse on
   isolated copies with the same working-directory identity before deployment.
4. Install the explicitly chosen Pipa candidate on the intended host; retain
   OpenCode v1 and the original Pipa profile. Do not rerun `pipa init` or recreate
   the Slack app just to change Pipa versions. Old profiles with no `slackMode`
   still load as Socket Mode.
5. Start the candidate with that profile, engine selection and directory.
   Verify a new mention, existing-thread history, permission/question controls,
   files, a routine/result-thread reply, and detached restart via the live gates.

Changing scopes is a separate Slack app reauthorization step, not a requirement
to create another app. Never run two Socket consumers for the selected app.

## Journey B: deliberately adopt v2

First complete Journey A's inventory, drain and matched snapshot. The Pipa
upgrade does not install or upgrade OpenCode automatically.

1. Inventory required providers, credentials, MCP servers, file definitions and
   plugins privately. A required integration without a working v2 port blocks
   cutover. Renaming a plugin setting does not port its implementation.
2. Stop **all** writers to the source OpenCode storage, including independent
   clients/services. Copy the stopped complete profile/storage to a disposable
   target, leaving the pristine v1 snapshot immutable.
3. Select the exact v2 executable in the candidate's private PATH, or select an
   independently managed v2 server. Preserve Pipa's config, session mappings and
   routine state; OpenCode owns schema/history migration. Wait for completed
   migration and configured-location readiness before dispatching work.
4. Continue the same mapped sessions and recall pre-migration history. Inspect
   active/inactive/completed routine definitions, exact prompts and destinations.
   Restart v2 and repeat continuation. Do not treat a migration/auth/location
   error as a missing session or silently substitute a new conversation.
5. Verify configured permission rules. Upstream remembered approvals can reset
   during migration or service restart: expect new approval prompts where
   observed. Pipa neither recreates grants nor owns a separate approval store.
6. Complete the private operator checklist and actual Slack/client gates. Only
   after successful rehearsal and explicit deployment authorization should the
   production copies be migrated.

### Matched snapshots and rollback

`PIPA_HOME` is the parent of `.pipa`, not `.pipa` itself. Preserve the complete
stopped Pipa profile: config/manifest, `sessions.json`, `routines.json`, restart
records and `opencode-recovery.json` when present. Keep credentials private.
Preserve OpenCode's actual database/storage plus database companions, credentials,
configuration, definitions, plugins and their package sources from the same
checkpoint. Include project-local `.opencode` definitions/configuration too.

Discover paths from the selected release's CLI help/path commands and configured
HOME/XDG/Windows app-data/DB overrides; do not assume one universal DB path.
For qualified v2 HTTP identity, `/api/info` exposes paths. Never copy only a live
SQLite main file. Stop/checkpoint writers or use the release's documented
consistent backup procedure. Record version/path inventory and snapshot hashes
privately, without a full environment dump.

On failure, stop the new Pipa and all target-storage writers. Retain v2-written
data separately for diagnosis. Restore **both** pristine Pipa and OpenCode
snapshots and old package/engine selections into the original identity, then
verify the old sessions/routines/rules. Never open a v2-written database in v1.
Post-snapshot side effects and state changes need reconciliation; binary rollback
does not undo them. Do not delete recovery journals to bypass blocked intake.

The reproducible synthetic rehearsal is:

```sh
npm run test:engines -- --migration --gate=deterministic
```

This seeds each old pin with histories, mappings, routine states, configured deny
rules and a remembered approval; stops writers; migrates only a copy; then
continues a separate pristine v1 rollback copy. It does not touch a live profile
or establish private operator/plugin compatibility.

## Configuration and deployment limitations

- Keep supported existing configuration/file definitions initially. V2 does not
  run LSP and ignores legacy `compaction.tail_turns`, `compaction.prune` and some
  experimental fields. Test workflows that depended on them; wholesale config
  conversion is outside this migration.
- V1 plugins require an actual compatible v2 implementation. Deterministic local
  definitions/MCP/plugin probes are separate from the operator's inventory.
  The [follow-up evidence](research/opencode-native-blockers-verification.md)
  corrects the synthetic v2 probes; it does not qualify installed operator plugins.
  V2 reads `plugins` (compatible package/directory entrypoints) and `mcp.servers`;
  MCP defaults to Code Mode, with `codemode:false` for direct tool exposure.
  Renaming keys alone does not convert plugin hooks or qualify credentials.
- Both v1 pins retain old plugin module bytes after location disposal; a fresh
  native process loads changed bytes. Their attached `run --command` can return
  before collecting output (an observed race); isolated standalone invocation returns it, but uses a
  separate session/process. Both original gates remain failed. V2 file commands
  work through `opencode api`/`session.command` plus completed-result collection;
  v2 `run --command` is not available.
- An attached server must serve the configured workspace and remain independently
  owned through Pipa stop/restart. Loopback attachment is not separate-host proof.
  Remote agent commands need access to the Pipa host for restart/routine CLI work.
- Incoming files are limited to **10 MiB each** against metadata and downloaded
  bytes. Owned v2 defaults `BUN_JSC_maxRegExpStackSize=536870912` unless overridden;
  independently launched attached v2 servers need that setting in the server
  process for the measured 2.0.29 large-base64 boundary. Model context/media limits
  remain separate. Outgoing files retain 10-file/100 MB per-file/response limits;
  non-loopback attachments use text fallback for local artifacts.
- Native event reconciliation is not durable replay. Foreign prompt writers in
  an active Pipa session cause an attribution conflict. Restore connectivity and
  resolve ownership conflicts rather than replaying prompts automatically.
- Routine restart skips missed schedules; saved explicit run requests survive.
  A crash after side effects/delivery but before saving completion can repeat
  work. There is no new exactly-once promise.

## Private operator/client checklist

For each selected engine/mode, record PASS/FAIL/BLOCKED, exact versions, OS,
session/thread/request identities, expected/observed behavior, private evidence
reference, human observer where applicable, and cleanup. Use the shared case IDs
from `npm run test:slack:release -- --plan`. Missing evidence blocks qualification.

| Gate | Required observation |
| --- | --- |
| Existing profile | Same Slack app/config, mappings and routine definitions; new and existing threads work |
| Providers | Every required credential/provider/model makes a real request; variants/defaults match intended configuration |
| MCP | Invoke a real required tool and verify its returned result, authentication and working directory |
| Definitions | Execute a file skill, agent and command, checking returned markers/history rather than listing files |
| Plugins | Every required v2 port loads; invoke its hook, reload and confirm one new registration/result |
| Interactions | Human exercises radio, multiselect, custom modal answer, dismiss and approval/rejection, including child requests |
| Retry controls | Native rejection leaves real Slack controls editable; corrected submission settles once; stale/unauthorized controls do not act |
| Files and typing | Observe actual typing, small image/document, exact/oversized incoming UX, outgoing checksum, unsafe path refusal and upload-failure fallback |
| Routines | Channel and existing-thread scheduled delivery, recurring dispatch, result-session reply, revocation/cancellation and overlap behavior |
| Restart | External observer sees request ID, old exit, new PID/generation, durable completion, one routed ready notice and history follow-up; scheduler recovers |
| Attached host | Separate host/workspace identity; attached engine PID survives Pipa restart and stop |
| Cleanup | Nonce routines removed; stop candidate/owned server, confirm locks/ports/staging cleared; attached server survives until operator teardown |

Store the populated inventory and raw client evidence outside git. The live
collector produces a partial automated report, never certifies the whole release.
Combine it with human observations, migration reports and all required OS/mode
cells before publishing minimums or declaring cutover ready.
