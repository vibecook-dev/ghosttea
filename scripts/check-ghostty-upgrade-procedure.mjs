import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { ghosttySourceDigest, ghosttySourceIdentity, targets } from "./ghostty-vt-target.mjs";

const root = resolve(import.meta.dirname, "..");
const runbookPath = "apple/GhostteaKit/Compatibility/ghostty-upgrade-procedure.md";
const lock = readJSON("native/ghostty.lock.json");
const configLock = readJSON("native/ghostty-config.lock.json");
const fonts = readJSON("native/fonts.lock.json");
const artifacts = readJSON("native/ghosttea/crates/ghosttea-vt-sys/artifacts.json");
const packageManifest = readJSON("package.json");
const sourceBom = readJSON("apple/GhostteaKit/Compatibility/ios-release.cdx.json");
const bundledBom = readJSON("apple/GhostteaApp/Resources/Ghosttea-iOS.cdx.json");
const workflow = read(".github/workflows/ghostty-vt-artifact.yml");
const runbook = read(runbookPath);
const configCompatibilitySource = read("native/ghosttea/crates/ghosttea-config/src/lib.rs");
const configKnownKeys = read("native/ghosttea/crates/ghosttea-config/src/known-keys.txt").trim().split("\n").sort();
const configX11Colors = read("native/ghosttea/crates/ghosttea-config/src/x11-rgb.txt");
const groundTruthConfig = read("bench/ghostty-ux/ground-truth/config-macos-default.txt");
const groundTruthVersion = read("bench/ghostty-ux/ground-truth/ghostty-version.txt");
const groundTruthCommit = read("bench/ghostty-ux/ground-truth/vendor-commit.txt").split("\n", 1)[0];

const commit = lock.ghostty?.commit;
if (!/^[0-9a-f]{40}$/.test(commit ?? "")) {
  throw new Error("native/ghostty.lock.json must pin a full lowercase 40-character commit.");
}
const sourceDigest = ghosttySourceDigest();
const sourceIdentity = { ...ghosttySourceIdentity(), digest: sourceDigest };
const revision = sourceDigest.slice(0, 12);
const expectedRelease = `ghostty-vt-${revision}`;

const configCommit = configLock.ghostty?.commit;
if (!/^[0-9a-f]{40}$/.test(configCommit ?? "")) {
  throw new Error("native/ghostty-config.lock.json must pin a full lowercase 40-character commit.");
}
requireEqual(groundTruthCommit, commit, "Ghostty UX ground-truth commit");
const version = groundTruthVersion.match(/^\s*-\s+version:\s+(\S+)\s*$/m)?.[1];
if (!version) throw new Error("Ghostty UX ground truth does not report a version.");
requireEqual(version, configLock.ghostty?.version, "Ghostty config ground-truth version");
requireEqual(configLock.ghostty?.tag, `v${version}`, "Ghostty config release tag");
if (
  !configCompatibilitySource.includes(`GHOSTTY_CONFIG_COMPAT_COMMIT: &str = "${configCommit}"`) ||
  !configCompatibilitySource.includes(`GHOSTTY_CONFIG_COMPAT_VERSION: &str = "${configLock.ghostty?.version}"`)
) {
  throw new Error("ghosttea-config compatibility constants do not match native/ghostty-config.lock.json.");
}
requireEqual(configKnownKeys.length, configLock.generated?.knownKeys?.count, "ghosttea-config known-key count");
requireEqual(
  sha256(`${configKnownKeys.join("\n")}\n`),
  configLock.generated?.knownKeys?.sha256,
  "ghosttea-config known-key schema digest",
);
requireEqual(sha256(configX11Colors), configLock.generated?.x11Colors?.sha256, "ghosttea-config X11 color digest");
requireEqual(
  configLock.sources?.x11Colors?.sha256,
  configLock.generated?.x11Colors?.sha256,
  "Ghostty source/generated X11 digest",
);
for (const [name, source] of Object.entries(configLock.sources ?? {})) {
  if (!source?.path || !/^[0-9a-f]{64}$/.test(source.sha256 ?? "")) {
    throw new Error(`Ghostty config source ${name} must have a path and SHA-256 digest.`);
  }
}

const groundTruthValue = (key) => groundTruthConfig.match(new RegExp(`^${key} = (.*)$`, "m"))?.[1]?.trim();
requireEqual(
  Number(groundTruthValue("scrollback-limit")),
  configLock.defaults?.scrollbackBytes,
  "Ghostty config scrollback default",
);
requireEqual(
  Number(groundTruthValue("font-size")),
  configLock.defaults?.fontSize?.macos,
  "Ghostty config macOS font-size default",
);
requireEqual(
  parseHexColor(groundTruthValue("foreground")),
  configLock.defaults?.foreground,
  "Ghostty config foreground default",
);
requireEqual(
  parseHexColor(groundTruthValue("background")),
  configLock.defaults?.background,
  "Ghostty config background default",
);
requireEqual(
  [Number(groundTruthValue("window-padding-x")), Number(groundTruthValue("window-padding-x"))],
  configLock.defaults?.paddingX,
  "Ghostty config horizontal padding default",
);
requireEqual(
  [Number(groundTruthValue("window-padding-y")), Number(groundTruthValue("window-padding-y"))],
  configLock.defaults?.paddingY,
  "Ghostty config vertical padding default",
);

requireEqual(artifacts.source, sourceIdentity, "native artifact source-and-recipe identity");
requireEqual(fonts.source, lock.ghostty, "font source pin");
requireEqual(lock.builder?.zigBuildJobs, 1, "Ghostty VT Zig build concurrency");
requireEqual(lock.builder?.zigOptimize, "fast", "Ghostty VT optimization mode");
requireEqual(lock.builder?.zigPackageDirectory, "packages", "Ghostty VT writable package directory");
requireEqual(lock.builder?.normalizer?.runner, "macos-26", "Ghostty VT normalizer runner");
for (const field of ["developerDirectory", "xcodeVersion", "xcodeBuild"]) {
  if (typeof lock.builder?.normalizer?.[field] !== "string" || lock.builder.normalizer[field] === "") {
    throw new Error(`Ghostty VT normalizer ${field} must be a non-empty string.`);
  }
}
for (const [target, config] of Object.entries(targets)) {
  const artifact = artifacts.targets?.[target];
  const expectedFilename = `${expectedRelease}-${target}.tar`;
  requireEqual(artifact?.sourceDigest, sourceDigest, `${target} native artifact source digest`);
  requireEqual(artifact?.release, expectedRelease, `${target} native artifact release`);
  requireEqual(artifact?.filename, expectedFilename, `${target} native artifact filename`);
  requireEqual(
    artifact?.url,
    `https://github.com/vibecook-dev/ghosttea/releases/download/${expectedRelease}/${expectedFilename}`,
    `${target} native artifact URL`,
  );
  requireEqual(artifact?.libraryPath, config.libraryPath, `${target} native artifact library path`);
  requireEqual(config.zigCpu, "baseline", `${target} portable Zig CPU target`);
  if (typeof config.reproducible !== "boolean") {
    throw new Error(`${target} must declare a boolean reproducibility classification.`);
  }
  requireEqual(artifact?.reproducible, config.reproducible, `${target} reproducibility classification`);
  for (const field of ["sha256", "librarySha256", "headersSha256"]) {
    if (!/^[0-9a-f]{64}$/.test(artifact?.[field] ?? "")) {
      throw new Error(`${target} native artifact ${field} is not a SHA-256 digest.`);
    }
  }
  if (!Number.isSafeInteger(artifact?.size) || artifact.size <= 0) {
    throw new Error(`${target} native artifact size must be a positive integer.`);
  }
  if (!config.reproducible && (!Number.isSafeInteger(artifact?.candidateRunId) || artifact.candidateRunId <= 0)) {
    throw new Error(`${target} must record the positive candidateRunId whose immutable bytes are promoted.`);
  }
}
const candidateRunIds = Object.entries(targets)
  .filter(([, config]) => !config.reproducible)
  .map(([target]) => artifacts.targets[target].candidateRunId);
if (new Set(candidateRunIds).size !== 1) {
  throw new Error("Non-reproducible Ghostty VT targets must come from one atomic candidate run.");
}

for (const [description, bom] of [
  ["source release BOM", sourceBom],
  ["bundled release BOM", bundledBom],
]) {
  const component = bom.components?.find((candidate) => candidate.name === "Ghostty VT");
  requireEqual(component?.version, commit, `${description} Ghostty version`);
  requireEqual(component?.purl, `pkg:github/ghostty-org/ghostty@${commit}`, `${description} Ghostty purl`);
}

const requiredScripts = [
  "bootstrap:ghostty-vt",
  "bootstrap:ghostty-vt:apple",
  "build:ghostty-vt",
  "build:ghostty-vt:apple",
  "check:ghostty-vt:apple",
  "test:ghostty-vt:apple",
  "sync:fonts",
  "sync:ghostty-config",
  "check:font-parity",
  "package:ghostty-vt",
  "check:ios-release-bom",
  "update:ios-release-resources",
  "test:ios:app:interop",
  "archive:ios:app",
  "check:ghostty-upgrade",
];
for (const name of requiredScripts) {
  if (!packageManifest.scripts?.[name]) throw new Error(`package.json is missing the ${name} script.`);
}

const requiredInputs = [
  "native/ghostty.lock.json",
  "native/ghostty-config.lock.json",
  "native/fonts.lock.json",
  "native/ghosttea/crates/ghosttea-vt-sys/artifacts.json",
  "native/ghosttea/crates/ghosttea-vt-sys/src/ghostty_shim.c",
  "native/ghosttea/crates/ghosttea-vt-sys/src/ghostty_shim.h",
  "native/ghosttea/crates/ghosttea-vt-sys/src/ghostty_shim_internal.h",
  "native/ghosttea/crates/ghosttea-vt-sys/src/ghostty_shim_saved.c",
  "native/ghosttea/crates/ghosttea-vt-sys/src/ghostty_shim_screen.c",
  "native/ghosttea/crates/ghosttea-vt-sys/src/ghostty_shim_identity.c",
  "scripts/ghostty-vt-target.mjs",
  "scripts/verify-ghostty-vt-candidate.mjs",
  "native/ghosttea/crates/ghosttea-config/src/known-keys.txt",
  "native/ghosttea/crates/ghosttea-config/src/x11-rgb.txt",
  "scripts/sync-ghostty-config-schema.mjs",
  "native/ghosttea/fixtures/phase1/ansi-baseline.json",
  "native/ghosttea/fixtures/phase2/font-parity.json",
  "apple/GhostteaKit/Sources/GhostteaTerminal/Resources/terminal-visual-golden.json",
  "apple/GhostteaKit/Compatibility/ios-release.cdx.json",
  "apple/GhostteaKit/Compatibility/ios-release-resources.lock.json",
  ...sourceIdentity.patches.map((patch) => patch.path),
];
for (const path of requiredInputs) {
  if (!existsSync(resolve(root, path))) throw new Error(`Ghostty upgrade input is missing: ${path}`);
}

const requiredRunbookText = [
  ...requiredInputs,
  ...requiredScripts.map((name) => `npm run ${name}`),
  "[STOP-SOURCE]",
  "[STOP-ABI]",
  "[STOP-PARITY]",
  "[STOP-FONTS]",
  "[STOP-PERFORMANCE]",
  "[STOP-PACKAGING]",
  "[STOP-DEVICE]",
  "[ROLLBACK]",
  "byte-identical TRF1",
  "desktop and iOS",
  "same Truffle session",
];
for (const text of requiredRunbookText) {
  if (!runbook.includes(text)) throw new Error(`${runbookPath} omits required text: ${text}`);
}

if (workflow.includes(`ghostty-vt-${revision}-`)) {
  throw new Error("Ghostty artifact workflow hardcodes the current revision instead of resolving its locked path.");
}
for (const text of [
  "id: ghostty_artifact",
  "artifacts.json",
  "steps.ghostty_artifact.outputs.path",
  "steps.ghostty_artifact.outputs.sbom",
  "candidateRunId",
  "scripts/verify-ghostty-vt-candidate.mjs",
  "run-id: ${{ steps.windows_candidate.outputs.run_id }}",
  "run-id: ${{ steps.macos_candidate.outputs.run_id }}",
  "needs: [package, windows]",
  "runs-on: macos-26",
  "GHOSTTEA_NORMALIZER_DEVELOPER_DIR",
]) {
  if (!workflow.includes(text)) throw new Error(`Ghostty artifact workflow omits ${text}.`);
}

// The multi-target scripts read the pin through one shared module rather than
// each opening the lock, so that module has to be the thing that reads it.
const sharedTargets = "scripts/ghostty-vt-target.mjs";
if (!read(sharedTargets).includes("native/ghostty.lock.json")) {
  throw new Error(`${sharedTargets} does not read native/ghostty.lock.json.`);
}

for (const path of [
  "scripts/bootstrap-ghostty-vt.mjs",
  "scripts/bootstrap-ghostty-vt-apple.mjs",
  "scripts/build-ghostty-vt.mjs",
  "scripts/build-ghostty-vt-apple.mjs",
]) {
  const source = read(path);
  if (!source.includes("native/ghostty.lock.json") && !source.includes("./ghostty-vt-target.mjs")) {
    throw new Error(`${path} does not read native/ghostty.lock.json.`);
  }
  for (const text of ["rev-parse", "lock.ghostty.commit"]) {
    if (!source.includes(text)) throw new Error(`${path} does not enforce ${text}.`);
  }
}
for (const path of ["scripts/bootstrap-ghostty-vt.mjs", "scripts/bootstrap-ghostty-vt-apple.mjs"]) {
  if (!read(path).includes("prepareGhosttySource")) {
    throw new Error(`${path} does not prepare the exact locked Ghostty VT patch set.`);
  }
}
for (const path of ["scripts/build-ghostty-vt.mjs", "scripts/build-ghostty-vt-apple.mjs"]) {
  if (!read(path).includes("assertGhosttySource")) {
    throw new Error(`${path} does not reject source changes outside the exact locked patch set.`);
  }
}
const desktopBuild = read("scripts/build-ghostty-vt.mjs");
for (const text of [
  "-Dcpu=${config.zigCpu}",
  "-j${lock.builder.zigBuildJobs}",
  "-Doptimize=${lock.builder.zigOptimize}",
  "-Demit-xcframework=false",
  "ZIG_GLOBAL_CACHE_DIR",
  "lock.builder.zigPackageDirectory",
  "-Dmsvc-runtime=${config.msvcRuntime}",
]) {
  if (!desktopBuild.includes(text)) {
    throw new Error(`scripts/build-ghostty-vt.mjs does not pin ${JSON.stringify(text)}.`);
  }
}
for (const [path, requiredText] of [
  ["scripts/check-ios-release-ready.mjs", "scripts/check-ghostty-upgrade-procedure.mjs"],
  ["scripts/archive-ios-app.mjs", "scripts/check-ghostty-upgrade-procedure.mjs"],
]) {
  if (!read(path).includes(requiredText)) {
    throw new Error(`${path} does not run the Ghostty upgrade drift gate.`);
  }
}

console.log(
  `Verified Ghostty VT ${commit} + ${sourceIdentity.patches.length} patch(es) (${sourceDigest}) and config ${configLock.ghostty.version} ${configCommit}: exact source/font/BOM locks, ${requiredInputs.length} inputs, and ${Object.keys(targets).length}-target artifact promotion.`,
);

function read(path) {
  return readFileSync(resolve(root, path), "utf8");
}

function readJSON(path) {
  return JSON.parse(read(path));
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function parseHexColor(value) {
  if (!/^#[0-9a-fA-F]{6}$/.test(value ?? "")) {
    throw new Error(`Expected a six-digit Ghostty color, got ${JSON.stringify(value)}.`);
  }
  return [1, 3, 5].map((index) => Number.parseInt(value.slice(index, index + 2), 16));
}

function requireEqual(actual, expected, description) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${description} drifted: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}.`);
  }
}
