# @vibecook/ghosttea-frame

Binary frame decoder and shared renderer types for Ghosttea. Most applications
should consume the higher-level Ghosttea renderer integration instead of this
low-level package directly.

Ghosttea is developed at <https://github.com/vibecook-dev/ghosttea>.

## Link targets (TRF1 section 12)

`decodeLinkTargets(section, cols, rows)` returns URL destinations and viewport
cell spans. The section replaces the entire visible link set on each frame;
an empty set clears old targets. Producers without link metadata omit it.
Unknown sections can be skipped by older decoders; existing sections retain
their byte layouts and TRF1 remains version 1.

All fields are little endian. Payload: `u32 targetCount`, then for each target
`u32 uriByteLength`, `u16 spanCount`, `u16 flags` (bit 0 = explicit OSC 8), UTF-8
URI bytes, followed by `spanCount` triples of `u16 row`, `u16 startColumn`,
`u16 endColumn`. End columns are exclusive. The section header's item count
must equal the target count. URI lengths are bounded at 8192 bytes, and all
spans must fit the advertised viewport.
