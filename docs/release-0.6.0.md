# Pipa 0.6.0 release preparation

**Publication: PENDING.** This is a stable-channel preparation, not evidence that
`0.6.0` is available. At preparation, npm `latest` is `0.5.6` and `beta` is
`0.6.0-beta.5`; the human publisher must recheck immediately before publication.

## Scope and accepted evidence

This release changes only version metadata and documentation from preparation
baseline `1e49eaacf1707328b72f3588f98e4dac42c14d80`. Runtime code and dependencies
are unchanged from beta.5; PR #70 changed only verification and documentation.
Pipa automatically
selects the native OpenCode v1/v2 adapter.
There is no manual Pipa migration command; OpenCode owns data/schema upgrades.

For **this 0.6.0 promotion only**, the owner explicitly accepted reusing beta.5
native/live evidence and daily use because runtime and dependencies are unchanged,
with **no fresh native/live or full-matrix runs**. The [beta receipts](beta-release.md) retain their
original commits, dates, failures, unobserved cases, and coverage limits; daily-use
acceptance is not an exhaustive test receipt. This decision does not assert that
the full matrix passed, certify every provider/client, or set `releaseQualified`
to true. Windows native is `—` (not run), not a pass. Generic future qualification
policy remains in [CONTRIBUTING](../CONTRIBUTING.md#stable-release).

Required exact-version verification:

- Require full tests in CI for the exact `0.6.0` release PR.
- Run `npm run test:pack` on `0.6.0`. Packed CLI smoke must report
  `0.6.0`; the existing package smoke checks the
  installed CLI and 1.19.0 / 2.0.29 / 2.2.5 contract fixtures, not real engines.
- Run `npm publish --dry-run --tag latest --access public` on exact `0.6.0`;
  inspect package contents for private state/credentials and expected public files.

Do not substitute beta package results for those checks or describe pending checks
as passing. No new tests are needed for the version/docs-only diff.

## Known unfixed follow-ups

- **[STU-866](https://linear.app/lunchpaillabs/issue/STU-866/bug-fix):** stale-lock/PID-reuse behavior remains unresolved.
- **[STU-867](https://linear.app/lunchpaillabs/issue/STU-867/patch-and-verify-pipas-axios-follow-redirects-production-dependencies):** axios/follow-redirects dependency findings remain unresolved; this
  release changes no dependency versions or lockfile dependency entries.

Neither issue is fixed or declared safe by this release decision. Existing
missing or failed native/live observations remain limitations, not new successes.

## Human publisher gate

Publication is a separate human action. The approved release workflow prepares
the merged commit and tag after checks pass; it does not authenticate or publish
to npm for the owner. Production installation/restart is not part of publication.

After required CI and exact-version package/dry-run evidence pass, the authorized
human publisher must:

1. Use a **clean checkout of the actual merged release commit**, already tagged
   `v0.6.0` by the authorized release workflow. Verify `git status --short` is empty,
   `git rev-parse HEAD` equals `git rev-parse 'v0.6.0^{commit}'`, and package/lockfile
   top-level and lockfile root versions are all `0.6.0`. Never publish an unmerged
   feature head. Recheck package smoke/dry-run on that checkout.
2. Run `npm view @usepipa/pipa dist-tags versions --json`. Confirm `0.6.0` is unused
   and record tags; stop on unexpected registry changes rather than overwriting
   or retagging another release.
3. Authenticate **locally** with `npm login --auth-type=web`, completing browser
   login and any 2FA prompts. Use `npm whoami` and verify that account's publish
   rights to `@usepipa/pipa` in npm's package/organization settings. Keep secrets
   local: never log credentials or paste tokens/2FA codes into chat.
4. Only after those gates, run locally:

   ```sh
   npm publish --tag latest --access public
   npm view @usepipa/pipa@0.6.0 version dist.integrity --json
   npm view @usepipa/pipa dist-tags --json
   ```

5. Verify registry version `0.6.0`, `latest` -> `0.6.0`, and the recorded `beta`
   tag unchanged. In a disposable directory/profile, install the registry artifact
   with `npm install --ignore-scripts --no-save @usepipa/pipa@0.6.0` and run
   `./node_modules/.bin/pipa --version`; it must print `0.6.0`. Do not start a
   production listener for this check. Verify published metadata/integrity against
   the inspected release artifact. Only after verified npm publication may the
   authorized owner create a public GitHub release/announcement; do not automate
   one during preparation.

Production cutover is a separate owner-approved action, not part of publication.

## Upgrade and rollback after publication

Stop/drain the existing installation on its actual host and privately back up its
profile. Keep its `PIPA_HOME`, working directory, launch environment and current
OpenCode version. Install `@usepipa/pipa@0.6.0`, check `pipa --version`, then start
the same profile. Do not rerun `pipa init`, recreate the Slack app, or run competing
listeners. See the [existing-installation guide](../README.md#upgrading-an-existing-installation)
for optional command/scope updates.

Record the previous Pipa version before cutover. If rollback is needed, stop the
candidate and reinstall that exact previous version (for beta.5,
`npm install --global @usepipa/pipa@0.6.0-beta.5`), retaining the private stopped
backup. Stable `0.5.6` predates v2 support and is not a drop-in rollback for a
v2-only setup. Reinstalling Pipa does not reverse OpenCode data upgrades; any
engine change requires a separate [matched-snapshot rollback plan](opencode-compatibility.md).
