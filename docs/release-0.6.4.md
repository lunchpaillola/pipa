# Pipa 0.6.4 — Safer start, stop, and restart

Pipa now verifies that the process recorded in its instance lock is the one that owns the profile. `pipa start` recovers confirmed stale locks, including when the OS has reused an old PID. `pipa stop` requests shutdown from the verified instance instead of signaling a PID saved on disk. See [PR #84](https://github.com/lunchpaillola/pipa/pull/84).

## Upgrade from 0.6.3

1. Pause automatic launchers and stop the existing instance using its terminal or service manager. Wait for it to exit before changing versions.
2. Once 0.6.4 is published on npm, run `npm install -g @usepipa/pipa@0.6.4` and confirm `pipa --version` reports `0.6.4`.
3. Start Pipa with the same profile and confirm it responds before resuming normal use. Keep each profile on one host and in one PID namespace; never run two versions against the same profile.

If Pipa cannot verify an old lock, it leaves it alone. Move `pipa.lock` or `pipa.lock.recovering` aside only after pausing automatic launchers and confirming that no Pipa instance is running for that profile. Never signal a process just because its PID appears in the lock. On macOS, a PID reused within the same second can still block startup temporarily.

To roll back, stop Pipa and pause automatic launchers again, install `@usepipa/pipa@0.6.3`, confirm the version, and start it with the same profile.

## Verification

- [Linux PR CI](https://github.com/lunchpaillola/pipa/actions/runs/45709505872) passed on `31fa42d`.
- The 43 focused tests and both isolated CLI lifecycle smoke cases passed on macOS and [Windows](https://github.com/lunchpaillola/pipa/actions/runs/45709185269) with the Windows fix.
- [Live Slack smoke](https://lunchpaillabs.slack.com/archives/C0BNJJ9RDB2/p1795643160113029) passed on macOS before the Windows-only follow-up. No production upgrade or rollback was tested. These checks do not constitute full stable release qualification.
