#!/usr/bin/env bash
# Fails (exit 1) if any tracked or untracked-but-not-ignored file contains
# personal data. Generic rules always apply; extra private patterns are read
# from HERDR_UI_PRIVATE_PATTERNS (comma-separated) in .env.local when present.
# Matched private values are never printed, only the file and a pattern index.
set -u

cd "$(git rev-parse --show-toplevel)" || exit 2

self="scripts/check-no-personal-data.sh"
status=0
hits=""

files=()
while IFS= read -r f; do
  [ -f "$f" ] && [ "$f" != "$self" ] && files+=("$f")
done < <(git ls-files -co --exclude-standard)

if [ "${#files[@]}" -eq 0 ]; then
  echo "check-no-personal-data: no files to check"
  exit 0
fi

# Generic rules (extended regex, case-sensitive for the home-path and key rules).
# Takes a rule name and a "file:line" list; prints and flags a failure if non-empty.
report() {
  if [ -n "$2" ]; then
    echo "FAIL: $1"
    echo "$2" | sed 's/^/  /'
    status=1
  fi
}

# Home paths other than /Users/dev/ and /home/dev/.
hits=$(grep -nHEI '(/Users|/home)/[A-Za-z0-9._-]+/' -- "${files[@]}" 2>/dev/null \
  | grep -vE ':[^:]*(/Users|/home)/dev/' | cut -d: -f1,2)
report "home path outside /Users/dev and /home/dev" "$hits"

# Anchored on the dashes of a real PEM header so docs describing the rule don't match.
hits=$(grep -nHE -e '-----BEGIN [A-Z ]*PRIVATE KEY-----' -- "${files[@]}" 2>/dev/null | cut -d: -f1,2)
report "private key block" "$hits"

hits=$(grep -nHE 'ssh-(rsa|ed25519) AAAA' -- "${files[@]}" 2>/dev/null | cut -d: -f1,2)
report "ssh public key" "$hits"

# Private patterns from .env.local (absent in CI).
if [ -f .env.local ]; then
  raw=$(grep -E '^HERDR_UI_PRIVATE_PATTERNS=' .env.local | tail -n1 | cut -d= -f2-)
  raw=${raw%\"}; raw=${raw#\"}; raw=${raw%\'}; raw=${raw#\'}
  idx=0
  IFS=',' read -r -a patterns <<< "$raw"
  for p in "${patterns[@]+"${patterns[@]}"}"; do
    p=$(echo "$p" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
    [ -z "$p" ] && continue
    idx=$((idx + 1))
    hits=$(grep -nHiF -e "$p" -- "${files[@]}" 2>/dev/null | cut -d: -f1,2)
    report "private pattern #$idx from .env.local" "$hits"
  done
fi

if [ "$status" -eq 0 ]; then
  echo "check-no-personal-data: clean"
fi
exit "$status"
