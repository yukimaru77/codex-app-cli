#!/usr/bin/env bash
set -euo pipefail

session_id="${1:?usage: run.sh SESSION_ID WORKSPACE [PROMPT]}"
workspace="${2:?usage: run.sh SESSION_ID WORKSPACE [PROMPT]}"
prompt="${3:-}"

if [[ ! -d "$workspace" ]]; then
  printf 'workspace does not exist: %s\n' "$workspace" >&2
  exit 1
fi
command -v codex-app >/dev/null || { printf 'codex-app command not found\n' >&2; exit 1; }

codex-app read --conversation "$session_id" --json >/dev/null
open "codex://threads/$session_id"

if [[ -n "$prompt" ]]; then
  codex-app send --conversation "$session_id" --cwd "$workspace" --text "$prompt"
fi
