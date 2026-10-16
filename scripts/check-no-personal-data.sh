#!/usr/bin/env bash
# Fails if any tracked or untracked-but-not-ignored file contains personal data.
# Exit 0 = clean, 1 = hits found, 2 = the check itself could not run (fails closed).
# Generic rules always apply; extra private patterns are read from
# HERDR_UI_PRIVATE_PATTERNS (comma-separated) in .env.local when present.
# Matched private values are never printed, only file:line and a pattern index.
set -u

cd "$(git rev-parse --show-toplevel)" || exit 2

errfile=$(mktemp) || exit 2
trap 'rm -f "$errfile"' EXIT

status=0

list=$(git ls-files -co --exclude-standard) || {
  echo "check-no-personal-data: git ls-files failed" >&2
  exit 2
}

files=()
while IFS= read -r f; do
  [ -f "$f" ] && files+=("$f")
done <<< "$list"

if [ "${#files[@]}" -eq 0 ]; then
  echo "check-no-personal-data: no files to check"
  exit 0
fi

# search RULE_NAME FILTER GREP_ARGS...
# Runs grep over all files. Exit 1 (no match) is fine; exit >= 2 (bad regex, unreadable
# file, argument list too long, ...) aborts with exit 2 so the gate never reports
# "clean" after a failed search. Hits are reduced to a sorted, unique file:line list.
# FILTER is an extended regex of "file:line:match" records to ignore ("" for none).
search() {
  local rule=$1 filter=$2 out rc
  shift 2
  out=$(grep "$@" -- "${files[@]}" 2>"$errfile")
  rc=$?
  if [ "$rc" -ge 2 ]; then
    echo "check-no-personal-data: search failed for rule '$rule' (grep exit $rc)" >&2
    exit 2
  fi
  if [ -n "$filter" ] && [ -n "$out" ]; then
    out=$(printf '%s\n' "$out" | grep -vE -e "$filter")
    # grep -v exits 1 when everything was filtered out; only >= 2 is an error.
    [ $? -ge 2 ] && { echo "check-no-personal-data: filter failed for rule '$rule'" >&2; exit 2; }
  fi
  if [ -n "$out" ]; then
    echo "FAIL: $rule"
    printf '%s\n' "$out" | cut -d: -f1,2 | sort -u | sed 's/^/  /'
    status=1
  fi
}

# Home paths, judged per match so an allowed path cannot hide a real one on the same
# line. Only a bare /Users/dev or /home/dev (the generic placeholder user) is allowed.
search "home path outside /Users/dev and /home/dev" ':(/Users|/home)/dev$' \
  -noHEI '(/Users|/home)/[A-Za-z0-9._-]+'

# Anchored on the dashes of a real PEM header so docs describing the rule don't match.
search "private key block" "" -nHE -e '-----BEGIN [A-Z ]*PRIVATE KEY-----'

search "ssh public key" "" -nHE -e 'ssh-(rsa|ed25519) AAAA'

# Private patterns from .env.local (absent in CI).
if [ -f .env.local ]; then
  raw=$(grep -E '^HERDR_UI_PRIVATE_PATTERNS=' .env.local | tail -n1 | cut -d= -f2-)
  raw=${raw%\"}; raw=${raw#\"}; raw=${raw%\'}; raw=${raw#\'}
  idx=0
  IFS=',' read -r -a patterns <<< "$raw"
  for p in "${patterns[@]+"${patterns[@]}"}"; do
    p=$(printf '%s' "$p" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -z "$p" ] && continue
    idx=$((idx + 1))
    search "private pattern #$idx from .env.local" "" -nHiF -e "$p"
  done
  if [ "$idx" -eq 0 ]; then
    echo "check-no-personal-data: notice: .env.local exists but HERDR_UI_PRIVATE_PATTERNS loaded 0 patterns"
  fi
fi

if [ "$status" -eq 0 ]; then
  echo "check-no-personal-data: clean"
fi
exit "$status"
