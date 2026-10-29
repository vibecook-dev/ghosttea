import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { assertGhosttySource, ghosttySourceDigest, ghosttySourceIdentity, lock, root } from "./ghostty-vt-target.mjs";

const vendor = join(root, "native/vendor/ghostty");
const zig = join(root, `.tools/zig-aarch64-macos-${lock.zig.version}/zig`);
const output = join(root, "native/build/ghostty-apple");
const install = join(output, "install");
const xcframework = join(install, "lib/ghostty-vt.xcframework");
const packageArtifact = join(root, "apple/GhostteaKit/Artifacts/ghostty-vt.xcframework");
const developerDir =
  process.env.GHOSTTY_DEVELOPER_DIR ?? `/Applications/Xcode_${lock.appleBuilder.xcodeVersion}.app/Contents/Developer`;
const commandEnvironment = {
  ...process.env,
  DEVELOPER_DIR: developerDir,
  ZIG_GLOBAL_CACHE_DIR: join(output, "global"),
};

function capture(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, env: commandEnvironment, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}

function directorySize(path) {
  return readdirSync(path, { withFileTypes: true }).reduce((total, entry) => {
    const child = join(path, entry.name);
    return total + (entry.isDirectory() ? directorySize(child) : statSync(child).size);
  }, 0);
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("The pinned Apple build currently requires Apple Silicon macOS.");
}
if (!existsSync(developerDir)) {
  throw new Error(
    `Pinned Ghostty Xcode developer directory does not exist: ${developerDir}. ` +
      "Set GHOSTTY_DEVELOPER_DIR to the reviewed side-by-side Xcode installation.",
  );
}
if (!existsSync(join(vendor, ".git")) || !existsSync(zig)) {
  throw new Error("Ghostty sources or macOS Zig are missing. Run `npm run bootstrap:ghostty-vt:apple` first.");
}
if (capture("git", ["rev-parse", "HEAD"], vendor) !== lock.ghostty.commit) {
  throw new Error(`Ghostty source is not at locked commit ${lock.ghostty.commit}`);
}
assertGhosttySource(vendor);
if (capture(zig, ["version"]) !== lock.zig.version) {
  throw new Error(`Expected Zig ${lock.zig.version} at ${zig}`);
}

const xcodeVersion = capture("xcodebuild", ["-version"]).replaceAll("\n", " ");
const macosSdk = capture("xcrun", ["--sdk", "macosx", "--show-sdk-version"]);
const iphoneosSdk = capture("xcrun", ["--sdk", "iphoneos", "--show-sdk-version"]);
const simulatorSdk = capture("xcrun", ["--sdk", "iphonesimulator", "--show-sdk-version"]);
for (const [description, actual, expected] of [
  ["Xcode version", xcodeVersion, `Xcode ${lock.appleBuilder.xcodeVersion}`],
  ["Xcode build", xcodeVersion, `Build version ${lock.appleBuilder.xcodeBuild}`],
  ["macOS SDK", macosSdk, lock.appleBuilder.macosSdkVersion],
  ["iPhoneOS SDK", iphoneosSdk, lock.appleBuilder.iphoneosSdkVersion],
  ["iPhoneSimulator SDK", simulatorSdk, lock.appleBuilder.iphonesimulatorSdkVersion],
]) {
  if (!actual.includes(expected)) {
    throw new Error(`${description} drifted; expected ${JSON.stringify(expected)} in ${JSON.stringify(actual)}.`);
  }
}
mkdirSync(output, { recursive: true });

const args = [
  "build",
  `-j${lock.builder.zigBuildJobs}`,
  "--cache-dir",
  join(output, "cache"),
  "--pkg-dir",
  join(output, lock.builder.zigPackageDirectory),
  "--prefix",
  install,
  "-Demit-lib-vt",
  "-Demit-xcframework",
  `-Doptimize=${lock.builder.zigOptimize}`,
];
const result = spawnSync(zig, args, { cwd: vendor, env: commandEnvironment, stdio: "inherit" });
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
if (!existsSync(xcframework)) {
  throw new Error(`Ghostty build completed without ${xcframework}`);
}

const licenseDirectory = join(install, "share/licenses/ghostty");
mkdirSync(licenseDirectory, { recursive: true });
cpSync(join(vendor, "LICENSE"), join(licenseDirectory, "LICENSE"));

mkdirSync(join(root, "apple/GhostteaKit/Artifacts"), { recursive: true });
rmSync(packageArtifact, { recursive: true, force: true });
cpSync(xcframework, packageArtifact, { recursive: true, force: true });

const metadata = {
  schemaVersion: 1,
  source: { ...ghosttySourceIdentity(), digest: ghosttySourceDigest() },
  zigVersion: lock.zig.version,
  xcodeVersion,
  macosSdk,
  iphoneosSdk,
  simulatorSdk,
  minimumIosVersion: lock.appleBuilder.minimumIosVersion,
  artifact: "native/build/ghostty-apple/install/lib/ghostty-vt.xcframework",
  artifactSizeBytes: directorySize(xcframework),
};
writeFileSync(join(output, "build-metadata.json"), `${JSON.stringify(metadata, null, 2)}\n`);

const validation = spawnSync(
  process.execPath,
  [join(root, "scripts/validate-ghostty-vt-xcframework.mjs"), xcframework],
  {
    cwd: root,
    env: commandEnvironment,
    stdio: "inherit",
  },
);
if (validation.error) throw validation.error;
if (validation.status !== 0) process.exit(validation.status ?? 1);

console.log(`Built ${xcframework}`);
console.log(`Synced ${packageArtifact}`);
