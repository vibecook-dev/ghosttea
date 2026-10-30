// Shared identity for the published GhostteaAppleNative binary target.
//
// The packager and the drift check must agree on three things or the published
// asset stops resolving: what bytes go into the archive, what the archive is
// called, and which release tag carries it. They live here so neither can drift
// from the other.
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, posix, resolve } from "node:path";

import { pathDependencies, workspacePathDependencies } from "./cargo-path-dependencies.mjs";

export const root = resolve(import.meta.dirname, "..");

export const repository = "https://github.com/vibecook-dev/ghosttea";

// The directory this artifact has on disk. It is a build output of
// `scripts/build-ghosttea-apple-native.mjs` and stays gitignored.
export const sourceArtifact = join(root, "apple/GhostteaKit/Artifacts/ghosttea-apple-native.xcframework");

// The name the artifact takes *inside* the archive, which is not the same as
// its name on disk. A URL binary target makes SwiftPM look for a bundle named
// after the target — `GhostteaAppleNative.xcframework` — and fail the whole
// package graph if it is absent. Renaming the top directory is safe: the
// xcframework's Info.plist addresses its slices by LibraryIdentifier and
// LibraryPath, never by the bundle's own name.
export const binaryTargetName = "GhostteaAppleNative";
export const bundleName = `${binaryTargetName}.xcframework`;
export const archiveName = `${bundleName}.zip`;

export const lockPath = join(root, "apple/GhostteaKit/Compatibility/apple-native-artifact.lock.json");
export const outputDirectory = join(root, "artifacts/apple-native");

export function readLock() {
  return JSON.parse(readFileSync(lockPath, "utf8"));
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Every entry of the artifact tree, sorted, with the archive-relative path it
 * will carry.
 *
 * Modes are normalised to the executable bit alone. The real mode carries the
 * packaging machine's umask, which would otherwise make the content digest a
 * property of the machine rather than of the artifact.
 */
export function collectEntries(directory = sourceArtifact, prefix = bundleName) {
  const entries = [];

  const walk = (absolute, relative) => {
    for (const child of readdirSync(absolute, { withFileTypes: true }).toSorted((left, right) =>
      compareText(left.name, right.name),
    )) {
      const childAbsolute = join(absolute, child.name);
      const childRelative = `${relative}/${child.name}`;
      if (child.isSymbolicLink()) {
        // The composer emits a flat tree. A symlink would need a mode and a
        // link target in both the digest and the archive, so refuse rather than
        // silently follow it into a wrong or duplicated artifact.
        throw new Error(`Unexpected symlink in the artifact tree: ${childRelative}`);
      }
      if (child.isDirectory()) {
        entries.push({ path: `${childRelative}/`, kind: "directory", mode: 0o755 });
        walk(childAbsolute, childRelative);
      } else if (child.isFile()) {
        const contents = readFileSync(childAbsolute);
        entries.push({
          path: childRelative,
          kind: "file",
          mode: statSync(childAbsolute).mode & 0o111 ? 0o755 : 0o644,
          contents,
        });
      } else {
        throw new Error(`Unsupported entry in the artifact tree: ${childRelative}`);
      }
    }
  };

  entries.push({ path: `${prefix}/`, kind: "directory", mode: 0o755 });
  walk(directory, prefix);
  return entries.toSorted((left, right) => compareText(left.path, right.path));
}

/**
 * A digest of what the artifact *contains*, independent of how it is archived.
 *
 * The zip's own SHA-256 is the checksum SwiftPM enforces, but it also depends on
 * the compressor. This digest depends only on paths, modes, and file bytes, so
 * it stays comparable across machines and zlib versions and is what the drift
 * check can honestly re-derive from a local build.
 */
export function contentDigest(entries) {
  const inventory = entries
    .map((entry) =>
      entry.kind === "directory"
        ? `${entry.path}\0dir\0${entry.mode.toString(8)}\n`
        : `${entry.path}\0file\0${entry.mode.toString(8)}\0${sha256(entry.contents)}\0${entry.contents.length}\n`,
    )
    .join("");
  return sha256(Buffer.from(inventory));
}

export function sha256(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * The release tag is content-addressed, and that is load-bearing rather than
 * tidy. `.binaryTarget(url:checksum:)` needs a checksum that is already valid at
 * the commit SwiftPM resolves, but a release asset is built *after* its release
 * commit — so an artifact keyed to the release version could never carry a valid
 * checksum at its own tag. Keying the tag to the content removes the ordering
 * problem: the artifact is published once, and every later ghosttea tag points
 * at bytes that already exist.
 */
export function releaseTag(digest) {
  return `ghosttea-apple-native-${digest.slice(0, 12)}`;
}

export function downloadUrl(tag) {
  return `${repository}/releases/download/${tag}/${archiveName}`;
}

/** Per-slice binary digests, the executable-level record kept in the lock. */
export function sliceDigests(entries) {
  return Object.fromEntries(
    entries
      .filter((entry) => entry.kind === "file" && entry.path.endsWith(".a"))
      .map((entry) => [entry.path.slice(`${bundleName}/`.length), sha256(entry.contents)]),
  );
}

export function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/**
 * The inputs that determine what the artifact contains.
 *
 * The archive's own digests answer "are these the bytes we published". They
 * cannot answer "were these bytes built from the source we ship", because a
 * digest computed from a stale build agrees with a lock written from that same
 * stale build — the comparison is circular. That is not hypothetical: 0.6.2's
 * key-encoder and cursor fixes live in `ghostty_shim.c`, which compiles into
 * every slice, and every gate stayed green against the previous artifact.
 *
 * So the lock records a digest of these paths too, and the check recomputes it
 * from the working tree.
 *
 * The set covers only inputs whose staleness is *undetectable* by hashing the
 * archive: the Rust crates compiled into the core and font-fixture libraries, the
 * pins fixing the vendored Ghostty and libssh2 inputs, and the scripts that
 * compile and compose them.
 *
 * The crates are listed by hand, so the list is checked against what links:
 * `uncoveredAppleNativeCrates()` walks the path dependencies from
 * ghosttea-apple-ffi, and check-apple-native-artifact.mjs fails on any crate the
 * list misses. ghosttea-config, which ghosttea-ffi links, was missing through
 * 0.13.2, so a change to it alone would have shipped a stale artifact unnoticed.
 *
 * It deliberately omits the packaging and identity scripts, even though they
 * decide how the artifact is archived and digested. A change there is already
 * caught, and caught better: the checks re-derive the content digest and the
 * archive checksum from the published bytes, so altered archiving or digesting
 * makes the re-derived values disagree with the lock. Freshness only has to cover
 * what re-derivation cannot see. Keeping them out also keeps an edit to a comment
 * in this file from demanding a republish.
 *
 * A mismatch here means a republish, not merely a new field. The Apple build is
 * not byte-reproducible — measured, not assumed: recomposing identical sources on
 * one machine with one toolchain moved the archive by two bytes and changed its
 * content digest. So every rebuild is a new artifact under a new tag.
 *
 * Still conservative within that set: whole source trees are hashed, so a comment
 * or an inline `#[cfg(test)]` change in a compiled crate asks for a republish that
 * ships identical behaviour. That is the safe direction to err, and no textual
 * rule can separate a comment from code that matters.
 */
export const nativeSourceInputs = [
  "native/ghosttea/crates/ghosttea-apple-ffi",
  "native/ghosttea/crates/ghosttea-ffi",
  "native/ghosttea/crates/ghosttea-vt-sys",
  "native/ghosttea/crates/ghosttea-vt",
  "native/ghosttea/crates/ghosttea-core",
  "native/ghosttea/crates/ghosttea-config",
  "native/ghosttea/crates/ghosttea-text",
  "native/ghosttea/crates/ghosttea-font-fixture-ffi",
  "native/ghostty.lock.json",
  "native/ssh.lock.json",
  "native/fonts.lock.json",
  "apple/GhostteaKit/Compatibility/ios-toolchain.lock.json",
  "native/ghosttea/crates/ghosttea-vt-sys/artifacts.json",
  "Cargo.lock",
  "Cargo.toml",
  "native/ghosttea/Cargo.toml",
  "scripts/build-ghosttea-apple-native.mjs",
  "scripts/cargo-target-directory.mjs",
  "scripts/build-ghostty-vt-apple.mjs",
  "scripts/ghostty-vt-target.mjs",
  "scripts/build-ssh-candidate-apple.mjs",
];

// Build outputs and caches live inside some of the source trees above. They are
// derived, machine-specific, and enormous, so hashing them would make the digest
// a property of the machine instead of the source.
const excludedSourceNames = new Set(["target", ".build", "node_modules", "build"]);

export function nativeSourceDigest(inputs = nativeSourceInputs) {
  const files = [];

  const walk = (absolute, relative) => {
    for (const child of readdirSync(absolute, { withFileTypes: true }).toSorted((left, right) =>
      compareText(left.name, right.name),
    )) {
      if (excludedSourceNames.has(child.name)) continue;
      const childAbsolute = join(absolute, child.name);
      const childRelative = `${relative}/${child.name}`;
      // A symlink's target is not covered by hashing what it points at, so treat
      // it the way the artifact tree does and refuse rather than guess.
      if (child.isSymbolicLink()) throw new Error(`Unexpected symlink in a native source input: ${childRelative}`);
      if (child.isDirectory()) walk(childAbsolute, childRelative);
      else if (child.isFile()) files.push([childRelative, sha256(readFileSync(childAbsolute))]);
    }
  };

  for (const input of inputs.toSorted(compareText)) {
    const absolute = join(root, input);
    if (!existsSync(absolute)) throw new Error(`Native source input is missing: ${input}`);
    if (statSync(absolute).isDirectory()) walk(absolute, input);
    else files.push([input, sha256(readFileSync(absolute))]);
  }

  // Sort again: a file listed directly can sort inside another input's subtree.
  const inventory = files
    .toSorted(([left], [right]) => compareText(left, right))
    .map(([path, digest]) => `${path}\0${digest}\n`)
    .join("");
  return sha256(Buffer.from(inventory));
}

/** The crate the artifact is built from: the workspace's only Apple staticlib. */
export const appleNativeRootCrate = "native/ghosttea/crates/ghosttea-apple-ffi";

/**
 * Every workspace crate compiled into the artifact, as repository-relative
 * directories: ghosttea-apple-ffi and each crate its path dependencies reach,
 * build and target-specific ones included.
 */
export function appleNativeCrates() {
  const workspace = workspacePathDependencies(readFileSync(join(root, "Cargo.toml"), "utf8"));
  const crates = new Set();
  const pending = [appleNativeRootCrate];
  while (pending.length > 0) {
    const crate = pending.pop();
    if (crates.has(crate)) continue;
    crates.add(crate);
    const manifest = readFileSync(join(root, crate, "Cargo.toml"), "utf8");
    for (const { path, fromWorkspace } of pathDependencies(manifest, workspace)) {
      pending.push(fromWorkspace ? posix.normalize(path) : posix.join(crate, path));
    }
  }
  return [...crates].toSorted(compareText);
}

/** The compiled crates that `inputs` does not cover, which the source digest would miss. */
export function uncoveredAppleNativeCrates(inputs = nativeSourceInputs) {
  const covered = (crate) => inputs.some((input) => crate === input || crate.startsWith(`${input}/`));
  return appleNativeCrates().filter((crate) => !covered(crate));
}
