#!/usr/bin/env bash
set -euo pipefail

# Creates the GitHub release for a tag, once. This exists because a release was
# the one publishing step nothing performed: the workflow uploaded 0.4.0 to both
# registries and the release page kept showing 0.3.0, because creating it was a
# manual step someone had to remember.
#
# Safe to rerun, like the registry publishers beside it: an existing release is
# left exactly as it is, so a rerun after a partial failure never overwrites
# notes that were edited by hand.

tag="${1:?tag name is required}"
version="${tag#v}"

if gh release view "$tag" >/dev/null 2>&1; then
  echo "release $tag already exists; skipping"
  exit 0
fi

# Fails closed when CHANGELOG.md has no section for this version, rather than
# publishing a release that describes nothing.
notes="$(node "$(dirname "$0")/release-notes.mjs" "$version")"

# A patch on an older line leaves Latest on the newest line
# (scripts/release-channel.mjs). Without a tag, `gh release view` reads the
# current Latest.
current="$(gh release view --json tagName --jq .tagName 2>/dev/null || true)"
latest_flag="$(node "$(dirname "$0")/release-channel.mjs" github-latest "$version" "$current")"

gh release create "$tag" --title "Ghosttea ${version}" "$latest_flag" --notes "$notes"
echo "created release $tag"
