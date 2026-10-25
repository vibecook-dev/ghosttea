// The Apple native source digest has to cover every crate compiled into the
// artifact. ghosttea-config, which ghosttea-ffi links, sat outside it through
// 0.13.2; check-apple-native-artifact.mjs now derives the compiled crates from the
// manifests and fails on any the list misses.
import assert from "node:assert/strict";
import { test } from "node:test";

import { pathDependencies, workspacePathDependencies } from "../scripts/cargo-path-dependencies.mjs";
import {
  appleNativeCrates,
  nativeSourceInputs,
  uncoveredAppleNativeCrates,
} from "../scripts/ghosttea-apple-native-artifact.mjs";

const crate = (name) => `native/ghosttea/crates/ghosttea-${name}`;

test("the artifact compiles ghosttea-apple-ffi and every crate its path dependencies reach", () => {
  const linked = ["apple-ffi", "config", "core", "ffi", "font-fixture-ffi", "text", "vt", "vt-sys"];
  assert.deepEqual(appleNativeCrates(), linked.map(crate));
});

test("nativeSourceInputs covers every compiled crate, and the check catches one it drops", () => {
  assert.deepEqual(uncoveredAppleNativeCrates(), []);
  const asThrough0132 = nativeSourceInputs.filter((input) => input !== crate("config"));
  assert.deepEqual(uncoveredAppleNativeCrates(asThrough0132), [crate("config")]);
});

test("path dependencies come from every compiled table form, never from dev-dependencies", () => {
  const workspace = workspacePathDependencies(
    ["[workspace.dependencies]", 'inherited = { path = "native/inherited" }', 'registry = "1.0"'].join("\n"),
  );
  const manifest = [
    "[package]",
    "version.workspace = true",
    "[dependencies]",
    'serde = { version = "1", features = ["derive"] }',
    'alpha = { path = "../alpha", version = "0.1" } # inline',
    'beta.path = "../beta"',
    "inherited = { workspace = true }",
    "registry = { workspace = true }",
    "[dev-dependencies]",
    'dev-only = { path = "../dev-only" }',
    "[target.'cfg(unix)'.dependencies]",
    'gamma = { path = "../gamma" }',
    "[target.'cfg(windows)'.dev-dependencies]",
    'windows-dev = { path = "../windows-dev" }',
    "[build-dependencies]",
    'delta = { path = "../delta" }',
    "[dependencies.epsilon]",
    'version = "0.2"',
    'path = "../epsilon"',
  ].join("\r\n");
  const describe = ({ name, path, fromWorkspace }) => `${name}${fromWorkspace ? "@" : ":"}${path}`;
  assert.deepEqual(pathDependencies(manifest, workspace).map(describe), [
    "alpha:../alpha",
    "beta:../beta",
    "inherited@native/inherited",
    "gamma:../gamma",
    "delta:../delta",
    "epsilon:../epsilon",
  ]);
});
