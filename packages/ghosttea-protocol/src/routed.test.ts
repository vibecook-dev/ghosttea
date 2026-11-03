import { describe, expect, it } from "vitest";
import {
  ROUTED_LEG_INBOUND,
  canonicalRoutedJson,
  decodeRoutedMessage,
  decodeRoutedPresentationEnvelope,
  encodeRoutedMessage,
  encodeRoutedPresentationEnvelope,
  routedCrc32c,
  routedGrantSigningInput,
  type RoutedCellTransportGrant,
  type RoutedPresentationEnvelopeHeader,
} from "./routed";

const transportGrant: RoutedCellTransportGrant = {
  protected: {
    v: 1,
    typ: "CellTransportGrant",
    iss: "fieldd",
    alg: "HS256",
    kid: { cellBootId: "cb-7f3a9c1e-2026", keyGeneration: 1 },
  },
  claims: {
    audienceCellBootId: "cb-7f3a9c1e-2026",
    clientId: "win-3c4d-incarnation-2",
    connectionSetId: "cs-win-3c4d-2-cb-7f3a9c1e",
    allowedChannels: ["control", "frames"],
    transportGrantGeneration: 3,
    issuedAt: 1_787_788_800_000,
    expiresAt: 1_787_788_860_000,
    nonce: "Qk9PVC1OT05DRS0wMDE",
  },
  mac: "C7-X5g4Km1-LHGW4sOvq-rI7ddkjZCDGzA7Mbi24bzo",
};

describe("TPv3 routed protocol", () => {
  it("matches the RFC 8785 canonical JSON golden vector", () => {
    const input = {
      numbers: [333333333.3333333, 1e30, 4.5, 0.002, 1e-27],
      string: '€$\u000f\nA\'B"\\\\"/',
      literals: [null, true, false],
    };
    expect(canonicalRoutedJson(input)).toBe(
      '{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\\u000f\\nA\'B\\"\\\\\\\\\\"/"}',
    );
  });

  it("matches the grant MAC signing-input golden vector", () => {
    expect(routedGrantSigningInput(transportGrant.protected, transportGrant.claims)).toBe(
      '{"claims":{"allowedChannels":["control","frames"],"audienceCellBootId":"cb-7f3a9c1e-2026","clientId":"win-3c4d-incarnation-2","connectionSetId":"cs-win-3c4d-2-cb-7f3a9c1e","expiresAt":1787788860000,"issuedAt":1787788800000,"nonce":"Qk9PVC1OT05DRS0wMDE","transportGrantGeneration":3},"protected":{"alg":"HS256","iss":"fieldd","kid":{"cellBootId":"cb-7f3a9c1e-2026","keyGeneration":1},"typ":"CellTransportGrant","v":1}}',
    );
  });

  it("round-trips tagged messages while enforcing the leg allow-list", () => {
    const wire = encodeRoutedMessage("ConnectionHello", {
      protocolMajor: 1,
      protocolMinor: 0,
      channel: "control",
      transportGrant,
      capabilities: ["resume", "x-future-capability"],
    });
    const decoded = decodeRoutedMessage(wire, ROUTED_LEG_INBOUND.control);
    expect(decoded).toEqual({ ok: true, message: JSON.parse(wire) });
    expect(decodeRoutedMessage(wire, ["AttachFramesLeg"])).toEqual({ ok: false, error: "not-allowed-here" });
  });

  it("does not let an extension field replace the encoded message tag", () => {
    expect(() =>
      encodeRoutedMessage("ConnectionHello", {
        protocolMajor: 1,
        protocolMinor: 0,
        channel: "control",
        transportGrant,
        capabilities: [],
        type: "AttachFramesLeg",
      }),
    ).toThrow("invalid routed ConnectionHello message");
  });

  it("matches the presentation-envelope binary golden vector", () => {
    const header: RoutedPresentationEnvelopeHeader = {
      creditEpoch: 1,
      activationSequence: 88,
      sessionId: "sess-01J8Z3K9",
      activationId: "act-01",
      leaseEpoch: 4,
      kind: "trf1-frame",
      baseContent: {
        sceneEpoch: { cellBootId: "cb-7f3a9c1e-2026", modelGeneration: 0 },
        sceneRevision: 4416,
      },
      resultContent: {
        sceneEpoch: { cellBootId: "cb-7f3a9c1e-2026", modelGeneration: 0 },
        sceneRevision: 4417,
      },
    };
    const payload = Uint8Array.from([0x54, 0x52, 0x46, 0x31, 0, 1, 2, 3, 0xff, 0x10]);
    const encoded = encodeRoutedPresentationEnvelope(header, payload);
    const expected = Uint8Array.from(
      atob(
        "VFABAAAAAVJ7ImNyZWRpdEVwb2NoIjoxLCJhY3RpdmF0aW9uU2VxdWVuY2UiOjg4LCJzZXNzaW9uSWQiOiJzZXNzLTAxSjhaM0s5IiwiYWN0aXZhdGlvbklkIjoiYWN0LTAxIiwibGVhc2VFcG9jaCI6NCwia2luZCI6InRyZjEtZnJhbWUiLCJiYXNlQ29udGVudCI6eyJzY2VuZUVwb2NoIjp7ImNlbGxCb290SWQiOiJjYi03ZjNhOWMxZS0yMDI2IiwibW9kZWxHZW5lcmF0aW9uIjowfSwic2NlbmVSZXZpc2lvbiI6NDQxNn0sInJlc3VsdENvbnRlbnQiOnsic2NlbmVFcG9jaCI6eyJjZWxsQm9vdElkIjoiY2ItN2YzYTljMWUtMjAyNiIsIm1vZGVsR2VuZXJhdGlvbiI6MH0sInNjZW5lUmV2aXNpb24iOjQ0MTd9fVRSRjEAAQID/xA=",
      ),
      (character) => character.charCodeAt(0),
    );
    expect(encoded).toEqual(expected);
    const decoded = decodeRoutedPresentationEnvelope(encoded);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    expect(decoded.chargedBytes).toBe(356);
    expect(decoded.envelope.header).toEqual(header);
    expect(decoded.envelope.payload).toEqual(payload);
  });

  it("rejects reserved bits and computes the standard CRC-32C vector", () => {
    const bytes = new Uint8Array(8);
    bytes.set([0x54, 0x50, 1, 1]);
    expect(decodeRoutedPresentationEnvelope(bytes)).toEqual({ ok: false, error: "bad-reserved" });
    expect(routedCrc32c(new TextEncoder().encode("123456789"))).toBe(0xe306_9283);
  });
});

describe("selection-text wire bounds", () => {
  const identity = { requestId: "copy-1", sessionId: "session-a", activationId: "activation-a", leaseEpoch: 4 };
  it("accepts absolute history selections and read results only on their proper leg", () => {
    const body = { ...identity, startColumn: 0, startRow: 160, endColumn: 79, endRow: 170, selectAll: false };
    const encoded = encodeRoutedMessage("SelectionTextRequest", body);
    expect(decodeRoutedMessage(encoded, ROUTED_LEG_INBOUND.control).ok).toBe(true);
    expect(decodeRoutedMessage(encoded, ROUTED_LEG_INBOUND.frames).ok).toBe(false);
    for (const patch of [{ startRow: -1 }, { endColumn: 65536 }, { endRow: 4294967296 }, { leaseEpoch: 1.5 }])
      expect(decodeRoutedMessage(JSON.stringify({ type: "SelectionTextRequest", ...body, ...patch })).ok).toBe(false);
  });
  it("requires exactly one success or refusal and preserves Unicode", () => {
    for (const fields of [{ text: "中 é 👩‍💻 🛙X" }, { text: "" }, { error: "UNAVAILABLE" }, { error: "TOO_LARGE" }])
      expect(decodeRoutedMessage(JSON.stringify({ type: "SelectionTextResult", ...identity, ...fields })).ok).toBe(
        true,
      );
    for (const fields of [{}, { text: "private", error: "UNAVAILABLE" }, { text: null }, { error: "unknown" }])
      expect(decodeRoutedMessage(JSON.stringify({ type: "SelectionTextResult", ...identity, ...fields })).ok).toBe(
        false,
      );
  });
});
