import {
  compareRoutedSceneContent,
  type RoutedCellActivationStatus,
  type RoutedFramesAttachOutcome,
  type RoutedFramesLegState,
  type RoutedPresentationStatus,
  type RoutedSceneContentStamp,
  type RoutedSessionRight,
  type RoutedTrfIdentity,
} from "@vibecook/ghosttea-protocol";

export type RoutedActivationPhase =
  | "unresolved"
  | "connecting"
  | "attaching"
  | "seeding"
  | "resuming"
  | "presenting"
  | "stalled"
  | "recovering"
  | "unavailable"
  | "ended";

export type RoutedInputPolicy = "read-write" | "read-only";

export interface RoutedActivationState {
  sessionId: string;
  activationId: string;
  phase: RoutedActivationPhase;
  inputPolicy: RoutedInputPolicy;
  sourceDemand: "live" | "none";
  resumeDemandSequence?: number;
  inputStatusAfterDemand?: number;
  unavailableReason?: string;
  replacesActivationId?: string;
  controlAttached: boolean;
  framesAttached: boolean;
  framesOutcome?: RoutedFramesAttachOutcome;
  trfIdentity?: RoutedTrfIdentity;
  resumeToken?: string;
  appliedContent?: RoutedSceneContentStamp;
  rights: readonly RoutedSessionRight[];
  grantGeneration: number;
  grantInputValid: boolean;
  lastCellStatusSequence: number;
  lastWorkerStatusSequence: number;
  cellStatus?: RoutedCellActivationStatus;
  framesState?: RoutedFramesLegState;
  presentationStatus?: RoutedPresentationStatus;
  cellLeaseDeadline: number;
  workerLeaseDeadline: number;
  presentationReady: boolean;
  inputAllowed: boolean;
  preAuthRemintUsed: boolean;
}

export type RoutedActivationEvent =
  | { type: "ticket-minted"; endpointsPresent: boolean }
  | { type: "no-route"; reason: string }
  | { type: "transport-ready" }
  | {
      type: "transport-failed";
      preAuth?: boolean;
      retryable?: boolean;
      recoveryExhausted?: boolean;
      reason?: string;
    }
  | { type: "control-attached"; grantGeneration: number; rights: readonly RoutedSessionRight[] }
  | {
      type: "frames-attached";
      outcome: RoutedFramesAttachOutcome;
      trfIdentity: RoutedTrfIdentity;
      resumeToken: string;
    }
  | { type: "attach-refused"; code: string; retryable: boolean }
  | { type: "attach-deadline" }
  | { type: "sync-complete"; appliedContent: RoutedSceneContentStamp }
  | { type: "sync-failed" }
  | { type: "cell-status"; status: RoutedCellActivationStatus; now: number }
  | { type: "presentation-status"; status: RoutedPresentationStatus; now: number }
  | { type: "frames-state"; state: RoutedFramesLegState }
  | { type: "cell-lease-expired" }
  | { type: "worker-lease-expired" }
  | { type: "leg-lost"; channel: "control" | "frames"; resumeCapable: boolean }
  | { type: "route-stale" }
  | { type: "grant-expiring" }
  | { type: "renew-failed" }
  | { type: "renewed"; grantGeneration: number; rights: readonly RoutedSessionRight[] }
  | { type: "input-policy"; policy: RoutedInputPolicy }
  | { type: "demand-declared"; mode: "live" | "none"; sequence?: number }
  | { type: "demand-accepted"; sequence: number }
  | { type: "retry" }
  | { type: "detach" | "replaced" | "runtime-destroyed" };

export function initialRoutedActivation(
  sessionId: string,
  activationId: string,
  inputPolicy: RoutedInputPolicy = "read-write",
): RoutedActivationState {
  return {
    sessionId,
    activationId,
    phase: "unresolved",
    inputPolicy,
    sourceDemand: "live",
    controlAttached: false,
    framesAttached: false,
    rights: [],
    grantGeneration: 0,
    grantInputValid: true,
    lastCellStatusSequence: -1,
    lastWorkerStatusSequence: -1,
    cellLeaseDeadline: 0,
    workerLeaseDeadline: 0,
    presentationReady: false,
    inputAllowed: false,
    preAuthRemintUsed: false,
  };
}

function withReadiness(state: RoutedActivationState): RoutedActivationState {
  const acceptedContent = state.cellStatus?.acceptedContent;
  const sceneComparison =
    acceptedContent === undefined || state.appliedContent === undefined
      ? undefined
      : compareRoutedSceneContent(state.appliedContent, acceptedContent);
  const sceneCoversAccepted = acceptedContent === undefined || sceneComparison === 0 || sceneComparison === 1;
  const presentationReady =
    state.phase === "presenting" &&
    state.controlAttached &&
    state.framesAttached &&
    state.cellLeaseDeadline > 0 &&
    state.workerLeaseDeadline > 0 &&
    state.cellStatus?.presentation.state === "presenting" &&
    state.presentationStatus?.state === "active" &&
    sceneCoversAccepted;
  const inputAllowed =
    presentationReady &&
    state.sourceDemand === "live" &&
    state.resumeDemandSequence === undefined &&
    (state.inputStatusAfterDemand === undefined || state.lastCellStatusSequence > state.inputStatusAfterDemand) &&
    state.inputPolicy === "read-write" &&
    state.grantInputValid &&
    state.rights.includes("input") &&
    state.cellStatus?.input.state === "allowed";
  if (state.presentationReady === presentationReady && state.inputAllowed === inputAllowed) return state;
  return { ...state, presentationReady, inputAllowed };
}

function recovering(state: RoutedActivationState, unavailableReason?: string): RoutedActivationState {
  return withReadiness({
    ...state,
    phase: "recovering",
    ...(unavailableReason === undefined ? {} : { unavailableReason }),
    inputAllowed: false,
    presentationReady: false,
  });
}

function ended(state: RoutedActivationState): RoutedActivationState {
  return {
    ...state,
    phase: "ended",
    inputAllowed: false,
    presentationReady: false,
    cellLeaseDeadline: 0,
    workerLeaseDeadline: 0,
  };
}

function phaseAfterBothLegs(state: RoutedActivationState): RoutedActivationPhase {
  if (!state.controlAttached || !state.framesAttached) return "attaching";
  return state.framesOutcome?.kind === "resume-accepted" ? "resuming" : "seeding";
}

/**
 * Executable activation table for the main-thread authority. Unknown or stale
 * events are ignored, which lets delayed WebSocket and worker messages arrive
 * without resurrecting an abandoned activation.
 */
export function reduceRoutedActivation(
  state: RoutedActivationState,
  event: RoutedActivationEvent,
): RoutedActivationState {
  if (state.phase === "ended") return state;
  if (event.type === "detach" || event.type === "replaced" || event.type === "runtime-destroyed") {
    return ended(state);
  }
  if (event.type === "input-policy") return withReadiness({ ...state, inputPolicy: event.policy });

  switch (event.type) {
    case "demand-declared": {
      const next = { ...state, sourceDemand: event.mode };
      if (event.mode === "none") {
        delete next.resumeDemandSequence;
        delete next.inputStatusAfterDemand;
      } else if (state.sourceDemand === "none" || state.resumeDemandSequence !== undefined) {
        // A cached worker frame and old allowed lease cannot authorize input
        // into a view the cell is still reattaching after a visibility change.
        if (event.sequence !== undefined) next.resumeDemandSequence = event.sequence;
        next.inputStatusAfterDemand = state.lastCellStatusSequence;
      }
      return withReadiness(next);
    }
    case "demand-accepted": {
      if (state.resumeDemandSequence !== event.sequence) return state;
      const next = { ...state, inputStatusAfterDemand: state.lastCellStatusSequence };
      delete next.resumeDemandSequence;
      return withReadiness(next);
    }
    case "ticket-minted":
      if (!["unresolved", "recovering", "unavailable"].includes(state.phase)) return state;
      if (!event.endpointsPresent) {
        return {
          ...state,
          phase: "unavailable",
          unavailableReason: "transport-not-landed",
          presentationReady: false,
          inputAllowed: false,
        };
      }
      {
        const available = { ...state };
        delete available.unavailableReason;
        return { ...available, phase: "connecting" };
      }
    case "no-route":
      if (state.phase !== "unresolved" && state.phase !== "recovering") return state;
      return {
        ...state,
        phase: "unavailable",
        unavailableReason: event.reason,
        presentationReady: false,
        inputAllowed: false,
      };
    case "transport-ready":
      if (state.phase !== "connecting" && state.phase !== "recovering") return state;
      {
        const reset = { ...state };
        delete reset.framesOutcome;
        delete reset.trfIdentity;
        delete reset.cellStatus;
        delete reset.presentationStatus;
        delete reset.resumeDemandSequence;
        delete reset.inputStatusAfterDemand;
        return {
          ...reset,
          phase: "attaching",
          controlAttached: false,
          framesAttached: false,
          cellLeaseDeadline: 0,
          workerLeaseDeadline: 0,
          presentationReady: false,
          inputAllowed: false,
        };
      }
    case "transport-failed":
      if (state.phase !== "connecting" && state.phase !== "attaching" && state.phase !== "recovering") return state;
      if (event.recoveryExhausted || (event.preAuth && state.preAuthRemintUsed) || event.retryable === false) {
        return {
          ...state,
          phase: "unavailable",
          unavailableReason: event.reason ?? (event.recoveryExhausted ? "recovery-exhausted" : "transport-refused"),
          presentationReady: false,
          inputAllowed: false,
        };
      }
      return recovering({ ...state, preAuthRemintUsed: state.preAuthRemintUsed || event.preAuth === true });
    case "control-attached":
      if (state.phase !== "attaching" && !state.controlAttached) return state;
      return withReadiness({
        ...state,
        controlAttached: true,
        grantGeneration: Math.max(state.grantGeneration, event.grantGeneration),
        rights: [...event.rights],
        grantInputValid: true,
        phase: state.phase === "attaching" ? phaseAfterBothLegs({ ...state, controlAttached: true }) : state.phase,
      });
    case "frames-attached":
      if (state.phase !== "attaching" && !(state.phase === "recovering" && state.controlAttached)) return state;
      return withReadiness({
        ...state,
        framesAttached: true,
        framesOutcome: event.outcome,
        trfIdentity: event.trfIdentity,
        resumeToken: event.resumeToken,
        phase: phaseAfterBothLegs({ ...state, framesAttached: true, framesOutcome: event.outcome }),
      });
    case "attach-refused":
      if (state.phase === "unresolved" || state.phase === "connecting" || state.phase === "unavailable") return state;
      if (["SESSION_UNKNOWN", "CAPACITY"].includes(event.code) && !event.retryable) {
        return {
          ...state,
          phase: "unavailable",
          unavailableReason: "attach-refused",
          presentationReady: false,
          inputAllowed: false,
        };
      }
      return recovering({ ...state, replacesActivationId: state.activationId });
    case "attach-deadline":
      return state.phase === "attaching" ? recovering({ ...state, replacesActivationId: state.activationId }) : state;
    case "sync-complete":
      if (state.phase !== "seeding" && state.phase !== "resuming") return state;
      return withReadiness({
        ...state,
        appliedContent: event.appliedContent,
        phase: state.cellStatus?.presentation.state === "presenting" ? "presenting" : state.phase,
      });
    case "sync-failed":
      return state.phase === "seeding" || state.phase === "resuming"
        ? recovering({ ...state, replacesActivationId: state.activationId })
        : state;
    case "cell-status": {
      if (event.status.activationId !== state.activationId) return state;
      if (event.status.cellStatusSequence <= state.lastCellStatusSequence) return state;
      const base: RoutedActivationState = {
        ...state,
        cellStatus: event.status,
        lastCellStatusSequence: event.status.cellStatusSequence,
        cellLeaseDeadline: event.now + event.status.leaseTtlMs,
      };
      if (event.status.presentation.state === "revoked") {
        const reason = event.status.presentation.reason;
        return reason === "leg-dead" || reason === "stale-route" ? recovering(base) : ended(base);
      }
      if (event.status.presentation.state === "stopped") {
        return withReadiness({ ...base, phase: "stalled", presentationReady: false, inputAllowed: false });
      }
      if (["seeding", "resuming", "presenting", "stalled"].includes(state.phase)) {
        return withReadiness({ ...base, phase: "presenting" });
      }
      return withReadiness(base);
    }
    case "presentation-status":
      if (event.status.activationId !== state.activationId) return state;
      if (event.status.workerStatusSequence <= state.lastWorkerStatusSequence) return state;
      return withReadiness({
        ...state,
        presentationStatus: event.status,
        lastWorkerStatusSequence: event.status.workerStatusSequence,
        workerLeaseDeadline: event.now + event.status.leaseTtlMs,
        ...(event.status.sceneContent === undefined ? {} : { appliedContent: event.status.sceneContent }),
      });
    case "frames-state":
      if (event.state.activationId !== state.activationId) return state;
      return withReadiness({
        ...state,
        framesState: event.state,
        ...(event.state.resumeToken === undefined ? {} : { resumeToken: event.state.resumeToken }),
        ...(event.state.appliedContent === undefined ? {} : { appliedContent: event.state.appliedContent }),
      });
    case "cell-lease-expired":
      return state.phase === "presenting" || state.phase === "stalled"
        ? withReadiness({ ...state, phase: "stalled", cellLeaseDeadline: 0 })
        : state;
    case "worker-lease-expired":
      return state.phase === "presenting" || state.phase === "stalled"
        ? withReadiness({ ...state, phase: "stalled", workerLeaseDeadline: 0 })
        : state;
    case "leg-lost":
      return recovering({
        ...state,
        ...(event.channel === "control" ? { controlAttached: false } : { framesAttached: false }),
        ...(event.channel === "frames" && event.resumeCapable && state.resumeToken
          ? {}
          : { replacesActivationId: state.activationId }),
      });
    case "route-stale":
      return recovering({ ...state, replacesActivationId: state.activationId }, "stale-route");
    case "grant-expiring":
      // Close input at the local renewal margin. Presentation is independent
      // and remains live while the host obtains a higher grant generation.
      return withReadiness({ ...state, grantInputValid: false });
    case "renew-failed":
      return withReadiness({ ...state, grantInputValid: false });
    case "renewed":
      return withReadiness({
        ...state,
        grantGeneration: Math.max(state.grantGeneration, event.grantGeneration),
        rights: [...event.rights],
        grantInputValid: true,
      });
    case "retry":
      if (state.phase !== "unavailable") return state;
      {
        const retrying = { ...state };
        delete retrying.unavailableReason;
        return recovering(retrying);
      }
  }
}

export function expireRoutedActivationLeases(state: RoutedActivationState, now: number): RoutedActivationState {
  let next = state;
  if (next.cellLeaseDeadline > 0 && now >= next.cellLeaseDeadline) {
    next = reduceRoutedActivation(next, { type: "cell-lease-expired" });
  }
  if (next.workerLeaseDeadline > 0 && now >= next.workerLeaseDeadline) {
    next = reduceRoutedActivation(next, { type: "worker-lease-expired" });
  }
  return next;
}
