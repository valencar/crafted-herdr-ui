#!/usr/bin/env bash
# Renders the Homebrew cask for a release to stdout.
#
# Usage: scripts/render-cask.sh <version> <sha256>
# <version> is x.y.z with no leading "v" and no prerelease suffix; <sha256> is the 64 lowercase hex
# characters of the universal DMG. The template (packaging/homebrew/crafted-herdr.rb) has its
# {{VERSION}} and {{SHA256}} placeholders replaced. Exits 1 with a message on stderr for a bad
# argument or when any placeholder survives. The release workflow and the tap bootstrap call this.
set -euo pipefail

# Locate the repo from this script's own path, so it runs from any directory.
cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [ $# -ne 2 ]; then
  echo "render-cask: usage: render-cask.sh <version> <sha256>" >&2
  exit 1
fi
version=$1
sha=$2

if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "render-cask: '$version' is not a release version (x.y.z, no leading v, no hyphen)" >&2
  exit 1
fi
if ! [[ $sha =~ ^[0-9a-f]{64}$ ]]; then
  echo "render-cask: '$sha' is not a sha256 (64 lowercase hex characters)" >&2
  exit 1
fi

rendered=$(sed -e "s/{{VERSION}}/$version/g" -e "s/{{SHA256}}/$sha/g" packaging/homebrew/crafted-herdr.rb)

if grep -q '{{' <<<"$rendered"; then
  echo "render-cask: unreplaced placeholders in the template" >&2
  exit 1
fi

printf '%s\n' "$rendered"
