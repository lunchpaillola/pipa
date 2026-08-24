---
name: slack-file-upload-evals
description: Run a real Slack end-to-end smoke test for local Pipa file uploads. Uploads files in an initial mention and a thread follow-up, then verifies Pipa reads both files.
---

# Slack File Upload Evals

Use this operator eval after changing Slack attachments or OpenCode file handling.

## Run

Copy `.env.example` to `.env`, fill in the three required values, start local Pipa, then run:

```sh
.opencode/skills/slack-file-upload-evals/scripts/run.sh
```

The posting user token needs `files:write`. The eval uses the local bot token already stored in `~/.pipa/config.json` to poll replies, so Piper must be invited to the dedicated test channel.

The eval uploads two generated text files into one Slack thread:

1. An initial bot mention with a file containing a unique pass phrase.
2. A mentioned follow-up with another file in the same thread, proving attachment handling and session continuity.

The posting token belongs to a Slack app, so Slack suppresses its ordinary non-mention events to that same app. Verify an unmentioned follow-up uploaded through the Slack UI separately when releasing attachment changes.

It passes only when Pipa replies with both pass phrases. Results are written to `.opencode/skills/slack-file-upload-evals/results/`.

Never commit `.env`, tokens, or generated results.
