import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const packageVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const artifacts = join(root, "apple/GhostteaKit/Artifacts");
const ghosttyArtifact = join(artifacts, "ghostty-vt.xcframework");
const sshArtifact = join(artifacts, "ghosttea-libssh2-candidate.xcframework");
const output = join(artifacts, "ghosttea-apple-native.xcframework");
const ghosttyBuildMetadataPath = join(root, "native/build/ghostty-apple/build-metadata.json");
const sshBuildMetadataPath = join(root, "native/build/ssh-apple/build-metadata.json");
const coreHeaders = join(root, "native/ghosttea/crates/ghosttea-ffi/include");
const fontFixtureHeaders = join(root, "native/ghosttea/crates/ghosttea-font-fixture-ffi/include");
const publicHeaders = [join(coreHeaders, "ghosttea.h"), join(fontFixtureHeaders, "ghosttea_font_fixture.h")];
const work = join(root, "native/build/ghosttea-apple-native");
const prefixRoot = join(work, "ghostty-prefixes");
const developerDir = process.env.DEVELOPER_DIR ?? "/Applications/Xcode.app/Contents/Developer";
const environment = {
  ...process.env,
  DEVELOPER_DIR: developerDir,
  IPHONEOS_DEPLOYMENT_TARGET: "17.0",
  MACOSX_DEPLOYMENT_TARGET: "14.0",
};

function execute(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    env: { ...environment, ...options.environment },
    encoding: options.capture ? "utf8" : undefined,
    maxBuffer: options.capture ? 64 * 1024 * 1024 : undefined,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowedStatuses?.includes(result.status)) {
    throw new Error(
      options.capture
        ? `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`
        : `${command} ${args.join(" ")} failed with exit code ${result.status ?? 1}`,
    );
  }
  return options.capture ? result.stdout.trim() : "";
}

function capture(command, args) {
  return execute(command, args, { capture: true });
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function readXCFramework(path) {
  return JSON.parse(capture("plutil", ["-convert", "json", "-o", "-", join(path, "Info.plist")]));
}

function sliceFor(info, platform, variant) {
  const slice = info.AvailableLibraries?.find(
    (candidate) =>
      candidate.SupportedPlatform === platform &&
      candidate.SupportedPlatformVariant === variant &&
      candidate.SupportedArchitectures?.includes("arm64"),
  );
  if (!slice) throw new Error(`Missing ${platform}${variant ? `-${variant}` : ""} arm64 slice.`);
  return slice;
}

function libraryPath(artifact, slice) {
  return join(artifact, slice.LibraryIdentifier, slice.LibraryPath);
}

function headersPath(artifact, slice) {
  return join(artifact, slice.LibraryIdentifier, slice.HeadersPath);
}

function publicCAbiSymbols() {
  const symbols = new Set();
  for (const header of publicHeaders) {
    for (const match of readFileSync(header, "utf8").matchAll(/\b(ghosttea_[a-z0-9_]+)\s*\(/g)) {
      symbols.add(`_${match[1]}`);
    }
  }
  if (symbols.size === 0) throw new Error("No public Ghosttea C ABI functions were found in the reviewed headers.");
  return [...symbols].sort();
}

function requireExactCAbi(library) {
  // Apple's nm returns 1 when any archive member has no external symbols, even
  // though it successfully prints the rest of the archive. That is expected
  // for Rust metadata/object members, so accept 1 and validate the output.
  const definitions = execute("nm", ["-gjU", library], {
    capture: true,
    allowedStatuses: [1],
  })
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("_ghosttea_"));
  const counts = new Map();
  for (const definition of definitions) counts.set(definition, (counts.get(definition) ?? 0) + 1);

  const expected = publicCAbiSymbols();
  const expectedSet = new Set(expected);
  const problems = [];
  for (const symbol of expected) {
    const count = counts.get(symbol) ?? 0;
    if (count !== 1) problems.push(`${symbol} has ${count} definitions`);
  }
  for (const symbol of [...counts.keys()].sort()) {
    if (!expectedSet.has(symbol)) problems.push(`${symbol} is exported but absent from the public headers`);
  }
  if (problems.length > 0) {
    throw new Error(
      `${library} does not expose the exact reviewed Ghosttea C ABI:\n- ${problems.join(
        "\n- ",
      )}\nThe Apple native archive must contain one unified, documented Rust linkage unit.`,
    );
  }
}

function requireUniqueMembers(library) {
  const members = capture("xcrun", ["ar", "-t", library]).split("\n").filter(Boolean);
  const seen = new Set();
  const duplicates = new Set();
  for (const member of members) {
    if (seen.has(member)) duplicates.add(member);
    seen.add(member);
  }
  if (duplicates.size > 0) {
    throw new Error(`${library} contains duplicate archive members: ${[...duplicates].sort().join(", ")}`);
  }
}

function requireDefinitions(library, symbols, description) {
  const definitions = new Set(
    execute("nm", ["-gjU", library], {
      capture: true,
      allowedStatuses: [1],
    })
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
  );
  const missing = symbols.filter((symbol) => !definitions.has(symbol));
  if (missing.length > 0) {
    throw new Error(
      `${library} is missing ${description}: ${missing.join(", ")}. ` +
        "The Apple native artifact must not depend on libraries discovered from the build host.",
    );
  }
}

if (process.platform !== "darwin" || process.arch !== "arm64") {
  throw new Error("Building GhostteaAppleNative requires Apple Silicon macOS.");
}
if (!existsSync(join(developerDir, "usr/bin/xcodebuild"))) {
  throw new Error(`Full Xcode is required at ${developerDir}.`);
}
for (const artifact of [ghosttyArtifact, sshArtifact]) {
  if (!existsSync(join(artifact, "Info.plist"))) {
    throw new Error(`Missing ${artifact}. Bootstrap the pinned Apple native inputs first.`);
  }
}
for (const metadata of [ghosttyBuildMetadataPath, sshBuildMetadataPath]) {
  if (!existsSync(metadata)) {
    throw new Error(`Missing input provenance ${metadata}. Rebuild the pinned Apple native inputs first.`);
  }
}

const ghosttyBuildMetadata = JSON.parse(readFileSync(ghosttyBuildMetadataPath, "utf8"));
const sshBuildMetadata = JSON.parse(readFileSync(sshBuildMetadataPath, "utf8"));

execute(process.execPath, [join(root, "scripts/check-ios-release-toolchain.mjs")]);
execute(process.execPath, [join(root, "scripts/sync-ghosttea-fonts.mjs")]);

const ghosttyInfo = readXCFramework(ghosttyArtifact);
const sshInfo = readXCFramework(sshArtifact);
rmSync(work, { recursive: true, force: true });
rmSync(output, { recursive: true, force: true });
mkdirSync(prefixRoot, { recursive: true });

const platforms = [
  {
    name: "macos-arm64",
    platform: "macos",
    variant: undefined,
    target: "aarch64-apple-darwin",
  },
  {
    name: "ios-arm64",
    platform: "ios",
    variant: undefined,
    target: "aarch64-apple-ios",
  },
  {
    name: "ios-arm64-simulator",
    platform: "ios",
    variant: "simulator",
    target: "aarch64-apple-ios-sim",
  },
];

function stageGhosttyPrefix(platform) {
  const slice = sliceFor(ghosttyInfo, platform.platform, platform.variant);
  const sliceRoot = join(ghosttyArtifact, slice.LibraryIdentifier);
  const prefix = join(prefixRoot, platform.target);
  const libraryDirectory = join(prefix, "lib");
  mkdirSync(libraryDirectory, { recursive: true });
  cpSync(join(sliceRoot, slice.HeadersPath, "ghostty"), join(prefix, "include/ghostty"), {
    recursive: true,
  });
  const sourceLibrary = join(sliceRoot, slice.LibraryPath);
  const outputLibrary = join(libraryDirectory, "libghostty-vt.a");
  const architectures = capture("xcrun", ["lipo", "-archs", sourceLibrary]).split(/\s+/);
  if (architectures.length > 1) {
    execute("xcrun", ["lipo", sourceLibrary, "-thin", "arm64", "-output", outputLibrary]);
  } else {
    cpSync(sourceLibrary, outputLibrary);
  }
  return prefix;
}

for (const platform of platforms) {
  const prefix = stageGhosttyPrefix(platform);
  execute("cargo", ["build", "--locked", "--release", "-p", "ghosttea-apple-ffi", "--target", platform.target], {
    environment: {
      GHOSTTY_VT_PREFIX: prefix,
    },
  });
}

const libraries = [];
for (const platform of platforms) {
  const directory = join(work, platform.name);
  const headers = join(directory, "Headers");
  const ghosttySlice = sliceFor(ghosttyInfo, platform.platform, platform.variant);
  const sshSlice = sliceFor(sshInfo, platform.platform, platform.variant);
  const ghosttyHeaders = headersPath(ghosttyArtifact, ghosttySlice);
  const sshHeaders = headersPath(sshArtifact, sshSlice);
  mkdirSync(headers, { recursive: true });
  cpSync(join(ghosttyHeaders, "ghostty"), join(headers, "ghostty"), { recursive: true });
  for (const header of ["libssh2.h", "libssh2_publickey.h", "libssh2_sftp.h"]) {
    cpSync(join(sshHeaders, header), join(headers, header));
  }
  cpSync(join(fontFixtureHeaders, "ghosttea_font_fixture.h"), join(headers, "ghosttea_font_fixture.h"));
  cpSync(join(coreHeaders, "ghosttea.h"), join(headers, "ghosttea.h"));
  writeFileSync(
    join(headers, "module.modulemap"),
    [
      "module GhosttyVt {",
      '  umbrella header "ghostty/vt.h"',
      "  export *",
      "}",
      "module LibSSH2Candidate {",
      '  header "libssh2.h"',
      '  header "libssh2_publickey.h"',
      '  header "libssh2_sftp.h"',
      "  export *",
      "}",
      "module GhostteaFontFixtureNative {",
      '  header "ghosttea_font_fixture.h"',
      "  export *",
      "}",
      "module GhostteaCoreNative {",
      '  header "ghosttea.h"',
      "  export *",
      "}",
      "",
    ].join("\n"),
  );

  const rustLibrary = join(root, "target", platform.target, "release", "libghosttea_apple_ffi.a");
  if (!existsSync(rustLibrary)) throw new Error(`Missing unified Rust static library ${rustLibrary}.`);
  requireExactCAbi(rustLibrary);
  requireDefinitions(rustLibrary, ["_hb_blob_create", "_hb_shape"], "embedded HarfBuzz definitions");
  requireUniqueMembers(rustLibrary);

  const library = join(directory, "libghosttea-apple-native.a");
  execute("xcrun", ["libtool", "-static", "-o", library, rustLibrary, libraryPath(sshArtifact, sshSlice)]);
  requireExactCAbi(library);
  requireUniqueMembers(library);
  libraries.push({ ...platform, library, headers });
}

const xcframeworkArguments = ["-create-xcframework"];
for (const slice of libraries) {
  xcframeworkArguments.push("-library", slice.library, "-headers", slice.headers);
}
xcframeworkArguments.push("-output", output);
execute("xcodebuild", xcframeworkArguments);

writeFileSync(
  join(work, "metadata.json"),
  `${JSON.stringify(
    {
      schemaVersion: 3,
      packageVersion,
      sourceCommit: capture("git", ["rev-parse", "HEAD"]),
      sourceDirty: capture("git", ["status", "--porcelain"]).length > 0,
      rustc: capture("rustc", ["--version"]),
      xcode: capture("xcodebuild", ["-version"]).split("\n"),
      inputs: {
        ghostty: ghosttyBuildMetadata,
        sshCandidate: sshBuildMetadata,
      },
      headers: {
        coreSha256: sha256(join(coreHeaders, "ghosttea.h")),
        fontFixtureSha256: sha256(join(fontFixtureHeaders, "ghosttea_font_fixture.h")),
      },
      slices: libraries.map((slice) => ({
        target: slice.target,
        librarySha256: sha256(slice.library),
      })),
    },
    null,
    2,
  )}\n`,
);

console.log(`Built ${output} from one unified Rust static library per platform.`);
