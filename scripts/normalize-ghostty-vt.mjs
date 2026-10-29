import { createHash } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  ghosttyNormalizerFiles,
  installPrefix,
  libraryPath,
  lock,
  resolveTarget,
  targetConfig,
} from "./ghostty-vt-target.mjs";

const target = resolveTarget();
const config = targetConfig(target);
const normalizer = lock.builder.normalizer;
const positional = process.argv.slice(2).find((value) => !value.startsWith("--"));
const library = resolve(positional ?? join(installPrefix(target), "install", libraryPath(target)));
const developerDirectory = process.env.GHOSTTEA_NORMALIZER_DEVELOPER_DIR ?? normalizer?.developerDirectory;
const commandEnvironment = { ...process.env, DEVELOPER_DIR: developerDirectory };

if (config.build !== "container") {
  // Normalization exists to make the container cross-build byte-identical
  // across hosts. A native build embeds the building machine's absolute paths
  // in its archive member table, which no postprocessing step can canonicalize.
  throw new Error(`${target} is built natively and has no normalization step.`);
}
if (process.platform !== "darwin") {
  throw new Error("Ghostty VT release archives must be normalized on macOS with Apple strip.");
}
if (
  !normalizer ||
  typeof developerDirectory !== "string" ||
  !Array.isArray(normalizer.stripFlags) ||
  normalizer.stripFlags.length === 0
) {
  throw new Error("native/ghostty.lock.json must declare the pinned Apple archive normalizer.");
}
if (!existsSync(developerDirectory)) {
  throw new Error(
    `Pinned normalizer developer directory does not exist: ${developerDirectory}. ` +
      "Set GHOSTTEA_NORMALIZER_DEVELOPER_DIR to the reviewed Xcode installation.",
  );
}
if (!existsSync(library)) throw new Error(`Ghostty VT archive does not exist: ${library}`);

const xcode = spawnSync("xcodebuild", ["-version"], {
  env: commandEnvironment,
  encoding: "utf8",
});
if (xcode.error) throw xcode.error;
if (xcode.status !== 0) throw new Error(xcode.stderr || "xcodebuild -version failed");
for (const expected of [`Xcode ${normalizer.xcodeVersion}`, `Build version ${normalizer.xcodeBuild}`]) {
  if (!xcode.stdout.includes(expected)) {
    throw new Error(
      `Ghostty VT normalizer drifted; expected ${JSON.stringify(expected)} in ${JSON.stringify(xcode.stdout)}.`,
    );
  }
}

// Upstream applies this step only on a Darwin build host. Our Linux cross-build
// reaches Darwin here: apply the same reviewed compiler-rt/libSystem policy
// before stripping, or its two memset definitions collide in Rust consumers.
const [override] = ghosttyNormalizerFiles();
if (!override) throw new Error("The Darwin normalizer must pin the upstream libSystem override.");
const normalized = `${library}.libsystem`;
const postprocess = spawnSync("/bin/sh", [override.absolutePath, library, normalized], {
  env: commandEnvironment,
  stdio: "inherit",
});
if (postprocess.error) throw postprocess.error;
if (postprocess.status !== 0) process.exit(postprocess.status ?? 1);
renameSync(normalized, library);

const strip = spawnSync("xcrun", ["strip", ...normalizer.stripFlags, library], {
  env: commandEnvironment,
  stdio: "inherit",
});
if (strip.error) throw strip.error;
if (strip.status !== 0) process.exit(strip.status ?? 1);

const archive = readFileSync(library);
if (archive.subarray(0, 8).toString("ascii") !== "!<arch>\n") {
  throw new Error(`Ghostty VT output is not a static archive: ${library}`);
}

function replaceField(headerOffset, fieldOffset, length, value) {
  archive.fill(0x20, headerOffset + fieldOffset, headerOffset + fieldOffset + length);
  archive.write(value, headerOffset + fieldOffset, length, "ascii");
}

let offset = 8;
while (offset < archive.length) {
  const headerEnd = offset + 60;
  if (headerEnd > archive.length || archive.subarray(offset + 58, headerEnd).toString("ascii") !== "`\n") {
    throw new Error(`Malformed static archive member at byte ${offset}: ${library}`);
  }

  const size = Number.parseInt(
    archive
      .subarray(offset + 48, offset + 58)
      .toString("ascii")
      .trim(),
    10,
  );
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new Error(`Invalid static archive member size at byte ${offset}: ${library}`);
  }

  replaceField(offset, 16, 12, "0");
  replaceField(offset, 28, 6, "0");
  replaceField(offset, 34, 6, "0");
  replaceField(offset, 40, 8, "100644");
  offset = headerEnd + size + (size % 2);
}

if (offset !== archive.length) throw new Error(`Malformed static archive length: ${library}`);
writeFileSync(library, archive);
console.log(`${createHash("sha256").update(archive).digest("hex")}  ${library}`);
