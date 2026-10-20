#!/usr/bin/env bash
set -euo pipefail

package="${1:?npm package name is required}"
version="$(node -p "require('./package.json').version")"

wait_until_resolvable() {
  for _ in {1..60}; do
    if npm view "${package}@${version}" version >/dev/null 2>&1; then
      return 0
    fi
    sleep 2
  done
  return 1
}

if npm view "${package}@${version}" version >/dev/null 2>&1; then
  echo "${package}@${version} is already published; skipping"
  exit 0
fi

publish_args=(publish --workspace "$package" --access public)

# A patch on an older line publishes beside the newest line's `latest`, never
# over it (scripts/release-channel.mjs). A failed lookup reads as a package the
# registry does not hold yet; for an older line npm then refuses the implicit
# `latest`, and a rerun resumes here.
latest="$(npm view "$package" dist-tags.latest 2>/dev/null || true)"
dist_tag="$(node "$(dirname "$0")/release-channel.mjs" npm-tag "$version" "$latest")"
publish_args+=(--tag "$dist_tag")

provenance="${NPM_CONFIG_PROVENANCE:-${npm_config_provenance:-}}"
if [[ "$provenance" == "false" || "$provenance" == "0" ]]; then
  publish_args+=(--provenance=false)
fi

npm "${publish_args[@]}"

if wait_until_resolvable; then
  echo "verified ${package}@${version} on npm"
  exit 0
fi

echo "timed out waiting for ${package}@${version} to become resolvable" >&2
exit 1
