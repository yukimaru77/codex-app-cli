# codex-app-cli

An unofficial macOS CLI for opening and controlling local Codex/ChatGPT Desktop App conversations.

It can:

- list and read conversations from the local Codex session store;
- create an App-owned conversation and submit its first prompt;
- send a follow-up to an existing App conversation;
- interrupt a running turn and watch App IPC events; and
- inspect, import, seed, and activate isolated in-app Browser profiles; and
- import an externally created rollout, fork it into a normal App conversation, and open it.

> [!WARNING]
> This is not an OpenAI-supported or stable API. It uses private Desktop App IPC methods, local implementation details, and deep links. An App update can change or remove any of them.

## Requirements

- macOS
- the official Codex/ChatGPT Desktop App, running under the current user
- Node.js 20 or later
- `sqlite3` on `PATH`
- the `codex` CLI on `PATH` when using `recognize`

## Install

```bash
git clone https://github.com/yukimaru77/codex-app-cli.git
cd codex-app-cli
npm link
codex-app status
```

The package installs its runtime dependencies with `npm link` or `npm install`.

The repository also includes the `codex-session-in-codex-app` skill under `.agents/skills/`. Codex discovers it automatically while working in this repository. To make this repository the source of truth for the skill in every workspace, link it into the user skill directory:

```bash
mkdir -p "${CODEX_HOME:-$HOME/.codex}/skills"
ln -s "$PWD/.agents/skills/codex-session-in-codex-app" \
  "${CODEX_HOME:-$HOME/.codex}/skills/codex-session-in-codex-app"
```

## Commands

| Command | What it uses | Purpose |
| --- | --- | --- |
| `status` | private App IPC | Verify that the local App IPC router is reachable. |
| `turn-status` | state database + rollout JSONL | Report the latest turn lifecycle status. |
| `wait` | state database + rollout change notifications | Wait for one exact turn and print only its final result. |
| `rename` | `codex app-server` | Change a conversation's display name and verify it. |
| `list` | `~/.codex/state_5.sqlite` | List locally stored conversations. |
| `read` | state database + rollout JSONL | Print a conversation transcript. |
| `open` | state database + `codex://` deep link | Open an existing conversation in the App. |
| `new` | `codex app-server` + deep link | Create a full-access App-owned conversation and submit its first prompt. |
| `send` | deep link + private App IPC | Send a follow-up through the live App handler. |
| `stop` | deep link + private App IPC | Interrupt the active turn. |
| `watch` | private App IPC | Stream matching App IPC broadcasts. |
| `recognize` | shared rollout store + `codex app-server` | Import and fork an external rollout into an App-visible conversation. |
| `profile` | signed App inspection + in-memory runtime patch | Manage per-session in-app Browser profiles. |

### Manage isolated in-app Browser profiles

Profile operations are built into `codex-app`; a separate `codex-iab-profile` installation is not required.

```bash
codex-app profile inspect
codex-app profile list
codex-app profile chrome-list
codex-app profile status
```

Start the signed App with per-session in-app Browser storage, using the App's current imported browser state as the seed:

```bash
codex-app profile restart --from default
```

Import a Chrome profile by its directory or unique display name. The signed App's standard importer imports Cookies and Passwords and leaves History disabled. The CLI supplements current non-partitioned Cookies that the standard importer omits, then snapshots the result into a unique seed before session profiles are created.

```bash
codex-app profile chrome-list
codex-app profile restart --from 'chrome:Profile 1'
codex-app profile restart --from 'chrome:Work'
```

`--from` chooses the seed for sessions created afterward. Existing sessions keep the Browser profile assigned when they were created; `profile restart` does not change it. Choose the intended profile at creation with `new --profile` or `recognize --profile`. Close Chrome before importing a Chrome profile. Return to an ordinary unpatched App launch with `codex-app profile restore`.

The runtime changes only the JavaScript loaded in memory. It does not edit, copy, re-sign, or replace `/Applications/ChatGPT.app`. See [IAB architecture](./docs/IAB_ARCHITECTURE.md), [live test](./docs/IAB_LIVE_TEST.md), [verification evidence](./docs/IAB_VERIFICATION.md), and the [2026-08-18 Chrome session import incident report](./docs/INCIDENT_2026-08-18_CHROME_SESSION_IMPORT.md).

### Inspect conversations

```bash
codex-app list --cwd "$PWD" --limit 10
codex-app read --conversation '<thread-id>'
codex-app read --conversation '<thread-id>' --json
codex-app read --conversation '<thread-id>' --all-item
codex-app turn-status --conversation '<thread-id>'

codex-app wait \
  --conversation '<thread-id>' \
  --turn '<turn-id>' \
  --timeout 14400000
codex-app rename --conversation '<thread-id>' --name 'New chat name'
```

`turn-status` reports `idle`, `inProgress`, `completed`, or `aborted` from the latest lifecycle event in the rollout.

`wait` subscribes to rollout file changes and periodically rechecks the persisted rollout so a missed filesystem notification cannot strand the waiter. It ignores other turns and emits one JSON result after the requested turn completes. An aborted turn, missing final assistant response, or timeout exits with an error.

`read` returns only the latest message by default. Add `--all-item` to return the full message transcript.

Add `--form <session-id>` to `send` (`--from` is an alias) to wait for the target turn to complete and relay that turn's final assistant message to the specified session.

### Create and immediately run a conversation

```bash
codex-app new \
  --cwd "$PWD" \
  --model 'gpt-5.6-luna' \
  --reasoning-effort max \
  --fast on \
  --text 'Find the failing tests and fix them.'
```

`new` creates the session and its first turn with `sandbox: danger-full-access` and `approvalPolicy: never`. `--model`, `--reasoning-effort`, and `--fast on|off` are applied when the session is created and synchronized to the Desktop composer's complete thread settings after the first turn. `--fast on` selects the Fast (`priority`) service tier; `--fast off` explicitly returns to the standard tier. Omitting `--fast` keeps the existing/default tier. The command ensures the in-memory App runtime is active when those settings or a Browser profile are requested. The signed App bundle is not modified. The same options are supported by `recognize`, including its bootstrap turn and imported Desktop thread.

Add `--profile` to select the initial in-app Browser profile for the new session. It accepts the same values as `codex-app profile restart --from`, including Chrome directory and display-name selectors.

```bash
codex-app new \
  --cwd "$PWD" \
  --profile 'chrome:Work' \
  --model 'gpt-5.6-luna' \
  --reasoning-effort max \
  --text 'Open the product and verify the signed-in flow.'
```

With `--profile`, `new` starts the profile runtime before the initial turn. It then stops the App so Chromium flushes the selected seed, copies it to the final session-ID profile, restarts the App, and reopens the session before returning. Two sessions created from the same source receive separate copies; choosing a different source produces another separate copy.

Use `--dry-run` to inspect the App Server creation request without creating a session:

```bash
codex-app new --cwd "$PWD" --text 'Hello' --profile default --dry-run
```

### Continue, stop, or watch a conversation

```bash
codex-app send \
  --conversation '<thread-id>' \
  --cwd "$PWD" \
  --model 'gpt-5.6-luna' \
  --reasoning-effort max \
  --fast off \
  --text 'Add a regression test as well.'

codex-app stop --conversation '<thread-id>'
codex-app watch --conversation '<thread-id>'
```

`watch` waits up to four hours by default so long-running browser E2E turns do not silently lose their result monitor. Use `--timeout <ms>` only when a different bound is intentional.

`send` always updates the target conversation to `danger-full-access` with approval policy `never`, and also puts those values directly on the turn request. This applies even when the existing conversation was previously restricted or approval-gated. Before starting the turn, it asks the owning Desktop view to load the complete conversation history. This keeps KB bootstrap turns, model changes, and the new instruction in ordinal order in the App UI.

Desktop ownership changes are serialized across `codex-app` processes with an inter-process lock. Only the short `ensure App runtime → open → discover the exact thread owner → load complete history → update settings → start turn` section is locked; turns continue running concurrently after acceptance. All follower requests target the discovered Desktop client instead of an arbitrary App window. A lock left by an exited process is recovered automatically. `stop` and Desktop settings synchronization use the same lock.

When `--model`, `--reasoning-effort`, or `--fast` is specified, those settings are updated with the permissions before the turn starts. `--fast on` enables Fast mode and `--fast off` disables it without changing the model or reasoning effort; omitting the option leaves the tier unchanged. Add `--dry-run` to print the serialized request sequence without sending it.

### Import an external rollout

First inspect the operation without changing the shared session store:

```bash
codex-app recognize \
  --rollout '/path/to/rollout-2026-08-12T10-20-30-<template-session-id>.jsonl' \
  --session-id '<template-session-id>' \
  --cwd '/path/to/workspace' \
  --name 'Imported project context' \
  --dry-run
```

Then run it, optionally sending a separate first instruction after the bootstrap turn:

```bash
codex-app recognize \
  --rollout '/path/to/rollout-2026-08-12T10-20-30-<template-session-id>.jsonl' \
  --session-id '<template-session-id>' \
  --cwd '/path/to/workspace' \
  --name 'Imported project context' \
  --model 'gpt-5.6-luna' \
  --reasoning-effort max \
  --fast on \
  --text 'Summarize the imported context.'
```

The command validates the filename, both session IDs in `session_meta`, every JSONL record, and the complete `ordinal` sequence. It installs the file with mode `0600` under `$CODEX_HOME/sessions/YYYY/MM/DD/` (or `~/.codex/sessions/...`) and refuses to overwrite an existing file. It then forks a persistent user thread, completes a bootstrap turn, runs the optional instruction as a separate turn, names the thread, verifies it with `thread/read`, shuts down app-server, and opens the child thread in the App.

> [!CAUTION]
> `new`, `recognize`, and every `send` deliberately run with `sandbox: danger-full-access` and `approvalPolicy: never`. Only use trusted prompts, sessions, rollout files, and workspaces. Run `--dry-run` first when inspection is needed. A copied rollout is not automatically removed if a later app-server step fails.

See [APP_SESSION_RECOGNITION.md](./APP_SESSION_RECOGNITION.md) for the protocol sequence and success criteria.

## IPC socket discovery

The socket is checked in this order:

1. `CODEX_IPC_SOCKET`
2. `~/.codex/ipc/ipc.sock`
3. `$TMPDIR/codex-ipc/ipc-<uid>.sock`
4. `$TMPDIR/codex-ipc/ipc.sock`
5. `/tmp/codex-ipc/...`

The observed wire format is a 4-byte little-endian payload length followed by UTF-8 JSON. The client sends `initialize` before private method calls.

If more than one Codex frontend is running, a different frontend can own the shared router. For the first diagnostic run, close other Codex frontends and check the socket owner with:

```bash
SOCKET="${CODEX_IPC_SOCKET:-$HOME/.codex/ipc/ipc.sock}"
lsof -nU 2>/dev/null | grep -F "$SOCKET"
```

## Scope and limitations

- The tool controls the local App; it does not emulate the App by changing `clientInfo` metadata.
- `new` depends on the current deep-link and composer UI behavior.
- `send`, `stop`, `watch`, and `status` depend on private IPC method names and versions.
- `list`, `read`, and `open` depend on the local state database and rollout layout.
- App-provided tools, in-app Browser availability, and callback routing remain properties of the live App-created thread and the installed App build.
- The profile runtime patches the App's loaded JavaScript only in memory; it does not edit, re-sign, or replace the official App bundle.

## Development

```bash
npm test
npm run verify
node --check bin/codex-app.mjs
npm pack --dry-run
```

## Attribution

The IPC protocol investigation was informed by InfinityMod's MIT-licensed [Codex IPC Tool](https://gist.github.com/InfinityMod/ecc1f441f7447824ff114b8a41debec2). This repository contains a purpose-built implementation rather than a copy of that script.

## License

MIT
