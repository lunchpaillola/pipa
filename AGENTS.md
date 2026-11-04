# Pipa Agent Guide

Architecture, request flow, file ownership: [`docs/repository-overview.md`](docs/repository-overview.md).

Setup, checks, contribution, release process: [`CONTRIBUTING.md`](CONTRIBUTING.md).

## Runtime

- Socket profile connects Slack to OpenCode. Managed profile runs OpenCode only.
- One Slack thread maps to one persisted OpenCode session.
- Different threads run concurrently. V2 messages use native steering; v1 retains same-thread interrupt-and-replace.
- Superseded turns must not persist stale state, post stale output, or add success reactions.
- Shutdown rejects new work and drains local observers/callbacks before disconnecting Slack. V1 aborts its server-side turns; v2 does not interrupt independently continuing native sessions. Owned OpenCode processes still stop; attached servers stay running.
- Attached OpenCode servers are health-checked, never process-owned.
- V2 follows native session responses beyond the first reply. Do not add turn-ownership policy or a second execution/recovery journal over OpenCode.
- V2 execution failures use OpenCode's message text. Do not add provider-error classification, recovery advice, or another sanitization layer.
- Runtime stays plain ESM. Prefer Node APIs and existing dependencies.

## Security

- Never expose Slack tokens through child environments, errors, logs, fixtures, or commits.
- Never commit local Pipa state.
- For v2, the configured directory is a starting location, not session confinement. Follow native session identity and ancestry across moves; keep Slack authorization and artifact containment as integration boundaries. Access-control changes require security review and regression tests.
- Preserve attachment cleanup and filename sanitization. Incoming files are limited to 10 MiB each; outgoing artifacts retain the 10-file/100 MB per-file and response limits.
- Preserve artifact containment, symlink, identity, type, count, and aggregate-size checks.
- Never expose local artifact paths to Slack.

## Code

- Trace full caller path before changing shared orchestration.
- Keep logic in one function unless composable or reused.
- No preemptive single-use helpers.
- Prefer `const`, early returns, direct property access.
- Avoid unnecessary reassignment, destructuring, import aliases, star imports, and `else` after return.
- Keep helpers near callers. Comment surprising constraints, not obvious control flow.
- Add dependencies only when Node and installed packages cannot provide a small clear solution.

## Tests and PRs

- Behavior change needs focused regression test in owning suite.
- Test real implementation. Avoid copied production logic, broad mocks, and global patches.
- Concurrency changes cover same-thread replacement and cross-thread independence.
- Keep docs aligned with user-facing commands, config, Slack behavior, limits, and releases.
- Use `type(scope): summary` commits and PR titles. Keep PRs focused.
- Open issue before large architecture or behavior changes.
- Version bumps happen only for intended releases; update both package files.
