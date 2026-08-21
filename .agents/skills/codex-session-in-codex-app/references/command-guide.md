# `codex-app` command guide

Select only the section needed for the request. Commands that mutate App state are marked by their effect; read-only inspection does not imply permission to create, send, stop, rename, import, or replace Browser state.

## The identifiers and outputs

- **Conversation/thread ID**: the persistent session ID used by `read`, `open`, `send`, `turn-status`, `wait`, `rename`, `stop`, and profile assignment.
- **Turn ID**: one execution inside a conversation. Take it from the `send` response and pass it to `wait --turn` when exact completion matters.
- **Template session ID**: the rollout identity passed to `recognize`. Its successful output contains a distinct App-facing child `threadId`; continue the child, not the template.
- **Profile selector**: `default`, a listed App Browser profile, or an exact Chrome selector such as `chrome:Profile 4`. Resolve names with `profile list` or `profile chrome-list`; do not guess.

`read` returns the latest message by default. Add `--all-item` only for the complete message transcript. `turn-status` reports the latest persisted lifecycle as `idle`, `inProgress`, `completed`, or `aborted`. `send` returning `inProgress` proves acceptance, not completion.

## Check connectivity and discover sessions

These operations are read-only:

```bash
codex-app status
codex-app list --cwd '/absolute/workspace' --limit 20 --json
codex-app read --conversation CONVERSATION_ID --json
codex-app read --conversation CONVERSATION_ID --all-item --json
codex-app turn-status --conversation CONVERSATION_ID
```

Use `status` to check the private App IPC router. Use `list` to discover candidates, then verify the exact session with `read`; do not select a session from recency alone when the request names an ID or multiple candidates exist.

## Open, continue, wait, rename, or stop

These commands affect the named App conversation except for `wait`:

```bash
codex-app open --conversation CONVERSATION_ID
codex-app send --conversation CONVERSATION_ID --cwd '/absolute/workspace' --text 'prompt'
codex-app wait --conversation CONVERSATION_ID --turn EXACT_TURN_ID --timeout 300000
codex-app rename --conversation CONVERSATION_ID --name 'New name'
codex-app stop --conversation CONVERSATION_ID
```

Use `open` only to show an existing session. Use `send` to continue it. If the result matters, extract the exact returned turn ID and run `wait`; do not substitute a later `turn-status` for exact-turn attribution. `stop` targets the active turn and `rename` verifies the persisted name.

Add settings only when intended:

```bash
codex-app send \
  --conversation CONVERSATION_ID \
  --cwd '/absolute/workspace' \
  --model MODEL \
  --reasoning-effort EFFORT \
  --fast on \
  --text 'prompt'
```

`--fast on` enables the priority tier; `--fast off` clears it; omission preserves it. For a Fast-only change, omit `--model` and `--reasoning-effort`. Check `appliedThreadSettings` to verify the intended overrides.

## Create a new App-owned conversation

Use `new` only when the user wants an unrelated new App conversation:

```bash
codex-app new \
  --cwd '/absolute/workspace' \
  --text 'initial prompt' \
  --model MODEL \
  --reasoning-effort EFFORT \
  --fast on \
  --profile PROFILE_SELECTOR
```

All settings are optional. With `--profile`, the command prepares isolated Browser state for the resulting session and preserves Browser changes from the initial turn. `new` is not a replacement for importing or forking existing conversation context. It uses the App composer and requires macOS Accessibility permission for the invoking terminal. Use `--dry-run` to preview without submitting.

## Recognize external rollouts

Use `recognize` to validate an external rollout and fork it into a normal App-visible child:

```bash
codex-app recognize \
  --rollout '/absolute/path/to/rollout.jsonl' \
  --session-id TEMPLATE_SESSION_ID \
  --cwd '/absolute/workspace' \
  --name 'App session name' \
  --profile PROFILE_SELECTOR \
  --dry-run
```

Omit `--profile` unless the user requested a specific Browser profile or status inspection proves that profile preparation is required. `--profile default` is not a harmless default: it may quit and restart the shared signed App, interrupting unrelated sessions. Read the restart-safety rules in `SKILL.md` before supplying any profile selector.

Then omit `--dry-run` for the live import. `--model`, `--reasoning-effort`, `--fast on|off`, and an optional `--text` are supported, but a workflow may require the first real instruction to remain separate. Successful output contains the App child in `threadId`; use that ID for later commands.

An input rollout already at its exact shared-store destination is valid and dry-run reports `rollout.action: "reuse"`. A different existing destination fails closed. `recognize` makes a bounded retry for transient SQLite state-runtime startup failures and reports `appServerStartAttempts`; it does not retry the fork operation itself.

`recognize` creates its child with `sandbox: danger-full-access` and `approvalPolicy: never`. Use it only with a trusted rollout and workspace, validate with `--dry-run` first, and do not treat migration as permission for unrelated external changes.

When the user specifically wants a CLI session forked and migrated, follow [fork-to-app.md](fork-to-app.md), which defines the required ordering and prohibits logical-fork substitutions.

## Prepare in-app Browser profiles

Inspection is read-only:

```bash
codex-app profile inspect
codex-app profile list
codex-app profile chrome-list
codex-app profile status
```

Runtime and assignment operations change App runtime/profile state:

```bash
codex-app profile restart --from default
codex-app profile restart --from 'chrome:Profile 4'
codex-app profile restore
```

Use one exact selector returned by the list commands. Close Chrome before importing a Chrome profile. `restart --from` selects the seed for sessions created afterward; it does not change an existing session's Browser profile. Choose an explicitly requested profile at creation with `new --profile` or `recognize --profile`. `restore` returns to an ordinary unpatched App launch.

`profile restart`, `profile restore`, and profile-bearing `new` or `recognize` may restart the shared signed App. They are disruptive operations, not ordinary setup. First inspect `profile status`; if the compatible runtime is already active and no profile change was requested, preserve it and omit profile mutation. Otherwise obtain explicit user confirmation immediately before the operation.

For ordinary existing-session Browser work, verify `profile status` reports an active runtime before sending. Profile preparation, Cookie import, and Browser execution are distinct: when the request requires proof that the in-app Browser works, send a non-mutating Browser task to the target conversation, wait for its exact turn, and verify matching tool output contains the resulting tab ID, URL, or title. An assistant assertion or `runtimeActive: true` alone is insufficient.

## Relay a completed worker result

```bash
codex-app send \
  --conversation WORKER_CONVERSATION_ID \
  --text 'complete this task' \
  --form ORCHESTRATOR_CONVERSATION_ID \
  --timeout 14400000
```

`--from` is an alias for `--form`. This waits for the exact worker turn, selects its final assistant message, and submits that result to the orchestrator. Success proves worker completion and relay acceptance; it does not prove the orchestrator's resulting turn completed. Do not manually resend after success. Aborted or timed-out worker turns are not relayed.

## Diagnose only when needed

```bash
codex-app watch --conversation CONVERSATION_ID --timeout 300000
```

`watch` streams matching private App IPC broadcasts and is primarily diagnostic. Prefer `wait` for a known turn and `turn-status` for persisted lifecycle state.

`CODEX_IPC_SOCKET` overrides automatic socket discovery when diagnosing a known alternate local App socket. Do not use it to launch or emulate a separate App identity.
