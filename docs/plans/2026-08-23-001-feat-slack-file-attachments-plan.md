---
title: "feat: Add Slack file attachments"
type: feat
status: completed
date: 2026-08-23
issue: https://linear.app/lunchpaillabs/issue/STU-551/add-inbound-slack-files-to-local-pipa
linear_document: https://linear.app/lunchpaillabs/document/implementation-plan-file-complete-local-pipa-1625796d7053
---

# File-Complete Local Pipa

**Parent:** [STU-525](https://linear.app/lunchpaillabs/issue/STU-525/open-source-pipa-publish-runtime-as-open-source-vellum-model-keep)  
**Working branch:** `feat/local-pipa-files`

## Summary

Let users send a text prompt with Slack attachments. Local Pipa downloads the attachments through Chat SDK, writes them to one temporary directory because the OpenCode CLI accepts file paths, passes those paths through repeated `--file` arguments, and removes the directory after the turn.

This is a small extension of the existing Slack-to-OpenCode path. There is no new service, staging abstraction, dependency, persistent upload store, MIME framework, or Shared Core work.

## Requirements

- **R1.** A Slack mention can include a text prompt and one or more attached files.
- **R2.** A subscribed thread follow-up can include a text prompt and attached files without another mention.
- **R3.** A prompt is required. File-only messages do not execute and Pipa does not invent a fallback instruction.
- **R4.** Pipa downloads attachments through Chat SDK's authenticated `attachment.fetchData()` interface rather than adding Slack API code.
- **R5.** Pipa applies only one local safety boundary: 100 MB per file. Slack's own 10-file-per-message limit remains the count boundary. Pipa does not add a separate aggregate limit.
- **R6.** If an attachment is too large or cannot be downloaded, Pipa does not run OpenCode with a partial set and posts a short human-readable message.
- **R7.** Pipa writes downloaded files to one temporary directory for the turn, passes them to OpenCode with repeated `--file` arguments, and removes the directory afterward.
- **R8.** Standalone and `PIPA_OPENCODE_ATTACH_URL` modes preserve the existing prompt, session, working-directory, shell-free execution, and Slack delivery behavior.
- **R9.** Existing text-only turns continue unchanged.

## Non-Goals

- File-only prompts or generated fallback instructions
- Outbound file delivery to Slack
- Persistent file storage or upload history
- MIME-specific OCR, transcription, conversion, or preview logic
- Configurable limits or a MIME allowlist
- DMs, Slack Connect, additional chat surfaces, hosted gateway work, or Shared Core extraction

## Decisions

1. **Use the existing adapter path.** Chat SDK already authenticates and downloads Slack attachments through `fetchData()`.
2. **Use the smallest bridge OpenCode requires.** The adapter returns bytes while `opencode run --file` accepts paths. The implementation therefore creates one temporary directory, writes the files, invokes the existing executor, and removes the directory in `finally`. This remains inside the existing turn path; it is not a new staging service or abstraction.
3. **Require the user's prompt.** Files accompany text. Pipa does not decide what the user wants done with an unexplained upload.
4. **Use one researched safety cap, not the prior arbitrary guardrail.** Slack permits up to 10 files per message and files up to 1 GB. AI products vary widely: Gemini's normal file limit is 100 MB, while ChatGPT and Claude allow substantially more. Because Chat SDK buffers a complete file in the local Node process and OpenCode's actual provider varies, Pipa caps each file at 100 MB, relies on Slack for the count limit, and adds no aggregate cap.
5. **Do not run partial input.** If one attachment fails, Pipa posts a simple message such as `Pipa could not read one of the attached files. Please try uploading it again.` OpenCode does not run with missing context.
6. **Attached mode is proven.** On 2026-08-23, OpenCode 1.18.19 successfully read the attached repository `README.md` and returned the expected `FILE_OK` response in both standalone and `--attach http://127.0.0.1:45551` modes. This is no longer an implementation uncertainty.

Boundary sources: [Slack file limits](https://slack.com/help/articles/201330736-Add-files-to-Slack), [Gemini upload limits](https://support.google.com/gemini/answer/14903178), [ChatGPT file limits](https://help.openai.com/en/articles/8555545-file-uploads-faq), and [Claude file limits](https://support.anthropic.com/en/articles/8241126-what-kinds-of-documents-can-i-upload-to-claude-ai).

## Implementation Units

### U1. Route Text-Plus-File Slack Turns

**Goal:** Carry Slack attachments through the existing per-thread queue without changing text-only behavior.

**Requirements:** R1, R2, R3, R4, R5, R6, R9

**Dependencies:** None

**Files:**

- Modify `src/app.mjs`
- Modify `test/app.test.mjs`

**Approach:**

- Read `message.attachments` from Chat SDK.
- Continue requiring a non-empty prompt after mention stripping.
- Allow `file_share` messages with text while continuing to reject edits, deletions, bot traffic, DMs, Slack Connect, and unsupported subtypes.
- Reject an attachment whose declared size exceeds 100 MB with a clear thread message.
- Pass attachment descriptors with the queued turn. Do not download them before their turn starts.

**Test scenarios:**

- A mention with text and one attachment reaches the executor with both.
- A subscribed follow-up with text and attachments runs without another mention.
- File-only and empty messages remain ignored.
- A file at 100 MB is accepted; a file over 100 MB posts the size message and does not call OpenCode.
- Existing app tests remain green.

### U2. Pass Downloaded Files to OpenCode

**Goal:** Add the minimal bytes-to-path bridge required by the OpenCode CLI.

**Requirements:** R4, R6, R7, R8

**Dependencies:** U1

**Files:**

- Modify `src/opencode.mjs`
- Modify `test/opencode.test.mjs`

**Approach:**

- When a queued turn starts, create one OS temporary directory.
- Download each attachment sequentially through `fetchData()` and write it into that directory using `path.basename()` plus an index to avoid duplicate names.
- Extend the existing argument builder with repeated `--file` paths before `--`.
- If a download or write fails, throw one simple attachment error and do not spawn OpenCode.
- Remove the temporary directory in `finally` after success or failure.
- Keep the current child process, timeout, shutdown, session, environment, and output parsing behavior.

**Test scenarios:**

- Standalone and attached arguments contain the expected repeated `--file` entries before the prompt.
- Downloaded bytes are written to the files passed to OpenCode.
- Duplicate filenames receive distinct paths.
- A download failure produces the simple attachment error and does not spawn OpenCode.
- The temporary directory is removed after success, OpenCode failure, and timeout.
- Existing shell-free prompt and Windows command-shim tests remain green.

**Verification:** Executor tests prove correct file bytes, arguments, failure behavior, and cleanup without introducing another runtime layer.

## Real Slack Release Gate

Before release, verify:

1. Text-plus-file mention produces the expected OpenCode result.
2. Text-plus-file follow-up continues the same thread/session.
3. A file over 100 MB receives a clear message and does not run OpenCode.
4. An unreadable attachment receives the simple retry message and does not run OpenCode.

## Done When

A clean installed package can receive Slack prompts with attachments, pass the downloaded files to OpenCode in both supported modes, continue the existing thread/session, explain size or download failures plainly, and remove its temporary copies after the turn. Existing text behavior and package checks remain green. The README and repository overview describe the shipped behavior and limits.
