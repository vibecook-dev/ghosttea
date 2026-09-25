# Publishing Ghosttea

Ghosttea publishes one shared version across ten npm packages and seven Rust
crates. The `ghosttead`, `ghosttea-ffi`, `ghosttea-font-fixture-ffi`, and
`ghosttea-apple-ffi` Rust packages and both desktop applications are private
integration targets and must never be published to crates.io.

The `ghosttead` crate staying off crates.io does not keep the daemon out of
consumers' hands: its release-built binary ships to npm through the
`os`/`cpu`-gated `@vibecook/ghosttead-darwin-arm64` and
`@vibecook/ghosttead-win32-x64`, which install through the
`@vibecook/ghosttead` resolver. The macOS native tabs addon ships prebuilt the
same way as `@vibecook/ghosttea-native-tabs`. Prebuilds exist for exactly the
targets the release gate validates.

Registry versions are immutable. Every release starts from a clean, pushed
commit whose signed `vX.Y.Z` tag matches the root package version.

## Package graph and order

Every crate and package directory is named after what it publishes: the crate
name for Rust, the unscoped package name for npm. Renaming a published artifact
therefore means renaming its directory in the same change.
`npm run check:workspace-names` enforces this, because a directory that drifts
from its published name is invisible to both the compiler and the registry.
The private applications under `apps/` are exempt and are never published.

Publish Rust crates in dependency order:

1. `ghosttea-vt-sys`
2. `ghosttea-text`
3. `ghosttea-vt`
4. `ghosttea-config`
5. `ghosttea-core`
6. `ghosttea`
7. `ghosttea-truffle`

Publish npm packages in dependency order. `scripts/publish-npm-packages.mjs`
derives it from the manifests: each package publishes once npm resolves every
workspace package it depends on at the release version, so
`@vibecook/ghosttead` never exists at a version whose optional dependencies do
not, and no package names a dependency npm cannot install. A package waits
only for its own dependencies, so the release waits for npm once per layer of
the graph rather than once per package. `node scripts/publish-npm-packages.mjs
--plan` prints the order without publishing anything. It is currently:

1. `@vibecook/ghosttea-frame`, `@vibecook/ghosttea-native-tabs`,
   `@vibecook/ghosttea-protocol`, `@vibecook/ghosttead-darwin-arm64`, and
   `@vibecook/ghosttead-win32-x64`
2. `@vibecook/ghosttea` and `@vibecook/ghosttea-client`, after
   `@vibecook/ghosttea-protocol`; `@vibecook/ghosttead`, after both binary
   packages
3. `@vibecook/ghosttea-electron` and `@vibecook/ghosttea-react`, after the
   packages they are built on

## Binary staging

The three binary-carrying packages hold no binaries in the repository:
`bin/` and `prebuilds/` are gitignored, and each package's `prepublishOnly`
runs `scripts/require-staged-binary.mjs`, so publishing an unstaged package
fails closed instead of shipping a package that resolves to nothing.

The release workflow stages them from the same jobs that gate the release:
the macOS validate job builds the release daemon and the universal native
tabs prebuild (`npm run build:ghosttea-native-tabs`), the Windows validate
job builds `ghosttead.exe`, both upload artifacts, and the publish job runs
`scripts/stage-published-binaries.mjs` to place them — restoring the
executable bit that artifact transport drops — before the first
`npm publish`.

Staging also injects the daemon packages' `os`/`cpu` gates. The committed
manifests deliberately omit them: npm refuses to install a workspace whose
gate does not match the development machine, so a committed `os: ["win32"]`
would break `npm ci` everywhere but Windows. The fields exist only in the
published manifests — the only place they mean anything — and the
`prepublishOnly` guard fails any publish where they are missing. The
post-release smoke proves the gates behave: the right package installs on
macOS and Windows, and a Linux install skips both and fails closed in the
resolver.

To stage by hand (for a first manual publish, or a local dry-run), download
the artifacts from the tag's validate run and stage them the same way:

```sh
gh run download <run-id> --dir /tmp/ghosttea-staging
node scripts/stage-published-binaries.mjs /tmp/ghosttea-staging
```

After every release, the `Published packages smoke` workflow installs the
published version from the registry on macOS, Windows, and Linux, runs the
daemon, and loads the addon — the registry serves objects the gate never
executed, and this keeps "published" and "verified" the same claim.

Development and published Rust builds pin the registry release of
`truffle-core` 0.7.12. Every crate sharing an application-owned Truffle node
must resolve the same version and source so its `Node` type is identical.

## Release gate

Run from a clean checkout of the release commit:

```sh
npm ci --ignore-scripts
npm audit --audit-level=high
npm run bootstrap:ghostty-vt:apple
npm run ci:desktop
npm run check:first-publishes
cargo audit
```

The desktop gate builds and tests every workspace, validates npm and Rust
package archives, builds external consumers exclusively from those archives,
and runs the native lifecycle soak. GitHub separately checks the declared Rust
1.88 minimum and extends the lifecycle soak on its weekly schedule.

`check:first-publishes` is the one gate step that is not in `ci:desktop`, and
deliberately: it asks crates.io and npm what they already hold, so it needs the
network and it answers differently before and after a release. It belongs to
the tag, not to a commit. Run it last, immediately before tagging — see
“First manual publish” for what it catches.

Before publishing, perform Cargo's atomic workspace dry-run. This uses Cargo's
temporary registry to verify the unpublished synchronized dependency graph
without uploading anything:

```sh
cargo publish \
  --dry-run \
  --locked \
  --workspace \
  --no-verify \
  --exclude ghosttead \
  --exclude ghosttea-apple-ffi \
  --exclude ghosttea-ffi \
  --exclude ghosttea-font-fixture-ffi
```

`--no-verify` is required on Cargo 1.94. Without it the dry-run verifies each
crate against its temporary registry and fails on the first one that depends on
a sibling, with `no hash listed for ghosttea-vt-sys` and Cargo's own note that
this is an internal error. It reaches `ghosttea-text` and `ghosttea-vt-sys`,
which have no workspace dependencies, and stops there.

Publishing itself is unaffected: crates go one at a time and each waits to
become resolvable on crates.io, so a dependent never resolves its siblings from
the temporary registry. Dropping the flag once Cargo can verify this graph
restores the build check the dry-run is otherwise doing.

Dry-run each npm package with local provenance disabled explicitly. The command
line flag is intentional: it takes precedence over the manifests'
`publishConfig.provenance=true` on every supported npm CLI. The binary
packages run their `prepublishOnly` staging guard even on a dry run, so stage
binaries first (see “Binary staging”) or their dry-run fails — which is the
guard working:

```sh
export npm_config_cache=/private/tmp/ghosttea-npm-release-cache

for release_package in \
  @vibecook/ghosttead-darwin-arm64 \
  @vibecook/ghosttead-win32-x64 \
  @vibecook/ghosttea-native-tabs \
  @vibecook/ghosttea-protocol \
  @vibecook/ghosttea-frame \
  @vibecook/ghosttea \
  @vibecook/ghosttea-client \
  @vibecook/ghosttea-electron \
  @vibecook/ghosttea-react \
  @vibecook/ghosttead
do
  npm publish \
    --dry-run \
    --workspace "$release_package" \
    --access public \
    --provenance=false
done

unset npm_config_cache
```

The Ghostty VT artifact referenced by
`native/ghosttea/crates/ghosttea-vt-sys/artifacts.json` must already exist in
the matching GitHub release. The crate downloads it and verifies its archive,
static library, and public headers before linking. Its release name is derived
from the complete source-and-recipe digest: upstream commit, ordered
checksum-locked VT patch set, Zig distribution and targets, target CPUs,
builder image, and archive normalizer. Push a new `ghostty-vt-*` tag only when
one of these pinned native inputs changes.

Both desktop/server archives are deliberately classified as non-reproducible.
Before tagging, dispatch `ghostty-vt-artifact.yml` on the release branch and
lock both results together with their shared `candidateRunId`. The tag workflow
downloads those immutable candidates by run ID, verifies each bundle and
embedded source identity, and promotes the exact reviewed bytes. The macOS
recipe still pins a single-job Zig schedule, dependency seed, `baseline` CPU,
and exact Xcode `strip` build; a controlled cross-host check nevertheless
produced a different instruction sequence in the root Zig object. A tag must
never rebuild and substitute either archive for the checksums in the reviewed
manifest.

The GhostteaKit native artifact is separate, and shipping it correctly means
verifying two properties rather than one. Its digests establish which bytes are
published; they cannot establish that those bytes contain the source being
shipped, because a digest taken from a stale build agrees with a lock written
from that same stale build. So the lock records a `sourceDigest` over the crates
compiled into it, and `npm run check:apple-native-artifact` recomputes that from
the working tree on every run. `--release` additionally fetches the locked URL,
hashes the archive, unpacks it, and re-derives the content and slice digests
from the bytes actually served.

That is not theoretical: 0.6.2's key-encoder and cursor fixes compile into every
slice of that artifact, and before these checks existed the whole gate passed
against an artifact built before them. `apple-native-spm-publishing.md` has the
content-addressed publication order. The authoritative bytes are now built,
tested, attested, published, downloaded, and re-verified by
`ghosttea-apple-native-artifact.yml`; developer-built archives are candidates
only.

Machine-local WebGPU comparisons and the authenticated live Truffle QUIC test
remain manual pre-release evidence because hosted GPU timing and tailnet
credentials are not stable CI inputs.

## First manual publish

The first release of a package or crate must exist before its trusted
publisher can be configured. Authenticate interactively with npm and
crates.io, then create and push the signed release tag. Never move the tag
after publishing any artifact.

This is a rule about each artifact, not about the repository's first release. A
crate or package added between releases has never been published either, so the
release that first ships it cannot use trusted publishing for it. crates.io
refuses with:

```
Trusted Publishing tokens do not support creating new crates. Publish the crate manually, first
```

and it refuses partway through, once the crates ahead of it have already
uploaded and the tag can no longer be reused. 0.7.0 shipped `ghosttea-config`,
created after 0.6.2, so `v0.7.0` was its first publish: the workflow failed on
`Publish ghosttea-config` with `ghosttea-vt-sys`, `ghosttea-text`, and
`ghosttea-vt` already on the registry, and recovery cost a manual publish and a
`v0.7.0-retry.1` tag. Nothing warned before the tag, because nothing asked.

`npm run check:first-publishes` asks. It derives the publishable crates and
packages from the manifests that declare them, checks that the release workflow
uploads exactly those, and queries both registries for each one — failing if any
has never been published. An artifact that exists but lacks the version being
released is not a finding; shipping that version is what the release is for.
Run it before tagging, publish anything it names using the commands below, and
configure that artifact's trusted publisher before the tag exists.

Publish one Rust crate at a time in the order above. Wait for
`cargo info NAME@VERSION` to succeed before publishing its dependents:

```sh
cargo publish --locked --package ghosttea-vt-sys
cargo publish --locked --package ghosttea-text
cargo publish --locked --package ghosttea-vt
cargo publish --locked --package ghosttea-config
cargo publish --locked --package ghosttea-core
cargo publish --locked --package ghosttea
cargo publish --locked --package ghosttea-truffle
```

The npm manifests enable provenance for trusted CI publishing. Disable it only
for the first local publish, which has no CI identity. With no arguments the
publisher uploads every package npm does not already hold at this version, in
dependency order. Naming packages uploads only those, and whatever they depend
on must already resolve:

```sh
export NPM_CONFIG_PROVENANCE=false
export npm_config_cache=/private/tmp/ghosttea-npm-release-cache

node scripts/publish-npm-packages.mjs

unset NPM_CONFIG_PROVENANCE npm_config_cache
```

Verify every exact version from clean external npm and Rust consumers before
creating the GitHub release. A first manual publish has no workflow run to
create that release, so run `scripts/create-release-if-missing.sh vX.Y.Z`
yourself. Revoke the temporary crates.io token after the manual release. If an
uploaded artifact is defective, deprecate or yank it and release the next patch
version; never try to replace a registry version.

## Resuming a partial release

A tag never moves once any registry holds its artifacts, so a release that
failed between registries is finished rather than repeated. Create a numbered
retry tag from the current `main`, after merging the workflow fix:

```sh
git tag -a vX.Y.Z-retry.1 -m "Retry vX.Y.Z release"
git push origin vX.Y.Z-retry.1
```

The current `Publish release` workflow resolves `vX.Y.Z-retry.N` back to the
immutable `vX.Y.Z` target. The retry therefore carries the workflow fix while
every checkout, version assertion, registry upload, and GitHub release still
uses the original release tag's tree. Keeping the retry inside the publishing
workflow also preserves the exact workflow identity trusted by npm and
crates.io. The retry itself is a `v*` tag, so it preserves the release
environment's tag-only deployment rule instead of allowing `main` to publish.

Every publish step skips artifacts a registry already holds, so only the
missing remainder ships. If the retry itself exposes another workflow defect,
fix it and increment the retry number; never move either tag.

Only the workflow file travels with a retry. The scripts it runs come from the
release tag's tree like everything else, so a fix to a publisher reaches the
next release, not this one. What the workflow passes to them does travel:
`REGISTRY_VISIBILITY_TIMEOUT_MINUTES` is set there so that a retry can wait
longer on a slow registry.

## The GitHub release

The workflow's `github-release` job creates it, after publishing, from the
matching `CHANGELOG.md` section. Nothing about it is hand-maintained: the
package and crate lists come from the manifests that declare whether they
publish, and the requirements from the versions the workspace already pins, so
release notes cannot advertise something that stopped shipping.

The job is the only one granted `contents: write`, and it fails closed when
`CHANGELOG.md` has no section for the version being tagged. Rerunning it leaves
an existing release untouched, so a rerun after a partial failure never
overwrites notes that were edited afterwards.

What a release says about upgrading, and what evidence qualified it, is
editorial and is not generated. Add it to the release afterwards — unlike a
registry version, a release stays editable.

## Trusted publishing

The `Publish release` workflow validates every `v*` tag. Registry mutation is
disabled until the repository variable `OIDC_RELEASE_ENABLED` is exactly
`true`.

After the first manual release:

1. Create a protected GitHub environment named `release`.
2. Configure every npm package and crates.io crate to trust:
   - GitHub owner: `vibecook-dev`
   - Repository: `ghosttea`
   - Workflow: `publish-release.yml`
   - Environment: `release`
3. Allow `npm publish` for each npm trusted publisher. With an authenticated
   npm 12 session, the ten npm trust relationships can be created with the
   following subshell:

   ```sh
   (
     set -e
     for release_package in \
       @vibecook/ghosttead-darwin-arm64 \
       @vibecook/ghosttead-win32-x64 \
       @vibecook/ghosttea-native-tabs \
       @vibecook/ghosttea-protocol \
       @vibecook/ghosttea-frame \
       @vibecook/ghosttea \
       @vibecook/ghosttea-client \
       @vibecook/ghosttea-electron \
       @vibecook/ghosttea-react \
       @vibecook/ghosttead
     do
       npm trust github "$release_package" \
         --repository vibecook-dev/ghosttea \
         --file publish-release.yml \
         --environment release \
         --allow-publish \
         --yes
       sleep 2
     done
   )
   ```

   The first attempt exits with an npm browser-authentication URL. Approve it,
   select npm's option to skip repeated 2FA for the next five minutes, and
   rerun the subshell. Then verify each relationship with
   `npm trust list PACKAGE`.

4. Set the repository variable `OIDC_RELEASE_ENABLED=true`.
5. Revoke obsolete registry automation tokens and configure npm to require
   two-factor authentication while disallowing token publishing.

The release job runs on an Apple Silicon GitHub-hosted runner because the
current verified Ghostty VT artifact targets `aarch64-apple-darwin`. It obtains
a fresh short-lived crates.io token before each Rust upload; npm exchanges the
same job's OIDC identity automatically and generates package provenance.

The publish helpers safely skip an exact version that already exists, making a
workflow rerun resumable after partial registry success. They never overwrite
or replace a published artifact. After an upload succeeds, they wait for the
exact version to become publicly resolvable so ordinary registry propagation
does not produce a false release failure: for up to
`REGISTRY_VISIBILITY_TIMEOUT_MINUTES`, which the workflow sets to 20.

That margin is deliberate. npm accepts an upload well before it records the
version: during 0.12.0 each package's `time[version]` trailed the accepted
upload by 56 seconds to 4 minutes 9 seconds. The helpers then allowed about two
and a half minutes, so four of the ten packages failed after publishing
successfully, and each failure cost a rerun and another approval of the
`release` environment. A publish npm refuses because it already holds the
version — an earlier attempt's upload, accepted but not yet recorded — is
waited for the same way instead of failing.
