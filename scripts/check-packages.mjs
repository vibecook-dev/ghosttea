import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { resolveTarget } from "./ghostty-vt-target.mjs";

const root = resolve(import.meta.dirname, "..");
const fixture = mkdtempSync(join(tmpdir(), "ghosttea-package-check-"));
const cache = join(fixture, "npm-cache");
/**
 * Run npm without going through its Windows `.cmd` shim.
 *
 * Node refuses to `execFile` a `.cmd` (CVE-2024-27980) and running one through
 * a shell would put every argument through cmd quoting. npm sets
 * `npm_execpath` for the scripts it invokes, so its CLI runs directly under
 * this Node instead; the shim is only a fallback for running this file by hand.
 */
function runNpm(args, options = {}) {
  const cli = process.env.npm_execpath;
  if (cli) return run(process.execPath, [cli, ...args], options);
  return run(process.platform === "win32" ? "npm.cmd" : "npm", args, {
    ...options,
    shell: process.platform === "win32",
  });
}

/**
 * Git for Windows puts GNU tar ahead of the system bsdtar on PATH, and GNU tar
 * reads the drive colon in an absolute Windows path as a remote host. Name the
 * system archiver so extraction targets stay local paths.
 */
const bsdtar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
const tar = process.platform === "win32" && existsSync(bsdtar) ? bsdtar : "tar";

function run(command, args, options = {}) {
  return execFileSync(command, args, {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    ...options,
  }).trim();
}

const npmPackages = [
  "@vibecook/ghosttea-protocol",
  "@vibecook/ghosttea-frame",
  "@vibecook/ghosttea",
  "@vibecook/ghosttea-client",
  "@vibecook/ghosttea-electron",
  "@vibecook/ghosttea-react",
  "@vibecook/ghosttea-native-tabs",
  "@vibecook/ghosttead",
];

// The daemon platform packages carry only a binary the release workflow
// stages, so at gate time their tarballs are almost empty — and that is the
// point of packing them anyway: a manifest mistake in a nearly empty package
// is caught where every other manifest mistake is. They are never installed
// into the fixture; the fixture install omits optional dependencies so the
// resolver's graph resolves offline without them.
const daemonPlatformPackages = ["@vibecook/ghosttead-darwin-arm64", "@vibecook/ghosttead-win32-x64"];

const rustPackages = [
  "ghosttea-vt-sys",
  "ghosttea-text",
  "ghosttea-vt",
  "ghosttea-config",
  "ghosttea-core",
  "ghosttea",
  "ghosttea-truffle",
];
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
// The consumer fixture links the artifact for the target it is building, and
// `fetch:ghostty-vt` resolves the same one, so the bundle is already present.
const nativeArtifact = JSON.parse(
  readFileSync(join(root, "native/ghosttea/crates/ghosttea-vt-sys/artifacts.json"), "utf8"),
).targets[resolveTarget()];

try {
  const tarballs = new Map();
  for (const workspace of npmPackages) {
    const output = runNpm([
      "pack",
      "--json",
      "--cache",
      cache,
      "--pack-destination",
      fixture,
      "--workspace",
      workspace,
    ]);
    const packResult = JSON.parse(output);
    const packed = Array.isArray(packResult) ? packResult[0] : packResult.name ? packResult : packResult[workspace];
    if (!packed || packed.name !== workspace) throw new Error(`npm packed the wrong workspace for ${workspace}`);
    const paths = new Set(packed.files.map((file) => file.path));
    for (const required of ["LICENSE", "README.md", "dist/index.js", "dist/index.d.ts", "package.json"]) {
      if (!paths.has(required)) throw new Error(`${workspace} tarball is missing ${required}`);
    }
    const packageSpecific =
      workspace === "@vibecook/ghosttea-electron"
        ? [
            "dist/main.js",
            "dist/main.d.ts",
            "dist/preload.js",
            "dist/types.js",
            "dist/automation.js",
            "dist/automation.d.ts",
            "dist/bridge-entry.js",
          ]
        : workspace === "@vibecook/ghosttea-react"
          ? [
              "dist/styles.css",
              "dist/workspace.css",
              "dist/workspace/index.js",
              "dist/workspace/index.d.ts",
              "dist/terminal-render.worker.js",
            ]
          : [];
    for (const required of packageSpecific) {
      if (!paths.has(required)) throw new Error(`${workspace} tarball is missing ${required}`);
    }
    if ([...paths].some((path) => path.startsWith("src/") || path.includes(".test."))) {
      throw new Error(`${workspace} tarball contains source or test files`);
    }
    tarballs.set(workspace, join(fixture, packed.filename));
  }

  for (const workspace of daemonPlatformPackages) {
    const output = runNpm([
      "pack",
      "--json",
      "--cache",
      cache,
      "--pack-destination",
      fixture,
      "--workspace",
      workspace,
    ]);
    const packResult = JSON.parse(output);
    const packed = Array.isArray(packResult) ? packResult[0] : packResult.name ? packResult : packResult[workspace];
    if (!packed || packed.name !== workspace) throw new Error(`npm packed the wrong workspace for ${workspace}`);
    const paths = new Set(packed.files.map((file) => file.path));
    for (const required of ["LICENSE", "README.md", "package.json"]) {
      if (!paths.has(required)) throw new Error(`${workspace} tarball is missing ${required}`);
    }
  }

  writeFileSync(
    join(fixture, "package.json"),
    JSON.stringify(
      {
        name: "ghosttea-external-consumer-fixture",
        private: true,
        type: "module",
        dependencies: Object.fromEntries([...tarballs].map(([name, tarball]) => [name, `file:./${basename(tarball)}`])),
      },
      null,
      2,
    ),
  );
  writeFileSync(
    join(fixture, "smoke.mjs"),
    [
      'import { ControlClient } from "@vibecook/ghosttea";',
      'import { FRAME_MAGIC } from "@vibecook/ghosttea-frame";',
      'import { PROTOCOL_MAJOR } from "@vibecook/ghosttea-protocol";',
      'import { GhostteaAutomationClient as NodeAutomationClient } from "@vibecook/ghosttea-client";',
      'import { GhostteaAutomationClient as ElectronAutomationClient } from "@vibecook/ghosttea-electron/automation";',
      'import { SUPPORTED_TARGETS, ghostteadPath } from "@vibecook/ghosttead";',
      'import { addonPath as nativeTabsAddonPath } from "@vibecook/ghosttea-native-tabs";',
      'import { existsSync, readFileSync } from "node:fs";',
      'import { createRequire } from "node:module";',
      'import { join } from "node:path";',
      'if (typeof ControlClient !== "function" || typeof NodeAutomationClient !== "function" || ElectronAutomationClient !== NodeAutomationClient || FRAME_MAGIC !== 0x31465254 || PROTOCOL_MAJOR !== 1) {',
      '  throw new Error("installed Ghosttea packages expose an invalid runtime API");',
      "}",
      'for (const file of ["@vibecook/ghosttea-electron/dist/bridge-entry.js", "@vibecook/ghosttea-react/dist/terminal-render.worker.js"]) {',
      '  if (!existsSync(join("node_modules", file))) throw new Error(`installed Ghosttea package is missing ${file}`);',
      "}",
      'const worker = readFileSync(join("node_modules", "@vibecook/ghosttea-react/dist/terminal-render.worker.js"), "utf8");',
      'if (/^\\s*import\\s/m.test(worker)) throw new Error("Ghosttea render worker is not a self-contained browser artifact");',
      'if (!SUPPORTED_TARGETS.includes("darwin-arm64") || !SUPPORTED_TARGETS.includes("win32-x64")) {',
      '  throw new Error("ghosttead lost a supported target");',
      "}",
      "// Installed without optional dependencies and without staged binaries,",
      "// so daemon resolution must fail closed with the diagnosis for this",
      "// exact state — never a bare module error, never a path to nothing.",
      "try {",
      "  ghostteadPath({ env: {} });",
      '  throw new Error("ghosttead resolved with no platform package installed");',
      "} catch (error) {",
      "  const target = `${process.platform}-${process.arch}`;",
      '  const expected = SUPPORTED_TARGETS.includes(target) ? "optional dependency" : "no prebuilt binary";',
      "  if (!String(error).includes(expected)) throw error;",
      "}",
      'if (process.platform === "darwin") {',
      "  try {",
      "    const tabs = nativeTabsAddonPath();",
      '    if (typeof tabs !== "string" || !existsSync(tabs)) throw new Error(`native tabs addon path is broken: ${tabs}`);',
      "  } catch (error) {",
      "    // Legitimate inside the repository: nothing staged a prebuild. The",
      "    // error must say what produces one.",
      '    if (!String(error).includes("build:ghosttea-native-tabs")) throw error;',
      "  }",
      "} else if (nativeTabsAddonPath() !== null) {",
      '  throw new Error("native tabs addon path must be null off macOS");',
      "}",
      "// An Electron main process is usually a CommonJS bundle, so the",
      "// resolver packages must stay reachable through require() as well as",
      "// import — the exports maps carry a require condition for exactly this.",
      "const requireProbe = createRequire(import.meta.url);",
      'if (typeof requireProbe("@vibecook/ghosttead").ghostteadPath !== "function") {',
      '  throw new Error("@vibecook/ghosttead cannot be required from CommonJS");',
      "}",
      'if (typeof requireProbe("@vibecook/ghosttea-native-tabs").addonPath !== "function") {',
      '  throw new Error("@vibecook/ghosttea-native-tabs cannot be required from CommonJS");',
      "}",
      'console.log("external npm consumer fixture passed");',
      "",
    ].join("\n"),
  );
  // `--omit=optional` keeps `@vibecook/ghosttead`'s platform packages out of
  // the resolution: at gate time this version exists nowhere but these
  // tarballs, so an offline install that tried to resolve them would fail.
  // The smoke below asserts the resolver diagnoses exactly that state.
  runNpm(
    [
      "install",
      "--ignore-scripts",
      "--legacy-peer-deps",
      "--offline",
      "--omit=optional",
      "--no-audit",
      "--no-fund",
      "--cache",
      cache,
    ],
    { cwd: fixture },
  );
  process.stdout.write(run(process.execPath, ["smoke.mjs"], { cwd: fixture }) + "\n");

  for (const crate of rustPackages) {
    const files = new Set(run("cargo", ["package", "--list", "--allow-dirty", "--package", crate]).split("\n"));
    for (const required of ["Cargo.toml", "LICENSE", "README.md"]) {
      if (!files.has(required)) throw new Error(`${crate} package is missing ${required}`);
    }
    if (crate === "ghosttea-vt-sys") {
      for (const required of ["artifacts.json", "build.rs", "src/ghostty_shim.c", "src/ghostty_shim.h"]) {
        if (!files.has(required)) throw new Error(`${crate} package is missing ${required}`);
      }
    }
    if (crate === "ghosttea-vt" && [...files].some((file) => file.endsWith(".c") || file === "build.rs")) {
      throw new Error("ghosttea-vt package still owns native build implementation");
    }
  }

  const rustCrates = join(fixture, "rust-crates");
  mkdirSync(rustCrates);
  // Fresh archives must belong to this fixture, even when Cargo's configured
  // target is shared by other checkouts or lives on an external drive.
  const cargoTarget = join(fixture, "rust-package-target");
  run("cargo", [
    "package",
    "--target-dir",
    cargoTarget,
    "--workspace",
    "--exclude",
    "ghosttead",
    "--exclude",
    "ghosttea-apple-ffi",
    "--exclude",
    "ghosttea-ffi",
    "--exclude",
    "ghosttea-font-fixture-ffi",
    "--exclude",
    "ghosttea-vt-crt-witness",
    "--allow-dirty",
    "--no-verify",
  ]);
  for (const crate of rustPackages) {
    run(tar, ["-xzf", join(cargoTarget, `package/${crate}-${version}.crate`), "-C", rustCrates]);
  }

  const embeddingConsumer = join(fixture, "rust-embedding-consumer");
  mkdirSync(join(embeddingConsumer, "src"), { recursive: true });
  const cratePath = (name) => join(rustCrates, `${name}-${version}`).replaceAll("\\", "/");
  // A host shares Ghosttea's `Node` type only when both resolve the same
  // `truffle-core`, so the consumer pins it exactly as the workspace does. It is
  // read from the workspace's one declaration: a copy kept here stayed at 0.7.12
  // when the workspace moved to 0.7.19.
  const truffleCore = /^truffle-core = ("=[^"]+")$/m.exec(readFileSync(join(root, "Cargo.toml"), "utf8"))?.[1];
  if (!truffleCore) throw new Error('Cargo.toml declares no exact `truffle-core = "=X.Y.Z"` requirement');
  writeFileSync(
    join(embeddingConsumer, "Cargo.toml"),
    [
      "[package]",
      'name = "ghosttea-external-embedding-consumer"',
      'version = "0.0.0"',
      'edition = "2024"',
      'rust-version = "1.88"',
      "",
      "[dependencies]",
      'anyhow = "1"',
      `ghosttea = { path = ${JSON.stringify(cratePath("ghosttea"))} }`,
      `ghosttea-truffle = { path = ${JSON.stringify(cratePath("ghosttea-truffle"))} }`,
      'tokio = { version = "1.45", features = ["full"] }',
      `truffle-core = ${truffleCore}`,
      "",
      "[patch.crates-io]",
      `ghosttea-vt-sys = { path = ${JSON.stringify(cratePath("ghosttea-vt-sys"))} }`,
      `ghosttea-text = { path = ${JSON.stringify(cratePath("ghosttea-text"))} }`,
      `ghosttea-vt = { path = ${JSON.stringify(cratePath("ghosttea-vt"))} }`,
      `ghosttea-config = { path = ${JSON.stringify(cratePath("ghosttea-config"))} }`,
      `ghosttea-core = { path = ${JSON.stringify(cratePath("ghosttea-core"))} }`,
      `ghosttea = { path = ${JSON.stringify(cratePath("ghosttea"))} }`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(embeddingConsumer, "src/main.rs"),
    [
      "use std::sync::Arc;",
      "",
      "use anyhow::Result;",
      "use ghosttea::{ipc, TerminalService, TerminalServiceConfig, TerminalServiceListeners};",
      "use ghosttea_truffle::{TruffleTerminalConfig, TruffleTerminalMesh};",
      "use truffle_core::{Node, network::tailscale::TailscaleProvider};",
      "",
      "#[allow(dead_code)]",
      "async fn serve_embedded(",
      "    node: Arc<Node<TailscaleProvider>> ,",
      "    control_path: String,",
      "    frame_path: String,",
      "    token: String,",
      ") -> Result<()> {",
      "    // Mirrors the documented embedding flow, so a consumer compiles the",
      "    // calls a host actually makes rather than only the types it passes.",
      "    ipc::remove_stale_endpoint(&control_path)?;",
      "    ipc::remove_stale_endpoint(&frame_path)?;",
      "    let control = ipc::Listener::bind(&control_path)?;",
      "    let frames = ipc::Listener::bind(&frame_path)?;",
      "    let mesh = TruffleTerminalMesh::new(node, TruffleTerminalConfig::default())?;",
      "    TerminalService::new(TerminalServiceConfig { control_socket: String::new(), frame_socket: String::new(), auth_token: token })",
      '        .with_private_env_prefixes(["FIELD_"])?',
      "        .with_terminal_mesh(mesh)",
      "        .serve(TerminalServiceListeners::new(control, frames))",
      "        .await",
      "}",
      "",
      "fn main() {}",
      "",
    ].join("\n"),
  );
  run("cargo", ["check"], {
    cwd: embeddingConsumer,
    env: {
      ...process.env,
      CARGO_TARGET_DIR: join(fixture, "rust-embedding-target"),
      GHOSTTEA_GHOSTTY_VT_BUNDLE: join(root, "artifacts/ghostty-vt", nativeArtifact.filename),
    },
  });
  console.log("external packaged Rust embedding fixture passed");
  console.log("Ghosttea package layouts passed");
} finally {
  rmSync(fixture, { recursive: true, force: true });
}
