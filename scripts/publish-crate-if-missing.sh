#!/usr/bin/env bash
set -euo pipefail

crate="${1:?crate name is required}"
version="$(node -p "require('./package.json').version")"
registry_url="https://crates.io/api/v1/crates/${crate}/${version}"
registry_user_agent="ghosttea-release/${version} (https://github.com/vibecook-dev/ghosttea)"

# A registry accepts an upload before it serves it: npm took as long as 4m 09s
# to serve a 0.12.0 package (see scripts/publish-npm-packages.mjs). crates.io
# has been quicker, but a timeout here fails the release behind another
# approval, so both publishers share one generous budget.
visibility_timeout_minutes="${REGISTRY_VISIBILITY_TIMEOUT_MINUTES:-20}"
if [[ ! "$visibility_timeout_minutes" =~ ^[1-9][0-9]*$ ]]; then
  echo "REGISTRY_VISIBILITY_TIMEOUT_MINUTES must be a whole number of minutes, not '${visibility_timeout_minutes}'" >&2
  exit 1
fi

wait_until_resolvable() {
  local deadline=$((SECONDS + visibility_timeout_minutes * 60))
  until curl --fail --silent --show-error --user-agent "$registry_user_agent" "$registry_url" >/dev/null 2>&1 &&
    cargo info --registry crates-io "${crate}@${version}" >/dev/null 2>&1; do
    if ((SECONDS >= deadline)); then
      return 1
    fi
    sleep 5
  done
}

if curl --fail --silent --show-error --user-agent "$registry_user_agent" "$registry_url" >/dev/null 2>&1; then
  if wait_until_resolvable; then
    echo "${crate}@${version} is already published and resolvable; skipping"
    exit 0
  fi
  echo "timed out after ${visibility_timeout_minutes} minutes waiting for ${crate}@${version} to become resolvable" >&2
  exit 1
fi

cargo publish --locked --package "$crate"

if wait_until_resolvable; then
  echo "verified ${crate}@${version} on crates.io and through Cargo"
  exit 0
fi

echo "timed out after ${visibility_timeout_minutes} minutes waiting for ${crate}@${version} to become resolvable" >&2
exit 1
