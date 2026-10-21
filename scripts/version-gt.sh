#!/usr/bin/env bash
# Exits 0 when version <a> is strictly newer than <b>, 1 when it is equal or older, 2 on bad input.
#
# Usage: scripts/version-gt.sh <a> <b>
# Both are plain x.y.z (digits only). Each component is compared as a number, so 0.10.0 > 0.9.9.
# The release workflow's tap job uses it so an older release finishing late cannot move the
# Homebrew tap back to an older DMG.
set -euo pipefail

usage() {
  echo "version-gt: usage: version-gt.sh <x.y.z> <x.y.z>" >&2
  exit 2
}

[ $# -eq 2 ] || usage
re='^[0-9]+\.[0-9]+\.[0-9]+$'
[[ $1 =~ $re ]] && [[ $2 =~ $re ]] || usage

IFS=. read -r -a a <<<"$1"
IFS=. read -r -a b <<<"$2"
for i in 0 1 2; do
  # 10# keeps a leading zero from being read as octal.
  if ((10#${a[i]} > 10#${b[i]})); then exit 0; fi
  if ((10#${a[i]} < 10#${b[i]})); then exit 1; fi
done
exit 1
