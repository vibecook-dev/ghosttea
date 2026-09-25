// Publishes the workspace's npm packages at the release version, each one once
// npm resolves every workspace package it depends on at that version, and
// returns only when npm resolves all of them.
//
// It replaced a helper that published one package at a time and gave each
// about two and a half minutes to become resolvable, which is not how long npm
// takes. npm accepts an upload — `npm publish` prints `+ name@version` and exits
// 0 — well before it records the version: during 0.12.0 the registry's own
// `time[version]` trailed the accepted upload by 56 seconds to 4 minutes 9
// seconds. Four of the ten packages outlasted the helper's budget and failed
// after publishing successfully. Each failure stopped the job behind a rerun
// and another approval of the `release` environment.
//
// So each package now gets twenty minutes (`REGISTRY_VISIBILITY_TIMEOUT_MINUTES`
// overrides that), and the run waits once per layer of the dependency graph
// instead of once per package: a package waits only for the packages it depends
// on. The promise the old fixed order kept still holds, and now holds for every
// dependency rather than the one the order was written around:
// `@vibecook/ghosttead` never exists at a version whose optional dependencies
// do not, and no package names a dependency npm cannot install. The order comes
// from the manifests, not from a list kept beside them.
//
// It is idempotent, like the crate publisher beside it. It skips a package npm
// already resolves at this version. If npm refuses a publish because it
// already holds the version (an earlier attempt's upload that is accepted but
// not yet recorded), the run waits for that version like any other.
//
// usage: node scripts/publish-npm-packages.mjs [--plan] [package ...]
//
// With no names it publishes every package the manifests publish. Named
// packages publish alone, for "First manual publish" in PUBLISHING.md, and
// whatever they depend on must already resolve. `--plan` prints the order and
// publishes nothing.
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import { publishedPackages } from "./release-notes.mjs";

const root = resolve(import.meta.dirname, "..");
const MINUTE = 60_000;

/**
 * Every package under `packages/`, published or not, mapped to the workspace
 * packages its consumers install with it. A private package stays in the map
 * so that a published package depending on one is reported as a dependency
 * nothing publishes, instead of passing for someone else's package.
 */
export function workspaceDependencies() {
  const manifests = readdirSync(join(root, "packages"), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => JSON.parse(readFileSync(join(root, "packages", entry.name, "package.json"), "utf8")));
  const workspace = new Set(manifests.map((manifest) => manifest.name));
  return new Map(
    manifests.map((manifest) => {
      const names = ["dependencies", "optionalDependencies", "peerDependencies"].flatMap((field) =>
        Object.keys(manifest[field] ?? {}),
      );
      return [manifest.name, [...new Set(names.filter((name) => workspace.has(name)))].sort()];
    }),
  );
}

/**
 * The order to publish `names` in. Each entry names the packages of this run it
 * waits for (`after`) and the ones outside it that must already resolve
 * (`requires`). Throws, before anything publishes, on a name the workspace does
 * not have or on packages that depend on each other in a cycle.
 */
export function releasePlan(names, dependencies) {
  const run = new Set(names);
  for (const name of run) {
    if (!dependencies.has(name)) throw new Error(`${name} is not a package in this workspace`);
  }
  const layers = new Map();
  const layerOf = (name, path) => {
    if (layers.has(name)) return layers.get(name);
    if (path.includes(name)) {
      throw new Error(`these packages depend on each other in a cycle: ${[...path, name].join(" -> ")}`);
    }
    const after = dependencies.get(name).filter((dependency) => run.has(dependency));
    const layer = Math.max(-1, ...after.map((dependency) => layerOf(dependency, [...path, name]))) + 1;
    layers.set(name, layer);
    return layer;
  };
  return [...run]
    .map((name) => ({ name, layer: layerOf(name, []) }))
    .sort((a, b) => a.layer - b.layer || (a.name < b.name ? -1 : 1))
    .map(({ name, layer }) => ({
      name,
      layer,
      after: dependencies.get(name).filter((dependency) => run.has(dependency)),
      requires: dependencies.get(name).filter((dependency) => !run.has(dependency)),
    }));
}

/** An elapsed time the way the job log should read it: `4m 09s`. */
function duration(ms) {
  const seconds = Math.round(ms / 1000);
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

/**
 * Publishes `plan` at `version`, settling once npm resolves every package in it.
 *
 * `registry.resolves(name, version)` answers whether a consumer could install
 * that exact version now. `registry.publish(name)` uploads it and answers
 * `{ ok, alreadyPublished }`. `clock` supplies `now()` and `sleep(ms)`. The
 * tests drive all three with a registry that behaves the way npm did during
 * 0.12.0.
 */
export async function publishPlan(
  plan,
  version,
  { registry, clock, log = console.log, visibilityTimeout = 20 * MINUTE, pollInterval = 10_000 },
) {
  const unresolvable = [...new Set(plan.flatMap((entry) => entry.requires))].filter(
    (name) => !registry.resolves(name, version),
  );
  if (unresolvable.length > 0) {
    throw new Error(
      `npm cannot resolve ${unresolvable.map((name) => `${name}@${version}`).join(", ")}, which this run depends on ` +
        `but does not publish. Publish ${unresolvable.length === 1 ? "it" : "them"} first; nothing was published.`,
    );
  }

  const resolved = new Set();
  const awaiting = new Map(); // name -> when this run began waiting for it
  let pending = [...plan];
  let reported = clock.now();
  const unpublished = () =>
    pending.length === 0 ? "" : ` Not published yet: ${pending.map((entry) => entry.name).join(", ")}.`;

  while (pending.length > 0 || awaiting.size > 0) {
    let progressed = false;

    for (const entry of pending.filter((candidate) => candidate.after.every((name) => resolved.has(name)))) {
      pending = pending.filter((candidate) => candidate !== entry);
      progressed = true;
      if (registry.resolves(entry.name, version)) {
        log(`${entry.name}@${version} is already published; skipping`);
        resolved.add(entry.name);
        continue;
      }
      const result = registry.publish(entry.name);
      if (result.alreadyPublished) {
        log(`npm already holds ${entry.name}@${version} from an earlier attempt; waiting for it to resolve`);
      } else if (!result.ok) {
        throw new Error(
          `npm publish failed for ${entry.name}@${version}.${unpublished()} ` +
            "Every step here is idempotent; rerunning resumes where this stopped.",
        );
      }
      awaiting.set(entry.name, clock.now());
    }

    for (const [name, since] of awaiting) {
      if (registry.resolves(name, version)) {
        awaiting.delete(name);
        resolved.add(name);
        progressed = true;
        log(`verified ${name}@${version} on npm after ${duration(clock.now() - since)}`);
      } else if (clock.now() - since >= visibilityTimeout) {
        throw new Error(
          `npm still cannot resolve ${name}@${version} after ${duration(clock.now() - since)}.${unpublished()} ` +
            "Every step here is idempotent; rerunning resumes where this stopped.",
        );
      }
    }

    if (progressed) continue;
    // Unreachable for a plan from `releasePlan`, which refuses cycles; a plan
    // that could never finish must fail rather than poll forever.
    if (awaiting.size === 0) throw new Error(`nothing can publish: ${pending.map((entry) => entry.name).join(", ")}`);
    if (clock.now() - reported >= MINUTE) {
      reported = clock.now();
      const waits = [...awaiting].map(([name, since]) => `${name}@${version} (${duration(clock.now() - since)})`);
      log(`waiting for npm to resolve ${waits.join(", ")}`);
    }
    await clock.sleep(pollInterval);
  }
}

// npm's answer when an upload names a version it already holds, including one
// it accepted from an earlier attempt and has not recorded yet.
const ALREADY_PUBLISHED = /\bEPUBLISHCONFLICT\b|\bE409\b|cannot publish over (?:the )?previously published version/i;

const npm = (args, options = {}) =>
  spawnSync("npm", args, { cwd: root, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, ...options });

export const npmRegistry = {
  // Asked through the same registry front a consumer's install reads, which is
  // the only answer that means the version is actually available.
  resolves(name, version) {
    const result = npm(["view", `${name}@${version}`, "version"], { timeout: MINUTE });
    return result.status === 0 && result.stdout.trim() === version;
  },
  publish(name) {
    const args = ["publish", "--workspace", name, "--access", "public"];
    const provenance = process.env.NPM_CONFIG_PROVENANCE || process.env.npm_config_provenance || "";
    if (provenance === "false" || provenance === "0") args.push("--provenance=false");
    const result = npm(args);
    if (result.error) throw result.error;
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    const ok = result.status === 0;
    return { ok, alreadyPublished: !ok && ALREADY_PUBLISHED.test(`${result.stdout}\n${result.stderr}`) };
  },
};

function describePlan(plan, version) {
  const width = Math.max(...plan.map((entry) => entry.name.length));
  const lines = plan.map((entry) => {
    const waits = [
      entry.after.length > 0 ? `after ${entry.after.join(", ")}` : "",
      entry.requires.length > 0 ? `requires ${entry.requires.join(", ")} already on npm` : "",
    ].filter(Boolean);
    return `  ${entry.layer + 1}. ${entry.name.padEnd(width)}  ${waits.join("; ")}`.trimEnd();
  });
  return [`${plan.length} npm packages publish at ${version}, each once npm resolves what it waits for:`, ...lines, ""];
}

// Importable for tests; publishes when run directly.
if (process.argv[1] === import.meta.filename) {
  const args = process.argv.slice(2);
  const names = args.filter((arg) => arg !== "--plan");
  const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  try {
    const plan = releasePlan(names.length > 0 ? names : publishedPackages(), workspaceDependencies());
    if (args.includes("--plan")) {
      process.stdout.write(describePlan(plan, version).join("\n"));
    } else {
      const setting = process.env.REGISTRY_VISIBILITY_TIMEOUT_MINUTES || "20";
      const minutes = Number(setting);
      if (!Number.isInteger(minutes) || minutes <= 0) {
        throw new Error(`REGISTRY_VISIBILITY_TIMEOUT_MINUTES must be a whole number of minutes, not '${setting}'`);
      }
      await publishPlan(plan, version, {
        registry: npmRegistry,
        clock: { now: Date.now, sleep },
        visibilityTimeout: minutes * MINUTE,
      });
      console.log(`verified ${plan.length} npm packages at ${version}`);
    }
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
