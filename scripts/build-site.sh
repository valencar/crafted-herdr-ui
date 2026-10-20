#!/usr/bin/env bash
# Builds the project site (site/) into _site/ for GitHub Pages.
#
# Usage: scripts/build-site.sh [version]
# Every {{VERSION}} in the HTML becomes <version> (no leading "v"), which names the release whose
# DMG the Download buttons link to. The Pages workflow passes the latest published release, so the
# site never links a DMG that isn't public yet. Without an argument, the version in package.json is
# used, for a local preview: python3 -m http.server -d _site
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"

version=${1:-$(node -p "require('./package.json').version")}
version=${version#v}
if ! [[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "build-site: '$version' is not a release version (x.y.z)" >&2
  exit 1
fi

rm -rf _site
cp -R site _site
find _site -name '*.html' -exec sed -i.bak "s/{{VERSION}}/$version/g" {} +
find _site -name '*.bak' -delete

if grep -rl '{{' _site --include='*.html'; then
  echo "build-site: unreplaced placeholders in the files above" >&2
  exit 1
fi

echo "build-site: _site/ built for v$version"
