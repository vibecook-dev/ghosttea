// Replays the pin that moved the lock from 0.13.1's Apple native artifact to
// 0.13.2's (22e25cd, written by hand) through the code that now writes it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { pinLock, pinManifest, previousRelease, provenanceNote, supersedesNote } from "../scripts/apple-native-pin.mjs";

const fixtures = join(import.meta.dirname, "fixtures/apple-native-pin");
const read = (name) => readFileSync(join(fixtures, name), "utf8");
const before = read("lock-0.13.1.json");
const after = read("lock-0.13.2.json");
const candidate = JSON.parse(read("candidate-0.13.2.json"));

test("a pin with the hand-written notes reproduces the 0.13.2 lock byte for byte", () => {
  const { supersedes, provenance } = JSON.parse(after).notes;
  assert.equal(pinLock(before, candidate, { today: "2026-10-23", supersedes, provenance }), after);
});

test("a pin moves Package.swift's URL and checksum and nothing else", () => {
  assert.equal(pinManifest(read("Package-0.13.1.swift"), JSON.parse(before), candidate), read("Package-0.13.2.swift"));
});

test("the generated notes name the superseded artifact, what moved, and the publishing run", () => {
  const lock = JSON.parse(before);
  const previous = previousRelease(lock.notes.provenance);
  assert.deepEqual(previous, { sourceCommit: "ccfb3e4ad4163d6e3e653361d9f2fa1bbf063331", version: "0.13.1" });

  const supersedes = supersedesNote({
    tag: lock.tag,
    version: previous.version,
    sourceDigest: lock.sourceDigest,
    nextSourceDigest: candidate.sourceDigest,
    changedInputs: ["Cargo.lock", "Cargo.toml", "native/ghosttea/Cargo.toml"],
  });
  assert.match(supersedes, /^ghosttea-apple-native-6c5898e91c6a, the 0\.13\.1 artifact\. /);
  assert.match(supersedes, / moved from fa08d01917c5 to 0c9f828ea677 through Cargo\.lock, Cargo\.toml, and native/);

  const provenance = provenanceNote({
    runUrl: "https://github.com/vibecook-dev/ghosttea/actions/runs/1",
    sourceCommit: "8263cf09ac56782124f71168d3e8e15d49bdf9ad",
    branch: "release/0.13.2",
    attestationUrl: "https://github.com/vibecook-dev/ghosttea/attestations/2",
    checksum: candidate.checksum,
  });
  assert.deepEqual(previousRelease(provenance), {
    sourceCommit: "8263cf09ac56782124f71168d3e8e15d49bdf9ad",
    version: "0.13.2",
  });

  const pinned = pinLock(before, candidate, { today: "2026-10-25", supersedes, provenance });
  const parsed = JSON.parse(pinned);
  for (const [field, value] of Object.entries(candidate)) assert.deepEqual(parsed[field], value, field);
  assert.match(parsed.notes.checksum, /Verified equal on 2026-10-25\./);
  assert.match(parsed.notes.verification, /Last confirmed 2026-10-25,/);
  assert.equal(parsed.notes.supersedes, supersedes);
  assert.equal(parsed.notes.provenance, provenance);
  for (const key of ["contentDigest", "tag", "sourceDigest"]) assert.equal(parsed.notes[key], lock.notes[key], key);
  assert.deepEqual(parsed.producedBy, lock.producedBy);
  assert.match(pinned, /"sourceLocks": \["native\/ghostty\.lock\.json", /);
});

test("--needed answers from this tree's digest and writes the step output", () => {
  const output = join(mkdtempSync(join(tmpdir(), "ghosttea-pin-")), "github-output");
  const stdout = execFileSync(process.execPath, ["scripts/pin-ghosttea-apple-native.mjs", "--needed"], {
    cwd: join(import.meta.dirname, ".."),
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: output },
  });
  assert.match(stdout, /^The (native sources hash to|pinned artifact was built from) /);
  assert.match(readFileSync(output, "utf8"), /^needed=(true|false)\n$/);
});

test("a pin refuses what it cannot write in place", () => {
  const extraSlice = { ...candidate, slices: { ...candidate.slices, "macos-x86_64/libghosttea-apple-native.a": "0" } };
  assert.throws(() => pinLock(before, extraSlice, { today: "2026-10-25", supersedes: "", provenance: "" }), /slices/);
  assert.throws(
    () => pinManifest(read("Package-0.13.2.swift"), JSON.parse(before), candidate),
    /exactly one appleNativeURL/,
  );
});
