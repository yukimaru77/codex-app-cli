---
name: codex-session-in-codex-app
description: "Operate Codex App sessions with the codex-app CLI: discover and inspect sessions, create or continue conversations, wait for exact turns, configure model, effort, Fast mode, and Browser profiles, migrate rollouts, relay results, rename, stop, and diagnose local App connectivity. Use when a request names codex-app, a Codex thread/session ID, or moving work into Codex App."
---

# Operate Codex App sessions

Use the installed `codex-app` command. Read [references/command-guide.md](references/command-guide.md) for the command and identifier needed by the requested operation; do not turn every request into a migration or Browser workflow.

Choose the operation from the user's actual intent:

- Discover or inspect: `status`, `list`, `read`, `turn-status`.
- Open or manage an existing App session: `open`, `send`, `wait`, `rename`, `stop`.
- Create an unrelated App-owned session: `new`.
- Import an external rollout: `recognize`.
- Configure in-app Browser state: `profile inspect|list|chrome-list|status|restart|restore` or `--profile` on `new`/`recognize`.
- Observe low-level App events only when needed: `watch`.
- Relay one completed worker result: `send --form` (`--from` is an alias).

Use `scripts/run.sh SESSION_ID /absolute/workspace/path 'prompt'` only as a convenience for the simple verify/open/optional-send case. Use direct commands when exact turn completion, settings, profiles, migration, or structured output matters.

## Preserve identifiers and intent

A conversation/thread ID identifies a session; a turn ID identifies one run inside it. Never pass one as the other. `send` can return an accepted `inProgress` turn; when completion matters, take that exact turn ID and use `wait`.

`new`, `recognize`, and `send` deliberately use `danger-full-access` with approval policy `never`. `send` overrides a restricted or approval-gated existing session before starting its turn. Treat prompts and target sessions as trusted; do not claim that model, effort, Fast mode, or prompt wording controls permissions.

`send` serializes the Desktop ownership-sensitive portion across CLI processes, ensures the in-app Browser runtime is active, discovers the exact Desktop owner client, and loads complete history before starting the turn. Parallel callers may wait briefly for this lock, but their accepted turns then run concurrently. Do not replace this with parallel `open` plus raw IPC calls or send the instruction before the KB bootstrap turn has completed.

Pass `--model`, `--reasoning-effort`, `--fast on|off`, and `--profile` only when requested or required by the chosen operation. `--fast on` selects the priority service tier, `--fast off` clears it, and omission preserves the tier. A Fast-only change must not add model or effort overrides.

For ordinary operations, use the existing session ID and do not fork. Never copy or edit installed rollout JSONL and never mutate `state_5.sqlite`. Use `--dry-run` where the command supports it when the user asks to preview or when validating a migration input before its live operation.

## Specialized workflows

When the user explicitly asks to fork a Codex CLI session and move that fork into Codex App, read and follow [references/fork-to-app.md](references/fork-to-app.md). This is one specialized workflow, not the default way to create or operate App sessions. Do not replace it with `codex-app new` or a prompt that merely mentions the parent ID.

Browser profile selection is creation-time only: use `new --profile` or `recognize --profile`. Do not claim that `profile restart` can change an existing session. Browser profile setup and Browser tool verification are separate facts. A successful profile import or active runtime proves that Browser state is prepared; it does not prove a particular App turn called the in-app Browser. When Browser use itself must be verified, require a completed exact turn plus matching Browser tool output as described in the command guide.

## App restart safety

Treat every Browser runtime restart as a global, disruptive operation: it can terminate or interrupt unrelated Codex App turns owned by the user or other agents. Authorization to migrate a session or use the in-app Browser does **not** authorize restarting the App.

- Before `new --profile`, `recognize --profile`, `profile restart`, or `profile restore`, run `codex-app profile status` and determine whether the requested task actually requires changing Browser profile state.
- If a compatible runtime is already active and no specific profile change was requested, omit `--profile` from `new` or `recognize`. In particular, do not add `--profile default` merely to ensure Browser availability.
- Keep session migration and Browser runtime/profile preparation separate. `recognize` can migrate a rollout without `--profile`; an already-active compatible runtime can then serve the migrated conversation.
- If profile preparation or recovery would quit or restart the signed App, stop before the mutating command, explain that all App sessions may be interrupted, and obtain explicit user confirmation immediately before proceeding.
- A failed attempt that already triggered a restart is not permission to retry another restart. Reinspect status and request confirmation if another disruptive attempt is needed.

Use the normal signed App and shared session store. Do not launch alternate App user-data roots or modify the signed App bundle.
