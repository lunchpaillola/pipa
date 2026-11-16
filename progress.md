# Pipa product progress

## Release-preparation checkpoint — 2026-11-16

- Stable clarification applied: GitHub release ID 447679446 is an **unpublished draft**, `prerelease: false`, named Pipa 0.6.1, provisional target 1ab406823e9436698ffccd70e9678d5ee86d1014. URL: https://github.com/lunchpaillola/pipa/releases/tag/untagged-a2f9159b3380de63506d . Notes explicitly say that target is still a 0.6.0 package until the reviewed metadata PR merges and draft is retargeted. No existing draft was duplicated. No tag was created intentionally; verify remote absence in final readback.
- Exact-0.6.1 preparation checks passed: npm test 569/569; package smoke printed packed CLI 0.6.1 for all three contracts; self-check 28/28; stable npm publish **dry-run only** contained 15 expected public files, no private profile data. Asserted all three package/lock version fields match and dependency graph/remaining metadata are unchanged. A local dry-run parser initially assumed array-shaped npm output; inspected its package-keyed JSON and corrected the local assertion, with no product changes. No real npm publication or dist-tag mutation. Separate preparation-PR CI/qualification/merge and clean merged-release package checks remain pending.

- Owner authorized exact-head squash merge plus draft-only release preparation, then explicitly selected **stable 0.6.1**, not beta. No public release/tag/npm publication, dist-tag mutation, install/restart, new live tests or spend authorized.
- PR #74 was verified mergeable at ca67d67293af5e24237b0f6a1befad102cb42067: CI/security SUCCESS, sole review thread resolved, no changes-requested review; fresh CodeRabbit was NEUTRAL/rate-limited, not approval. Inspected all three current workflows: no automatic npm/tag/release publication on merge or docs/version pushes. Squash merge with exact-head API guard succeeded; readback MERGED at 1ab406823e9436698ffccd70e9678d5ee86d1014 (21:57:40 UTC), tree byte-identical to tested feature head.
- GitHub stable/npm latest are 0.6.0; beta remains 0.6.0-beta.5. No existing draft or v0.6.1 release found; exact remote v0.6.1 tag query returned absent. Preserved all local live-test continuity on docs/stu-918-release-preparation from merged main. This separate preparation PR changes version metadata to 0.6.1 and adds docs/release-0.6.1.md; it does not change runtime/dependencies. Main's package remains 0.6.0 pending reviewed merge. GitHub draft targets the feature merge provisionally and must explicitly retain that limitation until retargeted to the actual merged version-bump commit.
- Merge-tree verification self-check passed 28/28. Exact-0.6.1 full/package/dry-run checks are next; no claim that prior 0.6.0 checks validate the new package version. Stable native/platform/live qualification and unfixed follow-ups remain required, not waived by the prior 0.6.0-only promotion exception. Mixed live outcomes and completed cleanup are retained below. Stop at preparation handoff; no automatic merge of this follow-up PR.

## Live-check checkpoint — 2026-11-16 21:42 UTC

- FINAL HANDOFF: no further user test steps, successful exchange requirement, restart or extension. Lola's retry succeeded; retained mixed outcomes are sufficient to describe the observed healthy-grant integration without rewriting earlier harness failures as passes. PR #74 returns to Sprock/Lola review at unchanged ca67d67293af5e24237b0f6a1befad102cb42067 with existing final-head CI success. This local progress-only update is uncommitted; no product/test/package files changed after the verified head. No merge/release authorized. Missing-permission handling remains deterministic evidence; visual status remains NOT VERIFIED. Readback captured at 21:54:39 UTC includes all observed requests/replies and final reactions; no additional messages were sent to force a green result.

- FINAL LIVE OUTCOME at ca67d67293af5e24237b0f6a1befad102cb42067: intended two-success healthy journey NOT PASSED due scratch-harness/input handling, not an established product regression. Startup Socket/auth and zero permission notices PASS; three real status API calls and receipt/result reaction operations returned ok. First Lola mention included copied instruction text; overly strict executor assertion returned “unexpected test request” (app reply https://lunchpaillabs.slack.com/archives/C0CB4GFH6HG/p1794865829848399). Unmentioned follow-up correctly ignored. Corrected mentioned `STU-918 live 2` executed the scripted turn and delivered https://lunchpaillabs.slack.com/archives/C0CB4GFH6HG/p1794866032914469 with bot white_check_mark verified by Slack readback. An additional Lola retry of live 1 reached the two-turn assertion and got https://lunchpaillabs.slack.com/archives/C0CB4GFH6HG/p1794866052707309, a harness-limit error. No further agent-authored prompts or access expansion.
- At 21:54:17 UTC the deadline shutdown completed: scripted executor stopped, real Socket disconnected, child 52840 exited (code 2), original tutorial config byte-unchanged and fixture state removed. PID absence independently verified at 21:54:39 UTC. Runner's generic BLOCKED text is not a correct summary of delivery count: three posts were delivered, but only one was a successful scripted reply; two-success criterion remains unmet. Visual “Working on it…” rendering lacks user/browser confirmation; Slack API acceptance is not rendering proof. Missing-scope enforcement remains untested. Retained actual output, readback/permalinks and scratch runner with the final-head evidence artifacts. No restart, grant/install change, paid inference, merge/release or production/Rick access. Any corrected rerun needs renewed bounded approval; nothing left listening.

- Lola explicitly approved exclusive Pipa Guide use and the bounded two-message healthy live check: “It sure can!” at https://lunchpaillabs.slack.com/archives/C0B9BJPJAT0/p1794865318316099, relayed by the current request. This supersedes the earlier live-test exclusion only for this test. No scope/install changes, production/Rick workspace access, paid inference, merge/release or continuous overnight operation.
- Available for the active bounded check. Target code is exact PR head ca67d67293af5e24237b0f6a1befad102cb42067; only this progress record changes locally. Original tutorial profile remains read-only. Fresh runtime fixture will hold config/session/workspace state, with Pipa Guide credentials loaded securely and only channel C0CB4GFH6HG/user U01KQLL26G5 allowed, mentionOnly true. Scripted executor, real Socket/Slack transport; two human-authored messages must come from Lola, never impersonated. Approval establishes exclusive availability; recheck no known local listener before connection. Automatically shut down the owned listener after completion or a short timeout.
- Prior deterministic feedback handoff is complete at ca67d67: capture PASS, focused 171/171, full 569/569, package smoke PASS, final-head CI https://github.com/lunchpaillola/pipa/actions/runs/43956882603 success. CodeRabbit finding visibly replied/resolved: https://github.com/lunchpaillola/pipa/pull/74#discussion_r4591602939. Healthy live proof cannot establish missing-scope enforcement. Next checkpoint: real Socket readiness and ask Lola for the two messages, or concrete startup blocker; retain redacted evidence outside the checkout.
- At 21:46:16 UTC, real Pipa Guide Socket Mode connected at ca67d67 with zero startup notices, exact demo/user allowlists and scripted executor. Test-owned child PID 52840; automatic shutdown by 21:54:17 UTC or earlier after both replies/reactions. Lola must send the two explicitly mentioned messages; no human messages sent by agent. Original tutorial profile is read-only, isolated state is fixture-owned. An earlier scratch-runner ESM import-resolution failure happened before auth/connection and cleaned up fully; corrected runner imports, no product code changes. Next: Lola's actual mention and same-thread mentioned follow-up, observe API status/reaction results and replies, then verify exit/cleanup.

## Current checkpoint — 2026-11-16 — PR 74 feedback: docs correction + internal extraction

- Feedback implementation complete locally: private map/helper extracted verbatim (only `export` added); app.mjs differs solely by import/removal. README now distinguishes caught reaction rejection from slow/pending receipt latency; no scheduling change. Module exports only `warnMissingSlackScopes`. Added entry-point characterization for a throwing warning callback; focused checks passed 171/171 both before and after extraction.
- Lola requested executed experience, not another sample. Added a bounded capture command using the existing runtime fixture, production initializePipa/startPipa, saved/loaded disposable config, injected auth/Chat/executor and fake outbound Slack. Covers healthy chat:write without assistant:write, core missing chat:write, multiple optional/private losses, exact copy/order, and mention/subscribed reply delivery despite rejected status/reactions. No new framework. Boundary: application entry points, not a full Socket CLI connection; existing package smoke separately invokes real CLI init and Managed start. No live enforcement/rendering claim.
- Precommit full checks: npm test passed 569/569; npm run test:pack passed all three existing native-version contracts. Development capture passed after correcting the capture's assertion to compare optional E3 lines explicitly (README only samples two notices). Next: commit owned changes, rerun capture/focused/full/package at the clean exact head, push same PR, verify final-head CI, reply/resolve the targeted CodeRabbit thread. Exact-head receipts will be retained outside the checkout to avoid changing the verified SHA.

- Current feedback accepted for this same PR: [CodeRabbit README finding](https://github.com/lunchpaillola/pipa/pull/74#discussion_r4591342304) is valid. On starting head c3c276e, app.mjs awaits the receipt reaction before enqueue; rejected reactions are caught, but slow/pending calls can delay replies. Correct documentation only; do not change reaction scheduling.
- Lola's module-boundary feedback: move the private capability map plus notice evaluation/formatting unchanged into src/slack-permissions.mjs; export only warnMissingSlackScopes for the two app.mjs callers. No public package API, registry/classes or broad cleanup. Preserve E3 copy/output/order, unknown guard and warn-callback failure behavior. Keep entry-point regressions; add only useful characterization coverage.
- Availability confirmed at 20:54 UTC on 2026-11-16 for this bounded active pass, not overnight execution. Starting tree clean, branch fix/stu-918-slack-permissions at c3c276e3ba8d741bf29f7d29ca449fd9f68f7f67; unrelated work remains untouched. CodeRabbit thread PRRT_kwDOT98WB864IH-N is unresolved with no prior reply; no pending review found. Next checkpoint: extraction/diff proof plus focused tests, then full/package and final-head CI. No new agents, live Slack messages/tests, production changes, merge/release or spend.

## Prior handoff — retained evidence

- **Deliverable:** [PR #74](https://github.com/lunchpaillola/pipa/pull/74), branch fix/stu-918-slack-permissions, base b5392af. Implementation commit 7df5b24, strengthened async-ingress test commit d459056. No runtime changes after independent review; final continuity commit changes only this document.
- **Final local results on d459056:** focused app/state PASS 170/170; npm test PASS 568/568 (159.5s); npm run test:pack PASS across the existing 1.19.0/2.0.29/2.2.5 contract fixtures; git diff --check PASS. Evidence logs: stu918-focused-final.log, stu918-full-final.log, stu918-pack-final.log in the approved host temporary directory. These are deterministic tests, not live Slack or native-engine qualification. Repo-local verification instructions were exercised through their documented doctor/drive/evidence/cleanup checks; no persistent real app instance was launched.
- **CI evidence source:** [PR checks](https://github.com/lunchpaillola/pipa/pull/74/checks) for the exact remote head. CI is mutable external evidence, not inferred from local tests or this document; the final handoff must read the head/check conclusions after this continuity commit is pushed. The code and test tree remains d459056 apart from this progress record. A passing prior-head run must not be substituted for the final head.
- **Next owner/action:** Sprock/Lola review the focused PR and its final-head check receipt. Stop at PR handoff; no merge/release, production cutover, live Slack tests/messages or spend. All approved reviewer work is complete; no active agents or background jobs. No deferred actionable findings. Live Slack enforcement/rendering remains NOT VERIFIED by the explicit approval boundary.

- **Approval recorded before implementation:** Lola approved the build/team/test/one-PR gate with “OK, this is good thank you” at [approval](https://lunchpaillabs.slack.com/archives/C0B9BJPJAT0/p1794860145727519), relayed explicitly in the current request. Approved: Chopper builds/integrates; one independent general reviewer checks accuracy and simplification; deterministic focused/full/package checks and final-head CI; one focused PR. No live Slack tests/messages, merge/release, production changes or spend.
- Availability: active now at 2026-11-16 20:16 UTC; this is not an unattended overnight promise. First concrete checks: fetched origin/main, confirmed unchanged base b5392affb66b6e7a72de28bdf115292f35d89121 and re-read official status-method docs (chat:write suffices; assistant:write remains transitional). Next: feature branch and focused app/state baseline before product edits. If execution stops, checkpoint here rather than imply continuing work.
- Pre-work inventory: detached 652f1b5d8c89bcee8884b0a510c2d3703fe8faf9; only progress.md untracked, authored for this approved task. No user edits or index entries observed; no commits ahead of remote main. Native inline execution selected per approved team; no external engine/config preference or additional builders. Existing PR #72 is unrelated and untouched.
- Build checkpoint (20:27 UTC): branch fix/stu-918-slack-permissions from b5392af. Focused baseline PASS 166/166; seven updated/new selected notice/auth tests observed FAIL against old implementation before production edits (retained stu918-red.log). Implemented capability map/shared formatting, token-specific app-preflight advice, README scope audit/overview and regressions. Default manifest and typing/authorization/provider paths unchanged. One intermediate SDK fixture used token-scoped webClient rather than the adapter's internal outbound client; corrected the replacement to _client, matching existing SDK tests, before the passing run. Only synthetic xoxb-test values were used; these fixture runs are not live evidence.
- Verification before independent review: focused app/state PASS 169/169, then one additional provider-separation test included in full npm test PASS 568/568 (159.6s); npm run test:pack PASS for v1/v2 fixture contracts. Logs are in approved host temporary storage (stu918-baseline.log, stu918-red.log, stu918-focused.log, stu918-full.log, stu918-pack.log). Run final focused/full/package again after review fixes. Git diff whitespace check PASS. Repo-local verification instructions reuse these existing checks, and a narrow gitignore exception tracks only this permission-verification skill, not runtime state. Independent reviewer is next, then final-head CI and one PR; no live Slack actions or production changes authorized.
- Independent review/simplification completed on 7df5b24016a2759ee8afec85a7e9076a5c3b3205 by the one approved general reviewer (session ses_e19f2c6e1ffe3N3cLH377eBvw3). No actionable defects or useful safe cuts. Focused ce-code-review receipt status complete, run stu918-review; artifacts retained privately in the approved host temporary directory. No external model route or extra reviewer was launched. Reviewer noted bounded evidence gap: synchronous SDK parsing did not prove enrichment fallbacks in the combined ingress path. Supervisor strengthened the same routing test to use real async parseSlackMessage with user/channel references and denied outbound metadata APIs; focused suite now PASS 170/170. No production code change after the review. Final full/package checks and exact-head CI remain pending before handoff.

## Planning record — superseded approval status, retained history

**Status: PLANNING ONLY.** Sprock accepted dropping the speculative INFO notice and preserving existing silent defensive handling/tests. E3 supersedes only E2's unknown-state presentation; connected core/feature notices, audited mapping, default scopes/typing, nonblocking startup and deterministic verification boundary remain unchanged. This acceptance is not Lola's build approval. Chopper is available and owns integration; no agents or background jobs are running. Next checkpoint: attach E3 for review, then await Lola's explicit build approval. No product code, manifest, branch, test app or ticket changes are authorized yet; no live messages, production restart, customer replies, merge/release or spend.

### Evidence review — unknown-grants INFO is not justified by observed integration evidence

- Decision accepted in the current request: **drop the proposed user-facing INFO; preserve the existing silent defensive return when grant metadata is unavailable, and its tests.** This supersedes E2's fourth sample and related presentation assertions only. Do not remove safe handling or treat unknown as an empty set; do not introduce logging, retries, extra probes or another subsystem.
- Inspected SHA remains 652f1b5d8c89bcee8884b0a510c2d3703fe8faf9. src/app.mjs:32-34 and :47-49 call checkSlackToken then warnMissingSlackScopes. checkSlackToken (:1033-1045) makes a direct Node fetch POST to Slack auth.test using the configured xoxb token, requires HTTP success and body ok, reads x-oauth-scopes first, splits commas and normalizes. Only if normalization yields undefined does it try the raw JSON body's response_metadata.scopes. It returns the original body when neither source is usable. Adapter metadata is not passed into this path.
- normalizeGrantedScopes (:1099-1103) accepts arrays of nonempty strings, trims/deduplicates, otherwise returns undefined. An explicit [] is valid known-empty. A missing/empty/malformed header without a usable body fallback yields no computed grantedScopes. warnMissingSlackScopes (:1105-1106) currently returns silently for non-array grants. Authentication/HTTP rejection throws earlier; request/JSON failures are not successful-auth unknown-grant cases.
- Official auth.test docs (https://docs.slack.dev/reference/methods/auth.test/) show successful bot JSON identity without a scope list. **That is body-only evidence, not evidence the HTTP header was absent.** Official OAuth guide's Appending scopes section (https://docs.slack.dev/authentication/installing-with-oauth/#appending_scopes) says x-oauth-scopes is returned with **every response**, indicating the calling token's current scopes. For this direct-fetch integration, a successful scoped bot response is therefore expected to supply header metadata. No documented normal missing-header case was found.
- Adapter dist/index.js:1300-1318 performs its own separate WebClient auth.test and uses identity fields only. Installed @slack/web-api/dist/WebClient.js:668-678 explicitly synthesizes response_metadata.scopes from x-oauth-scopes (and acceptedScopes separately from x-accepted-oauth-scopes). Seeing this SDK-shaped field is not proof Slack sends it in raw JSON; Pipa's preflight is not using WebClient. Raw-body fallback is defensive, not independently verified here.
- test/app.test.mjs:1250-1273 uses injected fake HTTP responses to cover header normalization, body fallback and absent/malformed metadata. :1314-1331 injects grantedScopes undefined and asserts no warning. These are synthetic contract tests, **not observed Slack responses**. No tests were run for this review.
- Searched tracked source/tests/scripts/docs for grant metadata receipts; found no retained real auth.test header/body capture demonstrating successful auth with missing scope metadata. Existing live evaluator scripts/verification/slack-eval.mjs:90-101 checks identity/workspace, not scope headers, and does not substantiate this scenario. Rick's reported missing-assistant warning establishes a displayed missing-scope warning, not the absent-metadata scenario or a raw header capture. No private profile/token/log dump or new authenticated request was made.
- Conclusion: possible under defensive inputs/abnormal transport, **not demonstrated as a real successful response in Pipa's actual integration and contrary to Slack's documented expected header**. Do not promote a hypothetical guard into routine customer messaging. Keep silent internally (existing undefined/early-return behavior, not a new log), keep negative tests proving no false missing-grant warning, and surface actual existing operation/auth errors as before. Do not falsely announce verified capabilities when the check was skipped.
- Next checkpoint: attach the final E3 review export, then await Lola's build approval. E2's connected consequence/remedy notices, audit, default scopes/typing, nonblocking startup and deterministic-only verification boundary otherwise remain unchanged. No implementation or reviewer launch.

### Final experience E3 — E2 with speculative INFO removed

**Decision:** connect consequence and remedy in each notice. One icon + written severity + capability loss + relevant scope/token + action in the same logical line. Natural wrapping is fine. No separate Missing lines, shared Next footer or repeated Help copy. Combine related consequences sharing the same scope/action, notably private-channel follow-ups and preceding context. Enhancements stay opt-in. At most one useful still-available line, derived from satisfied grants, never a live-readiness guarantee.

**Silent defensive handling:** keep the current early return when reported bot grants are unavailable/unusable; no INFO notice, extra logging, probe or new subsystem. Preserve existing tests for this behavior. Do not infer missing grants or verified capabilities. Extra/unrecognized grant names are ignored; an explicit valid empty array remains known-empty. The evidence review above explains why this is not a customer-facing scenario.

**Three terminal samples (illustrative, NOT executed):** Socket Mode, valid app token, existing startup messages preserved. The fixed local URL is an example, not a running preview. Notices remain at the existing bot-scope-check position before connection completes.

#### Healthy grants — no permission notice

```text
$ pipa start
Waiting for OpenCode... Ctrl+C to stop.
Pipa started a private OpenCode server at http://127.0.0.1:54321.
Pipa is connected through Slack Socket Mode.
```

#### Core reply loss — only bot chat:write missing

Other grants, including the currently transitional status alternative assistant:write, are present. No extra status-loss notice:

```text
$ pipa start
Waiting for OpenCode... Ctrl+C to stop.
✖ ERROR — Pipa cannot send text replies. Ask your Slack app admin to grant chat:write (bot) to enable replies.
Pipa started a private OpenCode server at http://127.0.0.1:54321.
Pipa is connected through Slack Socket Mode.
```

#### Several enhancements/channel capabilities missing

Only bot files:write, reactions:write and groups:history are missing; public-channel text permissions are present:

```text
$ pipa start
Waiting for OpenCode... Ctrl+C to stop.
⚠ WARNING — File uploads unavailable. To enable uploads, ask your Slack app admin to grant files:write (bot).
⚠ WARNING — Receipt and result reactions unavailable. To enable reactions, ask your Slack app admin to grant reactions:write (bot).
⚠ WARNING — Unmentioned private-channel follow-ups and preceding thread context unavailable. If you use private channels, ask your Slack app admin to grant groups:history (bot).
Still available: Public-channel text requests and replies.
Pipa started a private OpenCode server at http://127.0.0.1:54321.
Pipa is connected through Slack Socket Mode.
```

**Placement/repetition and limits:** one evaluation per init/start invocation, after successful bot auth; no per-request repetition or new persisted suppression. Healthy grants and Managed mode stay silent. No notices for satisfied alternatives, unused user grants, missing canvas grants or hypothetical features. Keep default scopes and typing unchanged. Icons are supplementary; ERROR/WARNING and their text carry meaning without color or glyph support. ERROR describes core capability loss, not a new fatal-startup/exit rule. The existing Socket connection message does not mean replies or optional capabilities are ready. Actual Slack/runtime/provider failures retain existing timing and error paths; these notices do not rewrite or diagnose them. Setup, membership, command registration and any genuinely necessary reauthorization detail belong in docs, not repeated notice footers. No new UI/framework, API migration or extra permission probes.

**Verification agreement:** retain v2's audit, scope alternatives, nonblocking delivery/typing regressions, manifest checks and focused/full tests, package smoke and final-head CI. Preserve existing silent defensive handling/tests rather than add unknown-state presentation. Assert consequence/action/scope/token connected in each logical notice; no Missing/Next/Help split; private history consequences combined with groups:history once; at most one truthful still-available line; no healthy or absent/unusable-metadata notice. Severity order and stable capability order remain. Recheck official status requirements before build: chat:write suffices, assistant:write remains explicitly transitional. Live Slack enforcement/rendering remains NOT VERIFIED; no live messages or test-app setup.

**Owners/gate:** Chopper implements/integrates only after Lola's build approval; the one independent accuracy/simplification reviewer is still proposed, not launched. Attach STU-918-notice-experience-final-E3.md here. Canonical continuity remains progress.md; the attachment is a review export. This request authorizes shaping only, not building, merge/release or spend. E3 changes only E2's unknown-state presentation; all other approved planning refinements remain intact.

### Superseded experience E1 — retained for history, replaced by E2 above

**Audience/task:** a CLI operator deciding whether Pipa can handle their Slack workflow and whether IT needs to change anything. Lead with lost capability, not OAuth terminology. Stay within existing init/start terminal output.

**Display contract:** one compact startup block, one icon + explicit ERROR/WARNING/INFO label per affected capability, severity ordered then fixed capability order. Scope/token details are indented beneath the affected capability. No color dependency, columns, spinner, new command or interface. Natural terminal wrapping is allowed. ERROR means core reply/ingress capability loss, not a new process-exit rule; WARNING means optional or channel-specific loss; INFO means scope metadata is unknown. Never label unknown as missing or verified. For icons that cannot render, the written severity and consequence remain sufficient.

- Show a single scope-based “Still available” summary when any known loss is present, derived from remaining satisfied capabilities; never promise unrelated features still work. Unknown state instead says availability was not established. Healthy grants produce no permissions block, success badge or sweeping “everything works” claim.
- Emit a single shared Next/Help footer per non-healthy block, not per capability. Core/optional actions refer to the access details; optional enabling stays opt-in. Unknown's action is to continue and investigate only if a real operation fails, not to grant/reinstall blindly. README > Slack permissions is the proposed docs heading to add after approval; setup/registration/membership and provider-error caveats live there, not repeated in headlines.
- No line for a satisfied alternative (chat:write satisfies current status access), unused user grants, absent canvas grants or unrelated extra permissions. If one missing scope affects separate user capabilities, show those consequences separately but do not repeat remediation. For private history this means distinct unmentioned-follow-up and preceding-context losses.

**Proposed terminal output — illustrative review samples, NOT actual runs.** The four cases assume Socket Mode and a valid app token; a fixed example server URL only illustrates existing startup output. Existing startup lines remain unchanged. Notices appear at the existing scope-check position: after successful bot auth, before the server/Socket connection completes. The block is labeled a permissions check, so “Still available” is scope-based, not a live test result.

#### 1. Healthy reported grants

All mapped capabilities are satisfied. This also covers absent assistant:write with chat:write present, absent unused user/canvas grants and unrelated extra grants. No permissions notice or footer:

```text
$ pipa start
Waiting for OpenCode... Ctrl+C to stop.
Pipa started a private OpenCode server at http://127.0.0.1:54321.
Pipa is connected through Slack Socket Mode.
```

#### 2. Core reply permission missing

Only bot chat:write is absent; assistant:write and ingress grants remain present. This avoids falsely showing a status-loss notice when its transitional alternative is satisfied:

```text
$ pipa start
Waiting for OpenCode... Ctrl+C to stop.
Pipa Slack permissions (reported grants)
  ✖ ERROR  Cannot send replies.
    Missing: bot scope chat:write.
  Still available: Receiving requests.
  Next: Ask your Slack app admin to enable the capabilities you need.
  Help: README > Slack permissions.
Pipa started a private OpenCode server at http://127.0.0.1:54321.
Pipa is connected through Slack Socket Mode.
```

Connection is not reply readiness. Preserve existing nonblocking startup; the ERROR stays visible and the connection line does not negate it. Other authentication/startup failures can still terminate startup as before.

#### 3. Several optional/channel capabilities missing

Bot commands, reactions:write and groups:history are absent; public-channel text permissions and other mapped grants are present. Private-channel use is not inferred from a channel ID or allowlist:

```text
$ pipa start
Waiting for OpenCode... Ctrl+C to stop.
Pipa Slack permissions (reported grants)
  ⚠ WARNING  Cannot use model slash commands.
    Missing: bot scope commands.
  ⚠ WARNING  Cannot show receipt or result reactions.
    Missing: bot scope reactions:write.
  ⚠ WARNING  Cannot receive unmentioned private-channel follow-ups.
    Missing: bot scope groups:history.
  ⚠ WARNING  Cannot read preceding private-channel context.
    Missing: bot scope groups:history.
  Still available: Public-channel text requests and replies.
  Next: Ask your Slack app admin to enable the capabilities you need.
  Help: README > Slack permissions.
Pipa started a private OpenCode server at http://127.0.0.1:54321.
Pipa is connected through Slack Socket Mode.
```

#### 4. Unknown bot-scope metadata

Bot authentication succeeded but scope metadata is absent/malformed; not equivalent to an explicit valid empty array:

```text
$ pipa start
Waiting for OpenCode... Ctrl+C to stop.
Pipa Slack permissions (reported grants)
  ℹ INFO  Cannot determine permission-based feature availability.
    Bot-scope metadata was not provided or was unusable.
  Availability: Not established by this check; startup continues.
  Next: Continue; investigate the reported error if an operation fails.
  Help: README > Slack permissions.
Pipa started a private OpenCode server at http://127.0.0.1:54321.
Pipa is connected through Slack Socket Mode.
```

**Placement and repetition:** reuse warnMissingSlackScopes at initializePipa/startPipa, after bot auth succeeds. Emit at most one permissions block per invocation. Running init and then start may show the block once in each command; no new persisted suppression or cache. Do not replay this summary for every Slack message, typing attempt or provider request. Managed profiles have no Slack block. Keep stdout/stderr routing and unrelated startup messages unchanged; combined terminal samples illustrate relative call order, not a guarantee of interleaving when streams are captured separately.

**Runtime/provider distinction:** the header identifies a reported-grant preflight, not a failed model request. Actual Slack operation/authentication/network failures and OpenCode/provider errors retain existing errors and timing; do not rewrite or classify them through this formatter. Missing metadata cannot diagnose an operation failure. No promise that changing optional scopes resolves provider errors. No API migration, scope removal, feature disabling or new status probe.

**Team and verification:** unchanged: Chopper implements/integrates only after approval, then one independent general reviewer checks accuracy/regressions and simplification. Preserve v2's full permission audit and test agreement below. Add presentation assertions to existing tests: one labeled line per lost capability, details not headline, deterministic severity order, shared summary/footer exactly once, no healthy/satisfied-alternative/unused notices, truthful unknown state and no per-turn summary repetition. Test same-scope multiple consequences without hiding one. Keep focused/full tests, package smoke and exact-final-head CI; live Slack remains NOT VERIFIED. Recheck current official status requirements before build, including the explicitly transitional assistant:write alternative.

**Review artifact:** STU-918-notice-experience-E1.md is a compact export of this section attached in this thread, not a competing continuity file. Product code has not changed. Return to Sprock for product review, then Lola; do not launch build or reviewer.

### V2 planning review — 2026-11-16 (current engineering-thread request)

- Sprock independently checked the official status-method page: chat:write suffices; assistant:write is currently an alternative but explicitly transitional, not a lasting guarantee. Preserve this limitation and recheck official requirements before build. No API migration in this issue.
- Customer notices should contain only the lost capability, scope/token and necessary action. Move repeated provider-error caveats and setup detail into documentation. Capability mapping, unknown-state handling and the regression agreement remain unchanged.
- Planning review is not Lola's implementation approval. Remain paused; do not launch the build or independent reviewer. Existing attachment confirmed; no replacement attachment needed for this review acknowledgment.

### Recommendation and important correction

Use one small, explicit capability-to-permission table and one shared notice formatter in the existing scope-notice path. Evaluate lost capabilities, not “every default grant absent.” Document all requested permissions, including generated user grants that Pipa never consumes. Preserve the manifest and existing best-effort typing calls.

**V1's notice is factually superseded:** current official Slack documentation says `assistant.threads.setStatus` accepts **either `chat:write` or `assistant:write`**. Slack's March 5, 2026 changelog explicitly permits channel loading states without assistant:write or the assistant split view. Missing assistant:write with chat:write present therefore does **not** establish loss of typing status and should produce **no missing-status notice**. The pinned adapter's comment claiming assistant:write/Agents & AI Apps are required is outdated; its executed code calls setStatus without a local scope gate. Actual rendering in this workspace is NOT VERIFIED. Do not migrate APIs or edit dependencies for this issue.

### Revision and continuity

- Inspected checkout `/Users/lolaojabowale/pipa`, detached `652f1b5d8c89bcee8884b0a510c2d3703fe8faf9`; tracked files unchanged, only this untracked progress.md. Cached remote main is `b5392affb66b6e7a72de28bdf115292f35d89121` from the planning fetch. No STU-918 PR has been created. The base must be refreshed and the audit rechecked after approval, before edits.
- Read the current product runbook and existing progress; repository AGENTS.md, CONTRIBUTING.md, overview and testing guidance remain applicable. V1 recovery/history is retained below; do not overwrite unrelated work or touch stats PR #72.
- Evidence below is source inspection plus official docs retrieved 2026-11-16, not executed missing-permission tests. SDK/adapter inspected: chat and @chat-adapter/slack 4.38.1.

### Complete generated/requested permission audit

Definitions: **Core** = required for the named core path, not a claim that every alternative entry path fails. **Channel-dependent** = needed for that public/private channel experience, not a universal requirement. **Feature-dependent** = absence loses the named enhancement, not ordinary text replies. **Unused/unneeded** = no invoked Pipa capability needs this grant. **Uncertain** = insufficient evidence; never assert a loss or demand a grant without resolving it.

Each scope name links to its current official Slack definition. Bot rows mean Pipa's configured **xoxb bot token**, even when Slack also supports that scope on user tokens. Membership, installation, authorization allowlists and event/command registration are separate prerequisites; having a scope alone does not prove a working capability.

| Permission | Token/request source | Classification | Actual path and concrete impact when absent |
| --- | --- | --- | --- |
| [connections:write](https://docs.slack.dev/reference/scopes/connections.write/) | xapp app-level token; requested by bin/pipa.mjs setup, not manifest bot scopes | Core, Socket profile only | apps.connections.open in app-token preflight and Socket Mode client. Without the grant a valid app token cannot establish Socket ingress. Bot grants cannot fix an app-token problem. Managed mode has no Slack requirement. |
| [app_mentions:read](https://docs.slack.dev/reference/scopes/app_mentions.read/) | xoxb; generated bot scope | Core for subscribed app_mention entry point | Manifest app_mention event -> adapter -> onNewMention. Without it that event subscription is unavailable. message.channels/groups are distinct ingress paths; do not claim every form of mention delivery necessarily stops. Installed/invited bot and subscribed event are required too. |
| [chat:write](https://docs.slack.dev/reference/scopes/chat.write/) | xoxb; generated bot scope | Core for text replies | Adapter chat.postMessage/postEphemeral/update used by replies, controls and picker feedback. Without it normal message delivery is unavailable. Also satisfies the current setStatus permission requirement. Membership is still required; do not add chat:write.public. |
| [channels:history](https://docs.slack.dev/reference/scopes/channels.history/) | xoxb; generated bot scope | Channel-dependent, required for full public-channel follow-up experience | message.channels subscription and direct conversations.replies for preceding context. Without it unmentioned public-channel subscribed replies are unavailable via message.channels and history reads fail; new app_mention requests can still arrive separately. Pipa labels unavailable context rather than blocking the current prompt. |
| [groups:history](https://docs.slack.dev/reference/scopes/groups.history/) | xoxb; generated bot scope | Channel-dependent, required for full private-channel follow-up experience | Same path through message.groups/private conversations.replies. Missing scope affects private-channel follow-ups/context, not public-channel support. Private membership and invitations remain necessary. |
| [channels:read](https://docs.slack.dev/reference/scopes/channels.read/) | xoxb; generated bot scope | Feature/channel-dependent: public-channel metadata enrichment | Adapter resolveInlineMentions -> lookupChannel -> conversations.info; failed lookup falls back to the channel ID. No Pipa calls to fetchThread/fetchChannelInfo were found. Ordinary event handling constructs thread visibility from adapter event/ID metadata, not these lookups. Missing scope loses public-channel name resolution, not demonstrated loss of all replies. Preserve security filters; do not call this an authorization bypass or change their behavior. |
| [groups:read](https://docs.slack.dev/reference/scopes/groups.read/) | xoxb; generated bot scope | Feature/channel-dependent: private-channel metadata enrichment | Same adapter lookup for private channels; falls back to channel ID when denied. Missing grant affects private-channel names/metadata. Pipa does not proactively list/join channels. |
| [commands](https://docs.slack.dev/reference/scopes/commands/) | xoxb; generated bot scope | Feature-dependent: model slash commands | createModelPicker registers normalized name/alias command handlers. Without grant/registration, slash picker entry is unavailable; mentions/thread text can continue. Socket Mode, interactivity and matching command definitions are additional prerequisites. Do not rerun init or replace a customized manifest. |
| [files:read](https://docs.slack.dev/reference/scopes/files.read/) | xoxb; generated bot scope | Feature-dependent: incoming file contents | Adapter createAttachment/fetchSlackFile uses bot-authenticated private file URL; executor fetches current attachments. Missing scope prevents protected file downloads. An attachment-bearing request may fail; do NOT promise it silently falls back to text. Plain text requests do not need this grant. No Pipa files.info invocation was found; the actual path is URL download. |
| [files:write](https://docs.slack.dev/reference/scopes/files.write/) | xoxb; generated bot scope | Feature-dependent: outgoing files | Adapter files.uploadV2 uses Slack external-upload APIs. Missing scope prevents artifact/full-form-detail uploads. postResult retries text-only on artifact delivery failure; that does not promise every file-dependent interaction works. Normal text replies still use chat:write. |
| [reactions:write](https://docs.slack.dev/reference/scopes/reactions.write/) | xoxb; generated bot scope | Feature-dependent: receipt/result reactions | app.mjs react/finishReaction -> adapter reactions.add/remove; failures are caught. Missing scope loses eyes/success/failure reactions, not the text reply. |
| [users:read](https://docs.slack.dev/reference/scopes/users.read/) | xoxb; generated bot scope | Feature-dependent: user profile/name enrichment | Adapter lookupUser -> users.info; denied lookup returns null and parsed author retains envelope user ID. Pipa authorization uses IDs/bot_id, not display names. Model command path already bypasses optional profile fetch. Missing scope loses friendly profile/name resolution; do not request users:read.email. |
| [assistant:write](https://docs.slack.dev/reference/scopes/assistant.write/) | xoxb; generated bot scope | Feature-dependent alternative, redundant for Pipa's current status call when chat:write is granted | Pipa invokes only thread.startTyping("Working on it...") -> assistant.threads.setStatus. Official method accepts chat:write OR assistant:write; no Pipa title/suggested-prompt/context handlers found. Missing assistant:write alone has no demonstrated capability loss. Status errors remain nonblocking. Keep the default scope pending a separately approved removal proposal. |
| [files:read](https://docs.slack.dev/reference/scopes/files.read/) | xoxp user-token grant in generated oauth_config.scopes.user | Unused/unneeded by Pipa runtime | Pipa asks for and stores xapp/xoxb only; adapter receives botToken, no user token. Without this user grant no current Pipa capability is lost; bot files:read remains a distinct dependency. Preserve generated defaults in this change. |
| [files:write](https://docs.slack.dev/reference/scopes/files.write/) | xoxp user-token grant in generated oauth_config.scopes.user | Unused/unneeded by Pipa runtime | Same unused user-token path; uploads use bot token. Missing user grant does not disable bot uploads. Preserve defaults pending explicit permission-removal approval. |

All 12 generated bot scopes, both generated user-scope entries and the separately requested app-token scope are accounted for. No other permission names are requested by Pipa setup/runtime in the inspected source. This is not an audit of permissions independently requested by a user's OpenCode tools, MCP servers or Composio connections.

### Canvases: investigated, not assumed supported

- [canvases:read](https://docs.slack.dev/reference/scopes/canvases.read/) supports bot/user tokens and canvas content/section APIs. [canvases:write](https://docs.slack.dev/reference/scopes/canvases.write/) supports bot/user tokens and create/edit/delete/access APIs.
- Neither scope is generated or requested by Pipa. No canvases.* API invocation exists in Pipa or the inspected adapter JS. Adapter normalizeAppContextEntities recognizes a canvas ID; Pipa does not invoke that context helper or register a canvas handler. Parsing an ID is not reading content.
- Classification: **unused/unneeded for the implemented Pipa Slack transport**, not an optional supported Pipa feature. Missing these grants warrants no Pipa notice; additional grants warrant no notice either. Do not claim canvas editing/reading works, remove a user's grants, or add new feature support.
- Uncertain/outside scope: canvas files/links incidentally appearing in a Slack message are not a tested content integration. Independent OpenCode/MCP tools may use their own credentials. No claim about their needs follows from this audit.

### Smallest reusable design — proposal only

1. Keep a single static capability list next to warnMissingSlackScopes in src/app.mjs; each row needs only capability label, token kind, scope alternatives, impact and core/channel/optional classification. Use one shared formatting path: E2 connects each lost capability and remedy, combining related consequences sharing one scope/action. No plugin registry, policy engine, settings UI, inferred remote manifest, capability state store, dependency or new API support.
2. Express **alternatives per capability**, not one warning per scope: status is satisfied by chat:write OR assistant:write. Other current rows have one required scope each; channel history and metadata are separate capabilities with separate impacts. Do not add a general rule language for hypothetical permissions. A later real capability adds one explicit evidence-backed row.
3. Evaluate only metadata for its matching token. Current grantedScopes comes from bot auth.test; it cannot establish app-level or user-token grants. Keep existing app-token preflight separate, with remediation tied to a known missing_scope response rather than treating every invalid token/network failure as permission loss. Do not add app-token scope discovery or a provider-error refactor. Limit any touched app-token message to the actual preflight, preserving validation/error behavior.
4. Known missing core capability -> ERROR; optional/channel dependency -> WARNING. Per E2, connect consequence, scope/token and remedy within each notice; combine related same-scope/action consequences instead of duplicating notices. No separate details/footer. Do not claim global failure for channel-specific loss. Render independent losses deterministically. If chat:write is missing, text replies are still a core problem even if assistant:write can authorize status.
5. Per the accepted evidence review/E3, preserve existing silent defensive handling for absent/unusable scope metadata and its tests. No INFO output or extra logging/probes. Do not treat unavailable metadata as an empty granted set or a successful permission check. An explicit valid empty scope array is known-empty. Keep successful startup nonblocking; no new enforcement or feature disabling. Reuse normalizeGrantedScopes.
6. Ignore extra/unrecognized grants, unused user grants and unrelated missing scopes such as canvases.*. Do not compare actual grants against every manifest default. The manifest is the out-of-box request, not the runtime minimum.
7. Remediation: core missing grants may require reviewing/installing/reauthorizing the existing app, scoped to the named capability. Optional notices must say “only if you want this feature”; no blanket reinstall advice. Membership, registration and runtime failures remain distinct. Missing grants do not diagnose provider/model failures. No automatic permission, app, token or workspace mutations.

### Superseded notice samples — replaced by experience E1 above

**Known core missing** (bot chat:write absent):

> Pipa Slack warning: Text replies unavailable: bot scope chat:write is missing. Ask your Slack app administrator to grant it and reauthorize the existing app if required.

**Multiple optional missing** (bot commands, reactions:write and files:write absent, core text permissions present):

> Pipa Slack optional features unavailable: model commands (bot commands), reactions (bot reactions:write), file uploads (bot files:write). Grant only those you want to enable; ordinary text replies do not need them.

**Channel-dependent** (bot groups:history absent; private-channel use not known from local configuration):

> Pipa Slack channel requirement: Private-channel follow-up events and preceding context unavailable: bot scope groups:history is missing. Grant it if you use private channels.

**Unknown metadata** (no usable reported scopes):

> Pipa Slack info: Bot permissions not checked: scope metadata unavailable. No permission change recommended from this check alone.

**Absent assistant:write + present chat:write:** no missing-status notice. **Absent canvas scopes or extra grants:** no notice. Docs explain why. These examples are output-shape samples; final wording must remain factual if the evidence changes before build.

### Proposed work, owners and approval gates

- **Chopper — supervisor, sole implementer and integration owner:** after approval, refresh main and create one focused fix/stu-918-slack-permissions branch, carry this progress forward, recheck source/docs drift, implement the small table/formatter in the existing notice path and align README's setup scope matrix plus repository overview. Check callers initializePipa/startPipa, existing app-token validation, manifest fixtures, scope parser, typing path and package smoke. No manifest, dependency, version, provider flow, authorization, canvas or DM-support changes.
- **One independent general reviewer — proposed, NOT launched:** on the exact resulting branch/SHA, audit the permission matrix against official docs and invoked adapter methods, verify classification/alternative scopes and caller behavior, review regressions and perform the required simplification pass. Return findings/proof, no competing edits. Chopper integrates safe fixes and reruns affected checks.
- **Deliverable after approval:** one focused tested PR. No merge/release, production installation or spend. Sprock reviews plan v2 first, then tags Lola. V1 planning review is not approval of v2.
- Canonical continuity remains this progress.md; the attached plan-v2 file is a review export, not a second handoff/decision source. Earlier v1 records remain below as superseded history.

### Revised verification and readiness (NOT RUN)

**Available:** Node 22.23.2, installed dependencies, production functions and existing Node test fixtures, package smoke and GitHub read access. No live credentials needed for proposed deterministic tests. Four upstream verification-skill files were found during v1 discovery. Reuse existing test commands; any required repo-local verification instructions should point to these checks, not introduce a new permission framework or artificial live harness. No formal model needed: no concurrency/retry/state-machine behavior is proposed.

**Before edits:** run focused app/state baseline, retaining failures against the exact base SHA. **After edits and independent simplification:** run focused app/state tests, npm test, npm run test:pack, git diff --check, then required CI on final PR head. Record SHA, any dirty-diff identity, command, environment, result and sanitized output for every check; rerun affected checks whenever the revision changes.

Focused regression agreement (extend test/app.test.mjs and existing helpers, not copied implementation logic):

- One row/assertion per generated/requested permission or documented unused grant; compare matrix coverage to createManifest so new defaults cannot silently escape audit. No test forcing every generated scope to be mandatory.
- Core vs optional vs channel-dependent output, multiple losses, stable grouping, no duplicates, exact token labeling and opt-in remediation. Exercise initializePipa and startPipa, not just the formatter.
- Status alternatives: chat:write-only -> no assistant/status warning; assistant:write-only -> still core text-reply warning; neither -> accurately report both affected capabilities. Retain the typing call without local scope gating.
- Missing/undefined/malformed metadata is unknown, valid [] is known-empty; trimmed/deduplicated metadata retains existing behavior. Extra grants, missing canvas grants and unused user grants cause no unrelated notices. Bot metadata never checks xapp/xoxp grants.
- Actual pinned adapter path with controlled outbound Slack: user/channel lookup denial preserves ID fallbacks; successful mention/subscribed-thread text delivery survives reaction/status failures; status is still attempted when assistant:write is absent but chat:write present. This is contract proof with fake transport, not a successful Slack authorization test. Keep existing allowlist/DM/external-channel rejection tests intact.
- App-token missing_scope advice versus invalid_auth/general rejection (if wording is touched); provider/model failures remain distinct from permission notices. Verify incoming-file failures and outgoing-artifact text fallback match their documented limits using existing suites.
- Preserve default manifest bot/user scopes, typing invocation, command definitions and packed manifest checks. Audit official doc links and README/overview consistency.

**Evidence gaps / exclusions:** actual Slack enforcement, current installed grants, status rendering, canvas content and Rick's workspace remain NOT VERIFIED. No test-app setup, scope changes, live messages, real-model inference or additional spend are proposed. Official docs and adapter comments disagree about status prerequisites; prefer current official method/changelog and retain the live gap. A scope's presence does not prove app membership, event subscription or admin policy permits use. CI write/PR actions occur only after approval and are not yet exercised. No tests have been run in this planning pass.

### Key method evidence and trace points

- [Current status method](https://docs.slack.dev/reference/methods/assistant.threads.setStatus/) and [March 5 scope update](https://docs.slack.dev/changelog/2026/03/05/set-status-scope-update/): chat:write alternative; channel loading states need no assistant split view.
- [Thread replies](https://docs.slack.dev/reference/methods/conversations.replies/), [conversation metadata](https://docs.slack.dev/reference/methods/conversations.info/), [app mention events](https://docs.slack.dev/reference/events/app_mention/) and [Socket connection](https://docs.slack.dev/reference/methods/apps.connections.open/); app-level scope page clarifies connections:write despite the method page's generic “No scopes required” facts block.
- Repo at inspected SHA: src/state.mjs:9-53 manifest; bin/pipa.mjs:334-345 app-token instructions; src/app.mjs:20-56 token injection, :220-304 ingress/typing/delivery, :975 history, :1033-1113 validation/notices, :1191-1199 best-effort reactions; src/models.mjs picker callbacks; src/opencode.mjs attachment handling.
- Pinned adapter dist/index.js:39-83 canvas-ID normalization only; :1621-1695 failed user/channel lookup fallbacks; :1888-1908 external-channel envelope metadata; :3292-3439 parsing and bot-auth file download; :3907 uploadV2; :4213-4240 unconditionally attempted best-effort status; :4698-4709 channel visibility. Chat dist/index.js:2225-2243 constructs event threads without metadata API reads.

### Next action

Attach final E3 with the accepted removal of E2's speculative INFO case. **WAIT** for Lola's explicit build approval; do not start implementation or reviewers. Approval must cover the corrected/transitional status claim, reusable mapping/formatter, connected consequence/remedy experience, assignments and deterministic-only evidence boundary. Recheck official status requirements before build; no API migration. No scheduled checkpoint is claimed; next checkpoint is the approval/review response.

## Superseded history — 2026-11-16 — STU-918 plan v1 (never approved for implementation)

- Owner/integration supervisor: Chopper. Available for this issue; no workers launched and no background build running.
- Stage: Plan v1 passed Sprock's planning review; Lola's plan/experience/team/verification approval is still pending. Remain paused. Next checkpoint is explicit Lola approval or requested revisions, not implementation.
- Planning review update (2026-11-16, current engineering-thread request): Sprock recommends deterministic PR evidence using existing focused/full tests, package smoke and final-head CI; live Slack rendering explicitly NOT VERIFIED, with no test-app setup or live messages. Preserve default scopes/typing, evidence-backed scope classifications and one independent accuracy/simplification reviewer. This is a recommendation awaiting Lola, not authorization to build. No merge/release or spend.
- Ticket: [STU-918](https://linear.app/lunchpaillabs/issue/STU-918/clarify-required-and-optional-slack-permissions), fetched as Now, Pipa project, unassigned in Linear. No ticket mutation performed.
- Sources: [support decision](https://lunchpaillabs.slack.com/archives/C02UW7HF5AR/p1794851904460069?thread_ts=1794851212.096659), [origin/approval routing](https://lunchpaillabs.slack.com/archives/C0C78BJCWQ7/p1794852411283239), [product routine](https://github.com/lunchpaillola/lunchpailwiki/blob/main/runbooks/product-workflow.md).
- Checkout: `/Users/lolaojabowale/pipa`, origin `lunchpaillola/pipa`, detached HEAD `652f1b5`; clean before this planning record. Fetched main is `b5392affb66b6e7a72de28bdf115292f35d89121`. Intervening changes are README/install guidance, issue templates, llms.txt and stats; no runtime changes. No STU-918 PR exists; unrelated open PR #72 is stats-only and must remain untouched.
- Continuity recovery: no existing Pipa `progress.md` in this checkout, its tracked history, remote main tree, registered worktrees, bounded home search or the full approved temporary-worktree directory search. Creating this canonical record rather than inventing recovered history. If an older owning file is supplied, reconcile it before build. The registered beta release worktree is prunable; do not remove it.
- Authorized now: read-only discovery and this continuity record only. No product edits, branch switching, build agents, push/PR, live tests, merge/release, production restart, spend, or customer messages performed.

### Observed implementation (not test results)

- `src/state.mjs:9-53`: default manifest has bot scopes commands, files:read, app_mentions:read, assistant:write, channels:history, channels:read, chat:write, groups:history, groups:read, reactions:write, users:read, files:write; user scopes files:read/files:write. Socket Mode/interactivity and public/private channel events are enabled. Preserve defaults.
- `initializePipa` and `startPipa` call `warnMissingSlackScopes`; `src/app.mjs:1105-1113` combines channels:read and assistant:write into add/reinstall advice. Missing commands already has feature-specific nonblocking guidance. Unknown scope metadata is intentionally not treated as missing.
- `src/app.mjs:277` still requests `thread.startTyping("Working on it...")`; runner `:908-910` ignores both synchronous and asynchronous typing failures. Pinned Slack adapter 4.38.1 calls assistant.threads.setStatus and catches errors; its implementation notes Agents & AI Apps plus assistant:write prerequisites.
- Existing regression coverage is in `test/app.test.mjs` (scope notices, missing commands, typing failures), `test/state.test.mjs` (default assistant scope) and `scripts/pack-smoke.mjs` (packed manifest). Existing typing-failure test does not explicitly assert all delivered results.
- README states DMs are excluded. Do not imply assistant:write enables DM support. Scope clarification must distinguish Pipa support from Slack API permissions and keep provider/model failures separate.

### Proposed smallest plan v1 (NOT approved)

1. After approval, create one focused `fix/stu-918-slack-permissions` branch from refreshed main, preserving this checkpoint and unrelated work. Recheck guidance and diff against the approved base. No release/version/dependency changes.
2. Trace every generated bot/user scope to actual Pipa/pinned-adapter use. Add a compact README setup matrix: scope, token type, purpose, core vs feature/channel-dependent vs generated-but-unused, and prerequisites. App-level xapp connections:write and Socket Mode belong separately from bot xoxb scopes. Explicitly identify generated user scopes versus the bot/app tokens Pipa actually consumes. Do not remove defaults or declare other scopes optional without evidence. Correct the repository overview's obsolete grouped wording.
3. Make assistant:write its own optional feature notice at init/start. State ordinary receiving/replying is unaffected and no permission change is necessary for ordinary replies. Preserve best-effort typing and the default manifest. Keep actionable advice scoped to genuine audited requirements; preserve opt-in commands upgrade instructions. Do not expand the runtime into an exhaustive new scope-enforcement subsystem.
4. Extend existing tests, not orchestration: assistant-only/both-missing/complete/unknown metadata, exact limited-impact wording and no mandatory reinstall instruction in the optional notice; genuine requirement advice; successful mentions and subscribed-thread deliveries with missing scope and synchronous/asynchronous status failures; retained status invocation when available; provider error remains a separate error. Retain manifest/package assertions.
5. One independent review/simplification pass, integrate safe findings, rerun affected checks on final SHA, and open one focused PR only under the eventual build/PR approval. Stop at handoff; no merge/release.

### Proposed team and proof (none launched)

- Chopper: supervisor, implementer and integration owner; owns scope audit, README/overview, warning change and focused tests, verification and continuity. Keeping one writer avoids unnecessary build agents.
- One `general` subagent after build, subject to Lola approval: independent full-flow review/QA and required simplification pass on exact branch/SHA, read-only findings, caller/docs/scope accuracy review and safe-cut recommendations. Supervisor applies changes and reruns checks. No customer messaging, production actions or spend.

### Verification agreement/readiness proposal

- AVAILABLE: Node v22.23.2, installed dependencies, git/GitHub read access, existing Node test/package harness and runtime isolation fixtures. All four upstream create/maintain verification/formal-verification skill files exist under `~/.agents/skills/`. No repo-local verification skill currently exists; after approval use create-verification-skill at `.opencode/skills/verify-slack-permissions/SKILL.md`, scoped to this journey and reusing existing checks, not a new framework.
- Baseline before edits: `node --test test/app.test.mjs test/state.test.mjs`; then final focused checks, `npm test` and `npm run test:pack`. Verify warning output through real initialize/start implementations with labelled injected transports; exercise actual pinned adapter status path with mocked outbound Slack only where needed. This is deterministic proof, NOT live Slack proof.
- Record every run with exact SHA plus dirty-diff identity if uncommitted, command, environment, PASS/FAIL/BLOCKED and sanitized output. After reviewer cuts, rerun affected checks and full required CI on final PR head. Compare README matrix to generated manifest and actual call sites, check links and `git diff --check`.
- Live status rendering/without-scope Slack smoke: BLOCKED pending approval and a ready isolated test environment. Historical documented Pipa V2 Smoke profile path is absent on this host. Known app/channel identities are historical, not current credential or sole-listener proof. Need secure test credentials, sole-consumer confirmation, isolated Pipa and OpenCode state, and explicitly authorized test-only messages/scope changes; use scripted local model with zero paid inference. Never use the production profile or Rick's workspace. No live check is authorized by this planning request.
- Ask Lola to approve deterministic checks as the PR evidence boundary with live Slack marked unverified, OR provide/approve the isolated live path before build if live proof is required for handoff. Do not silently substitute fixtures for live coverage.
- No formal model proposed: no scheduling, concurrency, cancellation or state-machine changes are needed. No UI prototype: CLI notice/documentation example below is the experience sample.
- Proposed notice: “Optional Slack scope assistant:write is missing. Pipa can still receive messages and reply, but cannot show the ‘Working on it...’ processing status. No permission change is needed for ordinary replies.” No claim that adding it fixes provider errors or enables DMs.
- Results now: discovery complete; baseline, implementation, reviewer, package/CI and live proof NOT RUN. This is a plan, not a verified fix.

### Next authorized action

Return plan v1 here for Sprock review, then WAIT for Lola's explicit plan/experience/team/verification approval. Confirm whether fixture-only PR evidence with the stated live gap is acceptable. No approval is inferred from the issue being Now. No timers or active jobs are left running.
