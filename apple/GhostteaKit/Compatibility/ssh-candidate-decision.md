# Phase 0 SSH candidate decision

**Status:** Phase 0 selects the libssh2 adapter as the implementation path for
development. The pinned 1.11.1 release is a compatibility artifact and must be
upgraded before production release.

**Recorded:** 2026-07-17

## Outcome

The current SwiftNIO SSH client surface, including Citadel’s higher-level
wrapper, does not expose keyboard-interactive authentication. That is a launch
gap for common PAM and OTP deployments. libssh2 1.11.1 does expose a
multi-prompt keyboard-interactive callback and a caller-driven nonblocking API,
and this repository now proves it can be packaged and imported on the supported
Apple targets.

This is a development architecture decision, not production dependency
approval. On 2026-07-17 the dependency review
found that the latest tagged release remains 1.11.1 while newly disclosed
pre-authentication vulnerabilities affect releases through 1.11.1. Upstream
fixes exist on the development branch, but no fixed release is tagged. The
checked-in `check:ssh:production` gate therefore fails closed until a fixed pin
incorporates the recorded commits and the Apple, fixture, package, and physical-
device gates are rerun. This release gate does not block Phase 1 implementation
against the current compatibility artifact.

The upstream state was checked again on 2026-07-18. The official download and
release pages still expose 1.11.1 as the latest tag. Upstream master at
`95375dc0dd56e2457ae216249e6f6b8156d5f7a3` contains all six fixes recorded in
the lock, but it is 791 commits beyond the pinned release. Absorbing that branch
would not be a narrow security update. A minimal chronological cherry-pick was
also tested in a disposable worktree; the first backport,
`2dae3024897e1898d389835151f4e9606227721d`, conflicts in `src/sftp.c` against
1.11.1. No generated source or lock pin was changed. The production blocker
therefore remains until upstream tags the prepared fixed release or a separately
reviewed backport stack is authored and passes every recorded revalidation
gate.

The review was repeated on 2026-10-24 (`securityReview` in the lock). 1.11.1
is still the latest tag and release; master reads `1.11.2_DEV`, and the
upstream release request (libssh2 issue #1925) remains open. The lock now
requires 19 fixes rather than six:

- the six above, which still map to the six advisories published between
  2026-05-02 and 2026-06-28;
- four more published on 2026-07-24, all "libssh2 through 1.11.1" in NVD and
  the GitHub advisory database, two of them pre-authentication; and
- nine that upstream's commits or master `RELEASE-NOTES` tie to repository
  advisories that are not yet public. Each of those GHSA IDs returns 404 from
  both the global and the repository advisory APIs. Each code path was read in
  the 1.11.1 tree and carries the defect.

Querying OSV by the pinned commit returns the same ten CVEs, plus five
OSS-Fuzz crash records that have no advisory. OSV records four as fixed on
master: OSV-2022-24 and OSV-2024-847 at `b89858b8`, OSV-2025-90 and
OSV-2025-92 at `631e2f82`. The fifth, OSV-2025-433, has no recorded fix. It is
a null-pointer read in `_libssh2_packet_add`, reached from
`_libssh2_transport_read` on server-sent packets, and was introduced by the
strict key exchange commit `d34d9258`, which 1.11.1 contains. OSV lists no
fixed commit for it, and no upstream commit since 1.11.1 cites its OSS-Fuzz
issue (422217191). None of the five is required, because none has an advisory,
and OSV-2025-433 has no fix commit to require. Treat it as unfixed upstream;
the next review should check it again.

| Advisory                                                 | Published  | Fix commit | Defect                                                      |
| -------------------------------------------------------- | ---------- | ---------- | ----------------------------------------------------------- |
| CVE-2026-7598, GHSA-jhp3-h4hp-2c3p                       | 2026-05-02 | `256d04b6` | `userauth_password` length integer overflow                 |
| CVE-2025-15661, GHSA-3wqh-87fg-ffgg                      | 2026-06-18 | `2dae3024` | `sftp_symlink` heap out-of-bounds read                      |
| CVE-2026-55199, GHSA-3cfq-4xx4-rmpg                      | 2026-06-17 | `17626857` | pre-authentication `EXT_INFO` CPU loop                      |
| CVE-2026-55200, GHSA-r8mh-x5qv-7gg2                      | 2026-06-17 | `97acf3df` | `packet_length` heap out-of-bounds write (critical)         |
| CVE-2026-58050, GHSA-mf77-5hj2-98w9                      | 2026-06-28 | `34497525` | 32-bit publickey attribute count overflow                   |
| CVE-2026-58051, GHSA-c5f3-hwj2-xp5p                      | 2026-06-28 | `a9758da4` | publickey list free of an uninitialized entry               |
| CVE-2026-66032, GHSA-83r8-6c29-8gwr, GHSA-px3w-7g75-hg7w | 2026-07-24 | `5e477614` | `sftp_open` double free                                     |
| CVE-2026-66034, GHSA-6h6q-9mwg-r6x7, GHSA-w6g9-cpfp-22gc | 2026-07-24 | `a13bb6c7` | publickey v1 `comment_len` out-of-bounds read               |
| CVE-2026-66035, GHSA-v6rf-8q4r-r495, GHSA-6c79-444r-wx26 | 2026-07-24 | `42e33d81` | pre-authentication ETM decrypt heap overflow                |
| CVE-2026-66033, GHSA-2g8c-wcg8-r65c, GHSA-c4f7-cvfc-33j7 | 2026-07-24 | `a2ed82d4` | pre-authentication AES-GCM underflow in `ssh2_cipher_crypt` |
| GHSA-w8q5-9hq2-h9pr                                      | not public | `e3fba528` | publickey init status out-of-bounds read                    |
| GHSA-m9rg-h9jv-9gvh                                      | not public | `fcf83078` | Diffie-Hellman public value not validated (OpenSSL backend) |
| GHSA-x4g5-mgfc-cxvv                                      | not public | `15257c08` | short chacha20-poly1305 packet length underflow             |
| GHSA-53q9-wmqr-fh7c                                      | not public | `0a17ea04` | leak on repeated `exit-signal`                              |
| GHSA-p2v4-ghw2-mvq3, GHSA-v6rf-jr7x-9hhp                 | not public | `4884fc61` | unchecked `snprintf` in `scp_send`                          |
| GHSA-qwvp-xm4w-32m7                                      | not public | `b4e6761d` | publickey list state lost across `EAGAIN`                   |
| GHSA-2q3j-q544-xxp7                                      | not public | `9438f90a` | `sftp_packet_read` loop on unexpected EOF                   |
| GHSA-4q73-hh48-fmr8                                      | not public | `b5c37a91` | zero channel `packet_size` from the server busy-loops       |
| GHSA-vc97-vgww-qggv                                      | not public | `5d27ee28` | uncapped OpenSSH private-key KDF rounds                     |

The lock records each full SHA and every advisory ID under `advisories`.
CVE-2026-55200's advisory text names `7acf3df`; its references and the commit
itself identify `97acf3dfda80c91c3a8c9f2372546301d4a1a7a8`. CVE-2026-58050 and
-58051 name no commit, and neither fix commit cites a CVE. The mapping matches
descriptions and dates: `34497525` caps `num_attrs` at 1024 before the
multiplication, `a9758da4` fixes the free of an uninitialized list entry, and
both landed within a day of the advisories' 2026-06-28 publication.

Several fixes are on paths this adapter can negotiate or call: transport
framing, AES-GCM, ETM and chacha20-poly1305 decryption, Diffie-Hellman key
exchange, exit signals, and in-memory OpenSSH private keys.

Three upstream changes were read and are deliberately not required:

- `d0ca946d` and `7f28c290` carry GHSA-m9rg-h9jv-9gvh to the os400qc3 and
  WinCNG backends, which this build (`-DCRYPTO_BACKEND=OpenSSL`) does not
  compile.
- GHSA-p6p8-66vc-3f24 (`59329f34`, which reverts `ce631aaf`) corrects
  documentation only: libssh2 frees keyboard-interactive response text with
  the session's allocator. The shim creates sessions with
  `libssh2_session_init_ex(NULL, NULL, NULL, …)`, the default allocator, so its
  `strdup` responses are correct under both readings.
- `2fedc0b3` extends `256d04b6`'s username and password caps for 32-bit builds
  only. Every slice here is arm64, but a reviewed backport should carry it.

Every required fix is an ancestor of master
`6e7b2076a6ced2230968b27ee7c1abb77fe5a88d`, which is 1108 commits beyond 1.11.1
(GitHub's compare API and a local clone agree). The minimal backport was
retried in a disposable clone. All 19 commits were cherry-picked onto
`libssh2-1.11.1` in master order. The first,
`2dae3024897e1898d389835151f4e9606227721d`, still conflicts in `src/sftp.c`, in
`sftp_symlink`'s local declarations. Applied alone, six apply cleanly
(`256d04b6`, `17626857`, `34497525`, `a9758da4`, `a13bb6c7`, `a2ed82d4`) and 13
conflict. A backport would therefore be a hand-ported stack of at least 13
fixes, not a cherry-pick. No fix is incorporated and no pin changed.

The fixed release will also change negotiated defaults. Master `RELEASE-NOTES`
says 1.11.2 disables SHA-1 `ssh-rsa` host keys and signatures, SHA-1 key
exchange and MACs, DSA, MD5, 3DES, RIPEMD-160, Blowfish, RC4 and CAST by
default. None of the fixture profiles below negotiates any of these.

Separately, against the pinned OpenSSH
`publickey,keyboard-interactive` endpoint, the correct public key returns
`LIBSSH2_ERROR_PUBLICKEY_UNVERIFIED` (`-19`) with the session still
unauthenticated; explicitly invoking keyboard-interactive next succeeds with
two prompts and completes authentication. A wrong-key control does not
authenticate. Thus chained MFA works, but libssh2 1.11.1 does not expose a
distinct partial-success result. The adapter must sequence only methods allowed
by product/server policy and lock this ambiguous return behavior under tests.
Upstream work to represent partial success explicitly remains relevant.

The repository now implements that narrow policy in `GhostteaSSH`: only the
explicit `publicKeyThenKeyboardInteractive` configuration accepts the observed
`-19` step and attempts the second method. A public-key-only configuration
still fails on `-19`, and the wrong-key chained control remains rejected by the
server. Keyboard-interactive authentication uses an asynchronous Swift
responder receiving the server name, instruction, prompt text, and echo policy.
The synchronous libssh2 callback waits on a condition variable on a dedicated
worker rather than blocking a Swift cooperative executor.

## Reproducible evidence

The exact inputs are locked in `native/ssh.lock.json`:

- OpenSSL `openssl-3.5.7` at
  `8cf17aaeb4599f8af87fefd810b5b5fee90fe69e`;
- libssh2 `libssh2-1.11.1` at
  `a312b43325e3383c865a87bb1d26cb52e3292641`;
- deployment targets macOS 14 and iOS 17 on arm64.

The build produces a static XCFramework with macOS arm64, iOS arm64, and iOS
simulator arm64 slices. On Xcode 26.1 the three archives total 26,209,680 bytes;
the individual archives are roughly 8.1–9.0 MB. These are pre-link archives
containing libssh2 and libcrypto, not installed-app size. Dead stripping and App
Store thinning must be measured in the eventual app.

After raising the OpenSSL floor to 3.5.7 on 2026-07-17, the clean three-slice
build and validator, C candidate fixture, complete Swift adapter fixture, all 25
package tests, and both iOS SDK harness builds passed. This validates the
OpenSSL-only upgrade; it does not satisfy the revalidation list for the future
fixed libssh2 pin, which remains deliberately empty in the lock.

The validator checks platform metadata, archive format, architecture, headers,
module map, and the following symbols in every slice:

- `libssh2_init`;
- `libssh2_session_init_ex`;
- `libssh2_userauth_keyboard_interactive_ex`;
- `libssh2_version`.

`GhostteaSSHProbe` additionally proves from Swift that global initialization,
session allocation/free, runtime version lookup, and the keyboard-interactive
API import work on macOS. The same target cross-compiles for iOS device and
simulator. The upstream 1.11.1 tag reports the runtime string `1.11.1_DEV`; the
commit pin, rather than that string, is the authoritative source identity.

The repository also contains a pinned OpenSSH reference fixture with four
endpoints: password, public key, two-prompt keyboard-interactive, and public key
followed by keyboard-interactive. Its system-OpenSSH baseline proves the
scenarios are configured correctly. It also verifies exact stdout/stderr and
exit status, an initial and repeated PTY size, and a 32 MiB stalled-reader flood
that resumes without byte loss. A test-only C probe linked against the packaged
XCFramework now passes password, Ed25519 public key, two-round
keyboard-interactive, strict known-host matching, command execution, and the
explicit chained-authentication sequence. It also locks the current `-19`
partial-step behavior and rejects a wrong-key control. The PTY and flood results
also run through the nonblocking Swift adapter. It allocates a 41x132 PTY,
resizes it to 50x140, stops reading for 750 ms during a 32 MiB stream, and then
drains exactly 33,554,432 bytes. The 2026-07-17 revalidation measured a stalled
process maximum RSS of 10,764,288 bytes on the development Mac, below the 64
MiB gate. With
cancellation-triggered socket shutdown, a blocked channel read observed Swift
task cancellation in under 1 ms. Strict
known-host matching succeeds, while empty and changed-key files are rejected.
Every fixture connection also locks the negotiated methods as
`curve25519-sha256`, `ssh-ed25519`,
`chacha20-poly1305@openssh.com` in both directions, and `hmac-sha2-256` in both
directions. A second forced profile passes strict known-host verification and a
shell session with `ecdsa-sha2-nistp256`, bidirectional
`aes256-gcm@openssh.com`, and `INTEGRATED-AES-GCM`. A third forced profile
passes strict known-host verification and a shell session with a 3072-bit RSA
host key negotiated as `rsa-sha2-512`, never the deprecated `ssh-rsa` signature
algorithm. The local feasibility matrix is green; representative
production-server coverage is still required.
The live keyboard fixture exercises an informational zero-prompt round followed
by distinct password and verification-code rounds, preserving their exact text
and mixed `echo=false`/`echo=true` metadata. A PAM `PAM_TEXT_INFO` message is
also preserved exactly where OpenSSH folds it into the hidden-password prompt.
The OpenSSH fixture's empty protocol-level server name and instruction are
asserted exactly. A separate minimal Paramiko endpoint emits nonempty
`Ghosttea metadata fixture` and `Supply both test factors.` values plus both
mixed-echo prompts in one round. System OpenSSH, the raw C/libssh2 callback, and
the Swift async challenge all preserve those values exactly. The cancellation
fixture's responder deliberately suspends before replying.
Cancelling while that responder is suspended wakes and joins the libssh2 worker
in under one millisecond on the development Mac.
TCP establishment now uses a nonblocking connector with an absolute deadline,
100 ms cancellation polling, and socket shutdown from the Swift task
cancellation handler. The SSH handshake has a separate deadline. A deterministic
fixture accepts TCP but never sends an SSH banner: its 250 ms handshake deadline
fired in approximately 307 ms, and cancellation unwound in approximately 77 ms.
Hostname lookup now uses the asynchronous Apple DNS-SD API under that same
absolute connection deadline. The connector polls the resolver at most every
100 ms, so cancellation and timeout no longer wait for a synchronous
`getaddrinfo`; numeric IPv4 and IPv6 literals retain a non-resolving fast path.
The package suite opens a loopback socket through `localhost`, and the full SSH
fixture authenticates through that hostname path. Both iOS SDK builds pass. A
signed iPhone build also resolves the Mac's Bonjour hostname and completes the
bounded SSH command through it; representative server DNS remains open.
The same process also completes 32 consecutive stalled-handshake cancellations
and 16 consecutive suspended keyboard-interactive cancellations, with every
cycle bounded below one second. This exercises repeated session destruction and
callback-worker cleanup. On a physical iPhone, disabling Wi-Fi during an active
LAN command and explicitly cancelling shuts down the socket and unwinds in 23
ms. After Wi-Fi restoration, a fresh connection to a new fixture completes a
bounded command. A reusable transport-neutral reducer and Network.framework
observer now implement generation-checked route state, automatic teardown,
background suspension, and explicit fresh-reconnect availability. Automatic
Wi-Fi-to-cellular teardown, explicit fresh reconnect, background teardown, and
foreground reconnect availability now pass on the physical iPhone.
The host-neutral transport now includes input half-close and a typed termination
result that distinguishes `.exited(code:)` from `.signaled(name:)`.
A non-PTY command fixture receives byte-exact, separate `fixture-stdout\n` and
`fixture-stderr\n` streams and preserves exit status 37. A second command sends
`half-close-payload\n`, calls `finishInput()`, reads the exact echoed bytes, and
completes `wait_eof`, channel close, and `wait_closed` with exit status 0. The
candidate command reader services both SSH streams before waiting on the
socket, preventing buffered stderr from starving behind idle stdout.
A third command terminates its remote shell with `SIGTERM`; the adapter copies
and frees libssh2's allocated exit-signal value and returns
`.signaled(name: "TERM")` instead of the library's default numeric zero.
The generated-key fixture also authenticates with a passphrase-encrypted
OpenSSH Ed25519 private key through both the legacy path/string case and the
production-shaped opaque resolver, and rejects incorrect passphrases through
both paths. The resolver receives only opaque private-key and passphrase IDs,
passes counted private-key bytes to libssh2's in-memory API, and supplies no
public-key data so the OpenSSL backend derives it. No key path or temporary key
file exists. The C shim also accepts counted passphrase bytes and wipes its
required null-terminated copy before freeing it. Unencrypted and encrypted
opaque resolver cases pass, and the wrong-passphrase control is rejected.

The candidate exposes diagnostic flow-control counters without changing the
host-neutral transport protocol: bytes delivered to Swift per channel, raw
encrypted socket bytes received/sent, bytes written, socket-wait calls, and
libssh2's current/initial receive-window state. During the 750 ms flood pause,
neither the delivered-byte nor raw socket-receive counters move, proving that
the adapter does not prefetch network or channel data into a hidden queue. The
subsequent drain remains byte-exact. One representative run consumed 33,848,488
encrypted socket bytes while delivering the 33,554,432-byte payload, reported a
2,096,949-byte receive window from an initial 2,097,152 bytes, and performed
1,143 socket waits. Because the adapter performs no channel read while demand
is paused, this observation shows backpressure at the socket/SSH-processing
boundary; it does not claim that libssh2 consumed packets and advertised a
smaller remote channel window during the pause.

Strict known-host verification remains the default. For an unknown or changed
key, an opt-in async responder now receives the host, port, negotiated key
algorithm, OpenSSH-style SHA-256 fingerprint, and whether the key is unknown or
changed. It may reject or accept that connection once; authentication never
starts before the decision. The fixture proves strict rejection and explicit
accept-once decisions for both states. An `acceptAndStore` decision inserts an
unknown key or replaces the rejected changed entry through a mode-preserving,
fsynced temporary file and atomic rename. Strict reconnects prove both stored
results. The UIKit confirmation flow remains product work.

## Reproduce

From the repository root on Apple Silicon macOS:

```sh
npm run bootstrap:ssh:apple
npm run build:ssh:apple
npm run check:ssh:apple
npm run test:ghostty-vt:apple
npm run test:ssh:fixture
npm run test:ssh:fixture:candidate
npm run test:ssh:fixture:swift
```

Generated source checkouts, build directories, and XCFrameworks are ignored.
Only lock data, scripts, package declarations, probes, tests, and this decision
record belong in source control.

## Intended adapter boundary

The candidate adapter is a `GhostteaSSH` package implementing
`TerminalTransport`. It owns the socket, opaque libssh2 session and channel,
credential callbacks, strict host-key check, and cancellation. A per-connection
async gate prevents actor reentrancy from overlapping libssh2 calls while a
poll wait is suspended. The generic terminal controller sees only:

- pull-based `read(maxBytes:)` demand;
- ordered, lossless writes;
- input half-close and typed remote exit status;
- resize and interrupt operations;
- disconnect and typed failure.

No libssh2 type crosses that boundary. Inbound reads must stop when the
terminal actor has no capacity, and the live flood fixture must demonstrate
that backpressure reaches the transport rather than accumulating in an
unbounded Swift stream. Depending on where processing pauses, SSH applies this
by withholding channel-window updates or by stopping socket consumption so TCP
backpressure reaches the peer. The live adapter calls neither socket nor
channel read without a `read(maxBytes:)` request; its stalled-reader fixture
remains bounded and lossless. `ReplayTransport` and `OrderedTerminalWriter`
separately test the host-neutral demand and queue semantics.

## Work required before production release

1. Upgrade to a fixed, immutable upstream libssh2 release or an explicitly
   reviewed commit that contains every fix recorded in `native/ssh.lock.json`.
   Do not ship the current 1.11.1 artifact. Rerun the three-slice Apple build,
   package suite, both live SSH fixtures, and physical-device harness before
   changing `productionApproved`. Development and parity work may continue
   while this release gate remains red.

2. Promote the diagnostic asynchronous challenge responder and opaque
   private-key chooser into the product connection UI. Opaque
   encrypted-key/passphrase resolution through the in-memory key API now
   passes both the macOS fixture and a physical iPhone. PAM informational text
   passes on macOS; nonempty protocol name/instruction metadata and mixed
   echo/no-echo prompts pass through the diagnostic UI on a physical iPhone.
3. Promote the tested unknown/changed host-key responder into the product
   connection UI. Strict rejection, explicit accept-once decisions, atomic
   insertion/replacement, and permission preservation pass in fixtures. A
   physical iPhone persists an unknown key, warns before replacing a changed
   key, and then reconnects strictly without another prompt.
4. Repeat the now-instrumented negotiated-method capture against the launch
   server sample and decide which profiles must ship. Forced ECDSA P-256,
   AES-256-GCM, and RSA/SHA-2-512 endpoints already pass.
5. Repeat the implemented resolver and reconnect orchestration against the
   representative server/network sample. PTY allocation, resize, shell I/O,
   command exit status/signal, half-close, graceful close, auth/read cancellation,
   DNS/connect/handshake deadlines and cancellation, and repeated auth/handshake
   cancellation stress already pass. Physical challenge-sheet cancellation,
   automatic Wi-Fi-to-cellular teardown, explicit fresh reconnect, background
   suspension, and foreground reconnect availability pass; representative-server
   transitions remain.
6. Carry the completed active-SSH gate into the terminal controller. The
   standard-tier iPhone pauses app demand with unchanged delivered and raw
   socket counters, holds the process at 16.9 MB, and then drains the complete
   32 MiB flood byte-for-byte. The same device also passes one active and seven
   compressed background VT sessions at 30.5 MB process footprint.
7. Run the package and network fixture on a physical low-end supported iOS
   device.

## Sources

- SwiftNIO SSH: <https://github.com/apple/swift-nio-ssh>
- Citadel: <https://github.com/orlandos-nl/Citadel>
- libssh2 keyboard-interactive API:
  <https://libssh2.org/libssh2_userauth_keyboard_interactive_ex.html>
- libssh2 partial-success pull request:
  <https://github.com/libssh2/libssh2/pull/1760>
- libssh2 upstream releases (1.11.1 is still latest as of the review):
  <https://github.com/libssh2/libssh2/releases>
- upstream security fixes recorded by the 2026-06 disclosure:
  <https://www.openwall.com/lists/oss-security/2026/06/23/10>
- the 2026-07-24 advisories, for example CVE-2026-66035:
  <https://github.com/advisories/GHSA-v6rf-8q4r-r495> and
  <https://nvd.nist.gov/vuln/detail/CVE-2026-66035>
- OSV's record of the pinned commit: `POST https://api.osv.dev/v1/query` with
  `{"commit":"a312b43325e3383c865a87bb1d26cb52e3292641"}`
- upstream master's release notes, which name each repository advisory:
  <https://github.com/libssh2/libssh2/blob/master/RELEASE-NOTES>
- the upstream release request:
  <https://github.com/libssh2/libssh2/issues/1925>
- Debian DSA-6365-1 impact summary:
  <https://lists.debian.org/debian-security-announce/2026/msg00276.html>
- OpenSSL 3.5 vulnerability floor:
  <https://openssl-library.org/news/vulnerabilities-3.5/>
- OpenSSL releases: <https://github.com/openssl/openssl/releases>
