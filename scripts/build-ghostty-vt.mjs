import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  assertBuildableHost,
  assertGhosttySource,
  installPrefix,
  libraryPath,
  lock,
  resolveTarget,
  root,
  targetConfig,
  zigExecutable,
  zigRoot,
} from "./ghostty-vt-target.mjs";

const target = resolveTarget();
const config = targetConfig(target);
assertBuildableHost(target);

const vendor = join(root, "native/vendor/ghostty");
const output = installPrefix(target);
const zig = zigExecutable(target);

function capture(command, args, cwd = root) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(result.stderr || `${command} failed`);
  return result.stdout.trim();
}

if (!existsSync(join(vendor, ".git")) || !existsSync(zig)) {
  throw new Error(
    `Ghostty sources or Zig are missing. Run \`npm run bootstrap:ghostty-vt -- --target=${target}\` first.`,
  );
}
if (capture("git", ["rev-parse", "HEAD"], vendor) !== lock.ghostty.commit) {
  throw new Error(`Ghostty source is not at locked commit ${lock.ghostty.commit}`);
}
assertGhosttySource(vendor);

mkdirSync(output, { recursive: true });

/**
 * Zig invocation shared by both builders.
 *
 * `resolve` differs per builder because the paths are not in the same
 * namespace: the container sees its mount points, the host sees its own tree.
 */
function zigArguments(resolve) {
  return [
    "build",
    `-j${lock.builder.zigBuildJobs}`,
    "--cache-dir",
    resolve("cache"),
    "--prefix",
    resolve("install"),
    "-Demit-lib-vt",
    "-Demit-xcframework=false",
    `-Doptimize=${lock.builder.zigOptimize}`,
    `-Dtarget=${config.zigTarget}`,
    `-Dcpu=${config.zigCpu}`,
    ...msvcRuntimeArguments(),
  ];
}

/**
 * The C runtime an MSVC target's C and C++ objects are compiled for. Every
 * object in one link must agree, and a Rust consumer links the dynamic runtime
 * unless its target enables `crt-static`, so each runtime is its own target:
 * ghosttea-vt-sys picks the one its build links.
 */
function msvcRuntimeArguments() {
  if (!config.zigTarget.endsWith("-msvc")) return [];
  if (!["dll", "static"].includes(config.msvcRuntime)) {
    throw new Error(`${target} must declare msvcRuntime "dll" or "static" in ghostty.lock.json`);
  }
  return [`-Dmsvc-runtime=${config.msvcRuntime}`];
}

/**
 * Cross-compile inside the pinned builder image. Running Zig in a minimal
 * Linux container avoids coupling the output to the host SDK.
 */
function containerBuild() {
  const cert = ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt"].find(existsSync);
  if (!cert) throw new Error("A host CA certificate bundle is required for Zig dependency downloads.");
  return spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "--platform",
      lock.builder.platform,
      "--user",
      `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`,
      "--env",
      "ZIG_GLOBAL_CACHE_DIR=/out/global",
      "-v",
      `${vendor}:/src:ro`,
      "-v",
      `${zigRoot(target)}:/zig:ro`,
      "-v",
      `${output}:/out`,
      "-v",
      `${cert}:/etc/ssl/certs/ca-certificates.crt:ro`,
      "-w",
      "/src",
      lock.builder.image,
      "/zig/zig",
      // Mount points inside the container, not host paths.
      ...zigArguments((part) => `/out/${part}`),
    ],
    { cwd: root, stdio: "inherit" },
  );
}

/**
 * Build on the host. Required for MSVC targets: Microsoft's CRT headers and
 * import libraries are not redistributable, so Zig cannot supply them from a
 * container and must find an installed MSVC and Windows SDK.
 */
function nativeBuild() {
  return spawnSync(
    zig,
    zigArguments((part) => join(output, part)),
    { cwd: vendor, stdio: "inherit", env: { ...process.env, ZIG_GLOBAL_CACHE_DIR: join(output, "global") } },
  );
}

const result = config.build === "container" ? containerBuild() : nativeBuild();
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);

const library = join(output, "install", libraryPath(target));
if (!existsSync(library)) throw new Error(`Ghostty build completed without ${libraryPath(target)}`);
const licenseDirectory = join(output, "install/share/licenses/ghostty");
mkdirSync(licenseDirectory, { recursive: true });
copyFileSync(join(vendor, "LICENSE"), join(licenseDirectory, "LICENSE"));
console.log(`Built ${library}`);
