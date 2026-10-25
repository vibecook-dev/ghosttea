// The pin commit that follows an Apple native artifact publication.
//
// A release used to pin its artifact by hand: copy the served identity into
// apple-native-artifact.lock.json, move Package.swift's URL and checksum, and
// rewrite the lock's dated notes. ghosttea-apple-native-artifact.yml now does it
// after publishing, through scripts/pin-ghosttea-apple-native.mjs. Values are
// replaced in place rather than re-serialised, so a pin changes exactly the
// lines a hand-written one did. Nothing here touches the filesystem or git.

/** The fields the packager writes, which a pin copies into the lock verbatim. */
export const identityFields = [
  "schemaVersion",
  "binaryTarget",
  "bundleName",
  "tag",
  "filename",
  "url",
  "checksum",
  "size",
  "contentDigest",
  "sourceDigest",
  "entries",
  "slices",
];

const isoDate = /\d{4}-\d{2}-\d{2}/;

function replaceOnce(text, from, to, what) {
  const at = text.indexOf(from);
  if (at === -1 || text.indexOf(from, at + 1) !== -1) {
    throw new Error(`Expected exactly one ${what} to replace, found ${at === -1 ? "none" : "several"}.`);
  }
  return `${text.slice(0, at)}${to}${text.slice(at + from.length)}`;
}

function replaceValue(text, key, before, after) {
  const field = (value) => `"${key}": ${JSON.stringify(value)}`;
  if (field(before) === field(after)) return text;
  return replaceOnce(text, field(before), field(after), `"${key}" value`);
}

function redate(note, phrase, today) {
  return note.replace(new RegExp(`${phrase} ${isoDate.source}`), `${phrase} ${today}`);
}

function listOf(items) {
  if (items.length <= 2) return items.join(" and ");
  return `${items.slice(0, -1).join(", ")}, and ${items.at(-1)}`;
}

/**
 * The lock after pinning `candidate`, the packager's `.zip.json` for the
 * published archive. `supersedes` and `provenance` describe this publication;
 * the two dated notes move to `today`.
 */
export function pinLock(lockText, candidate, { today, supersedes, provenance }) {
  const lock = JSON.parse(lockText);
  const slices = (value) => Object.keys(value).join("\n");
  if (slices(lock.slices) !== slices(candidate.slices)) {
    throw new Error("The artifact's slices changed, so this pin has to be written by hand.");
  }

  let text = lockText;
  for (const field of identityFields) {
    if (field !== "slices") text = replaceValue(text, field, lock[field], candidate[field]);
  }
  for (const [slice, digest] of Object.entries(candidate.slices)) {
    text = replaceValue(text, slice, lock.slices[slice], digest);
  }
  const notes = {
    checksum: redate(lock.notes.checksum, "Verified equal on", today),
    verification: redate(lock.notes.verification, "Last confirmed", today),
    supersedes,
    provenance,
  };
  for (const [key, note] of Object.entries(notes)) text = replaceValue(text, key, lock.notes[key], note);

  const identity = Object.fromEntries(identityFields.map((field) => [field, candidate[field]]));
  const expected = { ...lock, ...identity, notes: { ...lock.notes, ...notes } };
  if (JSON.stringify(JSON.parse(text)) !== JSON.stringify(expected)) {
    throw new Error("The edited lock does not parse to the intended pin.");
  }
  return text;
}

/** Package.swift after moving its binary target from the lock's artifact to `candidate`. */
export function pinManifest(manifestText, lock, candidate) {
  const moved = replaceOnce(manifestText, `"${lock.url}"`, `"${candidate.url}"`, "appleNativeURL");
  return replaceOnce(moved, `"${lock.checksum}"`, `"${candidate.checksum}"`, "appleNativeChecksum");
}

/** What the outgoing pin's provenance note records about the build it pinned. */
export function previousRelease(provenance) {
  return {
    sourceCommit: provenance.match(/source commit ([0-9a-f]{40})/)?.[1],
    version: provenance.match(/\(release\/(\d+\.\d+\.\d+)\)/)?.[1],
  };
}

/** The `supersedes` note: which artifact this one replaces, and what moved the digest. */
export function supersedesNote({ tag, version, sourceDigest, nextSourceDigest, changedInputs }) {
  const artifact = version ? `the ${version} artifact` : "the artifact pinned before it";
  const through = changedInputs.length > 0 ? ` through ${listOf(changedInputs)}` : "";
  const from = sourceDigest.slice(0, 12);
  const to = nextSourceDigest.slice(0, 12);
  return [
    `${tag}, ${artifact}.`,
    `The native source digest moved from ${from} to ${to}${through},`,
    "so the release sources require a new immutable publication rather than a field-only update.",
  ].join(" ");
}

/** The `provenance` note: the run, commit, branch and attestation behind the pinned bytes. */
export function provenanceNote({ runUrl, sourceCommit, branch, attestationUrl, checksum }) {
  return [
    `Built, qualified, attested, and published by ghosttea-apple-native-artifact.yml run ${runUrl}`,
    `from clean source commit ${sourceCommit} (${branch}), promoted through the release environment,`,
    "and pinned by the same run.",
    `Attestation: ${attestationUrl} (subject sha256:${checksum}).`,
  ].join(" ");
}
