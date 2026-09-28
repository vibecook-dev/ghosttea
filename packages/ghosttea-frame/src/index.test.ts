/// <reference types="node" />

import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
  decodeAccessibilityRows,
  decodeClipboardWrite,
  decodeCursorState,
  decodeFrame,
  decodeGlyphDefinitions,
  decodeRowReplacements,
  decodeScrollbarState,
  decodeStyleDefinitions,
  FRAME_HEADER_BYTES,
  FRAME_MAGIC,
  FRAME_PROTOCOL_VERSION,
  SECTION_HEADER_BYTES,
  SectionKind,
} from "./index";

function fixture(): ArrayBuffer {
  const text = new TextEncoder().encode("hello");
  const payloadBytes = 2 + 6 + text.length;
  const buffer = new ArrayBuffer(FRAME_HEADER_BYTES + SECTION_HEADER_BYTES + payloadBytes);
  const view = new DataView(buffer);
  view.setUint32(0, FRAME_MAGIC, true);
  view.setUint16(4, FRAME_PROTOCOL_VERSION, true);
  view.setBigUint64(8, 7n, true);
  view.setBigUint64(40, 3n, true);
  view.setUint16(56, 80, true);
  view.setUint16(58, 24, true);
  view.setUint16(60, 1, true);
  view.setUint16(64, SectionKind.AccessibilityText, true);
  view.setUint32(68, 80, true);
  view.setUint32(72, payloadBytes, true);
  view.setUint32(76, 1, true);
  view.setUint16(80, 1, true);
  view.setUint16(82, 0, true);
  view.setUint32(84, text.length, true);
  new Uint8Array(buffer, 88).set(text);
  return buffer;
}

describe("decodeFrame", () => {
  it("decodes only a bounded frame view without copying its sections", () => {
    const packet = new Uint8Array(fixture());
    const envelope = new Uint8Array(packet.length + 23);
    envelope.set(packet, 11);
    const payload = envelope.subarray(11, 11 + packet.length);
    const frame = decodeFrame(payload);
    expect(decodeAccessibilityRows(frame.sections[0]!)).toEqual([{ row: 0, text: "hello" }]);
    expect(frame.sections[0]!.bytes.buffer).toBe(envelope.buffer);
    expect(frame.sections[0]!.bytes.byteOffset).toBe(11 + FRAME_HEADER_BYTES + SECTION_HEADER_BYTES);
    // Bytes after the payload belong to the envelope, not to this frame.
    new DataView(payload.buffer, payload.byteOffset).setUint32(72, packet.length, true);
    expect(() => decodeFrame(payload)).toThrow(/section out of bounds/);
  });

  it("decodes a strict absolute text snapshot", () => {
    const frame = decodeFrame(fixture());
    expect(frame.sessionHandle).toBe(7n);
    expect(frame.frameSequence).toBe(3n);
    expect(decodeAccessibilityRows(frame.sections[0]!)).toEqual([{ row: 0, text: "hello" }]);
  });

  it("rejects unsupported protocol versions", () => {
    const buffer = fixture();
    new DataView(buffer).setUint16(4, FRAME_PROTOCOL_VERSION + 1, true);
    expect(() => decodeFrame(buffer)).toThrow(/unsupported protocol version/);
  });

  it("decodes cursor state", () => {
    const bytes = new Uint8Array([12, 0, 4, 0, 1, 0, 1, 0]);
    expect(decodeCursorState({ kind: SectionKind.CursorState, flags: 0, itemCount: 1, bytes })).toEqual({
      x: 12,
      y: 4,
      visible: true,
      style: 0,
      blinking: true,
    });
  });

  it("decodes bounded scrollbar state", () => {
    const bytes = new Uint8Array(24);
    const view = new DataView(bytes.buffer);
    view.setBigUint64(0, 100n, true);
    view.setBigUint64(8, 52n, true);
    view.setBigUint64(16, 24n, true);
    expect(decodeScrollbarState({ kind: SectionKind.ScrollbarState, flags: 0, itemCount: 1, bytes })).toEqual({
      total: 100n,
      offset: 52n,
      length: 24n,
    });
  });

  it("decodes bounded UTF-8 clipboard writes", () => {
    const text = new TextEncoder().encode("copied ✓");
    const bytes = new Uint8Array(4 + text.length);
    new DataView(bytes.buffer).setUint32(0, text.length, true);
    bytes.set(text, 4);
    expect(decodeClipboardWrite({ kind: SectionKind.ClipboardWrite, flags: 0, itemCount: 1, bytes })).toBe("copied ✓");
  });

  it("decodes atomic row replacements", () => {
    const text = new TextEncoder().encode("wide 界");
    const bytes = new Uint8Array(2 + 18 + text.length + 28 + 8);
    const view = new DataView(bytes.buffer);
    view.setUint16(0, 1, true);
    view.setUint16(2, 7, true);
    view.setBigUint64(4, 42n, true);
    view.setUint32(12, text.length, true);
    view.setUint16(16, 1, true);
    view.setUint16(18, 1, true);
    bytes.set(text, 20);
    const glyph = 20 + text.length;
    view.setUint32(glyph, 9, true);
    view.setFloat32(glyph + 8, 3.5, true);
    view.setFloat32(glyph + 12, 2, true);
    view.setFloat32(glyph + 16, 8, true);
    view.setFloat32(glyph + 20, 14, true);
    view.setUint16(glyph + 24, 5, true);
    view.setUint16(glyph + 26, 2, true);
    const style = glyph + 28;
    view.setUint32(style, 3, true);
    view.setUint16(style + 4, 5, true);
    view.setUint16(style + 6, 2, true);
    expect(decodeRowReplacements({ kind: SectionKind.RowReplacements, flags: 1, itemCount: 1, bytes })).toEqual([
      {
        row: 7,
        revision: 42n,
        text: "wide 界",
        glyphs: [{ glyphId: 9, styleId: 0, x: 3.5, y: 2, width: 8, height: 14, cellStart: 5, cellSpan: 2 }],
        styles: [{ styleId: 3, cellStart: 5, cellSpan: 2 }],
      },
    ]);
  });

  it("decodes complete terminal style definitions", () => {
    const bytes = new Uint8Array(20);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 1, true);
    view.setUint32(4, 7, true);
    view.setUint16(8, 0x6d, true);
    view.setUint8(10, 1);
    view.setUint8(11, 1);
    bytes.set([204, 102, 102, 20, 30, 40], 12);
    expect(decodeStyleDefinitions({ kind: SectionKind.StyleDefinitions, flags: 0, itemCount: 1, bytes })).toEqual([
      {
        id: 7,
        bold: true,
        italic: false,
        faint: true,
        inverse: true,
        invisible: false,
        strikethrough: true,
        underline: true,
        foreground: [204, 102, 102],
        background: [20, 30, 40],
      },
    ]);
  });

  it("decodes native alpha glyph definitions", () => {
    const bytes = new Uint8Array(4 + 20 + 4);
    const view = new DataView(bytes.buffer);
    view.setUint32(0, 1, true);
    view.setUint32(4, 12, true);
    view.setUint16(8, 2, true);
    view.setUint16(10, 2, true);
    view.setInt16(12, -1, true);
    view.setInt16(14, 3, true);
    view.setUint32(20, 4, true);
    bytes.set([0, 64, 128, 255], 24);
    expect(decodeGlyphDefinitions({ kind: SectionKind.GlyphDefinitions, flags: 0, itemCount: 1, bytes })).toEqual([
      { id: 12, width: 2, height: 2, bearingX: -1, bearingY: 3, format: 0, pixels: new Uint8Array([0, 64, 128, 255]) },
    ]);
  });

  it.each(["Uint8Array", "Buffer"])("owns glyph pixels decoded from a bounded %s frame", (kind) => {
    const payloadBytes = 4 + 20 + 4;
    const frameBytes = FRAME_HEADER_BYTES + SECTION_HEADER_BYTES + payloadBytes;
    const envelope = kind === "Buffer" ? Buffer.alloc(frameBytes + 23) : new Uint8Array(frameBytes + 23);
    const payload = envelope.subarray(11, 11 + frameBytes);
    const view = new DataView(payload.buffer, payload.byteOffset, payload.byteLength);
    view.setUint32(0, FRAME_MAGIC, true);
    view.setUint16(4, FRAME_PROTOCOL_VERSION, true);
    view.setUint16(60, 1, true);
    view.setUint16(64, SectionKind.GlyphDefinitions, true);
    view.setUint32(68, 80, true);
    view.setUint32(72, payloadBytes, true);
    view.setUint32(76, 1, true);
    view.setUint32(80, 1, true);
    view.setUint32(84, 12, true);
    view.setUint16(88, 2, true);
    view.setUint16(90, 2, true);
    view.setUint32(100, 4, true);
    payload.set([0, 64, 128, 255], 104);

    const section = decodeFrame(payload).sections[0]!;
    expect(section.bytes.buffer).toBe(envelope.buffer);
    expect(section.bytes.byteOffset).toBe(payload.byteOffset + 80);
    expect(section.bytes.byteLength).toBe(payloadBytes);
    expect(section.bytes.constructor).toBe(Uint8Array);
    const glyph = decodeGlyphDefinitions(section)[0]!;
    expect(glyph.pixels.buffer).not.toBe(envelope.buffer);
    expect(glyph.pixels.buffer.byteLength).toBe(4);
    payload.fill(123, 104);
    expect(glyph.pixels).toEqual(new Uint8Array([0, 64, 128, 255]));
    view.setUint32(72, payloadBytes + 1, true);
    expect(() => decodeFrame(payload)).toThrow(/section out of bounds/);
  });

  it("owns glyph pixels when a caller supplies a Buffer section directly", () => {
    const bytes = Buffer.alloc(28);
    bytes.writeUInt32LE(1, 0);
    bytes.writeUInt32LE(12, 4);
    bytes.writeUInt16LE(2, 8);
    bytes.writeUInt16LE(2, 10);
    bytes.writeUInt32LE(4, 20);
    bytes.set([0, 64, 128, 255], 24);
    const [glyph] = decodeGlyphDefinitions({ kind: SectionKind.GlyphDefinitions, flags: 0, itemCount: 1, bytes });
    bytes.fill(123, 24);
    expect(glyph!.pixels).toEqual(new Uint8Array([0, 64, 128, 255]));
    expect(glyph!.pixels.buffer).not.toBe(bytes.buffer);
  });

  it("rejects invalid section bounds", () => {
    const buffer = fixture();
    new DataView(buffer).setUint32(68, 0xfffffff0, true);
    expect(() => decodeFrame(buffer)).toThrow(/section out of bounds/);
  });
});
