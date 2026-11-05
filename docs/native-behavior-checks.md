# Pipa checks versus native OpenCode behavior

Pipa connects Slack to OpenCode. It should not invent execution failures for behavior OpenCode accepts. This review groups runtime/CLI checks by what they protect; it is not a claim that every error-construction site is a distinct policy or observed production incident.

## Removed in the native-v2 follow-up

- **Frozen session directory:** lookup, observer reuse, response-event filtering and child-interaction ownership no longer veto native moves. Session IDs and native parent relationships still select the Slack conversation. Reconnect uses session-scoped interaction reads, including independently moved descendants; a location-scoped global list cannot discover all of them.
- **Prompt echo veto after admission:** Pipa still sends the exact prompt once, but a successful native response no longer becomes a failed start because its returned representation differs. Genuine SDK/HTTP failures still propagate; Pipa does not automatically replay an uncertain admission.
- **Model catalog preflights:** native switching owns whether an explicit model is valid for a session. Browsing does not require a native-default read; resetting a session reads its current-location default directly, without catalog membership. Picker Save uses its authorized cached choice instead of rediscovering models.
- **Unused optional model validation:** config reads continue validating Slack access and required profile fields, but an invalid optional default does not veto authorization or an existing session with its own model. Defaults are normalized when actually used, and picker Save still validates the new selection.
- **Native error reinterpretation:** v2 execution failures use OpenCode's message text, without Pipa provider classification, recovery advice, or another sanitizer. SDK transport errors keep their existing representation. Pipa's default picker only affects new sessions.
- **Response/picker error replacements:** response reads, Slack delivery and model-picker failures retain the original error message instead of staged Pipa explanations. Only the existing Slack-token redaction applies; error bodies and stacks are not published. Failed partial response delivery is still not replayed.
- **V2 request deadlines and read recovery:** native requests use the SDK directly with caller/shutdown cancellation, without Pipa's request/body deadlines or timed read retries. Model discovery has no extra v2 deadline. Event attachment waits for a usable result path without a Pipa deadline; a stalled service can therefore keep it pending until cancellation or shutdown. Native event-stream reconnection remains separate from request replay.
- **Exact v2 CLI/server version equality:** different supported v2 versions no longer veto startup. Authentication, supported-major negotiation and the CLI/server major distinction remain; this is not a compatibility qualification for every v2 version.
- **Unused metadata and post-create directory checks:** unused v2 startup/catalog fields and directory spelling do not veto native success. Usable session identity and protocol negotiation still belong to the integration.
- **Explicit prompt-file confinement:** a local user-selected input file can be outside the starting folder or use a symlink. Relative resolution, bounded regular-file reading, and change detection remain; outbound publication has a separate boundary.

## Retained checks and concrete reasons

- **Slack access and interaction ownership** (`app.mjs`, `models.mjs`): prevent unauthorized requests, stale modal submissions and delivery after destination/responder revocation. Directory equality is not authorization.
- **Attachment and artifact validation** (`opencode.mjs`): prevent arbitrary file reads, symlink/path escapes, file replacement races and oversized uploads. Native moves do not change the original private publication directory.
- **Session identity and response shape** (`opencode-v2.mjs`, `opencode-v1.mjs`): prevent another session's data from reaching a Slack thread and avoid acting on malformed integration payloads. These do not impose a directory policy.
- **Credential-clean processes and existing Slack-token handling** (`opencode.mjs`, `app.mjs`): keep Pipa's Slack credentials out of child environments and its own diagnostics. Native v2 messages are not rewritten, except by the existing Slack-token protection in delivery; response bodies and stacks are not the message-text interface.
- **Startup protocol/authentication and starting-location checks** (`opencode.mjs`): establish that the selected server can serve the configured starting location. They do not confine an existing native session after startup.
- **Startup readiness probes and explicit harness deadlines** (`opencode.mjs`): remain separate from native execution requests, alongside caller cancellation and owned-process shutdown. Slack acknowledgment/UI-expiry timers and legacy v1 discovery limits are unchanged.
- **Observer readiness, cancellation and duplicate-delivery handling** (`opencode-v2.mjs`, `app.mjs`): avoid admitting work without an attached result path, posting after shutdown or replaying already-sent chunks. They are integration lifecycle checks, not native execution deadlines.
- **State, routine and process validation** (`state.mjs`, `routines.mjs`, `restart.mjs`, `bin/pipa.mjs`): protect persisted mappings, exact destinations, schedules, single-instance locks and owned restart handoffs. Removing them can lose continuity or target the wrong process/destination.
- **Permission/question translation and native-client fallback** (`opencode-v2.mjs`): validate Slack decisions before translating them, preserve editable controls when native submission fails, and avoid pretending Slack can answer unsupported rich forms.

## Narrow missing-folder repair

Existing v2 session resolution checks its actual location through OpenCode before sending the current request. A matching native `LocationNotFoundError` can trigger one native move back to the configured starting folder. Native running/inbox reads and an applied-location check bound that attempt; they are not a lock against other native clients. The Slack thread receives a factual location-change notice before execution continues. Missing source files are not restored, the model is not changed, and healthy session moves remain accepted.

An accepted but unapplied move is not reported as recovery. Current requests are never automatically replayed after prompt submission or transport uncertainty. Recovery is separate from native execution-error text, reconnect, missed-response catch-up, and process ownership. V1 receives no new location-repair policy.

## Deliberately separate legacy behavior

V1 still uses interrupt-and-replace and blocks intake after uncertain admission/cancellation. It does not have v2's independent native steering semantics. Removing those guards without replacing the v1 attribution contract can report another turn's output, so this PR does not mechanically delete them. That is remaining Pipa policy, not a claim that all extra behavior has been removed.

## Evidence limits

HTTP/SSE fixtures exercise the shipped adapter and owning integration paths, including moved-session continuity and unrelated-session isolation. They are not a real-engine compatibility matrix or isolated live Slack smoke. This PR does not deploy, restart or publish Pipa.
