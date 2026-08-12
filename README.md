# codex-app-cli

An unofficial macOS CLI for opening and controlling local Codex/ChatGPT Desktop App conversations.

It can:

- list and read conversations from the local Codex session store;
- create an App-owned conversation and submit its first prompt;
- send a follow-up to an existing App conversation;
- interrupt a running turn and watch App IPC events; and
- import an externally created rollout, fork it into a normal App conversation, and open it.

> [!WARNING]
> This is not an OpenAI-supported or stable API. It uses private Desktop App IPC methods, local implementation details, deep links, and macOS Accessibility automation. An App update can change or remove any of them.

## Requirements

- macOS
- the official Codex/ChatGPT Desktop App, running under the current user
- Node.js 20 or later
- `sqlite3` on `PATH`
- the `codex` CLI on `PATH` when using `recognize`
- Accessibility permission for the terminal application that invokes `codex-app new`

## Install

```bash
git clone https://github.com/yukimaru77/codex-app-cli.git
cd codex-app-cli
npm link
codex-app status
```

There are no runtime npm dependencies.

## Commands

| Command | What it uses | Purpose |
| --- | --- | --- |
| `status` | private App IPC | Verify that the local App IPC router is reachable. |
| `list` | `~/.codex/state_5.sqlite` | List locally stored conversations. |
| `read` | state database + rollout JSONL | Print a conversation transcript. |
| `open` | state database + `codex://` deep link | Open an existing conversation in the App. |
| `new` | `codex://threads/new` + Accessibility Return key | Create an App-owned conversation and submit its first prompt. |
| `send` | deep link + private App IPC | Send a follow-up through the live App handler. |
| `stop` | deep link + private App IPC | Interrupt the active turn. |
| `watch` | private App IPC | Stream matching App IPC broadcasts. |
| `recognize` | shared rollout store + `codex app-server` | Import and fork an external rollout into an App-visible conversation. |

### Inspect conversations

```bash
codex-app list --cwd "$PWD" --limit 10
codex-app read --conversation '<thread-id>'
codex-app read --conversation '<thread-id>' --json
```

### Create and immediately run a conversation

```bash
codex-app new \
  --cwd "$PWD" \
  --text 'Find the failing tests and fix them.'
```

`new` opens a prefilled App deep link, activates the App, waits four seconds, presses Return through macOS Accessibility, and then waits for a new local thread record. It does not send `start-conversation` over IPC.

Grant Accessibility permission to the terminal host you use to run the command under **System Settings → Privacy & Security → Accessibility**. Use `--dry-run` to inspect the deep link without opening the App or pressing a key:

```bash
codex-app new --cwd "$PWD" --text 'Hello' --dry-run
```

### Continue, stop, or watch a conversation

```bash
codex-app send \
  --conversation '<thread-id>' \
  --cwd "$PWD" \
  --text 'Add a regression test as well.'

codex-app stop --conversation '<thread-id>'
codex-app watch --conversation '<thread-id>'
```

`send` and `stop` first open the target thread so that the live Desktop handler owns it, then call `thread-follower-start-turn` or `thread-follower-interrupt-turn` over IPC. Add `--dry-run` to print the request without sending it.

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
  --text 'Summarize the imported context.'
```

The command validates the filename, both session IDs in `session_meta`, every JSONL record, and the complete `ordinal` sequence. It installs the file with mode `0600` under `$CODEX_HOME/sessions/YYYY/MM/DD/` (or `~/.codex/sessions/...`) and refuses to overwrite an existing file. It then forks a persistent user thread, completes a bootstrap turn, runs the optional instruction as a separate turn, names the thread, verifies it with `thread/read`, shuts down app-server, and opens the child thread in the App.

> [!CAUTION]
> `recognize` deliberately creates the fork with `sandbox: danger-full-access` and `approvalPolicy: never`, matching the workflow this tool was built to import. Only use trusted rollout files and trusted workspaces. Run `--dry-run` first. The copied rollout is not automatically removed if a later app-server step fails.

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
- This repository does not patch, re-sign, or replace the official App.

## Development

```bash
npm test
node --check bin/codex-app.mjs
npm pack --dry-run
```

## Attribution

The IPC protocol investigation was informed by InfinityMod's MIT-licensed [Codex IPC Tool](https://gist.github.com/InfinityMod/ecc1f441f7447824ff114b8a41debec2). This repository contains a purpose-built implementation rather than a copy of that script.

## License

MIT
