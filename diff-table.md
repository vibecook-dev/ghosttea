# harfrust 0.15.0: desktop render evidence for vibecook-dev/ghosttea#89

Captured 2026-10-26 on James's Mac (Apple Silicon, Xcode 26.6 host; 2400×1536 device px, scale 2) through the
render bench's own desktop-experiment app with a throwaway capture patch (`capture-harness.patch`, never committed):
- a `stopfonts-1` payload case;
- a PNG written beside the bench's frame hash;
- the window shown with `showInactive()`.

Each capture ran under an arm gate: HID idle ≥ 120 s, a dev-app guard clear, ≥ 10 GiB on both disks. Each label was
captured twice, 0-pixel stable, and every capture passed the bench's partial-vs-full-redraw hash check. Same app,
payload (`payload.txt`, 8 rows), window and fonts. Only `ghosttead` differs:

| label | ghosttead | shaper | sha256 (16) | `_hb_` symbols |
|---|---|---|---|---|
| before | main 139014b | HarfBuzz 2.6.8 via harfbuzz_rs 2.0.1 (what ships) | eeeaef8c4ab51778 | 31 |
| mid | #88 037f7dc5 | HarfBuzz 14.6.0 via harfbuzz_rs 3.0.1 | 4e1ebf39e09ef696 | 47 |
| after | #89 fb7623ec | harfrust 0.15.0 | 865e5a6044b6d1f5 | 0 |

Times: before and after at 05:24:53–05:25:09Z, mid at 05:57:04–05:57:08Z.

Rows are 38 device px each, from y = 0. The 64-mark column (x 71–77) is listed on its own because row 7's 64 stacked
combining acutes rise through the rows above it.

| region | harfrust vs 14.6 (px, max Δ) | 14.6 vs 2.6.8 (px, max Δ) | 14.6 vs 2.6.8 outside the mark column |
|---|---|---|---|
| **whole frame** | **0, 0** | 9,318, 191 | |
| 64-mark column (x 71–77, y 0–303) | 0, 0 | 1,059, 191 | |
| 1 `terminal 😀` | 0, 0 | 998, 191 | 266, 7 |
| 2 `⏸ ⏸︎ ⏸️ 😀` | 0, 0 | 517, 182 | 224, 7 |
| 3 `⏸ ✻ ⚠ ← ·` | 0, 0 | 380, 191 | 12, 3 |
| 4 eight emoji | 0, 0 | 2,420, 159 | 1,350, 9 |
| 5 box drawing | 0, 0 | 776, 137 | 637, 6 |
| 6 `Ghosttea => ffi != 0123456789` | 0, 0 | 2,160, 97 | 1,461, 97 |
| 7 combining marks, and `a` + 64 U+0301 | 0, 0 | 372, 8 | 0, 0 |
| 8 `Metal proof ✓ 界 styled 🙂` | 0, 0 | 1,695, 7 | 1,106, 7 |

- **harfrust and HarfBuzz 14.6 render this payload identically:** 0 pixels. `mid.png` and `after.png` are
  byte-identical files.
- **14.6 vs 2.6.8 reproduces before vs after exactly:** 9,318 pixels, row for row. Every change is the move from
  HarfBuzz 2.6.8 (2020) to modern HarfBuzz, the change a Homebrew-HarfBuzz build already shows.
- **The 64-mark column** is modern mark positioning: 2.6.8 stacks the 64 combining acutes differently. This is the
  input class of CVE-2023-25193.
- **Row 6's Δ 97** is one 1-px column at x 456, y 208–216: the anti-aliased right edge of the row's last glyph, where
  the row's whole-width sub-pixel advance shift (Δ ≤ 9 elsewhere) peaks. No glyph's identity changes.
- **Images:**
  - `before.png`, `mid.png`, `after.png`;
  - `diff-before-after.png` (|Δ| ×16; unchanged pixels at 20 % grey);
  - `diff-mid-after.png` (all zero: the frame at 20 % grey).
