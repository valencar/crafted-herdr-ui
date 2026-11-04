#!/usr/bin/env bash
# Captures READ-ONLY herdr-core output into fixtures-raw/hc/ (gitignored) so shapes can be
# learned from real data. Raw files hold real names and paths: never commit them,
# never paste their contents anywhere tracked. Committed fixtures live in
# src-tauri/tests/fixtures/hc/ and are rewritten with generic names by hand or script.
#
# Runs only reads: `hc --version`, `hc schema`, `hc server status`, `hc ls --all`,
# `hc machine ls`, `hc templates`, a short `hc events` sample, and one `hc connect`
# conversation (hello, events.subscribe, machine.list, templates.list, doc.get).
# Note: every hc command starts a stopped local core (CLAUDE.md rule 5, the stated exception).
#
# Point it at the sandbox core, never at a core you care about:
#   HC_SESSION=herdr-ui-qa XDG_STATE_HOME=... XDG_CONFIG_HOME=... XDG_RUNTIME_DIR=... scripts/capture-raw-fixtures.sh
# It refuses to run without HC_SESSION unless HERDR_UI_CAPTURE_DEFAULT=1 is set on purpose.
set -u

root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2
out="$root/fixtures-raw/hc"
mkdir -p "$out"

if [ -z "${HC_SESSION:-}" ] && [ "${HERDR_UI_CAPTURE_DEFAULT:-}" != "1" ]; then
  echo "capture-raw-fixtures: HC_SESSION is not set; refusing to read the default core." >&2
  echo "Use the sandbox environment (CLAUDE.md rule 4), or set HERDR_UI_CAPTURE_DEFAULT=1 on purpose." >&2
  exit 2
fi

# HC_SOCKET would point hc at some other core whatever HC_SESSION says. The terminal variables
# make hc act as a child of the terminal this runs in.
if [ -n "${HC_SOCKET:-}" ]; then
  echo "capture-raw-fixtures: HC_SOCKET is set; unset it (it overrides the session's socket)." >&2
  exit 2
fi
unset HC_TERMINAL_SOCKET HC_TERMINAL_ID HC_SCOPE

# A binary counts only if --version prints `hc X.Y.Z` (another program also ships an `hc`).
hc=""
for name in herdr-core hc; do
  candidate=$(command -v "$name" 2>/dev/null) || continue
  if "$candidate" --version 2>/dev/null | grep -Eq '^hc [0-9]+\.[0-9]+\.[0-9]+'; then
    hc=$candidate
    break
  fi
done
if [ -z "$hc" ]; then
  echo "capture-raw-fixtures: no herdr-core binary found (herdr-core or hc printing 'hc X.Y.Z')" >&2
  exit 2
fi

capture() {
  local name=$1
  shift
  if "$@" >"$out/$name" 2>"$out/$name.stderr"; then
    echo "captured $name"
  else
    echo "failed   $name (exit $?)"
  fi
}

capture version.txt "$hc" --version
capture schema.json "$hc" schema
capture server_status.json "$hc" server status
capture ls_all.json "$hc" ls --all --json
capture machine_ls.json "$hc" machine ls --json
capture templates.json "$hc" templates --json

# A few seconds of the live event stream (one JSON line each when piped).
"$hc" events --json >"$out/events_sample.jsonl" 2>"$out/events_sample.jsonl.stderr" &
events_pid=$!
sleep 5
kill "$events_pid" 2>/dev/null
wait "$events_pid" 2>/dev/null
echo "captured events_sample.jsonl"

# The API as the app will use it: JSON-RPC over `hc connect` (reads only).
{
  printf '%s\n' '{"jsonrpc":"2.0","id":1,"method":"hello","params":{"generation":1}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":2,"method":"machine.list","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":3,"method":"templates.list","params":{}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":4,"method":"doc.get","params":{"name":"herdr-app"}}'
  printf '%s\n' '{"jsonrpc":"2.0","id":5,"method":"events.subscribe","params":{}}'
  sleep 3
} | "$hc" connect >"$out/connect_conversation.jsonl" 2>"$out/connect_conversation.jsonl.stderr"
echo "captured connect_conversation.jsonl"
