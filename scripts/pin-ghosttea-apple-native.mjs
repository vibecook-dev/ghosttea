// Answers whether a release branch needs a new Apple native artifact, or pins
// the one ghosttea-apple-native-artifact.yml just published.
//
//   node scripts/pin-ghosttea-apple-native.mjs --needed
//   node scripts/pin-ghosttea-apple-native.mjs <candidate .zip.json> --run-url <url> \
//     --attestation-url <url> --source-commit <sha> --branch <name>
//
// --needed compares this tree's native source digest with the pinned one and
// writes `needed=true|false` to GITHUB_OUTPUT when it is set. A pin refuses a
// candidate that was not built from this tree, then rewrites the lock and
// Package.swift in place (scripts/apple-native-pin.mjs).
import { execFileSync } from "node:child_process";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { pinLock, pinManifest, previousRelease, provenanceNote, supersedesNote } from "./apple-native-pin.mjs";
import { lockPath, nativeSourceDigest, nativeSourceInputs, root } from "./ghosttea-apple-native-artifact.mjs";

const manifestPath = join(root, "Package.swift");
const [first, ...rest] = process.argv.slice(2);

function option(name) {
  const index = rest.indexOf(name);
  const value = index === -1 ? undefined : rest[index + 1];
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

/** The native source inputs that changed since `sourceCommit`, in the digest's own order. */
function changedInputs(sourceCommit) {
  if (!sourceCommit) return [];
  const args = ["diff", "--name-only", sourceCommit, "HEAD", "--", ...nativeSourceInputs];
  let output;
  try {
    output = execFileSync("git", args, { cwd: root, encoding: "utf8" });
  } catch {
    // A shallow checkout without that commit: the note just omits the list.
    return [];
  }
  const paths = output.split("\n").filter(Boolean);
  const touches = (input) => paths.some((path) => path === input || path.startsWith(`${input}/`));
  return nativeSourceInputs.filter(touches);
}

if (first === "--needed") {
  const tree = nativeSourceDigest();
  const { sourceDigest } = JSON.parse(readFileSync(lockPath, "utf8"));
  const needed = tree !== sourceDigest;
  const message = needed
    ? `The native sources hash to ${tree}, but the pinned artifact was built from ${sourceDigest}.`
    : `The pinned artifact was built from these native sources (${tree}).`;
  console.log(message);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `needed=${needed}\n`);
  process.exit(0);
}

if (!first) throw new Error("Pass the candidate's .zip.json, or --needed.");
const candidate = JSON.parse(readFileSync(first, "utf8"));
const tree = nativeSourceDigest();
if (candidate.sourceDigest !== tree) {
  throw new Error(`The candidate was built from ${candidate.sourceDigest}, but this tree hashes to ${tree}.`);
}

const lockText = readFileSync(lockPath, "utf8");
const lock = JSON.parse(lockText);
if (lock.tag === candidate.tag) {
  console.log(`The lock already pins ${candidate.tag}.`);
  process.exit(0);
}

const previous = previousRelease(lock.notes.provenance);
const notes = {
  today: new Date().toISOString().slice(0, 10),
  supersedes: supersedesNote({
    tag: lock.tag,
    version: previous.version,
    sourceDigest: lock.sourceDigest,
    nextSourceDigest: candidate.sourceDigest,
    changedInputs: changedInputs(previous.sourceCommit),
  }),
  provenance: provenanceNote({
    runUrl: option("--run-url"),
    sourceCommit: option("--source-commit"),
    branch: option("--branch"),
    attestationUrl: option("--attestation-url"),
    checksum: candidate.checksum,
  }),
};

// Both files are computed before either is written, so a refused pin leaves the
// tree as it was.
const pinnedLock = pinLock(lockText, candidate, notes);
const pinnedManifest = pinManifest(readFileSync(manifestPath, "utf8"), lock, candidate);
writeFileSync(lockPath, pinnedLock);
writeFileSync(manifestPath, pinnedManifest);
console.log(`Pinned ${candidate.tag} (sha256 ${candidate.checksum}), superseding ${lock.tag}.`);
