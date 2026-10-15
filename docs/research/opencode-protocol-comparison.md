# OpenCode v1/v2 integration spike

## Recommendation

Use one Pipa package with a shared executor contract and automatic selection of v1/v2 HTTP adapters. Retain the existing v1 integration and port only the v2 protocol boundary. Keep Slack behavior, routines, delivery checks, and restart orchestration shared.

ACP is a promising common interface, but the tested v1 releases do not provide the question tool over ACP. Moving every version to ACP would regress a current Pipa feature or require an additional bridge. V2's ACP command also rejects an explicit existing-server attachment flag; a pure ACP switch does not preserve Pipa's current attached-server connection model.

This is a recommendation from a compatibility spike, not approval to change the migration plan's product scope or proof that the final integration is ready to deploy.

## Experiment

Tested real OpenCode engines on macOS ARM64 with Node 22.23.2:

- Installed OpenCode 1.18.35.
- Separately downloaded OpenCode 1.19.0.
- Separately downloaded OpenCode 2.0.29 and Promise client 2.0.29.

Downloaded runtimes were installed under a temporary experiment directory, not globally. Each run used private HOME, XDG configuration/data/cache/state, working directory, and database paths. No production OpenCode database, provider credentials, Slack credentials, running Pipa process, or global binary was changed.

The model was a deterministic loopback OpenAI-compatible fixture. The OpenCode engines, ACP stdio protocol, HTTP endpoints, permission execution, question/form routing, persisted histories, and Pipa code under test were real. This measures integration semantics, not model intelligence or live Slack behavior.

One common JSON-RPC ACP client was used across the three runtimes. HTTP comparison reused the unmodified Pipa executor for v1 and a small throwaway native-v2 adapter for question/permission round-trips. No production runtime code was edited.

## Observed results

| Probe | ACP 1.18.35 | ACP 1.19.0 | ACP 2.0.29 |
|---|---|---|---|
| Initialize and create session | Pass | Pass | Pass |
| Prompt completion | Pass | Pass | Pass |
| Prior-turn context reaches the model | Pass | Pass | Pass |
| Embedded text attachment reaches the model | Pass | Pass | Pass |
| Valid PNG attachment reaches the model | Pass | Pass | Pass |
| Permission request/reply round-trip | Pass | Pass | Pass |
| Question request/answer round-trip | **Fail: question tool absent** | **Fail: question tool absent** | Pass using elicitation |
| Model switch changes the next provider request | Pass | Pass | Pass |
| Existing Pipa thread runner suppresses superseded delivery | Pass | Pass | Pass |
| Independent sessions execute concurrently | Pass | Pass | Pass |
| Cancel active prompt | Pass | Pass | Pass |
| Reload same ID/history after ACP process restart | Pass | Pass | Pass |
| Load an HTTP-created session through ACP | Pass | Pass | Pass |

| HTTP/connection probe | Result |
|---|---|
| Existing Pipa executor on 1.18.35 and 1.19.0 | Pass |
| Existing Pipa question handler on both v1 releases | Pass |
| Native v2 session creation and prompt/completion | Pass |
| Native v2 structured form create/reply/get | Pass |
| Thin v2 adapter: agent question to form, reply, final result | Pass |
| Thin v2 adapter: shell permission, reply, final result | Pass |
| Unchanged Pipa executor on v2 | **Fail: HTTP 405** |
| V1 status endpoint on v2 | **Fail: HTML response rather than the expected JSON** |
| V2 `acp --server <url>` | Rejected with **Unrecognized flag**; existing-server attachment is not supplied by this CLI option |

The final harness retained compatibility failures as FAIL results. The first form probe had an incorrectly nested client capability; correcting it enabled v2 questions. A malformed PNG fixture was replaced with a generated valid PNG before the final image probes. Neither initial harness error is counted as a final runtime limitation.

**Final comparison: 58 checks, 54 passed, 4 observed compatibility failures.** Two failures are the missing v1 ACP question path, one for each v1 release. The other two show that v2 does not satisfy the existing v1 HTTP endpoint/executor contracts. Rejection of the ACP attachment flag is a passing capability-detection check with `supported: false`, not a passing attachment feature.

For the v1 question limitation, the provider's observed tool catalog contained no question tool. The control test exercised Pipa's actual HTTP executor and question callback on the same v1 versions and succeeded. This is more specific evidence than merely observing a missing question notification.

## Baseline tests

`node --test test/routines.test.mjs test/restart.test.mjs test/cli.test.mjs`

**55 passed, 0 failed.** These existing tests cover routine validation/schedules/DST/lifecycle/overlap/cancellation, routine CLI behavior, detached restart handoffs, and isolated Managed ready/unready/startup-failure cases. They establish the current baseline. They do not prove that those flows already work with a production v2 adapter.

## Tradeoffs

- **ACP everywhere:** One protocol client for basic owned execution; measured v1 question gap and existing-server attachment differences prevent claiming feature parity. Patching around them would reintroduce version-specific behavior and potentially multiple transports.
- **Two HTTP adapters inside one Pipa release:** Preserve the existing v1 features and current server ownership/attachment model. Port v2's admission, completion, forms, and permission differences behind the same executor interface. Compatibility tests must run against both adapters.
- **Separate Pipa releases/branches:** Does not improve the protocol gaps and makes users choose a matching package. There is no evidence from this spike that duplicating the application is necessary.
- **V2-only:** Technically viable through either v2 HTTP or ACP, but requires users to upgrade their installed runtime. It does not satisfy version-transparent support for existing v1 users.

The product promise should describe supported capabilities and automatic connection selection, not an unconditional guarantee for every historical or future OpenCode release. Qualify the supported runtime range and report incompatible capabilities before accepting work.

## Still required before implementation/release qualification

- User confirmation of compatibility scope; do not silently override the earlier v2-only decision.
- Full v2 executor implementation, including robust event reconnection, final-result attribution, cancellation during admission, and child-session routing.
- Actual v1-to-v2 database migration and preserved session mappings. Loading an HTTP-created session into ACP on the same engine is **not** a cross-version migration test.
- Full Pipa Socket and Managed restart with each supported runtime, not merely restarting an ACP process.
- Real scheduled routine delivery and result-thread continuation with each supported runtime.
- Real Slack permission/form controls and attachment/artifact upload flows.
- Exact 20 MiB boundary and outgoing artifact limits; the image probe used a small fixture.
- Required provider/MCP/plugin/agent/skill/command compatibility, background-child behavior, and disconnect/reload recovery.
- A separately hosted attached server, supported-platform package checks, and a rollback trial.
- Real-provider inference smoke tests. A mock provider deliberately avoids credential exposure and paid-model dependence in the protocol comparison.

## Reproduction

The attached throwaway `probe.mjs`, `package.json`, and lockfile describe the experiment. It currently selects macOS ARM64 native package paths; this is a host-specific spike, not the cross-platform release evaluator.

Install the pinned packages in a temporary directory with lifecycle scripts disabled, then set `PIPA_REPO` to a local checkout and `PIPA_SPIKE_V1_BIN` to the v1 executable being qualified. Run `node probe.mjs` with those environment variables. The script creates private test state, uses only a loopback fake provider, shuts down its recorded processes, and writes `results.json`. Optional positional arguments select `v1`, `v1latest`, or `v2`.

`results-summary.json` contains the final checks and reduced provider observations. Test process cleanup was checked separately against recorded PIDs. Preserve failures in comparisons; do not report the whole harness as green just because it exits successfully after collecting failures.

## References

- [V1 ACP](https://opencode.ai/docs/acp/).
- [V2 ACP transport, capabilities, questions, and sessions](https://opencode.ai/v2/docs/cli/acp/).
- [V2 migration guide](https://opencode.ai/v2/docs/migrate-v1/).
- [V2 HTTP API](https://opencode.ai/v2/docs/api/).
- Existing Pipa executor: `src/opencode.mjs`.
- Shared thread and routine orchestration: `src/app.mjs`, `src/routines.mjs`.
