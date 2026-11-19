# Pipa 0.6.2

Pipa can now read a linked Slack thread, look up a user, post or edit its own messages, react, and transfer files when asked. The tools start automatically when Pipa owns the OpenCode v2 server for Slack. They use the existing bot account and its Slack permissions. No new Slack scopes or second listener are needed.

If the tools aren't ready at startup, Pipa warns and continues handling normal Slack replies. OpenCode v1 and attached servers do not register the tools automatically.

Explicit file transfers use the `slack-files` folder inside the Pipa profile directory. Downloads are limited to 10 MiB and do not overwrite existing files.

## Before publishing

- Verify required CI and review feedback on the final candidate in [PR #78](https://github.com/lunchpaillola/pipa/pull/78).
- The [live text smoke test](https://lunchpaillabs.slack.com/archives/C0BNJJ9RDB2/p1795097377759539) confirmed thread read, user lookup, and post/edit as the test bot on OpenCode 2.2.5 before the final release-preparation edits. Live reactions, file transfers, and ordinary reply delivery were not tested in that run.
- After separately approved merge, verify the exact merged package and registry state before tagging or publishing. For an install rollback, use the previous package version and the compatible profile snapshot, if needed.
