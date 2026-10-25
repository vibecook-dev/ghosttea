// The path dependencies a Cargo manifest declares, read without Cargo.
//
// scripts/ghosttea-apple-native-artifact.mjs walks these from ghosttea-apple-ffi
// to find every workspace crate compiled into the Apple native artifact, so the
// artifact's source digest can be checked against what is actually linked. The
// checks that use it run where no Rust toolchain is guaranteed, and nothing here
// touches the filesystem, so the parsing is tested on its own.
//
// It reads the forms this workspace uses and the ones Cargo documents beside them:
// inline tables (`name = { path = "…" }`), dotted keys (`name.path = "…"`),
// dotted tables (`[dependencies.name]`), target-specific tables, and
// `workspace = true` resolved through the root manifest's
// [workspace.dependencies]. [dev-dependencies] are skipped: they never compile
// into a library.

const dependencyTable = /^\[(?:target\.[^\]]+\.)?(?:build-)?dependencies(?:\.([A-Za-z0-9_-]+))?\]$/;
const workspaceTable = /^\[workspace\.dependencies(?:\.([A-Za-z0-9_-]+))?\]$/;
const inlineEntry = /^([A-Za-z0-9_-]+)\s*=\s*\{(.*)\}\s*(?:#.*)?$/;
const dottedEntry = /^([A-Za-z0-9_-]+)\.([A-Za-z0-9_-]+)\s*=\s*(.+?)\s*(?:#.*)?$/;

/** Each matching table's entries, as `{ name, fields }` with the entry's own text. */
function entries(manifestText, table) {
  const found = [];
  let current = null;
  for (const line of manifestText.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) {
      const match = trimmed.match(table);
      current = match ? { dotted: match[1] } : null;
      if (current?.dotted) found.push({ name: current.dotted, fields: "" });
      continue;
    }
    if (!current || trimmed === "" || trimmed.startsWith("#")) continue;
    if (current.dotted) {
      found.at(-1).fields += ` ${trimmed}`;
      continue;
    }
    const inline = trimmed.match(inlineEntry);
    if (inline) {
      found.push({ name: inline[1], fields: inline[2] });
      continue;
    }
    const dotted = trimmed.match(dottedEntry);
    if (dotted) found.push({ name: dotted[1], fields: `${dotted[2]} = ${dotted[3]}` });
  }
  return found;
}

const pathOf = (fields) => fields.match(/\bpath\s*=\s*"([^"]+)"/)?.[1];
const inherits = (fields) => /\bworkspace\s*=\s*true\b/.test(fields);

/** The root manifest's [workspace.dependencies] that are paths: name to root-relative path. */
export function workspacePathDependencies(rootManifestText) {
  const paths = new Map();
  for (const { name, fields } of entries(rootManifestText, workspaceTable)) {
    const path = pathOf(fields);
    if (path) paths.set(name, path);
  }
  return paths;
}

/**
 * A crate manifest's path dependencies. Each is `{ name, path, fromWorkspace }`:
 * `path` is relative to the crate's directory, or to the workspace root when
 * `fromWorkspace` is true because the entry inherits it.
 */
export function pathDependencies(manifestText, workspace = new Map()) {
  const dependencies = [];
  for (const { name, fields } of entries(manifestText, dependencyTable)) {
    const path = pathOf(fields);
    if (path) dependencies.push({ name, path, fromWorkspace: false });
    else if (inherits(fields) && workspace.has(name)) {
      dependencies.push({ name, path: workspace.get(name), fromWorkspace: true });
    }
  }
  return dependencies;
}
