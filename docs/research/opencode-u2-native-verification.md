# U2 native verification follow-up

Observed on macOS ARM64, Node 22.23.2, OpenCode/client 2.0.29.

**Current disposition (2026-10-15 continuation): the user-confirmed pragmatic U2
implementation and local verification scope is complete.** R8's exact **10 MiB
(10,485,760 bytes)** boundary now passes on native 2.0.29 with the existing
server regex-stack configuration. A harness environment-forwarding defect was
fixed, and freshly packed attached and Socket-owned candidates each passed all
11 targeted cases. Cancellation and abandoned-context recovery also passed fresh
native probes under KTD3's single-writer contract. See the final continuation
section for current evidence and the limits of this completion claim. U3 and
full migration/release qualification remain subsequent scope; changes are local
and uncommitted.

## Historical observations and conclusions before the user revision

The sections through “Final parent verification and disposition” preserve the
earlier results and reasoning. Their 20 MiB policy and cancellation/mutation
blocker conclusions are superseded by the current revision section.

## Fixed protocol defect

The adapter combined `order=asc` with every message cursor. Native 2.0.29
returns `InvalidCursorError: Cursor cannot be combined with order`. Its
`SessionMessagesQuery` specifies order only for the first page; opaque cursors
carry the order thereafter. Even a short nonempty page returns a next cursor,
so the scan must continue to the empty tail.

This broke execution/continuation and then repeated during independent cleanup,
where the cleanup wrapper hid the underlying cursor error. A private native
probe captured the HTTP 400 and nested cause. The adapter now omits order on
cursor reads. The existing pagination test was corrected from its incompatible
query expectation and observed red before the fix. An independent multi-page
wire fixture now verifies cursor-only reads through the empty terminal page.
The foreign-input-on-a-later-page assertion remains intact.

## Corrected native harness arguments

The artifact provider fixture sent v1's `write.filePath` to v2's native write
tool, whose required field is `path`. Native execution returned a tool argument
error and created no artifact. The fixture now chooses the path field from the
advertised native tool schema. File-content and checksum assertions are unchanged.

## Observed native results

The targeted attached cell used a newly packed and installed Pipa tarball and
the real 2.0.29 engine. Startup, exact prompt/history continuation, Chat
continuation, controlled provider failure, local document bytes, artifact bytes,
local and data-URI image/document transport, oversized-byte rejection,
oversized-metadata rejection, and attached ownership all passed. Cleanup passed.

The exact **20,971,520-byte** attachment case remains **FAIL**. A separate direct
pinned-SDK probe, bypassing the Pipa executor, reproduced HTTP 500 before any
provider request. The bytes round-tripped through 27,962,028 base64 bytes without
change. Native debug output reports `Schema validation failed` in
`SessionPrompt.normalizeImageAttachment`, with the `Prompt.Base64` pattern
check failing. Pipa's acceptance limit has not been reduced, and no file
splitting, prompt rewriting, or engine patch hides the incompatibility.

For **each** source pin, 1.18.35 and 1.19.0, the existing full migration journey
seed and matched-snapshot rollback passed. Upgrade now reaches `V2_APPROVAL`
and times out because U3 native permission routing is absent; the full upgrade
case remains failed. A separate U2 history-only probe used the same real seed
and disposable profile copies, continued both mapped sessions on v2 before and
after a v2 restart, asserted original history in the actual provider requests,
verified exact prompt admission and unchanged IDs/mappings/routine states, and
verified empty recovery journals. All eight continuations and both rollback
checks passed. This does not substitute for the failed approval assertion.

Original baseline reports were preserved. Private probe reports, native logs,
and disposable profiles are not repository artifacts; all probe-owned resources
were cleaned successfully. Linux/Windows and full release qualification are not
claimed by these targeted checks.

## Harness-native P1 review follow-up

The original cancellation/recovery claims were too strong. Eight focused cases
were observed red before the review fixes: unsafe active interruption, early
DELETE during cancelled PUT, journal loss after a lost PUT reply or mutation
timeout, a foreign writer racing cleanup's snapshot, late foreign success,
unbounded connection refusal, and same-session callback/download overlap.
An additional red case exposed a lost pending-cancel reply hiding promotion
between parallel message/inbox snapshots; its ownership record was incorrectly
cleared before settlement.

### Instruction mutation ordering and uncertainty

The private journal now records instruction state (`absent`, `putting`,
`present`) independently of prompt admission. `putting` is persisted before PUT.
The PUT uses its own bounded signal, not the turn's cancellation signal. If its
success reply arrives, Pipa records `present` before proceeding; cancellation
then orders DELETE after that acknowledged write. A lost reply or timeout keeps
`putting` durable, blocks intake, and does not issue a speculative DELETE.

An acknowledged DELETE or a currently absent entry cannot prove that a prior
PUT will not commit later. Startup therefore also blocks on `putting` (and on
legacy `prepared` records lacking instruction-state evidence). Automatically
resolving that uncertainty requires native mutation fencing or independently
verified settlement/termination of the original writer. No blind journal
deletion or instruction-absence heuristic is used. The SIGKILL test distinguishes
uncertain PUTs, which retain the record and block, from acknowledged instruction
registration, whose owned context can be removed before intake without replay.

### Active cancellation is a native capability blocker

Pinned `@opencode/protocol@2.0.29` declares `session.interrupt` with only a
session ID and optional `resume`; the pinned generated SDK has the same inputs.
There is no expected input ID, sequence, revision, or compare-and-interrupt
predicate. `session.inbox.cancel` does identify one pending input, but explicitly
cannot cancel an already delivered input. A GET followed by session-wide
interrupt cannot exclude a foreign admission between those operations.

Pipa no longer calls v2 `session.interrupt` during cleanup. Known pending Pipa
inputs remain cancellable by ID, including when a foreign input is queued or a
cancellation reply is lost. Reconciliation reads inbox before messages so native
atomic inbox-to-message promotion cannot disappear between those snapshots;
this ordering never authorizes a session-wide interrupt. If an owned input is already promoted and has no
terminal idle projection, local cancellation suppresses delivery, removes only
acknowledged owned context, retains unsettled ownership and blocks further
intake. It does **not** promise to stop the active engine execution. Reconciliation
can clear settled owned work once its authoritative terminal projection exists;
the blocked live executor does not silently reopen intake. A regression inserts
foreign work immediately after cleanup's snapshot and verifies zero interrupts.
This is a genuine unresolved R4/KTD3/KTD11 compatibility boundary, not an atomicity
fix achieved by another read.

### Final attribution and reservations

The live watcher remains active through cleanup. Foreign input observed by the
final projection or watcher suppresses success even when the owned input already
has a successful idle marker. If owned work is settled and its context removal
is acknowledged, its journal record can be cleared while the attribution error
still prevents delivery; this alone does not permanently block the executor.
This does not claim a native exclusive-writer lease or a linearizable boundary
against independent admissions after the last observable check.

The shared facade reserves an existing session before downloads, callbacks, or
artifact allocation and retains the reservation through file cleanup. Duplicate
same-session callers fail before those effects; distinct sessions remain
independent. A reservation that has not resolved its session only aborts local
work, preserving the prior server-cancellation boundary.

### Bounded disconnected recovery

Authoritative reads now have a bounded recovery window after transport failure
(10 seconds by default), bounded individual HTTP requests (5 seconds), and a
fresh bounded authenticated confirmation read/projection (1 second) before one
`onFatal` notification. Persistent refusal terminates local execution and retains
uncertain ownership. Attached engine processes are never killed by this adapter.
Repeated uncertain admission replies are also bounded and reuse the same input
ID; a healthy authoritative read does not falsely declare the server dead.
Stream reconnection is bounded before initial subscription readiness, while
post-subscription stream loss can reconcile through healthy projections.

These are connection/mutation deadlines, not deadlines on healthy agent work.
Tests cover brief projection and stream outages recovering without `onFatal`,
healthy work continuing beyond the configured recovery interval, persistent
authenticated refusal ending before a test safety deadline, and retained
uncertain state. The native 20 MiB blocker and full migration/U3 failures above
remain unresolved; this review follow-up does not supersede them with fixture
passes.

Observed review verification: the 19 targeted review/crash/pending-cancel checks passed; the
combined executor, contract, app, state, routine and harness self-check run passed
243 tests. This includes a real HTTP server committing a timed-out instruction
PUT after the client has stopped, with no DELETE and with the ownership record
still retained. The known pending-input cancellation cases continue to pass.

Two focused native 2.0.29 probes were rerun after the review changes. A healthy
turn reached the deterministic provider, delivered its result and cleaned up.
In the fault probe, the harness killed only its disposable independently launched
engine after native prompt acknowledgement; no app/server-exit observer was
wired to the executor. Actual authenticated projection reads encountered
`ECONNREFUSED`, bounded recovery emitted one `onFatal`, local execution ended,
and one uncertain recovery record remained before fixture teardown. Cleanup
passed. The adapter itself did not kill an attached server. The full native
matrix, migration journeys, and release gates were not rerun for these review
changes; the earlier native results above are historical evidence, not renewed
qualification.

## Final harness fallback review: cleanup-originated connection loss

The parent's final harness fallback review reported **one concrete P2**: a
transport failure first encountered during cleanup after successful idle could
exhaust the independent 5-second cleanup signal before the ordinary 10-second
connection-recovery window. Signal cancellation bypassed confirmation and
`onFatal`; subsequent intake was blocked, so no later turn could report the
disconnection either. This was a confirmed defect, not review approval.

The fix gives cleanup failure its own fresh, read-only authenticated session
confirmation, independent of both the expired cleanup signal and the turn
signal. Refusal/timeout through that bounded probe notifies `onFatal` once. A
healthy confirmation does not falsely mark the server unavailable, but also
does not turn failed cleanup into success or clear its journal. The network
cleanup path may consume the cleanup budget plus at most one confirmation
window (5 seconds plus 1 second by default); neither is an agent-work deadline.
No attached process is killed, and no cancellation or mutation endpoint is used
for confirmation.

Three new regression cases use cleanup=15 ms, recovery=100 ms and confirmation=5
ms, preserving the production timeout inequality. Refusal starts only after the
successful assistant/idle projection. All three were observed red before the
fix because no fresh confirmation occurred. After the fix, permanent refusal
and a hanging confirmation each notify fatal once; a healthy confirmation
notifies zero times. Every case retains its record, rejects subsequent intake,
preserves authentication, and terminates within its independent bounds.

**Final local results:** the three new regressions passed, and the focused
executor/contract suites passed **132 tests, zero failures**. `git diff --check`
passed. The parent's authoritative results immediately before this narrow fix
were **267 full-suite tests passed**, package smoke **PASS**, and **20 harness
self-checks passed**. Those were not rerun or relabeled as post-fix evidence.
The P2 fix is implemented with local red/green evidence. The native cancellation,
uncertain-mutation, 20 MiB and U3/migration limitations recorded above remain;
this is not a complete or release-qualified U2 claim.

## Final parent verification and disposition

After the final P2 correction, the parent ran `npm test`: **270 passed, zero
failed**, and `npm run test:pack`: **PASS**. Harness self-checks passed **20/20**
before this adapter-only correction; the harness did not change afterward.
No lint/typecheck command is configured. Final diff whitespace checks passed.

**Code review: harness-native fallback** — the dedicated `ce-code-review`
invocation could not dispatch its required nested reviewers. A separate native
review inspected the original four P1 corrections and confirmed their safe
behavior, identified the cleanup-originated P2, and the parent inspected that
final correction against its three red/green regressions. This is not a completed
dedicated multi-agent or cross-model review receipt.

The initial full matrix attempt exceeded its shell deadline; later targeted
native probes and migration checks are bounded evidence, not a completed nine-cell
post-port matrix. The full compatibility/release gate remains unpassed.

Work is preserved uncommitted on `feat/opencode-v1-v2`. No push, PR, deployment,
or live Pipa restart occurred. Implementation stops at the plan's native
capability boundary: completing U2 requires an upstream fix/newly qualified
runtime or an explicitly revised cancellation/recovery contract. Do not silently
lower R8, interrupt foreign work, or erase uncertain recovery records.

## 2026-10-15 user revision and native contract reassessment

### Implemented policy and local evidence

The user explicitly superseded the 20 MiB decision with 10 MiB. Production
metadata and downloaded-byte checks, Slack errors, current docs, contract tests,
and native harness expectations now use 10,485,760 bytes. R8, its settled
decision and KTD9 were minimally revised; no plan progress marks were changed.
Outgoing 10-file/100 MB per-file and response checks remain independent.
Original baseline research and the preceding observations remain historical.

Four revised boundary tests were observed red before the size change, then green
for both generations and both transports. Five lifecycle/recovery assertions
were observed red before implementation: active interruption, committed PUT with
lost reply, committed PUT with mutation timeout, real HTTP lost acknowledgement,
and SIGKILL with `putting` ownership. The acknowledged-context SIGKILL control
already passed. Regression coverage now also verifies interrupt acceptance is
not settlement (including a lost interrupt reply), foreign-input suppression,
pending-input promotion during cancellation, and failed cleanup retaining state.

### Cancellation: use the actual single-writer contract

[Pinned execution semantics](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/session/execution.ts)
and the [run coordinator](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/session/run-coordinator.ts)
confirm interruption acknowledges acceptance before asynchronous settlement. KTD3
already requires a Pipa-owned session to be single-writer during a turn; it does
not require a native compare-and-interrupt primitive. Cleanup now cancels an
owned pending ID, or interrupts active owned execution when no foreign input has
been observed, then polls for its terminal projection before clearing ownership.
The live watcher and authoritative foreign-input guard remain. An observed
foreign prompt is an attribution conflict, never permission to interrupt it.

Actual native probes passed: a held provider turn was interrupted, its terminal
outcome was `interrupted`, context and journal were cleared, and a replacement
turn succeeded on the same session. A held independent session remained active.
A separately admitted foreign prompt suppressed the local result with zero
additional interrupts, and the foreign work subsequently reached the provider.
This is an observable guard under the stated contract, not a claim of an
exclusive native lease against arbitrary unobserved external writers.

### Instruction cleanup: received mutation versus a fictional deferred worker

The [native received-body handler](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/server/src/handlers/session.ts)
calls [InstructionEntry.put/remove](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/session/instruction-entry.ts)
directly; the [Bun SQLite execution](https://github.com/anomalyco/opencode/blob/v2.0.29/packages/core/src/database/sqlite.bun.ts)
performs the SQL synchronously. It does not acknowledge or detach an instruction
job that can commit indefinitely later. Live cancellation still waits for the
independently bounded PUT operation. A lost reply or abandoned `putting` record
is reconciled with acknowledged removal of that namespaced key; failed removal
still retains ownership and blocks intake. No PUT is replayed during recovery.
The old tests deliberately created an asynchronous late-commit server absent
from this native contract; they are replaced by received/committed mutations
whose replies are lost or withheld.

Native probes passed for lost PUT reply, delayed reply with cancellation, and
20 ordered real PUT/DELETE pairs. Actual executor children were SIGKILLed while
their native engine survived: once after a committed instruction PUT but before
its acknowledgement reached the SDK (`putting`), and once after admission while
the provider was held. Fresh production `ready()` removed only owned context,
cleared recovery records, admitted no replay, and settled the active abandoned
turn as interrupted. Both roots cleaned successfully.

### Concrete remaining R8 failure, not a hypothetical race

On macOS ARM64 / Node 22.23.2 / native and client 2.0.29, a file containing
`Buffer.alloc(10 * 1024 * 1024, 97)` produces **13,981,016 base64 bytes**.
Direct `session.prompt` with either a file URI or `data:text/plain;base64,...`
returns **HTTP 500**, with **zero provider requests**. Native debug output again
identifies `SessionPrompt.normalizeImageAttachment` and the `Prompt.Base64`
pattern check (`Schema validation failed`). Both production transports reproduce
the same native failure; each used its own journal so one failure could not
poison the next case. Production retains admission ownership on that unresolved
500 and blocks intake, rather than pretending it was a verified rejection.

All four over-boundary checks passed: metadata and actual downloaded bytes at
10,485,761 bytes reject before admission for local and data URI paths; oversized
metadata is not downloaded. Small native image/document transport still passes.
No lower fallback, file splitting, prompt rewrite or engine patch was applied.

A freshly packed/installed candidate's targeted attached cell passed **10 cases**:
startup, exact continuation, Chat continuation, controlled provider failure,
local document bytes, artifact bytes, both small image/document transports,
actual-byte rejection, metadata rejection and attached ownership. Its exact
10 MiB case failed. Three existing full crash-journey catalog entries remained
`BLOCKED` because that harness still labels broader U2/U6 qualification seams
unqualified; the narrower real SIGKILL/`ready()` probes above passed and are not
being mislabeled as full Socket/routine crash or release qualification.

Private revision probes and reports are in the approved temporary `opencode`
directory (`u2-revision-native.mjs`, `u2-revision-{boundary,lifecycle,mutation,crash}.json`,
and `u2-revision-packed.json`). All probe-owned engines/profiles were torn down;
no live profile, commit, push, restart or deployment was used. The parent owns
the final full suite/review. The demonstrated 10 MiB native failure prevents a
U2 completion claim; U3/migration-approval work is not used as the reason.

Final focused checks for this revision:

- `node --test --test-reporter=spec test/opencode-contract.test.mjs test/opencode.test.mjs test/app.test.mjs`: **196 passed, zero failed**.
- `node --test --test-reporter=spec scripts/verification/self-check.mjs`: **20 passed, zero failed**.
- `git diff --check`: **PASS**.
- The earlier parent's 270-test full suite and package smoke are historical;
  they were not rerun or relabeled as current full-suite results.

## 2026-10-15 confirmed-scope continuation: verified U2 finish

The user confirmed the handoff's practical U2 finish line: exact prompts,
continuation, attributed results and files work; 10 MiB is verified; uncertain
cleanup stops clearly with a practical recovery path. U3 approval normalization
and full release qualification are deferred, not represented as passing U2 work.

### Existing fix confirmed; remaining harness defect corrected

This continuation found the 10 MiB policy, revised cancellation/recovery, and the
regex-stack workaround already present in the uncommitted checkout. Native
2.0.29's grouped Base64 validation exhausts its default regular-expression stack
on large valid attachments. `ownedEnvironment()` already defaulted
`BUN_JSC_maxRegExpStackSize=536870912` for owned v2 children, preserving explicit
overrides. Independently launched attached servers need that setting in their
own server environment, as documented in README. No attachment splitting,
prompt rewriting, lower fallback limit, or engine-source patch was introduced.

The first fresh packed run passed 11/11 attached cases but failed the owned
10 MiB case. `createRuntimeFixture().spawn()` discarded `options.env`, replacing
the production-prepared child environment with the fixture environment. That
stripped the regex-stack default from the owned server. The helper now uses
`options.env ?? env`. A focused child-process regression was observed red with
an undefined stack setting, then green after the one-line fix. It also checks
that the supplied cleaned environment retains private HOME and no Slack token.
Default fixture environment isolation checks still pass.

README now documents blocked-turn recovery: restore connectivity, allow foreign
work to settle, restart using the same profile/workspace, preserve the recovery
file and mappings, confirm restart status, and inspect partial side effects
before manually retrying. Startup recovery never replays the failed prompt.

### Fresh verification results

All results below were executed by this continuation against the current tree:

| Check | Observed result |
| --- | --- |
| `npm test` after the fixture fix | **273 passed, zero failures** |
| `npm run test:pack` | **PASS** |
| `node --test --test-reporter=spec scripts/verification/self-check.mjs` | **20 passed, zero failures** |
| `git diff --check` | **PASS** |
| Freshly packed/installed native 2.0.29 attached candidate | **11/11 targeted cases passed; cleanup PASS** |
| Same packed candidate, native 2.0.29 Socket-owned server | **11/11 targeted cases passed; cleanup PASS** |
| Native active cancellation and same-session reuse; independent session unchanged | **PASS** |
| Native observed foreign input suppresses delivery without interrupting foreign work | **PASS** |
| Native committed instruction PUT with lost reply and delayed reply/cancellation | **PASS** |
| Twenty ordered native PUT/DELETE pairs | **PASS** |
| Real executor SIGKILL at `putting` and after admission, followed by fresh `ready()` | **Both PASS; no replay, owned context/journal cleared** |

Each packed cell covered authenticated startup, exact prompt/history
continuation, Chat continuation, provider failure, local document bytes,
artifact bytes, small image/document local and data-URI transport, exact 10 MiB
local and data-URI acceptance, oversized actual-byte and metadata rejection,
and server stop ownership. The Socket-owned case deliberately did not pre-set
the VM setting in the harness: production startup supplied its default.

Machine-local reproducibility pointers (OS-temporary, not durable artifacts):
`u2-revision-packed.mjs` and `u2-revision-native.mjs` in the approved temporary
`opencode` directory. Commands used were `node u2-revision-packed.mjs` and
`node u2-revision-native.mjs lifecycle`, `mutation`, and `crash`. The packed
script invokes the repository's targeted `runCell()` with the 11 case IDs above.
Probe-owned engines, profiles, listeners and staging were torn down successfully.

### Review, scope and delivery

**Code review: harness-native fallback** — `ce-code-review` was invoked, but its
review session lacked command execution and nested reviewer dispatch. A separate
read-only source review inspected the shared facade, both adapters, persistence,
startup/runner/delivery paths, fixture environment forwarding, relevant U2 tests
and recovery docs; it established no actionable defect. This is a bounded static
review, not a completed dedicated multi-agent or cross-model review receipt.
The parent inspected the actual diff and owns the fresh checks above.

The continuation's code change is one fixture line plus one focused regression;
no production behavior was changed in this continuation. A broad simplification
pass was unnecessary for this small correction; existing U2 implementation was
preserved rather than rewritten. No lint/typecheck script is configured.

Current results establish the explicitly confirmed local U2 milestone. They do
not establish U3 permissions/questions, the full nine-cell runtime/platform
matrix, full migration/rollback approval journeys, real remote-host behavior,
live Slack/human qualification, or release/deployment readiness. V1 adapter
contract/boundary checks passed in the full suite; native v1 matrix cells were
not rerun by this continuation. Earlier migration-history evidence above remains
historical, not renewed. No commit, push, PR, live restart or deployment occurred.
Work remains uncommitted on `feat/opencode-v1-v2` for the next authorized step.
