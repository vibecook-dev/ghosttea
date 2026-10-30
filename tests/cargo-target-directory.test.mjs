import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { cargoTargetDirectory } from "../scripts/cargo-target-directory.mjs";

test("archive consumers follow Cargo's configured directory and environment override", (t) => {
  const fixture = realpathSync(mkdtempSync(join(tmpdir(), "ghosttea-cargo-target-")));
  t.after(() => rmSync(fixture, { recursive: true, force: true }));
  const root = join(fixture, "workspace");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".cargo"));
  const cargoHome = join(fixture, "cargo-home");
  mkdirSync(cargoHome);
  writeFileSync(join(root, "Cargo.toml"), '[package]\nname = "target-probe"\nversion = "0.0.0"\nedition = "2024"\n');
  writeFileSync(join(root, "src/lib.rs"), "");
  writeFileSync(join(root, "Cargo.lock"), 'version = 4\n\n[[package]]\nname = "target-probe"\nversion = "0.0.0"\n');
  const env = { ...process.env, CARGO_HOME: cargoHome };
  delete env.CARGO_TARGET_DIR;
  delete env.CARGO_BUILD_TARGET_DIR;
  assert.equal(cargoTargetDirectory(root, env), join(root, "target"));

  const external = join(fixture, "portable SSD", "build cache");
  writeFileSync(join(root, ".cargo/config.toml"), `[build]\ntarget-dir = ${JSON.stringify(external)}\n`);
  assert.equal(cargoTargetDirectory(root, env), external);

  const override = join(fixture, "isolated candidate");
  assert.equal(cargoTargetDirectory(root, { ...env, CARGO_TARGET_DIR: override }), override);
});
