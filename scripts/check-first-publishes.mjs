// Every publishable artifact must already exist on its registry before a
// release tag is pushed.
//
// Trusted publishing can add a version to something that exists; it cannot
// bring an artifact into being. crates.io refuses with "Trusted Publishing
// tokens do not support creating new crates. Publish the crate manually,
// first" — and it refuses at the moment the release is already half uploaded,
// because that is the first time anything asks. 0.7.0 shipped `ghosttea-config`
// for the first time and found this out between `ghosttea-vt` and
// `ghosttea-core`, leaving a broken run and a retry tag behind it.
//
// So this asks the registries the question the workflow only asks too late.
// It is a pre-tag gate rather than a CI step: it needs the network and it
// reads registry state, neither of which belongs in `ci:desktop`.
//
// A missing *version* is not a finding. That is what a release is for. The
// only finding is an artifact the registry has never heard of.
//
// usage: node scripts/check-first-publishes.mjs
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { publishedCrates, publishedPackages } from "./release-notes.mjs";

const root = resolve(import.meta.dirname, "..");
const workflow = readFileSync(join(root, ".github/workflows/publish-release.yml"), "utf8");

/**
 * The artifacts a release actually uploads, according to the workflow that
 * uploads them.
 *
 * The manifests are the authority on what publishes, and `release-notes.mjs`
 * already derives that; this derives the same thing from the other end, so a
 * crate that exists in one place and not the other cannot hide behind a list
 * maintained twice. That is the shape of the bug this file exists for.
 */
function workflowPublishes(script) {
  const pattern = new RegExp(String.raw`scripts/${script}\s+(\S+)`, "g");
  return [...workflow.matchAll(pattern)].map((match) => match[1]).sort();
}

function requireSameArtifacts(label, declared, published) {
  const missing = declared.filter((name) => !published.includes(name));
  const extra = published.filter((name) => !declared.includes(name));
  if (missing.length === 0 && extra.length === 0) return;
  console.error(`The ${label} the manifests declare are not the ones the release workflow publishes:\n`);
  for (const name of missing) console.error(`  - ${name} publishes, but publish-release.yml never uploads it`);
  for (const name of extra)
    console.error(`  - ${name} is uploaded by publish-release.yml, but no manifest publishes it`);
  console.error("\nReconcile them before tagging; until then neither list describes the release.");
  process.exit(1);
}

/**
 * Whether a registry has ever held this artifact, under the only two answers
 * worth acting on. Anything else — a rate limit, a proxy, an outage — is
 * reported rather than read as an absence, because "the registry did not say
 * yes" is exactly the false negative that would wave a first publish through.
 */
async function registryHolds(url, headers = {}) {
  let response;
  try {
    response = await fetch(url, { headers: { accept: "application/json", ...headers } });
  } catch (error) {
    throw new Error(`could not reach ${url}: ${error.message}`, { cause: error });
  }
  if (response.status === 404) return false;
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status} ${response.statusText}`);
  }
  return response.json();
}

// crates.io blocks requests that do not identify themselves, and a 403 here
// would otherwise look exactly like a registry that is up.
const cratesHeaders = { "user-agent": "ghosttea-release-gate (https://github.com/vibecook-dev/ghosttea)" };

async function crateExists(name) {
  const body = await registryHolds(`https://crates.io/api/v1/crates/${encodeURIComponent(name)}`, cratesHeaders);
  return body !== false;
}

async function packageExists(name) {
  const body = await registryHolds(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
  // A package whose every version was unpublished answers 200 with nothing in
  // it. The registry remembers the name; a trusted publisher still cannot
  // populate it, so this counts as never published.
  return body !== false && Object.keys(body.versions ?? {}).length > 0;
}

const crates = publishedCrates();
const packages = publishedPackages();
requireSameArtifacts("crates", crates, workflowPublishes("publish-crate-if-missing.sh"));
// The npm packages have no second list to reconcile: the workflow runs one
// publisher without arguments, and it publishes `publishedPackages()`, the
// manifests' own answer. What can still drift is the workflow calling it.
if (!/^\s*run: node scripts\/publish-npm-packages\.mjs\s*$/m.test(workflow)) {
  console.error(
    "publish-release.yml does not run `node scripts/publish-npm-packages.mjs` without arguments, " +
      "so it would not publish every npm package the manifests declare.",
  );
  process.exit(1);
}

// Sequentially, and deliberately: crates.io rate-limits its API, and a gate
// that trips that limit reports an outage instead of an answer.
const unpublished = [];
for (const name of crates) {
  if (await crateExists(name)) continue;
  unpublished.push(`crates.io has no crate named ${name}`);
}
for (const name of packages) {
  if (await packageExists(name)) continue;
  unpublished.push(`npm has no package named ${name}`);
}

if (unpublished.length > 0) {
  console.error("A release tag would fail: these artifacts have never been published.\n");
  for (const finding of unpublished) console.error(`  - ${finding}`);
  console.error(
    [
      "",
      "Trusted publishing cannot create an artifact, only add a version to one",
      "that exists. crates.io rejects the attempt with:",
      "",
      "  Trusted Publishing tokens do not support creating new crates. Publish the crate manually, first",
      "",
      "and it rejects it mid-release, after earlier artifacts have already",
      "uploaded — leaving a tag that can never be reused.",
      "",
      'Publish each artifact above by hand first, following "First manual publish"',
      "in PUBLISHING.md, then configure its trusted publisher. Only then push the tag.",
    ].join("\n"),
  );
  process.exit(1);
}

console.log(
  `Ghosttea first-publish check passed (${crates.length} crates and ${packages.length} npm packages already exist on their registries)`,
);
