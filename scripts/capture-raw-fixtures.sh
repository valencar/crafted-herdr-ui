#!/usr/bin/env bash
# Captures READ-ONLY herdr output into fixtures-raw/ (gitignored) so shapes can be
# learned from real data. Raw files hold real names and paths: never commit them,
# never paste their contents anywhere tracked.
# Runs only: api snapshot, api schema, machine list/status. HERDR_UI_TEST_MACHINE is
# read from .env.local (its value is never printed).
set -u

root=$(git rev-parse --show-toplevel) || exit 2
cd "$root" || exit 2
out="$root/fixtures-raw"
mkdir -p "$out"

machine=""
if [ -f .env.local ]; then
  machine=$(grep -E '^HERDR_UI_TEST_MACHINE=' .env.local | tail -n1 | cut -d= -f2-)
  machine=${machine%\"}; machine=${machine#\"}; machine=${machine%\'}; machine=${machine#\'}
fi

capture() {
  local name=$1
  shift
  if "$@" >"$out/$name.json" 2>"$out/$name.stderr"; then
    echo "captured $name"
  else
    echo "failed   $name (exit $?)"
  fi
}

capture snapshot_local herdr api snapshot
capture schema herdr api schema --json
capture machine_list herdr machine list --json
capture machine_status herdr machine status --json
if [ -n "$machine" ]; then
  capture snapshot_machine herdr --machine "$machine" api snapshot
fi
