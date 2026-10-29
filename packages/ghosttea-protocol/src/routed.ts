/**
 * Public client-side contract for the TPv3 routed terminal transport.
 *
 * The authority which mints and verifies grants lives outside Ghosttea. Grants
 * are therefore represented structurally and are transported unchanged. The
 * helpers in this module validate the renderer-facing wire invariants without
 * taking a dependency on an authority-specific schema package.
 */

export type RoutedTransportChannel = "control" | "frames";
export type RoutedCapability = "resume" | "snapshot-demand" | "profiling-envelope" | (string & {});
export type RoutedSessionRight = "geometry" | "geometryAdmin" | "input" | "read" | (string & {});

export interface RoutedCellEndpoints {
  controlUrl: string;
  framesUrl: string;
  [key: string]: unknown;
}

export interface RoutedRouteBinding {
  cellBootId: string;
  routeRevision: number;
  leaseEpoch?: number;
  [key: string]: unknown;
}

export interface RoutedGrantProtectedHeader {
  v: 1;
  typ: "CellTransportGrant" | "SessionAttachGrant";
  iss: "fieldd";
  alg: "HS256";
  kid: {
    cellBootId: string;
    keyGeneration: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface RoutedCellTransportGrantClaims {
  audienceCellBootId: string;
  clientId: string;
  connectionSetId: string;
  allowedChannels: RoutedTransportChannel[];
  transportGrantGeneration: number;
  issuedAt: number;
  expiresAt: number;
  nonce: string;
  [key: string]: unknown;
}

export interface RoutedSessionAttachGrantClaims {
  audienceCellBootId: string;
  clientId: string;
  sessionId: string;
  leaseEpoch?: number;
  routeRevision: number;
  grantGeneration: number;
  rights: RoutedSessionRight[];
  issuedAt: number;
  expiresAt: number;
  [key: string]: unknown;
}

export interface RoutedAuthenticatedGrant<TType extends RoutedGrantProtectedHeader["typ"], TClaims> {
  protected: RoutedGrantProtectedHeader & { typ: TType };
  claims: TClaims;
  mac: string;
  [key: string]: unknown;
}

export type RoutedCellTransportGrant = RoutedAuthenticatedGrant<"CellTransportGrant", RoutedCellTransportGrantClaims>;
export type RoutedSessionAttachGrant = RoutedAuthenticatedGrant<"SessionAttachGrant", RoutedSessionAttachGrantClaims>;

export interface RoutedTerminalOpenTicket {
  route: RoutedRouteBinding;
  endpoints?: RoutedCellEndpoints;
  transportGrant: RoutedCellTransportGrant;
  attachGrant: RoutedSessionAttachGrant;
  [key: string]: unknown;
}

export interface RoutedReceiverCapacities {
  connectionCreditBytes: number;
  perActivationCreditBytes: number;
  stagingBytesPerSession: number;
  stagingBytesTotal: number;
  maxConcurrentActivations: number;
  maxConcurrentSeeds: number;
  [key: string]: unknown;
}

export interface RoutedProtocolLimits {
  maxControlMessageBytes: number;
  maxPresentationChunkBytes: number;
  maxBatchLatencyMs: number;
  maxCreditReturnDelayMs: number;
  maxSceneAppliedDelayMs: number;
  sceneAppliedRefreshMs: number;
  presentationStatusRefreshMs: number;
  activationAttachDeadlineMs: number;
  maxActivationCatchupMs: number;
  maxCatchupBytes: number;
  creditAccountDrainTtlMs: number;
  urgentReserveBytes: number;
  maxBulkBytesAdmittedAhead: number;
  maxUrgentPresentationUnitBytes: number;
  [key: string]: unknown;
}

export const ROUTED_PROTOCOL_VERSION = { major: 1, minor: 0 } as const;

/** Conservative browser-worker capacities from the TPv3 golden HELLO. */
export const DEFAULT_ROUTED_RECEIVER_CAPACITIES: RoutedReceiverCapacities = {
  connectionCreditBytes: 8_388_608,
  perActivationCreditBytes: 2_097_152,
  stagingBytesPerSession: 16_777_216,
  stagingBytesTotal: 67_108_864,
  maxConcurrentActivations: 128,
  maxConcurrentSeeds: 4,
};

/** Ratified T1 limits. The cell repeats its authoritative values on accept. */
export const DEFAULT_ROUTED_PROTOCOL_LIMITS: RoutedProtocolLimits = {
  maxControlMessageBytes: 262_144,
  maxPresentationChunkBytes: 1_048_576,
  maxBatchLatencyMs: 4,
  maxCreditReturnDelayMs: 16,
  maxSceneAppliedDelayMs: 1_000,
  sceneAppliedRefreshMs: 2_000,
  presentationStatusRefreshMs: 2_000,
  activationAttachDeadlineMs: 5_000,
  maxActivationCatchupMs: 3_000,
  maxCatchupBytes: 8_388_608,
  creditAccountDrainTtlMs: 5_000,
  urgentReserveBytes: 2_097_152,
  maxBulkBytesAdmittedAhead: 4_194_304,
  maxUrgentPresentationUnitBytes: 262_144,
};

export const ROUTED_DOOR_LIMITS = {
  helloDeadlineMs: 5_000,
  preAuthMaxBytes: 65_536,
  preAuthConnectionCap: 64,
  maxConnectionSets: 256,
  heartbeatIntervalMs: 5_000,
  heartbeatTtlMs: 15_000,
} as const;

export const ROUTED_CLOSE_CODES = {
  GOING_AWAY: 1001,
  POLICY_PRE_AUTH: 1008,
  SERVER_ERROR: 1011,
  STALE_ROUTE: 4000,
  FENCED: 4001,
  SUPERSEDED: 4002,
  PROTOCOL: 4003,
  LEG_TIMEOUT: 4004,
} as const;

export type RoutedCloseReason =
  | "going-away"
  | "pre-auth"
  | "server-error"
  | "stale-route"
  | "fenced"
  | "superseded"
  | "protocol"
  | "leg-timeout"
  | "unknown";

export function classifyRoutedClose(code: number): RoutedCloseReason {
  switch (code) {
    case ROUTED_CLOSE_CODES.GOING_AWAY:
      return "going-away";
    case ROUTED_CLOSE_CODES.POLICY_PRE_AUTH:
      return "pre-auth";
    case ROUTED_CLOSE_CODES.SERVER_ERROR:
      return "server-error";
    case ROUTED_CLOSE_CODES.STALE_ROUTE:
      return "stale-route";
    case ROUTED_CLOSE_CODES.FENCED:
      return "fenced";
    case ROUTED_CLOSE_CODES.SUPERSEDED:
      return "superseded";
    case ROUTED_CLOSE_CODES.PROTOCOL:
      return "protocol";
    case ROUTED_CLOSE_CODES.LEG_TIMEOUT:
      return "leg-timeout";
    default:
      return "unknown";
  }
}

export interface RoutedSceneEpoch {
  cellBootId: string;
  modelGeneration: number;
  [key: string]: unknown;
}

export interface RoutedSceneContentStamp {
  sceneEpoch: RoutedSceneEpoch;
  sceneRevision: number;
  [key: string]: unknown;
}

export function compareRoutedSceneContent(
  left: RoutedSceneContentStamp,
  right: RoutedSceneContentStamp,
): -1 | 0 | 1 | null {
  if (
    left.sceneEpoch.cellBootId !== right.sceneEpoch.cellBootId ||
    left.sceneEpoch.modelGeneration !== right.sceneEpoch.modelGeneration
  ) {
    return null;
  }
  if (left.sceneRevision === right.sceneRevision) return 0;
  return left.sceneRevision < right.sceneRevision ? -1 : 1;
}

export interface RoutedSourceDemand {
  mode: "none" | "snapshot" | "live";
  cadenceClass?: "low" | "normal" | "high";
  urgency?: "background" | "normal" | "urgent";
  [key: string]: unknown;
}

export interface RoutedConnectionHello {
  protocolMajor: number;
  protocolMinor: number;
  channel: RoutedTransportChannel;
  transportGrant: RoutedCellTransportGrant;
  receiverCapacities?: RoutedReceiverCapacities;
  capabilities: string[];
  [key: string]: unknown;
}

export interface RoutedConnectionAccepted {
  selectedProtocolVersion: { major: number; minor: number; [key: string]: unknown };
  connectionSetId: string;
  channel: RoutedTransportChannel;
  legGeneration: number;
  heartbeatTtlMs: number;
  creditEpoch?: number;
  initialWindows?: RoutedReceiverCapacities;
  protocolLimits: RoutedProtocolLimits;
  capabilities: string[];
  [key: string]: unknown;
}

export interface RoutedConnectionRefused {
  code: string;
  retryable: boolean;
  [key: string]: unknown;
}

export interface RoutedLegHeartbeat {
  connectionSetId: string;
  channel: RoutedTransportChannel;
  legGeneration: number;
  sequence: number;
  [key: string]: unknown;
}

export interface RoutedLegHeartbeatAck {
  sequence: number;
  [key: string]: unknown;
}

export interface RoutedAttachControlLeg {
  activationId: string;
  attachGrant: RoutedSessionAttachGrant;
  replacesActivationId?: string;
  initialDemand: RoutedSourceDemand;
  [key: string]: unknown;
}

export interface RoutedControlLegAttached {
  sessionId: string;
  activationId: string;
  grantGenerationAccepted: number;
  rights: RoutedSessionRight[];
  [key: string]: unknown;
}

export interface RoutedAttachRefused {
  activationId?: string;
  code: string;
  retryable: boolean;
  [key: string]: unknown;
}

export interface RoutedResumeRequest {
  resumeToken: string;
  from: RoutedSceneContentStamp;
  [key: string]: unknown;
}

export interface RoutedAttachFramesLeg {
  activationId: string;
  attachGrant: RoutedSessionAttachGrant;
  resume?: RoutedResumeRequest;
  [key: string]: unknown;
}

export interface RoutedTrfIdentity {
  sessionHandle: string;
  viewHandle: string;
  [key: string]: unknown;
}

export interface RoutedFramesAttachOutcome {
  kind: "resume-accepted" | "seed-required";
  from?: RoutedSceneContentStamp;
  newestAvailable?: RoutedSceneContentStamp;
  reason?: string;
  [key: string]: unknown;
}

export interface RoutedFramesLegAttached {
  sessionId: string;
  activationId: string;
  resumeToken: string;
  trfIdentity: RoutedTrfIdentity;
  outcome: RoutedFramesAttachOutcome;
  [key: string]: unknown;
}

export interface RoutedDeclareDemand {
  sessionId: string;
  activationId: string;
  leaseEpoch: number;
  demandSequence: number;
  demand: RoutedSourceDemand;
  [key: string]: unknown;
}

export interface RoutedDemandAccepted {
  demandSequence: number;
  [key: string]: unknown;
}

export interface RoutedPresentationDimension {
  state: "presenting" | "stopped" | "revoked";
  reason?: string;
  [key: string]: unknown;
}

export interface RoutedInputDimension {
  state: "allowed" | "suspended" | "revoked";
  reason?: string;
  [key: string]: unknown;
}

export interface RoutedCellActivationStatus {
  sessionId: string;
  activationId: string;
  cellStatusSequence: number;
  leaseTtlMs: number;
  acceptedContent?: RoutedSceneContentStamp;
  presentation: RoutedPresentationDimension;
  input: RoutedInputDimension;
  [key: string]: unknown;
}

export interface RoutedPresentationStatus {
  activationId: string;
  workerStatusSequence: number;
  state: "connecting" | "seeding" | "active" | "recovering";
  sceneContent?: RoutedSceneContentStamp;
  leaseTtlMs: number;
  [key: string]: unknown;
}

export interface RoutedFramesLegState {
  activationId: string;
  state: "attaching" | "resuming" | "seeding" | "applying" | "active" | "failed";
  resumeToken?: string;
  appliedContent?: RoutedSceneContentStamp;
  [key: string]: unknown;
}

export interface RoutedGeometryClaimant {
  clientId: string;
  viewId: string;
  [key: string]: unknown;
}

export interface RoutedGeometryHolder extends RoutedGeometryClaimant {
  holderGeneration: number;
}

interface RoutedActivationTriple {
  sessionId: string;
  activationId: string;
  leaseEpoch: number;
}

export interface RoutedClaimGeometry extends RoutedActivationTriple {
  claimant: RoutedGeometryClaimant;
  cols: number;
  rows: number;
  expectRevision: number;
  [key: string]: unknown;
}

export interface RoutedReleaseGeometry extends RoutedActivationTriple {
  holder: RoutedGeometryHolder;
  [key: string]: unknown;
}

export interface RoutedTransferGeometry extends RoutedActivationTriple {
  from: RoutedGeometryHolder;
  to: RoutedGeometryClaimant;
  expectRevision: number;
  cols: number;
  rows: number;
  [key: string]: unknown;
}

export interface RoutedGeometryCommitted {
  holder: RoutedGeometryHolder;
  geometryRevision: number;
  cols: number;
  rows: number;
  [key: string]: unknown;
}

export interface RoutedGeometryRefused {
  code: string;
  currentHolder?: RoutedGeometryHolder;
  geometryRevision?: number;
  [key: string]: unknown;
}

export interface RoutedTransportCredit {
  creditEpoch: number;
  creditSequence: number;
  connectionBytesReturned: number;
  accounts: Array<{ activationId: string; bytesReturned: number; [key: string]: unknown }>;
  [key: string]: unknown;
}

export interface RoutedSceneApplied {
  sessionId: string;
  activationId: string;
  leaseEpoch: number;
  appliedContent: RoutedSceneContentStamp;
  [key: string]: unknown;
}

export interface RoutedCalibrationPing {
  sequence: number;
  t0: number;
  [key: string]: unknown;
}

/** Optional, negotiated read on the authenticated control leg. Coordinates
 * use the terminal's absolute history rows; the cell selects the engine view. */
export interface RoutedSelectionTextRequest {
  requestId: string;
  sessionId: string;
  activationId: string;
  leaseEpoch: number;
  startColumn: number;
  startRow: number;
  endColumn: number;
  endRow: number;
  selectAll: boolean;
}

export interface RoutedSelectionTextResult {
  requestId: string;
  sessionId: string;
  activationId: string;
  leaseEpoch: number;
  text?: string;
  error?: "UNAVAILABLE" | "TOO_LARGE";
}

export const ROUTED_SELECTION_TEXT_CAPABILITY = "selection-text";

export type RoutedMessageBodyMap = {
  ConnectionHello: RoutedConnectionHello;
  ConnectionAccepted: RoutedConnectionAccepted;
  ConnectionRefused: RoutedConnectionRefused;
  LegHeartbeat: RoutedLegHeartbeat;
  LegHeartbeatAck: RoutedLegHeartbeatAck;
  AttachControlLeg: RoutedAttachControlLeg;
  ControlLegAttached: RoutedControlLegAttached;
  AttachRefused: RoutedAttachRefused;
  DeclareDemand: RoutedDeclareDemand;
  DemandAccepted: RoutedDemandAccepted;
  CellActivationStatus: RoutedCellActivationStatus;
  ClaimGeometry: RoutedClaimGeometry;
  ReleaseGeometry: RoutedReleaseGeometry;
  TransferGeometry: RoutedTransferGeometry;
  GeometryCommitted: RoutedGeometryCommitted;
  GeometryRefused: RoutedGeometryRefused;
  AttachFramesLeg: RoutedAttachFramesLeg;
  FramesLegAttached: RoutedFramesLegAttached;
  TransportCredit: RoutedTransportCredit;
  SceneApplied: RoutedSceneApplied;
  CalibrationPing: RoutedCalibrationPing;
  SelectionTextRequest: RoutedSelectionTextRequest;
  SelectionTextResult: RoutedSelectionTextResult;
};

export type RoutedMessageType = keyof RoutedMessageBodyMap;
export type RoutedTaggedMessage<T extends RoutedMessageType = RoutedMessageType> = T extends RoutedMessageType
  ? { type: T } & RoutedMessageBodyMap[T]
  : never;

export const ROUTED_MESSAGE_TYPES = [
  "ConnectionHello",
  "ConnectionAccepted",
  "ConnectionRefused",
  "LegHeartbeat",
  "LegHeartbeatAck",
  "AttachControlLeg",
  "ControlLegAttached",
  "AttachRefused",
  "DeclareDemand",
  "DemandAccepted",
  "CellActivationStatus",
  "ClaimGeometry",
  "ReleaseGeometry",
  "TransferGeometry",
  "GeometryCommitted",
  "GeometryRefused",
  "AttachFramesLeg",
  "FramesLegAttached",
  "TransportCredit",
  "SceneApplied",
  "CalibrationPing",
  "SelectionTextRequest",
  "SelectionTextResult",
] as const satisfies readonly RoutedMessageType[];

export const ROUTED_LEG_INBOUND = {
  control: [
    "ConnectionHello",
    "LegHeartbeat",
    "AttachControlLeg",
    "DeclareDemand",
    "ClaimGeometry",
    "ReleaseGeometry",
    "TransferGeometry",
    "SelectionTextRequest",
  ],
  frames: ["ConnectionHello", "LegHeartbeat", "AttachFramesLeg", "TransportCredit", "SceneApplied", "CalibrationPing"],
} as const satisfies Readonly<Record<RoutedTransportChannel, readonly RoutedMessageType[]>>;

export const ROUTED_LEG_OUTBOUND = {
  control: [
    "ConnectionAccepted",
    "ConnectionRefused",
    "LegHeartbeatAck",
    "ControlLegAttached",
    "AttachRefused",
    "DemandAccepted",
    "CellActivationStatus",
    "GeometryCommitted",
    "GeometryRefused",
    "SelectionTextResult",
  ],
  frames: ["ConnectionAccepted", "ConnectionRefused", "LegHeartbeatAck", "FramesLegAttached", "AttachRefused"],
} as const satisfies Readonly<Record<RoutedTransportChannel, readonly RoutedMessageType[]>>;

const routedMessageTypeSet = new Set<string>(ROUTED_MESSAGE_TYPES);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCounter(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) >= 0;
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0;
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isSortedUniqueStringArray(value: unknown, allowed?: ReadonlySet<string>): value is string[] {
  return (
    isStringArray(value) &&
    value.every(
      (item, index) => (allowed === undefined || allowed.has(item)) && (index === 0 || String(value[index - 1]) < item),
    )
  );
}

function hasOptionalCounter(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || isCounter(record[key]);
}

function hasOptionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function isStamp(value: unknown): value is RoutedSceneContentStamp {
  if (!isRecord(value) || !isRecord(value.sceneEpoch)) return false;
  return (
    isNonEmptyString(value.sceneEpoch.cellBootId) &&
    isCounter(value.sceneEpoch.modelGeneration) &&
    isCounter(value.sceneRevision)
  );
}

const transportChannels = new Set<string>(["control", "frames"]);
const sessionRights = new Set<string>(["geometry", "geometryAdmin", "input", "read"]);
const loopbackWebSocket = /^wss?:\/\/(127\.0\.0\.1|\[::1\]|localhost)(:\d{1,5})?(\/[^?#]*)?$/;

function isGrantProtectedHeader(value: unknown, type: RoutedGrantProtectedHeader["typ"]): boolean {
  return (
    isRecord(value) &&
    value.v === 1 &&
    value.typ === type &&
    value.iss === "fieldd" &&
    value.alg === "HS256" &&
    isRecord(value.kid) &&
    isNonEmptyString(value.kid.cellBootId) &&
    isCounter(value.kid.keyGeneration)
  );
}

/** Runtime guard for a cell transport grant. MAC verification remains the cell's responsibility. */
export function isRoutedCellTransportGrant(value: unknown): value is RoutedCellTransportGrant {
  if (!isRecord(value) || !isGrantProtectedHeader(value.protected, "CellTransportGrant")) return false;
  const claims = value.claims;
  return (
    isRecord(claims) &&
    isNonEmptyString(claims.audienceCellBootId) &&
    isNonEmptyString(claims.clientId) &&
    isNonEmptyString(claims.connectionSetId) &&
    isSortedUniqueStringArray(claims.allowedChannels, transportChannels) &&
    claims.allowedChannels.length > 0 &&
    isCounter(claims.transportGrantGeneration) &&
    isCounter(claims.issuedAt) &&
    isCounter(claims.expiresAt) &&
    isNonEmptyString(claims.nonce) &&
    isNonEmptyString(value.mac)
  );
}

/** Runtime guard for an attach grant. MAC verification remains the cell's responsibility. */
export function isRoutedSessionAttachGrant(value: unknown): value is RoutedSessionAttachGrant {
  if (!isRecord(value) || !isGrantProtectedHeader(value.protected, "SessionAttachGrant")) return false;
  const claims = value.claims;
  return (
    isRecord(claims) &&
    isNonEmptyString(claims.audienceCellBootId) &&
    isNonEmptyString(claims.clientId) &&
    isNonEmptyString(claims.sessionId) &&
    hasOptionalCounter(claims, "leaseEpoch") &&
    isCounter(claims.routeRevision) &&
    isCounter(claims.grantGeneration) &&
    isSortedUniqueStringArray(claims.rights, sessionRights) &&
    isCounter(claims.issuedAt) &&
    isCounter(claims.expiresAt) &&
    isNonEmptyString(value.mac)
  );
}

export function isRoutedReceiverCapacities(value: unknown): value is RoutedReceiverCapacities {
  return (
    isRecord(value) &&
    isCounter(value.connectionCreditBytes) &&
    isCounter(value.perActivationCreditBytes) &&
    isCounter(value.stagingBytesPerSession) &&
    isCounter(value.stagingBytesTotal) &&
    isCounter(value.maxConcurrentActivations) &&
    isCounter(value.maxConcurrentSeeds)
  );
}

export function isRoutedProtocolLimits(value: unknown): value is RoutedProtocolLimits {
  return (
    isRecord(value) &&
    isCounter(value.maxControlMessageBytes) &&
    isCounter(value.maxPresentationChunkBytes) &&
    isCounter(value.maxBatchLatencyMs) &&
    isCounter(value.maxCreditReturnDelayMs) &&
    isCounter(value.maxSceneAppliedDelayMs) &&
    isCounter(value.sceneAppliedRefreshMs) &&
    isCounter(value.presentationStatusRefreshMs) &&
    isCounter(value.activationAttachDeadlineMs) &&
    isCounter(value.maxActivationCatchupMs) &&
    isCounter(value.maxCatchupBytes) &&
    isCounter(value.creditAccountDrainTtlMs) &&
    isCounter(value.urgentReserveBytes) &&
    isCounter(value.maxBulkBytesAdmittedAhead) &&
    isCounter(value.maxUrgentPresentationUnitBytes)
  );
}

function isSourceDemand(value: unknown): value is RoutedSourceDemand {
  return (
    isRecord(value) &&
    (value.mode === "none" || value.mode === "snapshot" || value.mode === "live") &&
    (value.cadenceClass === undefined ||
      value.cadenceClass === "low" ||
      value.cadenceClass === "normal" ||
      value.cadenceClass === "high") &&
    (value.urgency === undefined ||
      value.urgency === "background" ||
      value.urgency === "normal" ||
      value.urgency === "urgent")
  );
}

function isTrfIdentity(value: unknown): value is RoutedTrfIdentity {
  return (
    isRecord(value) &&
    typeof value.sessionHandle === "string" &&
    /^(0|[1-9][0-9]*)$/.test(value.sessionHandle) &&
    typeof value.viewHandle === "string" &&
    /^(0|[1-9][0-9]*)$/.test(value.viewHandle)
  );
}

function isFramesAttachOutcome(value: unknown): value is RoutedFramesAttachOutcome {
  if (!isRecord(value) || (value.kind !== "resume-accepted" && value.kind !== "seed-required")) return false;
  if (!hasOptionalString(value, "reason")) return false;
  if (value.kind === "resume-accepted") return isStamp(value.from) && isStamp(value.newestAvailable);
  return (
    (value.from === undefined || isStamp(value.from)) &&
    (value.newestAvailable === undefined || isStamp(value.newestAvailable))
  );
}

function isGeometryClaimant(value: unknown): value is RoutedGeometryClaimant {
  return isRecord(value) && isNonEmptyString(value.clientId) && isNonEmptyString(value.viewId);
}

function isGeometryHolder(value: unknown): value is RoutedGeometryHolder {
  return isGeometryClaimant(value) && isCounter(value.holderGeneration);
}

/** Validate the transport-private ticket before any endpoint is dialled. */
export function isRoutedTerminalOpenTicket(value: unknown): value is RoutedTerminalOpenTicket {
  if (!isRecord(value) || !isRecord(value.route)) return false;
  if (
    !isNonEmptyString(value.route.cellBootId) ||
    !isCounter(value.route.routeRevision) ||
    !hasOptionalCounter(value.route, "leaseEpoch") ||
    !isRoutedCellTransportGrant(value.transportGrant) ||
    !isRoutedSessionAttachGrant(value.attachGrant)
  ) {
    return false;
  }
  return (
    value.endpoints === undefined ||
    (isRecord(value.endpoints) &&
      typeof value.endpoints.controlUrl === "string" &&
      loopbackWebSocket.test(value.endpoints.controlUrl) &&
      typeof value.endpoints.framesUrl === "string" &&
      loopbackWebSocket.test(value.endpoints.framesUrl))
  );
}

function hasActivation(record: Record<string, unknown>): boolean {
  return isNonEmptyString(record.activationId);
}

function validateRoutedBody(type: RoutedMessageType, body: Record<string, unknown>): boolean {
  switch (type) {
    case "SelectionTextRequest":
    case "SelectionTextResult": {
      if (
        !isNonEmptyString(body.requestId) ||
        body.requestId.length > 64 ||
        !isNonEmptyString(body.sessionId) ||
        body.sessionId.length > 256 ||
        !isNonEmptyString(body.activationId) ||
        body.activationId.length > 256 ||
        !isCounter(body.leaseEpoch)
      )
        return false;
      if (type === "SelectionTextResult")
        return (
          (typeof body.text === "string" && body.error === undefined) ||
          (body.text === undefined && (body.error === "UNAVAILABLE" || body.error === "TOO_LARGE"))
        );
      return (
        [body.startColumn, body.endColumn].every((value) => isCounter(value) && value <= 65_535) &&
        [body.startRow, body.endRow].every((value) => isCounter(value) && value <= 4_294_967_295) &&
        typeof body.selectAll === "boolean"
      );
    }
    case "ConnectionHello":
      return (
        isCounter(body.protocolMajor) &&
        isCounter(body.protocolMinor) &&
        (body.channel === "control" || body.channel === "frames") &&
        isRoutedCellTransportGrant(body.transportGrant) &&
        (body.receiverCapacities === undefined || isRoutedReceiverCapacities(body.receiverCapacities)) &&
        isStringArray(body.capabilities)
      );
    case "ConnectionAccepted":
      return (
        isRecord(body.selectedProtocolVersion) &&
        isCounter(body.selectedProtocolVersion.major) &&
        isCounter(body.selectedProtocolVersion.minor) &&
        isNonEmptyString(body.connectionSetId) &&
        (body.channel === "control" || body.channel === "frames") &&
        isCounter(body.legGeneration) &&
        isCounter(body.heartbeatTtlMs) &&
        hasOptionalCounter(body, "creditEpoch") &&
        (body.initialWindows === undefined || isRoutedReceiverCapacities(body.initialWindows)) &&
        isRoutedProtocolLimits(body.protocolLimits) &&
        isStringArray(body.capabilities)
      );
    case "ConnectionRefused":
      return typeof body.code === "string" && typeof body.retryable === "boolean";
    case "LegHeartbeat":
      return (
        isNonEmptyString(body.connectionSetId) &&
        (body.channel === "control" || body.channel === "frames") &&
        isCounter(body.legGeneration) &&
        isCounter(body.sequence)
      );
    case "LegHeartbeatAck":
      return isCounter(body.sequence);
    case "AttachControlLeg":
      return (
        hasActivation(body) &&
        isRoutedSessionAttachGrant(body.attachGrant) &&
        (body.replacesActivationId === undefined || isNonEmptyString(body.replacesActivationId)) &&
        isSourceDemand(body.initialDemand)
      );
    case "ControlLegAttached":
      return (
        isNonEmptyString(body.sessionId) &&
        hasActivation(body) &&
        isCounter(body.grantGenerationAccepted) &&
        isSortedUniqueStringArray(body.rights, sessionRights)
      );
    case "AttachRefused":
      return (
        (body.activationId === undefined || isNonEmptyString(body.activationId)) &&
        typeof body.code === "string" &&
        typeof body.retryable === "boolean"
      );
    case "DeclareDemand":
      return (
        isNonEmptyString(body.sessionId) &&
        hasActivation(body) &&
        isCounter(body.leaseEpoch) &&
        isCounter(body.demandSequence) &&
        isSourceDemand(body.demand)
      );
    case "DemandAccepted":
      return isCounter(body.demandSequence);
    case "CellActivationStatus":
      if (
        !isNonEmptyString(body.sessionId) ||
        !hasActivation(body) ||
        !isCounter(body.cellStatusSequence) ||
        !isCounter(body.leaseTtlMs) ||
        (body.acceptedContent !== undefined && !isStamp(body.acceptedContent)) ||
        !isRecord(body.presentation) ||
        !["presenting", "stopped", "revoked"].includes(String(body.presentation.state)) ||
        !hasOptionalString(body.presentation, "reason") ||
        !isRecord(body.input) ||
        !["allowed", "suspended", "revoked"].includes(String(body.input.state)) ||
        !hasOptionalString(body.input, "reason")
      ) {
        return false;
      }
      return body.input.state !== "allowed" || body.presentation.state === "presenting";
    case "ClaimGeometry":
      return (
        isNonEmptyString(body.sessionId) &&
        hasActivation(body) &&
        isCounter(body.leaseEpoch) &&
        isGeometryClaimant(body.claimant) &&
        isPositiveInteger(body.cols) &&
        isPositiveInteger(body.rows) &&
        isCounter(body.expectRevision)
      );
    case "ReleaseGeometry":
      return (
        isNonEmptyString(body.sessionId) &&
        hasActivation(body) &&
        isCounter(body.leaseEpoch) &&
        isGeometryHolder(body.holder)
      );
    case "TransferGeometry":
      return (
        isNonEmptyString(body.sessionId) &&
        hasActivation(body) &&
        isCounter(body.leaseEpoch) &&
        isGeometryHolder(body.from) &&
        isGeometryClaimant(body.to) &&
        isCounter(body.expectRevision) &&
        isPositiveInteger(body.cols) &&
        isPositiveInteger(body.rows)
      );
    case "GeometryCommitted":
      return (
        isGeometryHolder(body.holder) &&
        isCounter(body.geometryRevision) &&
        isPositiveInteger(body.cols) &&
        isPositiveInteger(body.rows)
      );
    case "GeometryRefused":
      return (
        typeof body.code === "string" &&
        (body.currentHolder === undefined || isGeometryHolder(body.currentHolder)) &&
        hasOptionalCounter(body, "geometryRevision")
      );
    case "AttachFramesLeg":
      return (
        hasActivation(body) &&
        isRoutedSessionAttachGrant(body.attachGrant) &&
        (body.resume === undefined ||
          (isRecord(body.resume) && isNonEmptyString(body.resume.resumeToken) && isStamp(body.resume.from)))
      );
    case "FramesLegAttached":
      return (
        isNonEmptyString(body.sessionId) &&
        hasActivation(body) &&
        isNonEmptyString(body.resumeToken) &&
        isTrfIdentity(body.trfIdentity) &&
        isFramesAttachOutcome(body.outcome)
      );
    case "TransportCredit":
      return (
        isCounter(body.creditEpoch) &&
        isCounter(body.creditSequence) &&
        isCounter(body.connectionBytesReturned) &&
        Array.isArray(body.accounts) &&
        body.accounts.every(
          (account) => isRecord(account) && isNonEmptyString(account.activationId) && isCounter(account.bytesReturned),
        )
      );
    case "SceneApplied":
      return (
        isNonEmptyString(body.sessionId) &&
        hasActivation(body) &&
        isCounter(body.leaseEpoch) &&
        isStamp(body.appliedContent)
      );
    case "CalibrationPing":
      return isCounter(body.sequence) && typeof body.t0 === "number" && Number.isFinite(body.t0);
  }
}

export type RoutedMessageDecodeError =
  "not-json" | "not-an-object" | "missing-type" | "unknown-type" | "not-allowed-here" | "invalid";

export type RoutedMessageDecodeResult =
  { ok: true; message: RoutedTaggedMessage } | { ok: false; error: RoutedMessageDecodeError };

/** Decode a text message and enforce the caller-provided leg/direction tag set. */
export function decodeRoutedMessage(
  raw: string | unknown,
  allowed: readonly RoutedMessageType[] = ROUTED_MESSAGE_TYPES,
): RoutedMessageDecodeResult {
  let value: unknown = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: "not-json" };
    }
  }
  if (!isRecord(value)) return { ok: false, error: "not-an-object" };
  if (typeof value.type !== "string") return { ok: false, error: "missing-type" };
  if (!routedMessageTypeSet.has(value.type)) return { ok: false, error: "unknown-type" };
  const type = value.type as RoutedMessageType;
  if (!allowed.includes(type)) return { ok: false, error: "not-allowed-here" };
  const body = { ...value };
  delete body.type;
  if (!validateRoutedBody(type, body)) return { ok: false, error: "invalid" };
  return { ok: true, message: value as RoutedTaggedMessage };
}

export function encodeRoutedMessage<T extends RoutedMessageType>(type: T, body: RoutedMessageBodyMap[T]): string {
  if (!isRecord(body) || Object.hasOwn(body, "type") || !validateRoutedBody(type, body)) {
    throw new TypeError(`invalid routed ${type} message`);
  }
  return JSON.stringify({ type, ...body });
}

/** RFC 8785 JSON canonicalization for authenticated-grant MAC input. */
export function canonicalRoutedJson(value: unknown): string {
  if (value === null || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("canonicalRoutedJson: non-finite number");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value
      .map((item) => {
        if (item === undefined) throw new TypeError("canonicalRoutedJson: undefined array element");
        return canonicalRoutedJson(item);
      })
      .join(",")}]`;
  }
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalRoutedJson(value[key])}`);
    return `{${entries.join(",")}}`;
  }
  throw new TypeError(`canonicalRoutedJson: unsupported value of type ${typeof value}`);
}

export function routedGrantSigningInput(protectedHeader: RoutedGrantProtectedHeader, claims: unknown): string {
  return canonicalRoutedJson({ protected: protectedHeader, claims });
}

export type RoutedPresentationEnvelopeKind =
  "trf1-frame" | "transfer-begin" | "transfer-chunk" | "transfer-end" | "calibration";
export type RoutedTransferKind = "seed" | "catchup";

export interface RoutedTransferHeader {
  transferId: string;
  kind?: RoutedTransferKind;
  totalBytes?: number;
  chunkCount?: number;
  targetLayout?: { cols: number; rows: number; scrollbackRows: number; [key: string]: unknown };
  checksum?: { alg: "crc32c"; value: number; [key: string]: unknown };
  chunkIndex?: number;
  byteOffset?: number;
  [key: string]: unknown;
}

export interface RoutedPresentationEnvelopeHeader {
  creditEpoch: number;
  activationSequence: number;
  sessionId: string;
  activationId: string;
  leaseEpoch: number;
  kind: RoutedPresentationEnvelopeKind;
  baseContent?: RoutedSceneContentStamp | null;
  resultContent?: RoutedSceneContentStamp;
  transfer?: RoutedTransferHeader;
  calibration?: { sequence: number; t0: number; t1: number; t2: number; [key: string]: unknown };
  profiling?: {
    damageFirstTs: number;
    damageLastTs: number;
    encodeTs: number;
    probeId?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface RoutedPresentationEnvelope {
  header: RoutedPresentationEnvelopeHeader;
  /** A zero-copy view into the received message. Copy it before retaining. */
  payload: Uint8Array;
}

export const ROUTED_PRESENTATION_ENVELOPE_MAGIC = [0x54, 0x50] as const;
export const ROUTED_PRESENTATION_ENVELOPE_VERSION = 1 as const;
export const ROUTED_PRESENTATION_ENVELOPE_PREFIX_BYTES = 8 as const;
export const ROUTED_PRESENTATION_ENVELOPE_MAX_HEADER_BYTES = 4096 as const;

const routedUtf8Encoder = new TextEncoder();
const routedUtf8Decoder = new TextDecoder("utf-8", { fatal: true });

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isTransferLayout(value: unknown): boolean {
  return (
    isRecord(value) && isPositiveInteger(value.cols) && isPositiveInteger(value.rows) && isCounter(value.scrollbackRows)
  );
}

function isTransferChecksum(value: unknown): boolean {
  return isRecord(value) && value.alg === "crc32c" && isCounter(value.value);
}

function isCalibrationEcho(value: unknown): boolean {
  return (
    isRecord(value) &&
    isCounter(value.sequence) &&
    isFiniteNumber(value.t0) &&
    isFiniteNumber(value.t1) &&
    isFiniteNumber(value.t2)
  );
}

function isProfilingEnvelope(value: unknown): boolean {
  return (
    isRecord(value) &&
    isFiniteNumber(value.damageFirstTs) &&
    isFiniteNumber(value.damageLastTs) &&
    isFiniteNumber(value.encodeTs) &&
    (value.probeId === undefined || typeof value.probeId === "string")
  );
}

function validateEnvelopeHeader(value: unknown): value is RoutedPresentationEnvelopeHeader {
  if (!isRecord(value)) return false;
  if (
    !isCounter(value.creditEpoch) ||
    !isCounter(value.activationSequence) ||
    !isNonEmptyString(value.sessionId) ||
    !isNonEmptyString(value.activationId) ||
    !isCounter(value.leaseEpoch) ||
    !["trf1-frame", "transfer-begin", "transfer-chunk", "transfer-end", "calibration"].includes(String(value.kind))
  ) {
    return false;
  }
  const base = value.baseContent;
  const result = value.resultContent;
  if (base !== undefined && base !== null && !isStamp(base)) return false;
  if (result !== undefined && !isStamp(result)) return false;
  if (value.profiling !== undefined && !isProfilingEnvelope(value.profiling)) return false;
  if (isStamp(base) && isStamp(result) && compareRoutedSceneContent(base, result) === null) return false;
  switch (value.kind) {
    case "trf1-frame":
      return Object.hasOwn(value, "baseContent") && isStamp(result);
    case "transfer-begin": {
      if (!isRecord(value.transfer) || !isNonEmptyString(value.transfer.transferId)) return false;
      if (value.transfer.kind !== "seed" && value.transfer.kind !== "catchup") return false;
      if (!isCounter(value.transfer.totalBytes) || !isCounter(value.transfer.chunkCount)) return false;
      if (
        !isTransferLayout(value.transfer.targetLayout) ||
        !isTransferChecksum(value.transfer.checksum) ||
        !isStamp(result)
      ) {
        return false;
      }
      if (value.transfer.kind === "seed") return base === null;
      return isStamp(base);
    }
    case "transfer-chunk":
      return (
        isRecord(value.transfer) &&
        isNonEmptyString(value.transfer.transferId) &&
        isCounter(value.transfer.chunkIndex) &&
        isCounter(value.transfer.byteOffset)
      );
    case "transfer-end":
      return isRecord(value.transfer) && isNonEmptyString(value.transfer.transferId);
    case "calibration":
      return isCalibrationEcho(value.calibration);
    default:
      return false;
  }
}

export function encodeRoutedPresentationEnvelope(
  header: RoutedPresentationEnvelopeHeader,
  payload: Uint8Array,
): Uint8Array {
  if (!validateEnvelopeHeader(header)) throw new TypeError("invalid routed presentation envelope header");
  const headerBytes = routedUtf8Encoder.encode(JSON.stringify(header));
  if (headerBytes.byteLength > ROUTED_PRESENTATION_ENVELOPE_MAX_HEADER_BYTES) {
    throw new RangeError(`routed presentation envelope header too large: ${headerBytes.byteLength}`);
  }
  const output = new Uint8Array(
    ROUTED_PRESENTATION_ENVELOPE_PREFIX_BYTES + headerBytes.byteLength + payload.byteLength,
  );
  output[0] = ROUTED_PRESENTATION_ENVELOPE_MAGIC[0];
  output[1] = ROUTED_PRESENTATION_ENVELOPE_MAGIC[1];
  output[2] = ROUTED_PRESENTATION_ENVELOPE_VERSION;
  output[3] = 0;
  new DataView(output.buffer, output.byteOffset, output.byteLength).setUint32(4, headerBytes.byteLength, false);
  output.set(headerBytes, ROUTED_PRESENTATION_ENVELOPE_PREFIX_BYTES);
  output.set(payload, ROUTED_PRESENTATION_ENVELOPE_PREFIX_BYTES + headerBytes.byteLength);
  return output;
}

export type RoutedPresentationEnvelopeDecodeError =
  | "short"
  | "bad-magic"
  | "bad-version"
  | "bad-reserved"
  | "header-too-large"
  | "header-truncated"
  | "header-not-utf8"
  | "header-not-json"
  | "header-invalid";

export type RoutedPresentationEnvelopeDecodeResult =
  | { ok: true; envelope: RoutedPresentationEnvelope; chargedBytes: number }
  | { ok: false; error: RoutedPresentationEnvelopeDecodeError };

export function decodeRoutedPresentationEnvelope(bytes: Uint8Array): RoutedPresentationEnvelopeDecodeResult {
  if (bytes.byteLength < ROUTED_PRESENTATION_ENVELOPE_PREFIX_BYTES) return { ok: false, error: "short" };
  if (bytes[0] !== ROUTED_PRESENTATION_ENVELOPE_MAGIC[0] || bytes[1] !== ROUTED_PRESENTATION_ENVELOPE_MAGIC[1]) {
    return { ok: false, error: "bad-magic" };
  }
  if (bytes[2] !== ROUTED_PRESENTATION_ENVELOPE_VERSION) return { ok: false, error: "bad-version" };
  if (bytes[3] !== 0) return { ok: false, error: "bad-reserved" };
  const headerLength = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(4, false);
  if (headerLength > ROUTED_PRESENTATION_ENVELOPE_MAX_HEADER_BYTES) {
    return { ok: false, error: "header-too-large" };
  }
  const headerEnd = ROUTED_PRESENTATION_ENVELOPE_PREFIX_BYTES + headerLength;
  if (headerEnd > bytes.byteLength) return { ok: false, error: "header-truncated" };
  let text: string;
  try {
    text = routedUtf8Decoder.decode(bytes.subarray(ROUTED_PRESENTATION_ENVELOPE_PREFIX_BYTES, headerEnd));
  } catch {
    return { ok: false, error: "header-not-utf8" };
  }
  let header: unknown;
  try {
    header = JSON.parse(text);
  } catch {
    return { ok: false, error: "header-not-json" };
  }
  if (!validateEnvelopeHeader(header)) return { ok: false, error: "header-invalid" };
  return {
    ok: true,
    envelope: { header, payload: bytes.subarray(headerEnd) },
    chargedBytes: bytes.byteLength,
  };
}

/** CRC-32C (Castagnoli), returned as an unsigned 32-bit integer. */
export function routedCrc32c(bytes: Uint8Array, seed = 0): number {
  let crc = (seed ^ 0xffff_ffff) >>> 0;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = ((crc >>> 1) ^ (0x82f6_3b78 & -(crc & 1))) >>> 0;
    }
  }
  return (crc ^ 0xffff_ffff) >>> 0;
}
