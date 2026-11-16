---
name: verify-slack-permissions
description: Verify Pipa's init/start permission notices, typing preservation and nonblocking Slack delivery with deterministic transport fixtures.
---

# Verify Slack permission notices

This is deterministic application/adapter evidence, not live Slack authorization or rendering proof. Do not start a real Socket listener or read a private profile. The approved check needs no Slack/provider credentials, paid inference or remote app changes.

## Launch

From the Pipa checkout, use Node 22+ and installed dependencies (`npm ci` only if missing). No persistent app instance is needed: the existing Node tests launch the real init/start functions with isolated fixture state and replace outbound Slack transport. They shut down each created app.

## Doctor

Run `git status --short --branch`, `git rev-parse HEAD` and `node --version`. Check the intended revision and inspect `src/slack-permissions.mjs`'s capability map plus [the feature map](features/README.md). Never run `pipa start` against the operator's profile as a substitute for these tests.

## Drive

```sh
node scripts/verification/slack-permissions.mjs 2>&1 | tee /path/outside/checkout/slack-permissions.log
node --test test/app.test.mjs test/state.test.mjs
npm test
npm run test:pack
git diff --check
```

The focused suite must prove init/start notices and successful mention/follow-up delivery, not merely call a formatter. It also exercises the pinned adapter's real status method with controlled outbound APIs, metadata ID fallbacks and unchanged default manifest grants. See [permission notices](features/permissions.md) for the observable contract.

The capture command executes production `initializePipa`/`startPipa`, saving and loading configuration in the existing disposable runtime fixture. It prints actual notices through the injected warning sink and captures fake outbound posts, asserting healthy silence, core loss, optional/private loss copy/order, and mention/subscribed delivery through rejected status/reactions. Auth, Chat ingress and executor are injected; this is not a full Socket CLI start. Package smoke separately exercises actual CLI init and Managed start. Use a clean committed checkout for revision-bound evidence; the capture labels dirty development runs.

## Evidence

Save command output outside the checkout in the run's approved temporary evidence directory. Record the exact commit, dirty diff if any, Node/OS, command, exit status and test totals. Rerun affected checks after review cuts; record final-head GitHub CI separately. No token values, profile JSON or raw authenticated responses belong in evidence. Inspect terminal messages in the notice tests/README for the approved consequence-and-remedy format.

## Cleanup

Tests own and stop their fixture app instances; no live listener or production profile is created. Retain the terminal logs and revision record after tests finish. Do not delete unrelated temporary files or kill processes by name. A hung test is a failure to diagnose, not permission to restart production Pipa.
