import { describe, expect, it } from "vitest";
import { decodeLinkTargets, SectionKind } from "./index.js";

function section() {
  const uri = new TextEncoder().encode("https://example.com/界");
  const bytes = new Uint8Array(12 + uri.length + 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(0, 1, true);
  view.setUint32(4, uri.length, true);
  view.setUint16(8, 2, true);
  view.setUint16(10, 1, true);
  bytes.set(uri, 12);
  const offset = 12 + uri.length;
  [0, 5, 20, 1, 0, 4].forEach((value, index) => view.setUint16(offset + index * 2, value, true));
  return { kind: SectionKind.LinkTargets, flags: 0, itemCount: 1, bytes };
}

describe("link target section", () => {
  it("decodes UTF-8 targets and wrapped cell ranges", () => {
    expect(decodeLinkTargets(section(), 80, 24)).toEqual([
      {
        uri: "https://example.com/界",
        explicit: true,
        spans: [
          { row: 0, startColumn: 5, endColumn: 20 },
          { row: 1, startColumn: 0, endColumn: 4 },
        ],
      },
    ]);
  });
  it("represents clearing all targets with an empty section", () => {
    expect(
      decodeLinkTargets({ kind: SectionKind.LinkTargets, flags: 0, itemCount: 0, bytes: new Uint8Array(4) }, 80, 24),
    ).toEqual([]);
  });
  it("rejects truncation, mismatched counts and out-of-bounds cell ranges", () => {
    const payload = section();
    expect(() => decodeLinkTargets({ ...payload, bytes: payload.bytes.slice(0, -1) }, 80, 24)).toThrow();
    expect(() => decodeLinkTargets({ ...payload, itemCount: 2 }, 80, 24)).toThrow();
    expect(() => decodeLinkTargets(payload, 10, 24)).toThrow();
    expect(() => decodeLinkTargets(payload, 80, 1)).toThrow();
  });
});
