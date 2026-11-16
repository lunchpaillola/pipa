# Slack permission notices

## Sub-features

- ERROR for a core path; WARNING for an optional/channel loss; remedy and scope/token connected in each notice.
- Group private follow-up/context loss, and show at most one truthful remaining-public-text summary.
- Healthy/satisfied alternatives, unused grants and unavailable grant metadata remain silent.
- Preserve typing attempts and text replies through synchronous/asynchronous status/reaction failures; keep provider failures separate.

## How to get to it (user POV)

Socket-profile users encounter notices during `pipa init` or `pipa start`, not on each message. The generated defaults remain unchanged. Managed profiles do not use Slack.

## Driving it with Node's test runner

Run the parent skill's commands. `test/app.test.mjs` drives production initialize/start callbacks, actual mention/subscribed handlers, and the pinned adapter with fake outbound Slack APIs. `test/state.test.mjs` and package smoke check generated grants. Compare expected messages with README's Slack permissions section.

## Gotchas

Current official status docs allow chat:write or the explicitly transitional assistant:write; recheck before changing that mapping. A mock Slack success/failure does not prove real enforcement or visible status. Missing grant metadata tests are defensive, not evidence of a real missing-header occurrence. Keep them silent and do not add logging/probes. Local tests do not replace CI on the final PR SHA.
