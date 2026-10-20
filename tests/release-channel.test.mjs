// A patch on an older line runs the same publish steps as the newest release:
// once, on a tag, inside CI, where the wrong channel either fails after every
// crate has uploaded or moves `latest` back a line. The choice is pinned here,
// and so is each publish step's use of it.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { githubLatestFlag, npmDistTag } from "../scripts/release-channel.mjs";

const scripts = resolve(import.meta.dirname, "../scripts");

test("the newest line publishes as latest", () => {
  assert.equal(npmDistTag("0.12.1", "0.12.0"), "latest");
  assert.equal(npmDistTag("0.13.0", "0.12.0"), "latest");
  assert.equal(npmDistTag("1.0.0", "0.12.0"), "latest");
});

test("an older line publishes under its own tag and leaves latest alone", () => {
  assert.equal(npmDistTag("0.10.2", "0.12.0"), "release-0.10");
  assert.equal(npmDistTag("0.11.2", "0.12.0"), "release-0.11");
});

test("versions compare as numbers, not as text", () => {
  // As text, "0.9.10" sorts after "0.10.0".
  assert.equal(npmDistTag("0.9.10", "0.10.0"), "release-0.9");
  assert.equal(npmDistTag("0.10.0", "0.9.10"), "latest");
});

test("a release outranks a prerelease of its own version", () => {
  assert.equal(npmDistTag("0.13.0", "0.13.0-beta.1"), "latest");
});

test("a package the registry does not hold yet publishes as latest", () => {
  assert.equal(npmDistTag("0.10.2", ""), "latest");
});

test("an older line's tag never parses as a semver range, which npm rejects", () => {
  assert.doesNotMatch(npmDistTag("0.10.2", "0.12.0"), /^[v=<>~^\d]/);
});

test("fails closed on a version it cannot order", () => {
  assert.throws(() => npmDistTag("0.10", "0.12.0"), /not a release version/);
});

test("the GitHub release is Latest unless a newer line already is", () => {
  assert.equal(githubLatestFlag("0.12.1", "v0.12.0"), "--latest");
  assert.equal(githubLatestFlag("0.10.2", "v0.12.0"), "--latest=false");
  assert.equal(githubLatestFlag("0.10.2", ""), "--latest");
});

// The publish steps are shell scripts; these run them against a stubbed
// registry client, the one thing they call that cannot run here.
const posixOnly = { skip: process.platform === "win32" && "the publish steps run under bash" };

function withStub(name, script, run) {
  const dir = mkdtempSync(join(tmpdir(), "ghosttea-release-channel-"));
  try {
    mkdirSync(join(dir, "bin"));
    writeFileSync(join(dir, "bin", name), `#!/usr/bin/env bash\n${script(dir)}\n`, { mode: 0o755 });
    const env = { ...process.env, PATH: `${join(dir, "bin")}:${process.env.PATH}` };
    delete env.NPM_CONFIG_PROVENANCE;
    delete env.npm_config_provenance;
    run(dir, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("the npm publish step passes an older line's tag", posixOnly, () => {
  withStub(
    "npm",
    (dir) => `printf '%s\\n' "$*" >> "${dir}/calls"
case "$1 $2 $3" in
  "view @vibecook/example@0.10.2 version") [ -e "${dir}/published" ] ;;
  "view @vibecook/example dist-tags.latest") echo 0.12.0 ;;
  "publish --workspace @vibecook/example") touch "${dir}/published" ;;
  *) exit 64 ;;
esac`,
    (dir, env) => {
      writeFileSync(join(dir, "package.json"), JSON.stringify({ version: "0.10.2" }));
      execFileSync("bash", [join(scripts, "publish-npm-package-if-missing.sh"), "@vibecook/example"], {
        cwd: dir,
        env,
        stdio: "pipe",
      });
      assert.match(
        readFileSync(join(dir, "calls"), "utf8"),
        /^publish --workspace @vibecook\/example --access public --tag release-0\.10$/m,
      );
    },
  );
});

test("the GitHub release step leaves Latest on a newer line", posixOnly, () => {
  withStub(
    "gh",
    (dir) => `case "$1 $2 $3" in
  "release view v0.10.1") exit 1 ;;
  "release view --json") echo v0.12.0 ;;
  "release create v0.10.1") printf '%s\\n' "$@" > "${dir}/created" ;;
  *) exit 64 ;;
esac`,
    (dir, env) => {
      execFileSync("bash", [join(scripts, "create-release-if-missing.sh"), "v0.10.1"], {
        cwd: dir,
        env,
        stdio: "pipe",
      });
      const args = readFileSync(join(dir, "created"), "utf8").split("\n");
      assert.ok(args.includes("--latest=false"), "the older line took Latest");
      assert.ok(!args.includes("--latest"));
    },
  );
});
