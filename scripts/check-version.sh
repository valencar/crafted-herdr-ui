#!/usr/bin/env bash
# Fails unless the app's three version fields all equal the release tag without its leading "v".
#
# Usage: scripts/check-version.sh <tag> [repo-root]
# Reads src-tauri/tauri.conf.json, package.json and the [package] version in src-tauri/Cargo.toml.
# The release workflow runs it first, so a tag that doesn't match the code stops before anything is
# built or published (a mismatch would name the DMG differently from the cask and the site link).
# [repo-root] defaults to the repo this script lives in; it exists so the test can use a temp copy.
set -euo pipefail

if [ $# -lt 1 ] || [ $# -gt 2 ]; then
  echo "check-version: usage: check-version.sh <tag> [repo-root]" >&2
  exit 1
fi
tag=$1
root=${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}
want="${tag#v}"

json_version() {
  node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).version ?? ""))' "$1"
}

# The first `version = "…"` line after [package] and before the next table.
cargo_version() {
  awk '
    /^\[package\]/ { in_pkg = 1; next }
    /^\[/ { in_pkg = 0 }
    in_pkg && /^version[[:space:]]*=/ { gsub(/^[^"]*"|".*$/, ""); print; exit }
  ' "$1"
}

status=0
check() {
  local file=$1 have=$2
  if [ "$have" != "$want" ]; then
    echo "check-version: $file has version '$have', but the tag $tag needs '$want'" >&2
    status=1
  fi
}

check src-tauri/tauri.conf.json "$(json_version "$root/src-tauri/tauri.conf.json")"
check package.json "$(json_version "$root/package.json")"
check src-tauri/Cargo.toml "$(cargo_version "$root/src-tauri/Cargo.toml")"

if [ "$status" -eq 0 ]; then echo "All versions match $tag."; fi
exit "$status"
