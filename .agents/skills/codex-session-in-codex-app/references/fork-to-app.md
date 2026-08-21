# Fork a Codex CLI session into Codex App

Use this workflow only when the user explicitly asks to fork a CLI session and migrate that fork into Codex App. Preserve the user's eventual worker instruction, model, reasoning effort, Fast choice, Browser profile, workspace, and session name exactly.

## Required order

1. Record the source session ID, absolute workspace path, and the current session IDs in that workspace. When the user says "this/current session", use `CODEX_THREAD_ID` when present and verify that exact ID with `codex-app read`; do not guess from the latest session.
2. Run `codex fork SOURCE_SESSION_ID -C WORKSPACE --no-alt-screen` with no prompt argument. Wait for `Thread forked from ...`, then exit the forked TUI without sending the worker instruction.
3. Identify the one new fork session ID by comparing the workspace's session list before and after. Verify it with `codex-app read --conversation FORK_SESSION_ID --json`, and take `rolloutPath` from that output. Do not infer the ID from recency alone when more than one candidate exists.
4. Migrate that exact fork rollout with `codex-app recognize`. Resolve a requested Chrome display name with `codex-app profile chrome-list`, require one exact match, and pass its selector here; do not guess a profile or globally restart one first as a substitute for migration.
5. Take the App-facing child ID from `recognize` output field `threadId`. The fork source ID is a template and is not the final App conversation ID.
6. Only after `recognize` succeeds, send the preserved worker instruction to the returned child ID with `codex-app send`.
7. When completion matters, extract the exact turn ID from the send response and wait for it with `codex-app wait`.

Example migration after the fork ID and rollout are verified:

```bash
codex-app recognize \
  --rollout '/absolute/path/to/rollout-...-FORK_SESSION_ID.jsonl' \
  --session-id FORK_SESSION_ID \
  --cwd '/absolute/workspace' \
  --name 'App session name' \
  --profile 'chrome:Profile 4'
```

Then send the instruction to the `threadId` returned above:

```bash
codex-app send \
  --conversation APP_CHILD_THREAD_ID \
  --cwd '/absolute/workspace' \
  --text 'the preserved worker instruction'
```

Add `--model`, `--reasoning-effort`, or `--fast on|off` only when explicitly requested. `--profile` belongs on `recognize`; the post-migration `send` targets the already-profiled child.

## Prohibited substitutions

- Do not use `codex-app new` for this request.
- Do not tell a new session to read or imitate the parent by embedding the parent ID in a prompt.
- Do not send the worker instruction as the optional `PROMPT` argument to `codex fork`; it must run only after App migration.
- Do not send the worker instruction through `recognize --text`; keep migration/bootstrap separate from the requested work.
- Do not copy, rewrite, renumber, or overwrite rollout JSONL, and do not modify `state_5.sqlite`.
- Do not continue after an ambiguous fork ID, failed `recognize`, aborted bootstrap, or missing App child ID. Report the exact failed stage and preserve the fork for a safe retry.

Success means the CLI fork exists, `recognize` reports a distinct App child `threadId`, the requested profile was applied during migration, and the worker instruction was accepted by that child. A completed worker result requires the matching `wait` result, not merely `send` returning `inProgress`.
