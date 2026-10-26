# harfrust 0.15.0: Apple render evidence for vibecook-dev/ghosttea#89

Measured 2026-10-26 after 0.13.5 shipped. It closes the Apple half of #89's [STOP-FONTS] pair, which was deviated
on the night: the pinned Ghostty toolchain could not be installed on the available hosts.

**How.** GhostteaKit's development manifest reads one binary, `Artifacts/ghosttea-apple-native.xcframework`, which is
gitignored. The PUBLISHED release artifacts were unzipped there, each checksum equal to its release lock, so no
pinned-toolchain build was needed. One Swift build of GhostteaKit at main 60c5a228, made with Xcode 26.6 on an
Apple M1 Max, ran `GhostteaRenderEvidenceTests` (from ci/apple-render-evidence) against each artifact. The test
draws the production terminal frame offscreen through `GhostteaMetalRenderer`: 787×574 px, 100×30 cells, the
cursor hidden.

| label | Apple native artifact | shaper | zip sha256 | render pixel hash |
|---|---|---|---|---|
| before | `ghosttea-apple-native-3ee0f5d6ccad` (0.13.4) | HarfBuzz 2.6.8 | 492b7940288cdb887a7d03e04552e5cd86a36fdd9b647381b09bbf8979624b87 | 3554ff23fb0f9b4a |
| after | `ghosttea-apple-native-d68c21713d81` (0.13.5) | harfrust 0.15.0 | 7f7a60a5b4390a8e298baf1e67490d347a9ad1bcaaa1cabf31674df5643e003c | f5ca28f75f20130d |

**Result: 286 pixels differ of 451,738, max channel Δ 8.** Rows are 19 px each:

| row | text | pixels | max Δ |
|---|---|---|---|
| 1 | `Ghosttea => ffi != 0123456789` | 0 | 0 |
| 2 | bold `bold terminal` | 0 | 0 |
| 3 | italic `italic terminal` | 0 | 0 |
| 4 | bold italic `bold italic` | 0 | 0 |
| 5 | `e` + U+0301, `界` (combining-wide-missing) | 0 | 0 |
| 6 | `terminal 😀` (emoji-fallback) | 84 | 8 |
| 7 | `⏸ ⏸︎ ⏸️ 😀` (emoji-presentation) | 121 | 6 |
| 8 | `⏸ ✻ ⚠ ← ·` (symbol-fallback) | 23 | 2 |
| 9 | `Metal proof ✓ 界 styled 🙂` (the visual golden's text) | 58 | 6 |
| 10 | box drawing | 0 | 0 |
| 11 | `a` + 64 × U+0301 | 0 | 0 |

- **Only the rows the font fixture predicted move,** plus the golden's ✓/🙂. They are the three cases whose
  `font-parity.json` digests changed, and the glyph classes whose advances moved ≤ 0.015 px.
- **The 64-mark stack is pixel-identical on the Apple renderer with the bundled fonts.** The desktop capture's
  mark-column change came from the system fonts that the desktop app discovers.
- **Images:**
  - `before.png`, `after.png`;
  - `diff.png` (|Δ| ×16; unchanged pixels at 20 % grey).
