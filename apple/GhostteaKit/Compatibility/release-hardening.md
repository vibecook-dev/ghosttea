# iOS release hardening

**Status:** Phase 9 in progress (started under former Phase 8 numbering)

**Started:** 2026-07-18

## Accepted release-only deferrals

The following qualification work is deliberately deferred as of 2026-07-20 so
implementation and optimization can continue. These are release-only
deferrals, not waivers: ordinary development and internal device builds may
proceed, but `npm run check:ios-release-ready` must continue to fail while any
item is open. No App Store or external beta artifact may be described as
release-eligible until all five are closed against the same clean release
revision and signed artifact:

1. adopt and review-lock Xcode 26.6 or later, then rerun the one-hour Swift/TRF1
   sanitizer campaign and the complete physical-device Instruments capture;
2. replace libssh2 1.11.1 with a fixed upstream release or a separately reviewed
   minimal backport, rebuild every Apple slice, and rerun the SSH/security
   validation matrix;
3. complete the checked 24-scenario physical beta matrix across compact and
   large iPhones, iPads, 60 Hz and 120 Hz hardware, including Stage Manager and
   hardware-input coverage;
4. capture genuine OS-delivered memory-warning and system-pressure/jetsam
   restoration evidence, rather than treating deterministic warning and
   host-termination proxies as equivalent; and
5. resolve the account-owned privacy, encryption/export, review-access, signing,
   and distribution decisions, then produce and validate a clean Apple
   Distribution archive and IPA with retained provenance.

The fail-closed contracts, manifests, recorders, and proxy gates already in the
repository remain active. Work may reduce risk ahead of release, but it must not
change a required release result to `passed`, weaken a verifier, or relabel proxy
evidence to satisfy one of these deferred items.

## Performance and energy

[`performance-and-energy.md`](performance-and-energy.md) defines the physical
device protocol and the first production instrumentation slice. The opt-in
`GhostteaPerformance` package emits bounded Instruments intervals for input
through ordered write, demanded bytes through ordered frame delivery, native
feed, TRF1 retained-state decode, and Metal submission. It records only numeric
durations and byte counts, uses constant-time bounded storage, and remains
disabled by default. Package tests pass on the locked Xcode toolchain.

Release qualification remains open until 60 Hz and 120 Hz physical-device
traces establish the accepted latency/CPU/energy baseline. Native shared
text-engine lock wait/hold attribution is implemented per serialized terminal
and replica through a dedicated snapshot ABI, with no additional call when
profiling is disabled. A fail-closed physical-device Release runner covers the
repeatable local pipeline. It scores 1,000 ordered input writes and 1,000
received-byte-to-Metal submissions, requires every native/feed/decode/render
boundary with zero sample drops, and proves suspended draw attempts submit no
GPU work. It also runs 256 concurrent native feeds per terminal across four and
eight terminals sharing one runtime, with exact attribution counts and explicit
lock-wait, per-session p99, and starvation/skew bounds. Its Metal loop is
refresh-paced outside the scored interval and issues exactly one explicit draw
per update. The device returns redacted numeric JSON through `devicectl`; the
host writes ignored evidence even when a scored invariant fails. The corrected
120 Hz iPhone 14 Pro run passes every automated latency, sample-count,
background-GPU, and four/eight-session fairness gate with nominal thermal state.
Its evidence SHA-256 is
`163b312644886f0a4678d06969a409252256eb270fe87dbeff96edfaac5eab9b`.
The 60 Hz run and Instruments CPU/Energy plus rendered multi-session traces
remain release gates.

The long-trace runner now automates the repeatable portion of that open gate:
one idle trace and sustained rendered one/four/eight-session workloads, with a
real production Metal surface and shared-runtime contention. It preflights the
physical device against the locked iPhoneOS SDK, captures Time Profiler, Metal,
Points of Interest, Power, and Thermal instruments, validates the physical-iOS
target and duration, and hashes the signed app and retained traces. A separate
strict verifier rejects unknown evidence fields, quick/partial traces, stale or
dirty source, and pending CPU/Energy review; release readiness now invokes it.

The first recording attempt is correctly blocked: the connected iPhone is on
iOS 26.5.2, while locked Xcode 26.1 supports iOS 26.1 devices. [Apple's support
matrix](https://developer.apple.com/support/xcode) identifies Xcode 26.6 as the
compatible toolchain. Updating the Xcode lock and rerunning the full trace
command is mandatory before release, but this known toolchain gap does not
block the remaining Phase 9 implementation.

## Deterministic component inventory

[`ios-release.cdx.json`](ios-release.cdx.json) is the checked-in CycloneDX 1.6
inventory for the iOS application's direct native inputs, complete
Apple-target Rust dependency closure, bundled resources, and reviewed build
toolchains. It is generated only by an explicit, reviewed `--write` invocation
from the authoritative repository pins:

- `native/ghostty.lock.json`;
- `native/ssh.lock.json`;
- `native/fonts.lock.json`;
- `truffle-swift.lock.json`;
- `ios-rust-components.lock.json` and its exact `Cargo.lock` hash;
- `ios-toolchain.lock.json`;
- the root package version and license; and
- the tracked MIT, OFL-1.1, and font-notice files.

The BOM records the shared Rust FFI runtime and all 89 non-development crates
selected from it for `aarch64-apple-ios`, pinned Ghostty source, OpenSSL,
libssh2, the exact sibling Truffle Swift revision, the exact TailscaleKit source
revision, reviewed source-patch path/hash/purpose, binary/license hashes, and
each of the five exact bundled font files. Relationships describe the static
native/runtime inputs, and every font carries its locked SHA-256. The carried
libtailscale patch fixes authenticated listener address lookup after
`SCM_RIGHTS` duplicates the accepted descriptor; it has passed the signed
iPhone shared-session and desktop-restart gates. The separately observed
self-recovering LocalAPI watch timeout remains a release-hardening item.
Xcode, Apple Swift/Clang, Rust/Cargo/LLVM, and all intended Apple Rust targets
are recorded as BOM creation tools. Registry crates carry the checksum selected
by `Cargo.lock`, SPDX license expressions, exact dependency edges, and their
target identity.
The BOM timestamp and serial are fixed so identical repository inputs produce
byte-identical JSON.

Run the drift gate with:

```sh
npm run check:ios-release-bom
```

After intentionally reviewing a lock change, regenerate the checked-in file
with:

```sh
npm run update:ios-rust-components
node scripts/check-ios-release-bom.mjs --write
npm run update:ios-release-resources
npm run check:ios-release-bom
npm run check:ios-release-resources
```

The Rust updater is the only step that asks Cargo to resolve the locked graph.
Ordinary verification is offline: it requires the recorded `Cargo.lock` hash
and exact BOM bytes to remain unchanged.

The verifier constructs the expected BOM in memory and compares it exactly
with the checked-in file. A changed dependency commit, tag, font hash, package
version, license text, or notice file therefore requires an intentional BOM
review. The ordinary repository `check` command includes this non-release
gate.

The dedicated `iOS release hardening` workflow repeats the drift and graph
checks on Linux, then validates the checked-in document as CycloneDX 1.6 with
the official CycloneDX CLI 0.32.0. This keeps schema validation independent
from the generator that produced the document. The workflow preserves the
validated bundled BOM, notices, resource lock, and toolchain lock together as
`ghosttea-ios-release-metadata`; this is durable CI input evidence, not a
substitute for the later signed archive/IPA provenance.

## Reviewed release toolchain

`ios-toolchain.lock.json` records the exact Xcode, Swift, Clang, Rust, Cargo,
and LLVM identities used for the release candidate. Verify the current machine
with:

```sh
npm run check:ios-release-toolchain
```

`npm run archive:ios:app` runs both the BOM drift gate and this toolchain gate
before invoking Xcode. A release archive therefore cannot silently move to a
new compiler. Updating the toolchain lock is an explicit review operation and
must be followed by the complete release validation matrix.

## Packaged notices and release BOM

The production application resource phase embeds two reviewed files:

- `THIRD-PARTY-NOTICES.txt`, a human-readable index for all 105 BOM components
  followed by 94 deduplicated exact license and notice documents; and
- `Ghosttea-iOS.cdx.json`, a byte-identical copy of the checked-in CycloneDX
  release BOM.

The explicit `npm run update:ios-release-resources` command reads license files
from the locked native sources and Cargo package sources, removes machine-local
paths, deduplicates documents by SHA-256, and writes
`ios-release-resources.lock.json`. Ordinary verification does not need Cargo's
source cache. It checks the source and bundled BOM hashes and bytes, notice
hash, every component label, license-section count, and absence of local paths.

The production app exposes the notice through its About sheet. Both Debug and
Release builds package the same reviewed bytes. Archive validation reruns the
offline gate before building and then verifies both files inside the signed
`.app`; a missing, stale, or substituted resource fails the archive command.

## Archive and IPA evidence

`npm run archive:ios:app` now writes
`native/build/ios-app/archive/Ghosttea.release-evidence.json` after Xcode
finishes. The deterministic evidence document records:

- the source revision and whether the worktree was clean;
- the exact Truffle source revision and whether its worktree was clean;
- hashes for the release BOM, notices, resource lock, and toolchain lock;
- sorted content-tree hashes for the `.xcarchive`, archived `.app`, and dSYM;
- application identity, version, deployment target, arm64 architecture,
  executable hash, Mach-O UUID, code-directory hashes, signing authorities,
  signed application/team/debug entitlements, provisioning-profile hash, and
  bundled-resource hashes; and
- the exact dSYM UUID match.

Given release-account export options, the archive runner can produce and
validate one coherent artifact chain:

```sh
GHOSTTEA_IOS_EXPORT_OPTIONS_PLIST=/secure/path/ExportOptions.plist \
GHOSTTEA_IOS_RELEASE=1 \
npm run archive:ios:app
```

The export options remain account-owned and outside the repository. To attest
an existing archive/IPA pair instead, run:

```sh
npm run validate:ios:release-artifact -- \
  --archive native/build/ios-app/archive/Ghosttea.xcarchive \
  --ipa /path/to/Ghosttea.ipa \
  --release
```

IPA validation rejects unsafe ZIP paths, requires exactly one payload app,
repeats signature and packaged-resource validation after extraction, and
requires its identity, version, minimum OS, architecture, executable UUID, and
release-resource hashes to match the archive. Release eligibility also
requires an Apple Distribution signature whose certificate chain is trusted
on the verification host and rejects an IPA that permits debugger attachment.
A development-signed archive may therefore provide useful build evidence, but
a development-signed IPA-shaped ZIP cannot be mistaken for a distributable
artifact. Evidence contains artifact names and hashes, never machine-local
paths. Validation always writes the evidence so a blocked build can be
audited; `--release` then exits nonzero unless every recorded policy condition
is satisfied. The archive command applies that same fail-closed behavior when
`GHOSTTEA_IOS_RELEASE=1`; an already exported IPA may also be supplied through
`GHOSTTEA_IOS_IPA` when it came from the exact archive being validated.

## Fail-closed release mode

Release certification additionally runs:

```sh
npm run check:ios-release-ready
```

The aggregator always runs the BOM/SSH policy, resource, toolchain, App Store,
physical beta matrix, and Instruments-evidence gates so one failure cannot hide
the other blockers. It currently fails by design because `native/ssh.lock.json` records
`productionApproved: false` for the pinned libssh2 release, the three
account-owned App Store decisions below remain open, and the complete physical
beta evidence has not been collected. Development and parity work may continue,
but a release artifact cannot pass while any policy condition is false.

Changing the bit alone is not approval. The SSH lock must first move to a fixed
source revision, incorporate the required fixes, and record successful Apple
artifact, package, fixture, Swift, and physical-device revalidation.

The 2026-10-24 security review found no fixed tag. The lock's
`requiredFixCommits` grew from six to 19:

- the ten published CVEs against libssh2 through 1.11.1, four of them
  published on 2026-07-24; and
- nine fixes that upstream ties to repository advisories that are not yet
  public.

`advisories` maps each commit to its IDs, and
[`ssh-candidate-decision.md`](ssh-candidate-decision.md) records the evidence.
Upstream master contains all 19 fixes but is 1108 commits beyond 1.11.1. The
first fix in master order still conflicts against the release source, and 13 of
the 19 conflict when cherry-picked alone. The lock records that observation
without changing its pin or approval bit. Waiting for the prepared upstream
release, or conducting a separately reviewed backport, is intentional risk
control, not an implementation gap to bypass.

## Remaining release work

The dependency graph, compiler identity, notices, app-bundle BOM, archive
checksums, dSYM match, and optional exported-IPA inspection now form one
fail-closed evidence contract. The release-account pipeline must still produce
the Apple Distribution export from a clean revision, run this validator on a
host with a trusted certificate chain, attach its JSON plus validated BOM to
signed provenance, and retain the archive, IPA, and dSYM. The separate SSH
production-approval blocker also remains in force.

Development-only Docker fixture tools such as Zellij, htop, btop, and Claude
Code do not ship in the iOS app and must remain outside the release component
graph.

## Beta device and application matrix

[`beta-qualification.md`](beta-qualification.md) and
[`ios-beta-matrix.json`](ios-beta-matrix.json) define the fail-closed physical
campaign. The checked contract requires four device classes, 60/120 Hz, 24
real-application and lifecycle scenarios, exact automatic/manual methods, and
special per-device coverage for transport continuity, Unicode/IME, Stage
Manager, and hardware input.

The matrix now carries the memory gates explicitly: deterministic signed-app
over-soft recovery and abrupt process restoration are automatic requirements
on every device class, while OS-delivered warning/resync and real
system-pressure termination are separate manual requirements. This prevents
the passing proxy gates from being mistaken for jetsam qualification.

`npm run record:ios:beta-evidence` is the fail-closed acquisition boundary. It
queries only the paired device's redacted model/OS fields, hashes retained
automatic or manual records, and atomically merges reviewed scenario/method
pairs. It will not write unless the worktree and sibling Truffle checkout are
clean and the supplied artifact evidence contains an eligible Apple
Distribution IPA with debugger attachment disabled. Existing evidence cannot
be reused across a matrix, revision, artifact, or device change.

Evidence files accept only reviewed numeric/device fields, known enum-like
identifiers, revisions, timestamps, and SHA-256 hashes. They reject UDIDs,
device names, hosts, users, commands, terminal output, and arbitrary notes.
Every file binds to the exact matrix, clean source revision, common signed
artifact evidence, and retained trace hashes. Ordinary checks validate the
contract without claiming completion; `check:ios-release-ready` invokes the
release form and reports every missing coverage item. The physical campaign is
open and intentionally release-blocking.

## App Store privacy, encryption, and review gate

`ios-app-store.lock.json` records the reviewed submission inputs independently
from the binary provenance. Run its ordinary drift check with:

```sh
npm run check:ios-app-store
```

The production application now carries an app-owned `PrivacyInfo.xcprivacy`
for the `_stat`/`_fstat` file-metadata use inside its container. The pinned
Truffle materializer places a separate manifest inside every TailscaleKit
framework slice for its file-metadata and elapsed-time APIs. The bundle gate
compares both manifests semantically after Xcode's binary-plist conversion,
audits the final app and framework undefined-symbol sets, and fails if a newly
linked required-reason API has not been reviewed. The sibling manifest,
compatibility copy, hash lock, and exact Truffle revision must agree.

Because the app embeds OpenSSL, libssh2, and TailscaleKit, both configurations
set `ITSAppUsesNonExemptEncryption=YES`. This deliberately sends the account
owner through Apple's export-compliance determination instead of claiming an
unreviewed exemption. `app-store-review-notes.md` documents the remote-terminal
execution boundary, credentials, background behavior, and the review fixtures
that must be supplied outside the repository.

The fail-closed form is:

```sh
npm run check:ios-app-store-ready
```

It currently reports three owner/account blockers: reconcile Tailscale
control-plane data with the privacy label and publish an in-app privacy-policy
link; complete encryption export review and documentation; and approve final
review notes with working SSH and desktop-session access. These are not safe to
infer from code, so development builds remain possible while release evidence
stays ineligible.

## Crash-safe redacted diagnostics

`GhostteaDiagnostics` is a separate Swift package product used by the production
app. Its persisted event schema contains only an audited enum code, enum
severity, monotonically increasing sequence, and timestamp. It has no API for
arbitrary messages, errors, hostnames, usernames, paths, commands, terminal
content, byte buffers, or metadata dictionaries. Adding a new diagnostic
therefore requires a source-reviewed enum case instead of passing an opaque
string through a nominal redactor.

The actor retains at most 128 events and 64 KiB. Every mutation writes an
atomic replacement, synchronizes it, applies complete iOS file protection, and
excludes the diagnostic directory and file from backup. A failed write leaves
the previous snapshot intact. Invalid, unknown-schema, or over-budget input is
discarded and replaced by a `diagnosticStoreRecovered` event; corrupt bytes are
never copied into the support export. A launch left active by a crash, jetsam,
or force-quit is conservatively reported as `previousTerminationUnrecorded` on
the next launch. The app does not claim it can distinguish those causes without
an Apple crash report.

The About sheet can copy the JSON support record. Production shared-session,
SSH workspace, renderer, resize, and Metal error surfaces use fixed UI text and
audited event codes instead of interpolating native or server-controlled error
descriptions. Verify the static contract with:

```sh
npm run check:ios-diagnostics
```

Swift package tests additionally prove event-count and byte limits, recorded
versus unrecorded termination behavior, and replacement of a corrupt fixture
containing a password, private-key marker, and terminal output.

## Atomic Ghostty upgrades

[`ghostty-upgrade-procedure.md`](ghostty-upgrade-procedure.md) makes a Ghostty
revision change an atomic source, ABI, artifact, font, parity, release-metadata,
performance, and physical-device operation. It names explicit stop conditions
for each boundary and requires desktop and iOS to prove the same Truffle
session after the upgrade. A rollback restores the complete compatibility set,
never only the source pin or only a binary.

Run the offline consistency gate with:

```sh
npm run check:ghostty-upgrade
```

The gate requires a full immutable source commit; exact agreement among the
Ghostty, font, downloadable-artifact, source-BOM, and bundled-BOM locks; all
authoritative fixture inputs; and the complete runbook command/stop checklist.
The release workflow now derives its provenance and SBOM subject paths from
the locked artifact manifest, eliminating the prior revision literal that
would otherwise become stale during an upgrade. CI and the normal repository
check both run this verifier. Runtime and human-review gates remain mandatory:
passing the offline consistency check cannot authorize an ABI, golden,
performance, licensing, or terminal-behavior change.

## FFI and TRF1 mutation gates

[`fuzzing.md`](fuzzing.md) defines reproducible mutation gates for the C ABI
state machine and Swift TRF1 envelope/section decoders. The Rust gate performs
256 stateful operations while checking panic/poison status, owned-output
zeroing, arena bounds, and effect order. The Swift gate exercises 4,096
envelopes and 4,096 independent section payloads from a fixed seed, including
structured magic/version cases that reach beyond the outer header checks.

The first run found an availability bug: impossible `u32` selection rows could
enter Ghostty's formatter for more than a minute. The shared model now rejects
non-select-all endpoints outside the retained terminal grid, and the exact
maximum-coordinate call is a permanent FFI seed. Run both bounded gates with:

```sh
npm run test:fuzz:smoke
```

The smoke gates are suitable for ordinary regression runs but do not yet close
the release item. A timed AddressSanitizer campaign against the locked release
toolchain and release native libraries, with corpus hashes and resource limits
recorded in evidence, remains mandatory.

`npm run test:fuzz:sanitizer` now implements the timed campaign and redacted
evidence schema. It hashes seven exact lock/source/corpus inputs, records the
source and locked Xcode/Swift/Rust identities (not bare PATH tools), bounds each
isolated iteration, reclaims its Rust target between boundaries, and requires a
clean locked-toolchain one-hour run in release mode. The Rust FFI boundary runs
first and passes under LLVM ASan. On macOS 26.5.1 with the currently locked
Xcode 26.1 toolchain, Apple's clang/Swift ASan runtime hangs during shadow
initialization before `main` (Apple radar **171762808**; fixed by Xcode 26.4+).
A 15-second Apple-clang preflight plus Swift TRF1 preflight classifies that hang,
writes blocked release-ineligible evidence that still includes the completed FFI
boundary, and refuses TRF1 sanitizer coverage. Closing this gate requires
reviewing and locking Xcode ≥26.4 on the release host, then re-running
`npm run test:fuzz:sanitizer:release`.

**Accepted deferral (2026-07-18):** continue implementation and internal device
qualification with the deterministic smoke gates and passing Rust FFI ASan
boundary. Do not treat the deferral as a waiver: a fixed, review-locked Xcode
and a passing one-hour Swift/TRF1 ASan campaign remain mandatory before an App
Store or external beta release candidate can be release-eligible.

## Memory-pressure recovery

[`memory-pressure.md`](memory-pressure.md) defines the implemented
presentation-cache transaction. A UIKit memory warning now releases the 4 MiB
alpha atlas, the lazily allocated 16 MiB color atlas when present, and CPU
glyph/style render payloads; it preserves readable row and accessibility text,
enters full-resync state, and suppresses redraw
until the host supplies a valid full snapshot. The production Truffle surface
requests that snapshot from the desktop attachment; the direct SSH surface
requests it from the local core. Recovery does not reconnect or replay remote
transport bytes.

The retained-state test and iOS harness cover glyph release, rejection of an
incremental frame after eviction, atomic full-frame recovery, atlas release,
and lazy rebuild. This closes the renderer memory-pressure and atlas-eviction
deliverable. The next memory slice surfaces Ghostty's full scrollback
compression through the serialized production C/Rust/Swift boundary and has
the application compress hidden-tab SSH terminals on a warning while every
selected-tab pane remains protected. Cross-layer tests require 2,000 lines and
scrollbar state to remain unchanged. The following slice enforces the Phase 0
four/eight-session device-tier target with deterministic detached-session LRU
eviction. Layout identity and secret-free profile bindings survive while the
terminal, transport, frame, and scrollback are released; selecting or
reconnecting the cold pane recreates fresh native resources under the same
session ID without silently starting a remote shell. Aggregate CPU/GPU byte
enforcement then uses Darwin's process-wide physical-footprint counter and the
same Phase 0 96/160 MiB soft and 128/224 MiB hard bounds. While over soft, it
evicts remaining hidden SSH resources one at a time and resamples; selected
panes and active Truffle views remain protected, with typed diagnostics if they
alone leave the bound unsatisfied. A Debug-only signed-app gate now creates five
demand-paused sessions, crosses the standard-tier soft limit without crossing
hard, invokes that exact production handler, and jointly verifies the numeric
result on-device and on the host. Its first iPhone 14 Pro run recovered from
185.1 MiB to 145.2 MiB with exactly the oldest hidden session evicted; the
selected session, workspace, idle survivors, protected persistence, and typed
diagnostics all passed. Compact-tier physical-device evidence and real
system-pressure/jetsam restoration remain open release qualification.

An opt-in Debug gate now exercises the production app across abrupt process
death. It uses an isolated per-run protected store, persists a demand-paused
workspace, lets the host terminate the process without a lifecycle callback,
and verifies stable identity, zero connection attempt, secret-free restoration,
and conservative `previousTerminationUnrecorded` diagnostics after relaunch.
This reduces the jetsam-restoration risk but remains a proxy: a real
system-pressure kill and foreground/resync run are still required for release.
The first signed iPhone 14 Pro run completed both launches, the host-initiated
signal-15 termination, restoration validation, isolated cleanup, and exit zero.
