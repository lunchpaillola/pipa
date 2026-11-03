# Pipa checks versus native OpenCode behavior

Pipa connects Slack to OpenCode. It should not invent execution failures for behavior OpenCode accepts. This review groups runtime/CLI checks by what they protect; it is not a claim that every error-construction site is a distinct policy or observed production incident.

## Removed in the native-v2 follow-up

- **Frozen session directory:** lookup, observer reuse, response-event filtering and child-interaction ownership no longer veto native moves. Session IDs and native parent relationships still select the Slack conversation. Reconnect uses session-scoped interaction reads, including independently moved descendants; a location-scoped global list cannot discover all of them.
- **Prompt echo veto after admission:** Pipa still sends the exact prompt once, but a successful native response no longer becomes a failed start because its returned representation differs. Genuine SDK/HTTP failures still propagate; Pipa does not automatically replay an uncertain admission.
- **Explicit model catalog preflight:** native switching owns whether an explicit model is valid for a session. A catalog from the original folder must not overrule it. Resolving a native default uses the session's current location.
- **Unused optional model validation:** config reads continue validating Slack access and required profile fields, but an invalid optional default does not veto authorization or an existing session with its own model. Defaults are normalized when actually used, and picker Save still validates the new selection.
- **Blanket provider-error attribution:** native failures outside the provider category get sanitized execution-failure copy. Reconnecting a provider or changing the existing session's model in OpenCode permits retrying in the same thread; Pipa's default picker only affects new sessions.

## Retained checks and concrete reasons

- **Slack access and interaction ownership** (`app.mjs`, `models.mjs`): prevent unauthorized requests, stale modal submissions and delivery after destination/responder revocation. Directory equality is not authorization.
- **Attachment and artifact validation** (`opencode.mjs`): prevent arbitrary file reads, symlink/path escapes, file replacement races and oversized uploads. Native moves do not change the original private publication directory.
- **Session identity and response shape** (`opencode-v2.mjs`, `opencode-v1.mjs`): prevent another session's data from reaching a Slack thread and avoid acting on malformed integration payloads. These do not impose a directory policy.
- **Credential-clean processes and safe error copy** (`opencode.mjs`, adapters, `app.mjs`): keep Slack tokens and raw provider bodies out of child environments and Slack. Native errors are not forwarded verbatim.
- **Startup protocol/authentication and starting-location checks** (`opencode.mjs`): establish that the selected server can serve the configured starting location. They do not confine an existing native session after startup.
- **Observer readiness, cancellation and duplicate-delivery handling** (`opencode-v2.mjs`, `app.mjs`): avoid admitting work without an attached result path, posting after shutdown or replaying already-sent chunks. They are integration lifecycle checks, not native execution deadlines.
- **State, routine and process validation** (`state.mjs`, `routines.mjs`, `restart.mjs`, `bin/pipa.mjs`): protect persisted mappings, exact destinations, schedules, single-instance locks and owned restart handoffs. Removing them can lose continuity or target the wrong process/destination.
- **Permission/question translation and native-client fallback** (`opencode-v2.mjs`): validate Slack decisions before translating them, preserve editable controls when native submission fails, and avoid pretending Slack can answer unsupported rich forms.

## Deliberately separate legacy behavior

V1 still uses interrupt-and-replace and blocks intake after uncertain admission/cancellation. It does not have v2's independent native steering semantics. Removing those guards without replacing the v1 attribution contract can report another turn's output, so this PR does not mechanically delete them. That is remaining Pipa policy, not a claim that all extra behavior has been removed.

## Evidence limits

HTTP/SSE fixtures exercise the shipped adapter and owning integration paths, including moved-session continuity and unrelated-session isolation. They are not a real-engine compatibility matrix or isolated live Slack smoke. This PR does not deploy, restart or publish Pipa.
