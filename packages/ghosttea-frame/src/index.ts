export const FRAME_MAGIC = 0x31465254;
export const FRAME_PROTOCOL_VERSION = 1;
export const FRAME_HEADER_BYTES = 64;
export const SECTION_HEADER_BYTES = 16;
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;
export const FrameFlag = {
  FullSnapshot: 1 << 0,
  MouseTracking: 1 << 1,
  CatalogReset: 1 << 2,
} as const;

export enum SectionKind {
  GlyphDefinitions = 1,
  StyleDefinitions = 2,
  RowReplacements = 3,
  CursorState = 4,
  SelectionSpans = 5,
  ImageDefinitions = 6,
  ImagePlacements = 7,
  ScrollbarState = 8,
  ViewportMetadata = 9,
  AccessibilityText = 10,
  ClipboardWrite = 11,
  LinkTargets = 12,
}

export interface FrameSection {
  kind: SectionKind;
  flags: number;
  itemCount: number;
  bytes: Uint8Array;
}

export interface TerminalFrame {
  protocolVersion: number;
  flags: number;
  sessionHandle: bigint;
  viewHandle: bigint;
  sessionEpoch: bigint;
  layoutEpoch: bigint;
  frameSequence: bigint;
  terminalRevision: bigint;
  cols: number;
  rows: number;
  sections: FrameSection[];
}

export interface TextRow {
  row: number;
  text: string;
}

export interface RowReplacement extends TextRow {
  revision: bigint;
  glyphs: GlyphInstance[];
  styles: StyleRun[];
}

export enum GlyphFormat {
  Alpha8 = 0,
  Rgba8Premultiplied = 1,
}

export interface GlyphDefinition {
  id: number;
  width: number;
  height: number;
  bearingX: number;
  bearingY: number;
  format: GlyphFormat;
  pixels: Uint8Array;
}

export interface GlyphInstance {
  glyphId: number;
  styleId: number;
  x: number;
  y: number;
  width: number;
  height: number;
  cellStart: number;
  cellSpan: number;
}

export interface StyleDefinition {
  id: number;
  bold: boolean;
  italic: boolean;
  faint: boolean;
  inverse: boolean;
  invisible: boolean;
  strikethrough: boolean;
  underline: boolean;
  foreground?: readonly [number, number, number];
  background?: readonly [number, number, number];
}

export interface StyleRun {
  styleId: number;
  cellStart: number;
  cellSpan: number;
}

export interface CursorState {
  x: number;
  y: number;
  visible: boolean;
  style: CursorStyle;
  blinking: boolean;
}

export interface ScrollbarState {
  total: bigint;
  offset: bigint;
  length: bigint;
}

export enum CursorStyle {
  Bar = 0,
  Block = 1,
  Underline = 2,
  HollowBlock = 3,
}

function assertRange(condition: boolean, message: string): asserts condition {
  if (!condition) throw new RangeError(`Invalid terminal frame: ${message}`);
}

export function decodeFrame(buffer: ArrayBuffer): TerminalFrame {
  assertRange(buffer.byteLength >= FRAME_HEADER_BYTES, "truncated header");
  assertRange(buffer.byteLength <= MAX_FRAME_BYTES, "packet exceeds limit");
  const view = new DataView(buffer);
  assertRange(view.getUint32(0, true) === FRAME_MAGIC, "bad magic");
  assertRange(view.getUint16(4, true) === FRAME_PROTOCOL_VERSION, "unsupported protocol version");

  const sectionCount = view.getUint16(60, true);
  const tableEnd = FRAME_HEADER_BYTES + sectionCount * SECTION_HEADER_BYTES;
  assertRange(tableEnd <= buffer.byteLength, "truncated section table");

  const sections: FrameSection[] = [];
  for (let index = 0; index < sectionCount; index += 1) {
    const base = FRAME_HEADER_BYTES + index * SECTION_HEADER_BYTES;
    const kind = view.getUint16(base, true) as SectionKind;
    const flags = view.getUint16(base + 2, true);
    const offset = view.getUint32(base + 4, true);
    const length = view.getUint32(base + 8, true);
    const itemCount = view.getUint32(base + 12, true);
    const end = offset + length;
    assertRange(end >= offset && offset >= tableEnd && end <= buffer.byteLength, "section out of bounds");
    sections.push({ kind, flags, itemCount, bytes: new Uint8Array(buffer, offset, length) });
  }

  return {
    protocolVersion: view.getUint16(4, true),
    flags: view.getUint16(6, true),
    sessionHandle: view.getBigUint64(8, true),
    viewHandle: view.getBigUint64(16, true),
    sessionEpoch: view.getBigUint64(24, true),
    layoutEpoch: view.getBigUint64(32, true),
    frameSequence: view.getBigUint64(40, true),
    terminalRevision: view.getBigUint64(48, true),
    cols: view.getUint16(56, true),
    rows: view.getUint16(58, true),
    sections,
  };
}

export function decodeAccessibilityRows(section: FrameSection): TextRow[] {
  const view = new DataView(section.bytes.buffer, section.bytes.byteOffset, section.bytes.byteLength);
  assertRange(section.bytes.byteLength >= 2, "truncated text row header");
  const count = view.getUint16(0, true);
  assertRange(count === section.itemCount, "text row count mismatch");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const rows: TextRow[] = [];
  let offset = 2;
  for (let index = 0; index < count; index += 1) {
    assertRange(offset + 6 <= section.bytes.byteLength, "truncated text row");
    const row = view.getUint16(offset, true);
    const length = view.getUint32(offset + 2, true);
    offset += 6;
    assertRange(offset + length <= section.bytes.byteLength, "text row payload out of bounds");
    rows.push({ row, text: decoder.decode(section.bytes.subarray(offset, offset + length)) });
    offset += length;
  }
  assertRange(offset === section.bytes.byteLength, "trailing text row bytes");
  return rows;
}

export function decodeRowReplacements(section: FrameSection): RowReplacement[] {
  assertRange(section.kind === SectionKind.RowReplacements, "wrong row replacement section kind");
  assertRange(section.bytes.byteLength >= 2, "truncated row replacement header");
  const view = new DataView(section.bytes.buffer, section.bytes.byteOffset, section.bytes.byteLength);
  const count = view.getUint16(0, true);
  assertRange(count === section.itemCount, "row replacement count mismatch");
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const rows: RowReplacement[] = [];
  let offset = 2;
  for (let index = 0; index < count; index += 1) {
    assertRange(offset + 18 <= section.bytes.byteLength, "truncated row replacement");
    const row = view.getUint16(offset, true);
    const revision = view.getBigUint64(offset + 2, true);
    const length = view.getUint32(offset + 10, true);
    const glyphCount = view.getUint16(offset + 14, true);
    const styleCount = view.getUint16(offset + 16, true);
    offset += 18;
    assertRange(offset + length <= section.bytes.byteLength, "row replacement payload out of bounds");
    const text = decoder.decode(section.bytes.subarray(offset, offset + length));
    offset += length;
    const glyphs: GlyphInstance[] = [];
    for (let glyphIndex = 0; glyphIndex < glyphCount; glyphIndex += 1) {
      assertRange(offset + 28 <= section.bytes.byteLength, "truncated glyph instance");
      glyphs.push({
        glyphId: view.getUint32(offset, true),
        styleId: view.getUint32(offset + 4, true),
        x: view.getFloat32(offset + 8, true),
        y: view.getFloat32(offset + 12, true),
        width: view.getFloat32(offset + 16, true),
        height: view.getFloat32(offset + 20, true),
        cellStart: view.getUint16(offset + 24, true),
        cellSpan: view.getUint16(offset + 26, true),
      });
      offset += 28;
    }
    const styles: StyleRun[] = [];
    for (let styleIndex = 0; styleIndex < styleCount; styleIndex += 1) {
      assertRange(offset + 8 <= section.bytes.byteLength, "truncated row style run");
      styles.push({
        styleId: view.getUint32(offset, true),
        cellStart: view.getUint16(offset + 4, true),
        cellSpan: view.getUint16(offset + 6, true),
      });
      offset += 8;
    }
    rows.push({ row, revision, text, glyphs, styles });
  }
  assertRange(offset === section.bytes.byteLength, "trailing row replacement bytes");
  return rows;
}

export function decodeGlyphDefinitions(section: FrameSection): GlyphDefinition[] {
  assertRange(section.kind === SectionKind.GlyphDefinitions, "wrong glyph definition section kind");
  assertRange(section.bytes.byteLength >= 4, "truncated glyph definition header");
  const view = new DataView(section.bytes.buffer, section.bytes.byteOffset, section.bytes.byteLength);
  const count = view.getUint32(0, true);
  assertRange(count === section.itemCount, "glyph definition count mismatch");
  const definitions: GlyphDefinition[] = [];
  let offset = 4;
  for (let index = 0; index < count; index += 1) {
    assertRange(offset + 20 <= section.bytes.byteLength, "truncated glyph definition");
    const format = view.getUint8(offset + 12) as GlyphFormat;
    assertRange(format === GlyphFormat.Alpha8 || format === GlyphFormat.Rgba8Premultiplied, "invalid glyph format");
    assertRange(
      view.getUint8(offset + 13) === 0 && view.getUint16(offset + 14, true) === 0,
      "nonzero glyph reserved bytes",
    );
    const pixelLength = view.getUint32(offset + 16, true);
    const width = view.getUint16(offset + 4, true);
    const height = view.getUint16(offset + 6, true);
    const expectedLength = width * height * (format === GlyphFormat.Alpha8 ? 1 : 4);
    assertRange(pixelLength === expectedLength, "glyph pixel length mismatch");
    offset += 20;
    assertRange(offset + pixelLength <= section.bytes.byteLength, "glyph pixels out of bounds");
    definitions.push({
      id: view.getUint32(offset - 20, true),
      width,
      height,
      bearingX: view.getInt16(offset - 12, true),
      bearingY: view.getInt16(offset - 10, true),
      format,
      pixels: section.bytes.slice(offset, offset + pixelLength),
    });
    offset += pixelLength;
  }
  assertRange(offset === section.bytes.byteLength, "trailing glyph definition bytes");
  return definitions;
}

export function decodeStyleDefinitions(section: FrameSection): StyleDefinition[] {
  assertRange(section.kind === SectionKind.StyleDefinitions, "wrong style definition section kind");
  assertRange(section.bytes.byteLength >= 4, "truncated style definition header");
  const view = new DataView(section.bytes.buffer, section.bytes.byteOffset, section.bytes.byteLength);
  const count = view.getUint32(0, true);
  assertRange(count === section.itemCount, "style definition count mismatch");
  assertRange(section.bytes.byteLength === 4 + count * 16, "invalid style definition length");
  const styles: StyleDefinition[] = [];
  for (let index = 0; index < count; index += 1) {
    const offset = 4 + index * 16;
    const flags = view.getUint16(offset + 4, true);
    const foregroundKind = view.getUint8(offset + 6);
    const backgroundKind = view.getUint8(offset + 7);
    assertRange((flags & ~0x7f) === 0, "invalid style flags");
    assertRange(foregroundKind <= 1 && backgroundKind <= 1, "invalid style color kind");
    assertRange(view.getUint16(offset + 14, true) === 0, "nonzero style reserved bytes");
    styles.push({
      id: view.getUint32(offset, true),
      bold: (flags & 1) !== 0,
      italic: (flags & 2) !== 0,
      faint: (flags & 4) !== 0,
      inverse: (flags & 8) !== 0,
      invisible: (flags & 16) !== 0,
      strikethrough: (flags & 32) !== 0,
      underline: (flags & 64) !== 0,
      ...(foregroundKind === 1
        ? { foreground: [view.getUint8(offset + 8), view.getUint8(offset + 9), view.getUint8(offset + 10)] as const }
        : {}),
      ...(backgroundKind === 1
        ? { background: [view.getUint8(offset + 11), view.getUint8(offset + 12), view.getUint8(offset + 13)] as const }
        : {}),
    });
  }
  return styles;
}

export function decodeCursorState(section: FrameSection): CursorState {
  assertRange(section.kind === SectionKind.CursorState, "wrong cursor section kind");
  assertRange(section.itemCount === 1, "cursor item count mismatch");
  assertRange(section.bytes.byteLength === 8, "invalid cursor payload length");
  const view = new DataView(section.bytes.buffer, section.bytes.byteOffset, section.bytes.byteLength);
  const visible = view.getUint8(4);
  const style = view.getUint8(5) as CursorStyle;
  const blinking = view.getUint8(6);
  assertRange(visible <= 1, "invalid cursor visibility");
  assertRange(style <= CursorStyle.HollowBlock, "invalid cursor style");
  assertRange(blinking <= 1, "invalid cursor blinking state");
  assertRange(view.getUint8(7) === 0, "nonzero cursor reserved byte");
  return {
    x: view.getUint16(0, true),
    y: view.getUint16(2, true),
    visible: visible === 1,
    style,
    blinking: blinking === 1,
  };
}

export function decodeScrollbarState(section: FrameSection): ScrollbarState {
  assertRange(section.kind === SectionKind.ScrollbarState, "wrong scrollbar section kind");
  assertRange(section.itemCount === 1, "scrollbar item count mismatch");
  assertRange(section.bytes.byteLength === 24, "invalid scrollbar payload size");
  const view = new DataView(section.bytes.buffer, section.bytes.byteOffset, section.bytes.byteLength);
  const total = view.getBigUint64(0, true);
  const offset = view.getBigUint64(8, true);
  const length = view.getBigUint64(16, true);
  assertRange(length <= total, "scrollbar viewport exceeds total rows");
  assertRange(offset <= total - length, "scrollbar offset exceeds scrollable range");
  return { total, offset, length };
}

export function decodeClipboardWrite(section: FrameSection): string {
  assertRange(section.kind === SectionKind.ClipboardWrite, "wrong clipboard section kind");
  assertRange(section.itemCount === 1, "clipboard item count mismatch");
  assertRange(section.bytes.byteLength >= 4, "truncated clipboard payload");
  const view = new DataView(section.bytes.buffer, section.bytes.byteOffset, section.bytes.byteLength);
  const length = view.getUint32(0, true);
  assertRange(length === section.bytes.byteLength - 4, "clipboard length mismatch");
  return new TextDecoder("utf-8", { fatal: true }).decode(section.bytes.subarray(4));
}

export interface TerminalLinkSpan {
  row: number;
  startColumn: number;
  endColumn: number;
}

export interface TerminalLink {
  uri: string;
  explicit: boolean;
  spans: TerminalLinkSpan[];
}

/** Section 12 replaces the entire viewport link set, even on incremental frames. */
export function decodeLinkTargets(section: FrameSection, cols: number, rows: number): TerminalLink[] {
  const bytes = section.bytes;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assertRange(bytes.length >= 4, "truncated link count");
  const count = view.getUint32(0, true);
  assertRange(count === section.itemCount && count <= cols * rows, "invalid link count");
  const links: TerminalLink[] = [];
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let offset = 4;
  for (let index = 0; index < count; index++) {
    assertRange(offset + 8 <= bytes.length, "truncated link header");
    const length = view.getUint32(offset, true);
    const spanCount = view.getUint16(offset + 4, true);
    const flags = view.getUint16(offset + 6, true);
    offset += 8;
    assertRange(
      length > 0 && length <= 8192 && spanCount > 0 && spanCount <= rows && flags <= 1,
      "invalid link header",
    );
    assertRange(offset + length + spanCount * 6 <= bytes.length, "truncated link target");
    const uri = decoder.decode(bytes.subarray(offset, offset + length));
    offset += length;
    const spans: TerminalLinkSpan[] = [];
    for (let spanIndex = 0; spanIndex < spanCount; spanIndex++) {
      const row = view.getUint16(offset, true);
      const startColumn = view.getUint16(offset + 2, true);
      const endColumn = view.getUint16(offset + 4, true);
      assertRange(row < rows && startColumn < endColumn && endColumn <= cols, "link span exceeds viewport");
      spans.push({ row, startColumn, endColumn });
      offset += 6;
    }
    links.push({ uri, explicit: flags === 1, spans });
  }
  assertRange(offset === bytes.length, "trailing link data");
  return links;
}
