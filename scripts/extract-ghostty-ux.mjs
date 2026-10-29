#!/usr/bin/env node
/**
 * Extract Ghostty UX ground truth into bench/ghostty-ux/ground-truth and
 * package fixtures used by the binding matcher tests.
 *
 * Prefers:
 *   1. GHOSTTY env / CLI binary
 *   2. /Applications/Ghostty.app/Contents/MacOS/ghostty
 *
 * The application UX baseline is pinned separately from VT in
 * native/ghostty-config.lock.json. Both the CLI version and reviewed source
 * checkout must match before any fixture is overwritten. GHOSTTY_UX_SOURCE
 * selects that checkout when the VT vendor has moved ahead.
 */

import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");
const outDir = join(root, "bench/ghostty-ux/ground-truth");
const fixtureDir = join(root, "packages/ghosttea-react/src/bindings/fixtures");

function findGhostty() {
  if (process.env.GHOSTTY) return process.env.GHOSTTY;
  const app = "/Applications/Ghostty.app/Contents/MacOS/ghostty";
  if (existsSync(app)) return app;
  try {
    return execFileSync("which", ["ghostty"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
}

function run(bin, args) {
  return execFileSync(bin, args, { encoding: "utf8" });
}

function parseKeybindLine(line) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("keybind")) return null;
  const eq = trimmed.indexOf("=");
  if (eq < 0) return null;
  const rest = trimmed.slice(eq + 1).trim();
  // Action params use ':'; trigger may end with '=' (the key).
  const sep = rest.lastIndexOf("=");
  if (sep < 0) return null;
  return { trigger: rest.slice(0, sep), action: rest.slice(sep + 1) };
}

function write(path, content) {
  writeFileSync(path, content.endsWith("\n") ? content : `${content}\n`);
}

function main() {
  const ghostty = findGhostty();
  if (!ghostty) {
    console.error("ghostty binary not found; set GHOSTTY= or install Ghostty.app");
    process.exit(1);
  }

  const configLock = JSON.parse(readFileSync(join(root, "native/ghostty-config.lock.json"), "utf8"));
  const expected = configLock.uxGroundTruth;
  const version = run(ghostty, ["+version"]);
  const cliVersion = version.match(/version:\s*(\S+)/)?.[1];
  if (!expected || cliVersion !== expected.cliVersion || cliVersion !== configLock.ghostty?.version) {
    throw new Error(`Ghostty CLI ${cliVersion ?? "unknown"} does not match the reviewed config/UX baseline.`);
  }
  const vendorGit = process.env.GHOSTTY_UX_SOURCE ?? join(root, "native/vendor/ghostty");
  const vendorCommit = execFileSync("git", ["-C", vendorGit, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  if (vendorCommit !== expected.vendorCommit) {
    throw new Error(`UX source must be ${expected.vendorCommit}; set GHOSTTY_UX_SOURCE to that reviewed checkout.`);
  }
  const vendorNote =
    `${vendorCommit}\n` +
    execFileSync("git", ["-C", vendorGit, "log", "-1", "--format=%H%n%s%n%ci"], { encoding: "utf8" });

  mkdirSync(outDir, { recursive: true });
  mkdirSync(fixtureDir, { recursive: true });

  write(join(outDir, "ghostty-version.txt"), version);

  const keybindsTxt = run(ghostty, ["+list-keybinds", "--default", "--plain"]);
  write(join(outDir, "keybinds-macos-default.txt"), keybindsTxt);

  const actionsTxt = run(ghostty, ["+list-actions"]);
  write(join(outDir, "actions.txt"), actionsTxt);

  try {
    write(join(outDir, "actions-docs.txt"), run(ghostty, ["+list-actions", "--docs"]));
  } catch {
    // optional
  }

  try {
    write(join(outDir, "config-macos-default.txt"), run(ghostty, ["+show-config", "--default"]));
  } catch {
    // optional
  }

  // CLI dump omits Binding.Flags. Overlay performable from Config.zig macOS defaults.
  const PERFORMABLE_TRIGGERS = new Set([
    "super+c",
    "super+v",
    "shift+arrow_left",
    "shift+arrow_right",
    "shift+arrow_up",
    "shift+arrow_down",
    "shift+page_up",
    "shift+page_down",
    "shift+home",
    "shift+end",
    "super+f",
    "super+e",
    "super+shift+f",
    "escape",
    "super+g",
    "super+shift+g",
    "super+k",
    "super+shift+t",
    "super+z",
    "super+shift+z",
    "super+j",
  ]);

  const bindings = [];
  for (const line of keybindsTxt.split("\n")) {
    const row = parseKeybindLine(line);
    if (row) {
      bindings.push({
        ...row,
        flags: { performable: PERFORMABLE_TRIGGERS.has(row.trigger) },
      });
    }
  }

  const keybindsJson = {
    platform: "macos",
    source: "ghostty +list-keybinds --default --plain",
    ghostty_app: version.match(/version:\s*(\S+)/)?.[1] ?? "unknown",
    count: bindings.length,
    flagsNote: "performable flags from Ghostty src/config/Config.zig Keybinds.init (macOS). CLI dump omits flags.",
    bindings,
  };
  write(join(outDir, "keybinds-macos-default.json"), JSON.stringify(keybindsJson, null, 2));

  const actions = actionsTxt
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  write(join(outDir, "actions-from-source.json"), JSON.stringify(actions, null, 2));

  // The independently reviewed application UX source, not the current VT source.
  write(join(outDir, "vendor-commit.txt"), vendorNote);

  // Intentional Ghosttea extensions (never overwrite note casually)
  const extensions = {
    description: "Ghosttea-only binding extensions (not part of Ghostty defaults).",
    bindings: [
      {
        trigger: "super+shift+o",
        action: "ghosttea.remote_sessions",
        note: "Remote session palette. Intentional product extension; keep this binding.",
      },
    ],
  };
  write(join(outDir, "extensions.json"), JSON.stringify(extensions, null, 2));

  // Package fixtures used at test/runtime
  copyFileSync(join(outDir, "keybinds-macos-default.json"), join(fixtureDir, "keybinds-macos-default.json"));
  copyFileSync(join(outDir, "actions-from-source.json"), join(fixtureDir, "actions-from-source.json"));
  write(join(fixtureDir, "extensions.json"), JSON.stringify(extensions, null, 2));

  console.log(`Extracted ${bindings.length} keybinds and ${actions.length} actions`);
  console.log(`  ground truth → ${outDir}`);
  console.log(`  package fixtures → ${fixtureDir}`);
}

main();
