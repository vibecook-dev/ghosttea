import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { release as osRelease } from "node:os";
import { join, relative } from "node:path";
import {
  artifactNames,
  ghosttyPatchFiles,
  ghosttySourceDigest,
  ghosttySourceIdentity,
  installPrefix,
  libraryPath,
  lock,
  resolveTarget,
  root,
  targetConfig,
} from "./ghostty-vt-target.mjs";
import { msvcRuntimeProblems, RUNTIME_STAMPS } from "./ghostty-vt-msvc-runtime.mjs";

const allowMismatch = process.argv.includes("--allow-mismatch");
const target = resolveTarget();
const config = targetConfig(target);
const library = libraryPath(target);
// Reproducibility is measured rather than inferred from the build mechanism.
// A pinned container still sees host CPU/compiler behavior unless proven
// otherwise, so the lock carries the reviewed classification explicitly.
const reproducible = config.reproducible;
if (typeof reproducible !== "boolean") {
  throw new Error(`${target} must declare a boolean reproducible classification.`);
}
const { release, filename } = artifactNames(target);
const sourceDigest = ghosttySourceDigest();
const source = { ...ghosttySourceIdentity(), digest: sourceDigest };
const outputDirectory = join(root, "artifacts/ghostty-vt");

/**
 * The newest entry of a versioned toolchain directory, or null when the
 * directory is absent.
 */
function newestVersion(directory) {
  try {
    return (
      readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .at(-1) ?? null
    );
  } catch {
    return null;
  }
}

/**
 * What a native build linked against, recorded rather than enforced.
 *
 * Best effort by design: a build that cannot report its toolchain should still
 * produce an artifact, and a null here says the record is unknown rather than
 * claiming the build had nothing.
 */
function hostToolchain() {
  if (process.platform !== "win32") return null;
  const programFiles = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  const vswhere = join(programFiles, "Microsoft Visual Studio/Installer/vswhere.exe");
  const query = (property) => {
    const result = spawnSync(vswhere, ["-latest", "-products", "*", "-property", property], {
      encoding: "utf8",
    });
    return result.status === 0 ? result.stdout.trim() || null : null;
  };
  const installation = query("installationPath");
  return {
    visualStudio: query("installationVersion"),
    msvcTools: installation ? newestVersion(join(installation, "VC/Tools/MSVC")) : null,
    windowsSdk: newestVersion(join(programFiles, "Windows Kits/10/Include")),
    osRelease: osRelease(),
  };
}

function filesBelow(directory) {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? filesBelow(path) : [path];
    })
    .toSorted(compareText);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

const install = join(installPrefix(target), "install");
const includeRoot = join(install, "include");
const headerInputs = filesBelow(includeRoot).map((sourcePath) => ({
  bundlePath: `include/${relative(includeRoot, sourcePath).replaceAll("\\", "/")}`,
  sourcePath,
}));
const inputs = [
  ...headerInputs,
  // Only the static archive ships. On Windows the install tree also holds
  // ghostty-vt.lib, the DLL import library, which must not be bundled.
  { bundlePath: library, sourcePath: join(install, library) },
  {
    bundlePath: "LICENSES/Ghostty.txt",
    sourcePath: join(install, "share/licenses/ghostty/LICENSE"),
  },
  ...ghosttyPatchFiles().map((patch) => ({
    bundlePath: `SOURCE-PATCHES/${patch.path}`,
    sourcePath: patch.absolutePath,
  })),
].map((file) => ({ ...file, contents: readFileSync(file.sourcePath) }));

// An MSVC library is built for one C runtime, and every object in a consumer's
// link must agree with it. Refuse to package objects stamped for the other one,
// whatever `--allow-mismatch` says: that flag tolerates a manifest that has not
// caught up, never a library its consumers cannot link.
if (config.zigTarget.endsWith("-msvc")) {
  const archive = inputs.find((file) => file.bundlePath === library).contents;
  const problems = msvcRuntimeProblems(archive, config.msvcRuntime);
  if (problems.length > 0) {
    throw new Error(`${target} is not built for the ${config.msvcRuntime} C runtime:\n- ${problems.join("\n- ")}`);
  }
  console.log(`${target}: every stamped object is ${RUNTIME_STAMPS[config.msvcRuntime]}`);
}

function digest(algorithm, contents) {
  return createHash(algorithm).update(contents).digest("hex");
}

function stableJson(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function treeDigest(files) {
  const inventory = files
    .toSorted((left, right) => compareText(left.bundlePath, right.bundlePath))
    .map((file) => `${file.bundlePath}\0${digest("sha256", file.contents)}\0${file.contents.length}\n`)
    .join("");
  return digest("sha256", inventory);
}

const artifact = {
  schemaVersion: 1,
  name: "ghostty-vt",
  target,
  source,
  builder:
    config.build === "container"
      ? {
          mode: "container",
          image: lock.builder.image,
          platform: lock.builder.platform,
          zigBuildJobs: lock.builder.zigBuildJobs,
          zigOptimize: lock.builder.zigOptimize,
          zigPackageDirectory: lock.builder.zigPackageDirectory,
          zigVersion: lock.zig.version,
          zigTarget: config.zigTarget,
          zigCpu: config.zigCpu,
          postprocessor: {
            tool: "xcrun strip",
            xcodeVersion: lock.builder.normalizer.xcodeVersion,
            xcodeBuild: lock.builder.normalizer.xcodeBuild,
            flags: lock.builder.normalizer.stripFlags,
            canonicalArchiveMetadata: true,
          },
        }
      : {
          mode: "native",
          hostPlatform: config.hostPlatform,
          zigBuildJobs: lock.builder.zigBuildJobs,
          zigOptimize: lock.builder.zigOptimize,
          zigPackageDirectory: lock.builder.zigPackageDirectory,
          zigVersion: lock.zig.version,
          zigTarget: config.zigTarget,
          zigCpu: config.zigCpu,
          // A container build is pinned by its image digest. A native build is
          // pinned by whatever the host had installed, and these are the parts
          // Zig links against, so they belong in the record even though they
          // cannot be enforced from it.
          hostToolchain: hostToolchain(),
          postprocessor: null,
        },
  files: Object.fromEntries(
    inputs.map((file) => [file.bundlePath, { sha256: digest("sha256", file.contents), size: file.contents.length }]),
  ),
};

const spdxFiles = inputs.map((file, index) => ({
  SPDXID: `SPDXRef-File-${index + 1}`,
  fileName: `./${file.bundlePath}`,
  checksums: [
    { algorithm: "SHA1", checksumValue: digest("sha1", file.contents) },
    { algorithm: "SHA256", checksumValue: digest("sha256", file.contents) },
  ],
  licenseConcluded: "MIT",
  licenseInfoInFiles: ["MIT"],
  copyrightText: "NOASSERTION",
}));
const verificationCode = digest(
  "sha1",
  spdxFiles
    .map((file) => file.checksums.find((checksum) => checksum.algorithm === "SHA1").checksumValue)
    .sort()
    .join(""),
);
const sbom = {
  spdxVersion: "SPDX-2.3",
  dataLicense: "CC0-1.0",
  SPDXID: "SPDXRef-DOCUMENT",
  name: `${release}-${target}`,
  documentNamespace: `https://github.com/vibecook-dev/ghosttea/sbom/${release}/${target}`,
  creationInfo: {
    created: "1970-01-01T00:00:00Z",
    creators: ["Tool: ghosttea-package-ghostty-vt"],
  },
  packages: [
    {
      SPDXID: "SPDXRef-Package-Ghostty",
      name: "Ghostty VT",
      versionInfo: sourceDigest,
      downloadLocation: "NOASSERTION",
      filesAnalyzed: true,
      packageVerificationCode: { packageVerificationCodeValue: verificationCode },
      licenseConcluded: "MIT",
      licenseDeclared: "MIT",
      copyrightText: "Copyright (c) Mitchell Hashimoto and contributors",
    },
  ],
  files: spdxFiles,
  relationships: [
    {
      spdxElementId: "SPDXRef-DOCUMENT",
      relationshipType: "DESCRIBES",
      relatedSpdxElement: "SPDXRef-Package-Ghostty",
    },
    ...spdxFiles.map((file) => ({
      spdxElementId: "SPDXRef-Package-Ghostty",
      relationshipType: "CONTAINS",
      relatedSpdxElement: file.SPDXID,
    })),
  ],
};

function writeOctal(header, offset, length, value) {
  const encoded = value.toString(8).padStart(length - 1, "0") + "\0";
  header.write(encoded, offset, length, "ascii");
}

function tarEntry(name, contents) {
  if (Buffer.byteLength(name) > 100) throw new Error(`tar path is too long: ${name}`);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, contents.length);
  writeOctal(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header.write("0", 156, 1, "ascii");
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write("root", 265, 32, "ascii");
  header.write("root", 297, 32, "ascii");
  const checksum = header.reduce((sum, byte) => sum + byte, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  const padding = Buffer.alloc((512 - (contents.length % 512)) % 512);
  return Buffer.concat([header, contents, padding]);
}

const entries = [
  ...inputs.map((file) => [file.bundlePath, file.contents]),
  ["artifact.json", stableJson(artifact)],
  ["sbom.spdx.json", stableJson(sbom)],
].sort(([left], [right]) => compareText(left, right));
const bundle = Buffer.concat([...entries.map(([name, contents]) => tarEntry(name, contents)), Buffer.alloc(1024)]);

mkdirSync(outputDirectory, { recursive: true });
writeFileSync(join(outputDirectory, filename), bundle);
const result = {
  schemaVersion: 1,
  sourceDigest,
  release,
  target,
  filename,
  url: `https://github.com/vibecook-dev/ghosttea/releases/download/${release}/${filename}`,
  sha256: digest("sha256", bundle),
  size: bundle.length,
  libraryPath: library,
  librarySha256: artifact.files[library].sha256,
  headersSha256: treeDigest(inputs.filter((file) => file.bundlePath.startsWith("include/"))),
  reproducible,
};
writeFileSync(join(outputDirectory, `${filename}.json`), stableJson(result));
writeFileSync(join(outputDirectory, `${filename}.spdx.json`), stableJson(sbom));
console.log(JSON.stringify(result, null, 2));
const lockedManifest = JSON.parse(
  readFileSync(join(root, "native/ghosttea/crates/ghosttea-vt-sys/artifacts.json"), "utf8"),
);
const lockedTarget = lockedManifest.targets[target];
if (JSON.stringify(lockedManifest.source) !== JSON.stringify(source)) {
  const message = "native artifact manifest source identity does not match the locked Ghostty VT patch set";
  if (!allowMismatch) throw new Error(message);
  console.warn(message);
}
for (const field of [
  "sourceDigest",
  "release",
  "filename",
  "url",
  "sha256",
  "size",
  "libraryPath",
  "librarySha256",
  "headersSha256",
  "reproducible",
]) {
  if (lockedTarget?.[field] !== result[field]) {
    const message = `native artifact manifest mismatch for ${field}: expected ${JSON.stringify(lockedTarget?.[field])}, got ${JSON.stringify(result[field])}`;
    if (!allowMismatch) throw new Error(message);
    console.warn(message);
  }
}
