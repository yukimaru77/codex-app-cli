# Making an external Codex session visible in the Desktop App

## Scope

This document covers one operation: taking an already-created Codex rollout and producing a persistent child thread that the Codex/ChatGPT Desktop App can display and continue.

It does not create or compact the source context. The caller supplies:

- a validated session rollout;
- its session ID; and
- the workspace path to associate with the App conversation.

## Sequence

```text
external rollout
  ↓ validate and install without overwriting
~/.codex/sessions/YYYY/MM/DD/rollout-...-SESSION_ID.jsonl
  ↓ thread/fork
persistent user child thread
  ↓ bootstrap turn, optional first instruction, and name
App project/conversation list
  ↓ deep link
codex://threads/CHILD_THREAD_ID
```

### 1. Install the rollout in the shared session store

Codex App and Codex CLI use the session directory below `CODEX_HOME`. Its usual location is:

```text
~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<session-id>.jsonl
```

Before installing a file, `codex-app recognize` verifies that:

- the filename ends with the expected session ID;
- the filename date supplies the destination directory;
- `session_meta.payload.id` and `session_meta.payload.session_id` both match;
- every non-empty line is valid JSON; and
- top-level `ordinal` values are contiguous non-negative integers. A fork page may begin at a
  nonzero inherited ordinal.

The command creates the destination with mode `0600` and refuses to overwrite an existing file.
When the supplied rollout is already the exact destination in the shared session store, it reuses
that file instead of attempting to overwrite it. A missing ordinal caused paginated fork preparation
to fail in the Codex CLI version used while developing this workflow:

```text
failed to prepare paginated fork:
paginated rollout line for <session-id> is missing an ordinal
```

At this point the installed rollout is a fork source, not yet the normal App-facing work thread.

### 2. Fork an App-facing child through app-server

The command starts app-server with the same environment and therefore the same `CODEX_HOME`:

```bash
codex app-server --listen stdio://
```

After `initialize` and `initialized`, it sends:

```json
{
  "method": "thread/fork",
  "id": 2,
  "params": {
    "threadId": "TEMPLATE_SESSION_ID",
    "cwd": "/absolute/path/to/workspace",
    "ephemeral": false,
    "sandbox": "danger-full-access",
    "approvalPolicy": "never",
    "threadSource": "user"
  }
}
```

The returned child ID becomes the conversation ID opened in the App. The template ID is not used as the final App thread.

### 3. Complete a bootstrap turn

The child receives a short `turn/start`, and the command waits for its matching `turn/completed` notification:

```json
{
  "method": "turn/start",
  "id": 3,
  "params": {
    "threadId": "CHILD_THREAD_ID",
    "cwd": "/absolute/path/to/workspace",
    "effort": "low",
    "input": [
      {
        "type": "text",
        "text": "Use the imported conversation context when answering future requests."
      }
    ]
  }
}
```

If `--text` is supplied, that instruction is sent only after the bootstrap completes, as a separate turn. `--bootstrap-text` can replace the default bootstrap message.

### 4. Name and verify the child

The command calls `thread/name/set`, then reads the child with `thread/read`. It rejects the result unless the returned ID, absolute workspace path, and name match the requested values.

### 5. Shut down app-server and open the App

The temporary app-server process is closed before the deep link is opened:

```bash
open "codex://threads/CHILD_THREAD_ID"
```

Closing app-server first avoids keeping two writers attached to the same thread.

## Success criteria

The operation is successful only when:

1. rollout validation and installation complete without overwriting a file;
2. `thread/fork` returns a child thread ID;
3. the bootstrap turn reaches `completed`;
4. the optional first instruction, if supplied, reaches `completed`;
5. `thread/read` returns the same child ID, workspace path, and name; and
6. the child deep link opens in the Desktop App.

The user should additionally verify in the UI that the conversation appears below the intended project and retains the source context needed for follow-up questions.

## Security and operational notes

- The fork uses `danger-full-access` and `approvalPolicy: never`. Use only trusted rollout files and workspaces.
- The rollout is installed before app-server creates the child. If a later step fails, the installed source file remains in the session store.
- If the App is already the active writer for a thread, another app-server writer can produce a `thread-store conflict`.
- The tool does not edit `state_5.sqlite` to fabricate an App-visible row; it uses `thread/fork`, `turn/start`, `thread/name/set`, and `thread/read`.
- Making a session visible in the App does not by itself provision App-specific dynamic tools. Those depend on the live App connection and the installed App build.
