# Instance lifecycle feature map

| User action | Evidence in the isolated CLI lane |
| --- | --- |
| `pipa start` | A stale lock recording a live but different process is replaced; the new owner becomes usable. |
| `pipa restart` / `pipa restart --status` | A stale owner cannot accept a request. A real restart confirms the replacement only after authenticated workspace readiness and keeps the profile config unchanged. |
| `pipa stop` | A stale owner is not a target. A stop request reaches the current owner; its process, engine listener, and lock go away. |

Use `node --test test/state.test.mjs test/restart.test.mjs` for additional contention, abrupt exit, older lock format, and restart handoff assertions. A live legacy PID is deliberately not a proof of ownership.
