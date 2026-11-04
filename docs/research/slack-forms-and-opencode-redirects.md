# Slack forms and OpenCode redirects

Audit date: 2026-11-04. Scope: executable strings in `src/` and `bin/`, the README,
and current compatibility/release documentation after PR #64. Historical plans and
test fixtures describe old contracts, not additional live redirects.

## Redirect inventory

| Situation | Source | Current behavior and disposition |
| --- | --- | --- |
| Unsupported form | `src/app.mjs`, `renderSlackInteraction`; `src/opencode-v2.mjs`, `dispatch` | The Slack card says the form requires an OpenCode client. The adapter also refuses submission with that instruction. This strands Slack-only users; replacing the sentence alone does not fix it. Still unresolved. |
| Empty model catalog | `src/models.mjs`, `open` | Previously said “Connect a provider in OpenCode.” Now names `opencode auth login` in a terminal on Pipa's host, with operator guidance for an attached server. Setup outside Slack is appropriate here; an empty catalog alone does not prove why models are unavailable. |
| Expired provider API key (v1) | `src/opencode-v1.mjs`, `execute` | Says to replace the key in OpenCode, or choose another provider using the installation's Slack model command and start a new thread. Retained; clearer host/operator setup guidance is a separate messaging change. |
| Provider authentication failure (v1) | `src/opencode-v1.mjs`, `execute` | Says to reconnect the provider in OpenCode; offers the same Slack/new-thread alternative. Retained. |
| Failed provider on an existing thread | `README.md`, model-selection section | Says to reconnect in OpenCode and retry that thread. This is operator authentication work, not an in-thread question-answer operation. Retained. |
| Change an existing v2 session's model | `README.md`, model-selection section | Says to change it in OpenCode. The Slack picker currently changes only new-thread defaults. A real missing Slack operation; wording alone cannot add it. Retained. |
| Upstream error guidance | `src/opencode-v2.mjs`, response forwarding | Native message text can itself instruct users to open OpenCode. This is not a closed set of Pipa-authored strings. Preserve passthrough; do not reintroduce an error-rewriting framework. |

Operator diagnostics also ask for `opencode --version`, installation of a supported
runtime, the correct server URL/workspace, or server authentication environment
settings (`src/opencode.mjs`: version parsing, executable discovery and connection
readiness). These are startup/setup errors, not “answer this pending Slack form
elsewhere” fallbacks. The README's installation prerequisites and external-client
password setup likewise belong to operator setup.

Current docs repeat the unsupported-form boundary in `docs/opencode-compatibility.md`,
`docs/native-behavior-checks.md`, `docs/repository-overview.md`, and
`docs/beta-release.md`; those repetitions are not separate runtime redirects.

## What upstream actually does

Inspected the source at **OpenCode v2.2.5**, Pipa's current native target; Pipa's
generated client remains pinned to **2.0.29**. This is source research, not a live
qualification run. Relevant sources:

- [Schema](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/schema/src/form.ts): a finite tagged union of string, number, integer, boolean, multiselect and external fields. Options have separate labels and values. Conditions reference earlier fields.
- [TUI helpers](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/tui/src/util/form.ts): field-type-based controls, native option values, defaults and value validation.
- [TUI renderer](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/tui/src/routes/session/form.tsx): evaluates conditions against prior active answers, keeps drafts, shows review, opens external links and requires explicit completion acknowledgement. It omits unanswered values from the reply.
- [Core validation](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/form.ts): validates keyed typed answers, requiredness, active conditions, constraints and external acknowledgement. An omitted optional key, an explicit empty string and an empty selection are distinct. Defaults are initialized by the client, not filled in by `reply`.
- [Provider setup](https://opencode.ai/v2/docs/cli/providers): documents `opencode auth login` and `/connect`. Provider authentication can itself produce forms, for example Azure resource details and GitHub Enterprise domains. This does not establish that those forms appear in Pipa's session-scoped events; global/authentication ownership needs separate investigation.

## Recommendation

Use the native field schema as the contract, with a small Slack control mapping.
New form titles, metadata kinds, field keys and combinations of supported controls
should not require a new Pipa workflow. Pipa already avoids metadata/key allowlists;
its gap is the narrow supported field/visibility subset.

Keep keyed typed answers, option identity, omission and explicit values intact.
Build visibility/default handling from native semantics, and keep final validation
native. Numbers and booleans map to ordinary Slack controls; an external action
needs its real URL and an explicit “I finished” step, not a fabricated success.
Conditional fields need to update from earlier answers and exclude inactive values.
Hidden/default semantics must follow the actual producer; do not display secrets or
silently drop required input. Slack option-count, text-length, modal and block limits
also need explicit UX treatment.

This is schema-driven rendering, **not** automatic support for unknown future field
types or protocol changes. Upstream itself explicitly implements each field type.
No exported framework-independent renderer/validator was established in the pinned
client; copying the Solid/OpenTUI UI would bring the wrong runtime into Slack.
Follow its semantics rather than importing its UI stack. Unknown types must remain
visible and cancellable in Slack; do not silently omit them or guess an answer.

Before expanding the renderer, capture realistic session-scoped payloads from
actual producers and agree the supported interactions. Existing web-search setup
is a verified supported shape. The numeric/conditional/external fixtures in Pipa
are synthetic; this audit has not established their frequency in user workflows.
The broader renderer, per-session Slack model switching, provider authentication
workflows and cancellation of unsupported forms are not implemented in this PR.
No replay, delivery-retry or automatic file-cleanup machinery is proposed.
