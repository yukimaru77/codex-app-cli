---
name: codex-session-in-codex-app
description: Open, inspect, continue, stop, rename, configure, migrate, and orchestrate Codex sessions in Codex App through the shared session store, live private IPC, and codex app-server. Use when given a thread/session ID, including requests to fork a current CLI session and move the fork into the App, open or read a session, send a follow-up, select model, reasoning effort, Fast mode, or Browser profile, relay a result, rename the chat, stop a turn, or verify the App-produced response.
---

# Operate an existing Codex App session

Use `scripts/run.sh SESSION_ID /absolute/workspace/path 'prompt'` to verify, open, and optionally continue a session. Omit the prompt when only opening it.

For direct operations, use the installed `codex-app` CLI:

```bash
codex-app open --conversation SESSION_ID
codex-app read --conversation SESSION_ID --json
codex-app turn-status --conversation SESSION_ID
codex-app rename --conversation SESSION_ID --name 'New chat name'
codex-app stop --conversation SESSION_ID
```

Create a new App-owned session with explicit settings when requested:

```bash
codex-app new \
  --cwd /absolute/workspace/path \
  --profile 'chrome:<profile>' \
  --model MODEL \
  --reasoning-effort EFFORT \
  --fast on \
  --text 'prompt'
```

`--profile` accepts the selectors from `codex-app profile list` and `codex-app profile chrome-list`. The command waits for the initial turn, transfers its temporary Browser partition to a separate final session profile, restarts the App, and reopens the created session before returning.

`read` returns only the latest message by default. Add `--all-item` only when the complete message transcript is required.

## Fork a CLI session into the App

When the user explicitly asks to fork a Codex CLI session and move that fork into Codex App, read and follow [references/fork-to-app.md](references/fork-to-app.md). This is a distinct workflow from creating an unrelated App session. Do not replace it with `codex-app new`, a prompt containing the parent session ID, or any other logical-fork approximation.

## Send and relay results

Send an ordinary follow-up through the App's live IPC:

```bash
codex-app send \
  --conversation WORKER_SESSION_ID \
  --cwd /absolute/workspace/path \
  --text 'prompt'
```

When requested, add `--model MODEL`, `--reasoning-effort EFFORT`, or `--fast on|off`. Pass only settings the user explicitly selected. `--fast on` selects the Fast (`priority`) service tier, `--fast off` clears it, and omitting `--fast` preserves the current tier. A Fast-only change must omit `--model` and `--reasoning-effort` so it does not change either setting. Verify `appliedThreadSettings` contains only the intended overrides.

An accepted response with `status: inProgress` proves IPC acceptance, not completion. Verify the matching assistant response or use `turn-status` when completion matters.

To return a worker result to an orchestrator session, use `--form` (`--from` is an alias):

```bash
codex-app send \
  --conversation WORKER_SESSION_ID \
  --text 'complete this task' \
  --form ORCHESTRATOR_SESSION_ID \
  --timeout 14400000
```

This waits for the exact worker turn to complete, selects that turn's final assistant message, and sends it to the orchestrator as a new user message. A successful command proves the worker completed and the orchestrator App handler accepted the relay; it does not prove the orchestrator's resulting turn completed. Do not manually resend after success. An aborted or timed-out worker turn is not relayed.

## Session integrity

For ordinary operations, use the existing session ID and do not fork. Fork only when the user explicitly requests a fork or migration. Never copy or edit an installed rollout and never mutate `state_5.sqlite`. `recognize` may reuse a source rollout already at its exact shared-store destination; it must never overwrite one.

`turn-status` derives `idle`, `inProgress`, `completed`, or `aborted` from persisted rollout lifecycle events. Treat a stale `inProgress` as possible after an abnormal process exit.

For work using the in-app Browser in multiple sessions, verify `codex-app profile status | jq -e '.runtimeActive == true'` before sending. If inactive, run `codex-app profile restart --from default` once and verify again. Use `codex-app profile chrome-list` and `codex-app profile restart --from 'chrome:<profile>'` when a Chrome seed is explicitly requested. Use the normal signed App and shared store; do not launch separate App user-data profiles.
