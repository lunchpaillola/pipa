---
name: verify-instance-lifecycle
description: Verify the real Pipa CLI start, stop, and restart commands against an isolated Managed profile after changing lock ownership or recovery.
---

# Verify Pipa instance lifecycle

From the candidate checkout, use Node 22+ and `npm ci`. Record `node --version`, the OS, and `git rev-parse HEAD`. Never use a global Pipa executable or the daily profile.

Run `node --test --test-name-pattern='isolated Managed restart .*: ready' test/cli.test.mjs`. The existing harness creates a private profile, launches the actual CLI with an isolated engine fixture, and checks authenticated workspace readiness. Both cases must pass; HTTP listening alone is not readiness. The harness tears down only its own test resources; a teardown failure is a failed run.

Retain the TAP log outside the checkout and profile. Record the revision, commands, outcomes, and any untested platform. This exercises the real CLI against a synthetic engine, not live Slack or a production profile. See [feature coverage](features/README.md).
