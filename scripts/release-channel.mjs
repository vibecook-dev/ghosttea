// Which channel a release publishes to: the newest line's, or its own.
//
// Every release used to be the newest one, so the publish steps let npm apply
// `latest` and marked the GitHub release Latest. A patch on an older line —
// 0.10.2 after 0.12.0 — must do neither. npm 11 refuses to apply `latest`
// implicitly to a version below it, which would fail the publish job after
// every crate had already uploaded; and a Latest GitHub release would point
// readers at the older line. So an older line publishes under its own npm
// dist-tag and leaves GitHub's Latest where it is. crates.io and SwiftPM need
// nothing: both resolve the highest version.

const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-[0-9A-Za-z.-]+)?$/;

function core(version) {
  const match = VERSION.exec(version);
  if (!match) throw new Error(`not a release version: ${JSON.stringify(version)}`);
  return match.slice(1, 4).map(Number);
}

/** Whether `version` sorts below `other`, comparing major, minor and patch as numbers. */
function isOlder(version, other) {
  const [a, b] = [core(version), core(other)];
  const differs = a.findIndex((part, index) => part !== b[index]);
  return differs >= 0 && a[differs] < b[differs];
}

/**
 * The npm dist-tag `version` publishes under, given the registry's current
 * `latest` for the package (empty when the registry does not hold it yet).
 */
export function npmDistTag(version, latest) {
  if (!latest || !isOlder(version, latest)) return "latest";
  const [major, minor] = core(version);
  // Not `0.10`: npm rejects a dist-tag that parses as a semver range.
  return `release-${major}.${minor}`;
}

/**
 * The `gh release create` flag for `version`, given the tag of the
 * repository's current Latest release (empty when it has none).
 */
export function githubLatestFlag(version, latestTag) {
  const latest = (latestTag ?? "").replace(/^v/, "");
  return latest && VERSION.test(latest) && isOlder(version, latest) ? "--latest=false" : "--latest";
}

// Importable for tests; prints when run directly.
if (process.argv[1] === import.meta.filename) {
  const [command, version, current = ""] = process.argv.slice(2);
  const choose = { "npm-tag": npmDistTag, "github-latest": githubLatestFlag }[command];
  if (!choose) throw new Error("usage: release-channel.mjs npm-tag|github-latest VERSION [CURRENT]");
  process.stdout.write(`${choose(version, current)}\n`);
}
