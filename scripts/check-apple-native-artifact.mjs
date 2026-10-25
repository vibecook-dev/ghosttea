// Guards the ways the published GhostteaKit package can silently stop resolving,
// or keep resolving to the wrong bytes:
//
//   1. The root manifest's URL/checksum drift from the artifact lock.
//   2. The root and local manifests drift into different package graphs — they
//      are mirrors except for how the native artifact is sourced.
//   3. The locked artifact stops describing the artifact actually on disk.
//   4. The published artifact predates the native sources being shipped.
//   5. `--release`: the bytes at the locked URL are not the bytes locked.
//
// 4 and 5 are separate properties, and reading them as one is what let 0.6.2
// nearly ship an Apple artifact built before its own fixes. Hashing establishes
// *which* bytes are published (5); it cannot establish that those bytes contain
// the current source (4), because a digest taken from a stale build agrees with a
// lock written from that same stale build.
//
// 5 replaces a hand-maintained `published: true` in the lock — the one claim here
// that nothing verified, and which stayed true across a change to the artifact's
// contents.
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appleNativeRootCrate,
  collectEntries,
  contentDigest,
  lockPath,
  nativeSourceInputs,
  nativeSourceDigest,
  readLock,
  releaseTag,
  root,
  sha256,
  sliceDigests,
  sourceArtifact,
  uncoveredAppleNativeCrates,
} from "./ghosttea-apple-native-artifact.mjs";

const arguments_ = process.argv.slice(2);
const unknownArguments = arguments_.filter((argument) => !["--manifests-only", "--release"].includes(argument));
if (unknownArguments.length > 0 || new Set(arguments_).size !== arguments_.length) {
  throw new Error("Usage: check-apple-native-artifact.mjs [--manifests-only | --release]");
}
const releaseMode = arguments_.includes("--release");
const manifestsOnly = arguments_.includes("--manifests-only");
if (releaseMode && manifestsOnly) {
  throw new Error("--manifests-only and --release are mutually exclusive.");
}
const lock = readLock();
const problems = [];
const manifestCache = mkdtempSync(join(tmpdir(), "ghosttea-swift-manifest-"));
const developerDirectory =
  process.env.DEVELOPER_DIR ?? (process.platform === "darwin" ? "/Applications/Xcode.app/Contents/Developer" : null);
const swiftEnvironment = {
  ...process.env,
  CLANG_MODULE_CACHE_PATH: manifestCache,
  ...(developerDirectory ? { DEVELOPER_DIR: developerDirectory } : {}),
  SWIFTPM_MODULECACHE_OVERRIDE: manifestCache,
};

const rootManifest = join(root, "Package.swift");
const localManifest = join(root, "apple/GhostteaKit/Package.swift");
const desktopThemeCatalog = join(root, "packages/ghosttea-react/src/appearance/theme-catalog.generated.json");
const appleThemeCatalog = join(
  root,
  "apple/GhostteaKit/Sources/GhostteaAppearance/Resources/theme-catalog.generated.json",
);
const artifactWorkflow = join(root, ".github/workflows/ghosttea-apple-native-artifact.yml");

// The published-artifact audit must run whenever an input to sourceDigest
// changes. Keeping this assertion in the manifests-only gate makes path-filter
// drift fail in the ordinary repository check, before a release tag is cut.
const workflowText = readFileSync(artifactWorkflow, "utf8");
const pullRequestPaths = workflowText
  .match(/\n {2}pull_request:\n([\s\S]*?)(?=\n {2}[a-z_]+:)/)?.[1]
  ?.matchAll(/^ {6}- "([^"]+)"$/gm);
const auditedPaths = new Set(Array.from(pullRequestPaths ?? [], (match) => match[1]));
const requiredAuditPaths = [
  ".github/workflows/ghosttea-apple-native-artifact.yml",
  "Package.swift",
  "apple/GhostteaKit/Compatibility/apple-native-artifact.lock.json",
  "scripts/check-apple-native-artifact.mjs",
  "scripts/ghosttea-apple-native-artifact.mjs",
  "scripts/package-ghosttea-apple-native.mjs",
  "scripts/verify-ghosttea-apple-native-package.mjs",
  ...nativeSourceInputs,
];

function auditCovers(path) {
  return [...auditedPaths].some((filter) => {
    if (filter === path) return true;
    if (!filter.endsWith("/**")) return false;
    const directory = filter.slice(0, -3);
    return path === directory || path.startsWith(`${directory}/`);
  });
}

for (const path of requiredAuditPaths) {
  if (!auditCovers(path)) {
    problems.push(
      `${artifactWorkflow}'s pull_request paths do not cover native artifact input ${path}; ` +
        "a source change could reach a product release without auditing the published SwiftPM bytes.",
    );
  }
}

// The source digest is only as complete as nativeSourceInputs, which lists the
// compiled crates by hand: ghosttea-config sat outside it through 0.13.2 while
// ghosttea-ffi linked it. So the crates that actually compile in are derived from
// the manifests' path dependencies, here in the manifests-only gate too, and each
// must be covered.
for (const crate of uncoveredAppleNativeCrates()) {
  problems.push(
    `nativeSourceInputs does not cover ${crate}, which ${appleNativeRootCrate} compiles in; ` +
      "a change to it alone would ship a stale Apple native artifact without failing this check.",
  );
}

// ── 1. The root manifest pins what the lock records ──────────────────────────
const manifestText = readFileSync(rootManifest, "utf8");
const pinned = (name) => manifestText.match(new RegExp(`let ${name} =\\s*\\n?\\s*"([^"]+)"`))?.[1] ?? null;

const pinnedURL = pinned("appleNativeURL");
const pinnedChecksum = pinned("appleNativeChecksum");

if (pinnedURL !== lock.url) {
  problems.push(`Package.swift pins appleNativeURL ${pinnedURL ?? "<unparsed>"}, but the lock records ${lock.url}.`);
}
if (pinnedChecksum !== lock.checksum) {
  problems.push(
    `Package.swift pins appleNativeChecksum ${pinnedChecksum ?? "<unparsed>"}, but the lock records ${lock.checksum}.`,
  );
}
// The tag is what makes the URL content-addressed; a URL that no longer contains
// it would resolve to some other artifact's release.
if (!lock.url.includes(`/download/${lock.tag}/`)) {
  problems.push(`The locked URL does not carry the locked tag ${lock.tag}.`);
}
if (!lock.url.endsWith(`/${lock.filename}`)) {
  problems.push(`The locked URL does not end in the locked filename ${lock.filename}.`);
}

// ── 2. Both manifests describe the same package ─────────────────────────────
function dumpPackage(packagePath) {
  const result = spawnSync("swift", ["package", "--disable-sandbox", "--package-path", packagePath, "dump-package"], {
    cwd: root,
    env: swiftEnvironment,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.status !== 0) {
    problems.push(`swift package dump-package failed for ${packagePath}: ${result.stderr?.trim() || result.error}`);
    return null;
  }
  return JSON.parse(result.stdout);
}

// Dependency order is meaningless to SwiftPM, so compare as a set — an ordering
// difference is not drift and should not fail a release.
function shape(dump) {
  return {
    // Package-level pins, not just target wiring. A `truffleRevision` bumped in
    // one manifest and not the other is invisible in products and targets — both
    // sides keep naming the same `.product(name:package:)` — but it would ship
    // consumers a different Truffle than Apple development builds against.
    dependencies: (dump.dependencies ?? [])
      .flatMap((dependency) => dependency.sourceControl ?? [])
      .map((source) =>
        [
          source.identity,
          source.location?.remote?.map((remote) => remote.urlString).join(",") ?? "<local>",
          JSON.stringify(source.requirement),
        ].join("|"),
      )
      .toSorted(),
    products: dump.products
      .map((product) => `${product.name}:${JSON.stringify(product.targets.toSorted())}`)
      .toSorted(),
    targets: dump.targets
      .map((target) =>
        [
          target.name,
          target.type,
          JSON.stringify(target.dependencies.map((dependency) => JSON.stringify(dependency)).toSorted()),
        ].join("|"),
      )
      .toSorted(),
  };
}

try {
  if (spawnSync("swift", ["--version"], { env: swiftEnvironment, encoding: "utf8" }).status !== 0) {
    console.warn("swift is unavailable; skipping the manifest-parity comparison.");
  } else {
    const rootDump = dumpPackage(".");
    const localDump = dumpPackage("apple/GhostteaKit");
    if (rootDump && localDump) {
      const rootShape = shape(rootDump);
      const localShape = shape(localDump);
      for (const field of ["dependencies", "products", "targets"]) {
        const onlyRoot = rootShape[field].filter((entry) => !localShape[field].includes(entry));
        const onlyLocal = localShape[field].filter((entry) => !rootShape[field].includes(entry));
        for (const entry of onlyRoot) problems.push(`${field}: only Package.swift declares ${entry}`);
        for (const entry of onlyLocal)
          problems.push(`${field}: only apple/GhostteaKit/Package.swift declares ${entry}`);
      }
      // The one intended difference: the root manifest fetches the artifact, the
      // local one builds against it. Assert that rather than let it slip.
      const binaryTargetOf = (dump) => dump.targets.find((target) => target.type === "binary");
      if (binaryTargetOf(rootDump)?.url !== lock.url) {
        problems.push("Package.swift's binary target must be sourced by url; it is not.");
      }
      if (binaryTargetOf(localDump)?.path !== "Artifacts/ghosttea-apple-native.xcframework") {
        problems.push(
          "apple/GhostteaKit/Package.swift's binary target must stay path-sourced so Apple development builds against a local artifact.",
        );
      }
    }
  }
} finally {
  rmSync(manifestCache, { recursive: true, force: true });
}

if (!readFileSync(localManifest, "utf8").includes("Artifacts/ghosttea-apple-native.xcframework")) {
  problems.push(`${localManifest} no longer references the local artifact path.`);
}

// The two renderer implementations deliberately consume the same generated
// bytes. Checking this alongside manifest parity prevents a catalog refresh
// from silently updating only the desktop settings UI.
if (!existsSync(appleThemeCatalog)) {
  problems.push(`${appleThemeCatalog} is missing.`);
} else {
  const desktopCatalogBytes = readFileSync(desktopThemeCatalog);
  const appleCatalogBytes = readFileSync(appleThemeCatalog);
  if (!desktopCatalogBytes.equals(appleCatalogBytes)) {
    problems.push(
      "The Apple and desktop Ghostty theme catalogs differ; regenerate both outputs with scripts/sync-ghostty-theme-catalog.mjs.",
    );
  }
}

if (manifestsOnly) {
  if (problems.length > 0) {
    console.error(problems.map((problem) => `- ${problem}`).join("\n"));
    process.exit(1);
  }
  console.log(`SwiftPM manifests are equivalent and pin ${lock.tag}.`);
  process.exit(0);
}

// ── 3. The lock still describes the local artifact, when checking locally ───
// Release mode independently unpacks and hashes the served archive in section
// 5. A developer's older gitignored build is irrelevant to those published
// bytes and must not make a valid release audit fail. The ordinary check keeps
// enforcing local build freshness for candidate development.
if (!releaseMode) {
  if (existsSync(sourceArtifact)) {
    const entries = collectEntries();
    const digest = contentDigest(entries);
    if (digest !== lock.contentDigest) {
      problems.push(
        `The composed artifact has content digest ${digest}, but the lock records ${lock.contentDigest}. ` +
          `Re-run \`npm run package:ghosttea-apple-native\`, publish the new tag, and update ${lockPath}.`,
      );
    }
  } else {
    // Not a failure: the artifact is a gitignored build output, and this check
    // has to pass on a machine that has never run the Apple build.
    console.warn("The composed artifact is absent; skipping the content-digest comparison.");
  }
}

// ── 4. The artifact was built from the sources being shipped ────────────────
// The digests above establish which bytes are published, not whether those bytes
// contain the source in this checkout. Computed from a stale build they agree
// with a lock written from that same stale build, so the comparison is circular
// and passes exactly when it should not. 0.6.2 is the worked example: the key
// encoder and cursor fixes live in `ghostty_shim.c`, which compiles into every
// slice, and every gate here stayed green against the previous artifact.
const expectedSourceDigest = nativeSourceDigest();
if (!lock.sourceDigest) {
  problems.push(
    `${lockPath} records no sourceDigest, so nothing establishes that the published artifact was built ` +
      `from these sources. Re-run \`npm run package:ghosttea-apple-native\` and copy the field it emits.`,
  );
} else if (lock.sourceDigest !== expectedSourceDigest) {
  problems.push(
    `The native sources hash to ${expectedSourceDigest}, but the artifact was built from ${lock.sourceDigest}. ` +
      `The published artifact predates this checkout, so GhostteaKit consumers would get the older native code. ` +
      `Rebuild and republish: \`npm run build:apple-native\`, ` +
      `\`npm run package:ghosttea-apple-native\`, then publish ` +
      `the tag it names and copy its fields here. The Apple build is not byte-reproducible, so this always ` +
      `produces a new content digest and a new tag — there is no path that updates sourceDigest alone.`,
  );
}

// ── 5. The published bytes are the bytes the lock claims ────────────────────
// Only reachable over the network, so it is release-gated rather than part of an
// offline `npm run check`. This replaces a hand-set `published: true`, which was
// the one unverified human claim among these locks — and which stayed true across
// a release that changed the artifact's contents.
if (releaseMode) {
  let response;
  try {
    response = await fetch(lock.url, { redirect: "follow" });
  } catch (error) {
    problems.push(`${lock.url} could not be fetched: ${error instanceof Error ? error.message : String(error)}.`);
  }
  if (response && !response.ok) {
    problems.push(`${lock.url} is not resolvable: HTTP ${response.status} ${response.statusText}.`);
  } else if (response) {
    const archive = Buffer.from(await response.arrayBuffer());
    if (archive.length !== lock.size) {
      problems.push(`The published archive is ${archive.length} bytes; the lock records ${lock.size}.`);
    }
    const checksum = sha256(archive);
    if (checksum !== lock.checksum) {
      problems.push(
        `The published archive hashes to ${checksum}, but the lock — and therefore Package.swift — pins ` +
          `${lock.checksum}. SwiftPM will refuse this artifact.`,
      );
    } else {
      // Unpack and re-derive the content and slice digests, so the check covers
      // what the archive contains and not merely how many bytes it is.
      const scratch = mkdtempSync(join(tmpdir(), "ghosttea-apple-native-"));
      try {
        const archivePath = join(scratch, lock.filename);
        writeFileSync(archivePath, archive);
        const unzip = spawnSync("unzip", ["-q", archivePath, "-d", scratch], { encoding: "utf8" });
        if (unzip.status !== 0) {
          problems.push(`Could not unpack the published archive: ${unzip.stderr?.trim() || unzip.error}`);
        } else {
          const entries = collectEntries(join(scratch, lock.bundleName), lock.bundleName);
          const publishedDigest = contentDigest(entries);
          if (publishedDigest !== lock.contentDigest) {
            problems.push(
              `The published archive has content digest ${publishedDigest}, but the lock records ` +
                `${lock.contentDigest}.`,
            );
          }
          const publishedSlices = sliceDigests(entries);
          for (const [slice, expected] of Object.entries(lock.slices ?? {})) {
            if (publishedSlices[slice] !== expected) {
              problems.push(
                `Published slice ${slice} hashes to ${publishedSlices[slice] ?? "<absent>"}, ` +
                  `but the lock records ${expected}.`,
              );
            }
          }
          if (!lock.url.includes(`/download/${releaseTag(publishedDigest)}/`)) {
            problems.push(
              `The published content digest derives tag ${releaseTag(publishedDigest)}, which is not the tag ` +
                `in the locked URL. The artifact is published under a name that does not address its content.`,
            );
          }
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    }
  }
}

if (problems.length > 0) {
  console.error(problems.map((problem) => `- ${problem}`).join("\n"));
  process.exit(1);
}

console.log(
  `Apple native artifact lock is consistent (tag ${lock.tag}, source ${expectedSourceDigest.slice(0, 12)})` +
    `${releaseMode ? ", and the published archive matches it byte for byte" : ""}.`,
);
