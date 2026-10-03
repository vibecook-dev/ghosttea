# WebGPU appearance pipeline

Each terminal pane owns one persistent terminal-scene texture and lazily owns
up to two shader ping-pong targets. All panes share a WebGPU device, pipelines,
and glyph atlases through the render worker. Empty and single-effect stacks
need no intermediate target; two effects need one; longer stacks need both.

## Pass composition

1. The terminal scene pass updates the persistent scene texture. Full damage
   clears it to the theme background; row damage first overwrites affected
   rows with the premultiplied background, then blends cell backgrounds,
   selection, glyphs, decorations, and cursor geometry.
2. The ordered shader stack samples the scene. Intermediate effects alternate
   between ping-pong A and B; the final effect writes to the canvas texture.
3. An empty effect stack still performs one full-screen blit, so scene
   persistence and canvas acquisition use the same path.

Each effect pass has an independent 48-byte uniform containing its registry
mode, frame number, stack position, physical resolution, time/delta, and
cursor state. Separate uniform buffers are required because multiple writes to
one buffer before a queue submission would otherwise make every encoded pass
observe the final effect's values.

Animation marks only focused, visible WebGPU surfaces with at least one
animated effect dirty. With no terminal damage, the renderer bypasses terminal
geometry and the scene pass and reruns only the full-screen effects. Static
CRT-only stacks, Canvas fallback, hidden tabs, and unfocused panes stop
requesting frames.

## Alpha semantics

The scene, ping-pong textures, canvas context, and shader outputs all use
premultiplied alpha. `background-opacity` controls the default terminal
background. `background-opacity-cells` also applies that alpha to explicit
cell backgrounds.

Incremental row reset uses a no-blend overwrite pipeline. Normal source-over
blending cannot reduce destination alpha, so using the standard rectangle
pipeline would retain stale opaque pixels after transparency is enabled.
macOS BrowserWindows are created alpha-capable and the DOM beneath each canvas
is transparent. Native framed Windows/Linux windows remain OS-opaque even
though renderer alpha remains correct.

A solid block cursor is inserted after selection backgrounds and before glyphs;
the covered glyph uses `cursor-text`. Bar, underline, and hollow cursors remain
late overlay geometry.

## Light adaptation

Some applications paint every cell with their own truecolor background, so a
light theme never shows through (Grok's default theme paints `#141414`
everywhere). With `ghosttea-light-adaptation = auto` (the default; Settings →
Appearance → Readability, or `off` to disable), a pane is remapped when the theme background is light and at least 60% of its
cells carry an explicit dark background. It releases below 35%, so partially
painted scrolls do not flicker. Applications that follow the theme (Codex,
OpenCode, Claude Code's Auto theme) never cross that threshold.

The remap runs in `resolveStyle`, per style and before blending, so glyph
coverage, color glyphs, and the shader stack are untouched. Surfaces mirror
their OKLab-with-toe lightness around the theme background, anchored at the
application's dominant surface. Neutral ink keeps its distance from its own
cell background, and accents land in an APCA mid-tone band with their hue
intact. Default foreground and background stay theme-owned, and so do the
chromatic ANSI colors (palette 1–6 and 9–14): TRF1 section 13 tells the
renderer which palette entry a style color came from, and the light theme's own
entry is kept unless the remapped surface beneath leaves it less legible than
on the theme background (capped at APCA Lc 45). Neutral entries (0, 7, 8, 15)
describe a role rather than a hue and remap like truecolor. Engaging,
re-keying, or releasing invalidates the persistent scene and geometry cache.

## Minimum contrast

Ghostty's `minimum-contrast` (WCAG ratio 1–21, 1 is off) applies to text
glyphs and their underline and strikethrough, measured against the cell
background composited over the theme background, after light adaptation.
Ghostty snaps failing text to black or white; Ghosttea keeps hue and chroma and
moves OKLab lightness toward whichever extreme contrasts more, only as far as
the ratio needs. Box drawing, block elements, and color glyphs are exempt, as
in Ghostty.

Applications that switch themes themselves need the terminal to say which
scheme it is. ghosttead answers `CSI ? 996 n` from the default background's
luminance, sends `CSI ? 997 ; 1|2 n` when a theme change flips it and mode
2031 is set, and sets `COLORFGBG` for new sessions unless the caller provides
one.

## Catalogs and persistence

The linked `ghostty.style` gallery seeds its built-in collection from every
Ghostty file in `mbadolato/iTerm2-Color-Schemes`. Ghosttea packages that source
directly as a deterministic offline picker rather than depending on the
gallery's mutable community database at runtime. The generated catalog pins
all 602 files at revision
`875a82f0fdc773ae45099ce683a11c56bb0f8b3d`. A selected theme expands to fixed
colors plus ANSI palette entries 0–15. The daemon applies sparse palette
overrides on top of libghostty's default 256-color palette.

The desktop bridge validates settings, generates a marked Ghostty-syntax
appearance block, validates the full layered candidate through the daemon, and
replaces the profile overlay with compare-and-swap. Text outside the managed
block is preserved. A configuration is identified as a catalog theme only when
all fixed colors and ANSI entries 0–15 match; otherwise the picker keeps a
"Current custom colors" choice and omits color mutations. The managed block is
kept last, and the daemon's effective projection must match every requested
value before the save may succeed, so later includes cannot silently shadow an
Apply operation.

The shader picker accounts for all 36 files at reviewed
`0xhckr/ghostty-shaders` revision
`85898f08fcf4a9274e418912098e99e00a5f8350`. New bundled ports are limited to
files with explicit redistributable terms. The other names remain visible but
disabled pending clearance; arbitrary GLSL paths are never executed as WGSL.
