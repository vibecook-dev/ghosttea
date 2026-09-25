// The npm publisher runs once per release, on a tag, behind an approval of the
// `release` environment, and every failure it reports costs a rerun and another
// approval. Its order, its waiting, and its idempotence are pinned here against
// a registry that behaves the way npm did during 0.12.0: it accepts an upload
// at once and serves it minutes later.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { publishPlan, releasePlan, workspaceDependencies } from "../scripts/publish-npm-packages.mjs";
import { publishedPackages } from "../scripts/release-notes.mjs";

const SECOND = 1000;
const MINUTE = 60 * SECOND;

// How long npm took to record each 0.12.0 upload: the registry's
// `time["0.12.0"]` minus the job log's `+ name@version` line.
const NPM_0_12_0 = {
  "@vibecook/ghosttead-darwin-arm64": 158 * SECOND,
  "@vibecook/ghosttead-win32-x64": 77 * SECOND,
  "@vibecook/ghosttea-native-tabs": 56 * SECOND,
  "@vibecook/ghosttea-protocol": 127 * SECOND,
  "@vibecook/ghosttea-frame": 96 * SECOND,
  "@vibecook/ghosttea": 56 * SECOND,
  "@vibecook/ghosttea-client": 127 * SECOND,
  "@vibecook/ghosttea-electron": 249 * SECOND,
  "@vibecook/ghosttea-react": 248 * SECOND,
  "@vibecook/ghosttead": 56 * SECOND,
};

/**
 * A registry that serves each upload `delays[name]` after accepting it, on a
 * clock that only moves when the publisher sleeps. `accepted` holds uploads an
 * earlier attempt made, by when; `refuses` names uploads that fail outright.
 */
function simulatedNpm({ delays = {}, accepted = {}, refuses = [] } = {}) {
  let now = 0;
  const acceptedAt = new Map(Object.entries(accepted));
  const resolvedAt = (name) => acceptedAt.get(name) + (delays[name] ?? 0);
  const uploads = [];
  return {
    uploads,
    resolvedAt,
    log: () => {},
    clock: {
      now: () => now,
      // A publisher that would wait forever fails here instead of hanging the
      // suite, since this clock never lets a real timer fire.
      sleep: async (ms) => {
        now += ms;
        if (now > 24 * 60 * MINUTE) throw new Error("the publisher waited a simulated day and was still waiting");
      },
    },
    registry: {
      resolves: (name) => acceptedAt.has(name) && now >= resolvedAt(name),
      publish(name) {
        uploads.push({ name, at: now });
        if (refuses.includes(name)) return { ok: false, alreadyPublished: false };
        if (acceptedAt.has(name)) return { ok: false, alreadyPublished: true };
        acceptedAt.set(name, now);
        return { ok: true, alreadyPublished: false };
      },
    },
  };
}

const dependencies = workspaceDependencies();
const fullPlan = () => releasePlan(publishedPackages(), dependencies);
const uploaded = (npm) => npm.uploads.map((upload) => upload.name);

test("publishes every package once, each only after everything it depends on resolves", async () => {
  const npm = simulatedNpm({ delays: NPM_0_12_0 });
  await publishPlan(fullPlan(), "0.12.0", npm);
  assert.deepEqual(uploaded(npm).sort(), publishedPackages());
  for (const upload of npm.uploads) {
    for (const dependency of dependencies.get(upload.name)) {
      assert.ok(npm.resolvedAt(dependency) <= upload.at, `${upload.name} was uploaded before ${dependency} resolved`);
    }
  }
});

test("waits once per layer of the dependency graph, not once per package", async () => {
  // One package at a time, 0.12.0's delays add up to 21 minutes of waiting.
  const npm = simulatedNpm({ delays: NPM_0_12_0 });
  await publishPlan(fullPlan(), "0.12.0", npm);
  assert.ok(npm.clock.now() < 10 * MINUTE, `took ${npm.clock.now() / MINUTE} minutes`);
});

test("outlasts npm taking far longer than it ever did during 0.12.0", async () => {
  const slow = Object.fromEntries(publishedPackages().map((name) => [name, 12 * MINUTE]));
  const npm = simulatedNpm({ delays: slow });
  await publishPlan(fullPlan(), "0.12.0", npm);
  assert.deepEqual(uploaded(npm).sort(), publishedPackages());
});

test("fails when a version never resolves, and publishes nothing that depends on it", async () => {
  const npm = simulatedNpm({ delays: { ...NPM_0_12_0, "@vibecook/ghosttea-protocol": Infinity } });
  await assert.rejects(
    publishPlan(fullPlan(), "0.12.0", npm),
    /npm still cannot resolve @vibecook\/ghosttea-protocol@0\.12\.0 after 20m 0\ds\..*rerunning resumes/,
  );
  for (const dependent of [
    "@vibecook/ghosttea",
    "@vibecook/ghosttea-client",
    "@vibecook/ghosttea-electron",
    "@vibecook/ghosttea-react",
  ]) {
    assert.ok(!uploaded(npm).includes(dependent), `${dependent} was published over a dependency npm cannot resolve`);
  }
});

test("a rerun skips every package npm already resolves", async () => {
  const everything = Object.fromEntries(publishedPackages().map((name) => [name, -30 * MINUTE]));
  const npm = simulatedNpm({ delays: NPM_0_12_0, accepted: everything });
  await publishPlan(fullPlan(), "0.12.0", npm);
  assert.deepEqual(npm.uploads, []);
  assert.equal(npm.clock.now(), 0);
});

test("a rerun waits for an upload npm accepted but has not recorded, rather than failing on it", async () => {
  // The earlier attempt got as far as ghosttea-client, 30 seconds before this one.
  const earlier = [
    "@vibecook/ghosttead-darwin-arm64",
    "@vibecook/ghosttead-win32-x64",
    "@vibecook/ghosttea-native-tabs",
    "@vibecook/ghosttea-protocol",
    "@vibecook/ghosttea-frame",
    "@vibecook/ghosttea",
  ];
  const accepted = Object.fromEntries(earlier.map((name) => [name, -30 * MINUTE]));
  accepted["@vibecook/ghosttea-client"] = -30 * SECOND;
  const messages = [];
  const npm = simulatedNpm({ delays: NPM_0_12_0, accepted });
  await publishPlan(fullPlan(), "0.12.0", { ...npm, log: (message) => messages.push(message) });
  assert.ok(
    messages.includes(
      "npm already holds @vibecook/ghosttea-client@0.12.0 from an earlier attempt; waiting for it to resolve",
    ),
  );
  const electron = npm.uploads.find((upload) => upload.name === "@vibecook/ghosttea-electron");
  assert.ok(
    electron.at >= npm.resolvedAt("@vibecook/ghosttea-client"),
    "electron was uploaded before its client resolved",
  );
  assert.deepEqual(uploaded(npm).sort(), [
    "@vibecook/ghosttea-client",
    "@vibecook/ghosttea-electron",
    "@vibecook/ghosttea-react",
    "@vibecook/ghosttead",
  ]);
});

test("stops at once when npm refuses an upload for any other reason", async () => {
  const npm = simulatedNpm({ delays: NPM_0_12_0, refuses: ["@vibecook/ghosttea-frame"] });
  await assert.rejects(
    publishPlan(fullPlan(), "0.12.0", npm),
    /npm publish failed for @vibecook\/ghosttea-frame@0\.12\.0\. Not published yet: .*@vibecook\/ghosttea-react/,
  );
  assert.equal(npm.clock.now(), 0, "waited on the registry after a failure that waiting cannot fix");
  assert.ok(!uploaded(npm).includes("@vibecook/ghosttea-react"));
});

test("a named package publishes alone, and only once what it depends on already resolves", async () => {
  const react = releasePlan(["@vibecook/ghosttea-react"], dependencies);
  const missing = simulatedNpm();
  await assert.rejects(
    publishPlan(react, "0.12.0", missing),
    /npm cannot resolve @vibecook\/ghosttea@0\.12\.0, .*nothing was published/,
  );
  assert.deepEqual(missing.uploads, []);

  const earlier = ["@vibecook/ghosttea", "@vibecook/ghosttea-frame", "@vibecook/ghosttea-protocol"];
  const present = simulatedNpm({ accepted: Object.fromEntries(earlier.map((name) => [name, 0])) });
  await publishPlan(react, "0.12.0", present);
  assert.deepEqual(uploaded(present), ["@vibecook/ghosttea-react"]);
});

test("refuses a cycle or an unknown package before anything publishes", async () => {
  const cyclic = new Map([
    ["a", ["b"]],
    ["b", ["a"]],
  ]);
  assert.throws(() => releasePlan(["a", "b"], cyclic), /in a cycle: a -> b -> a$/);
  assert.throws(() => releasePlan(["@vibecook/ghosttea-nope"], dependencies), /not a package in this workspace/);

  // A plan built by hand can still be one nothing can finish; it fails rather
  // than polling forever.
  const stuck = [
    { name: "a", layer: 0, after: ["b"], requires: [] },
    { name: "b", layer: 0, after: ["a"], requires: [] },
  ];
  await assert.rejects(publishPlan(stuck, "0.12.0", simulatedNpm()), /nothing can publish: a, b/);
});

test("the resolver waits for every platform package it names", () => {
  const manifest = JSON.parse(readFileSync(new URL("../packages/ghosttead/package.json", import.meta.url), "utf8"));
  const resolver = fullPlan().find((entry) => entry.name === "@vibecook/ghosttead");
  assert.deepEqual(resolver.after, Object.keys(manifest.optionalDependencies).sort());
  assert.ok(resolver.after.length > 0);
});

test("every workspace package a published package depends on publishes with it", () => {
  for (const entry of fullPlan()) {
    assert.deepEqual(entry.requires, [], `${entry.name} depends on packages that never publish`);
  }
});
