import type { SessionSummary } from "@vibecook/ghosttea-protocol";
import { WORKSPACE_SCHEMA_VERSION, type WorkspaceDocumentV1, type WorkspaceNode } from "./workspace-model.js";

export type SplitAxis = "horizontal" | "vertical";
export type SplitSizing = "halves" | "equal";

export interface PaneLeaf {
  kind: "pane";
  id: string;
  session: SessionSummary;
}

export interface PaneSplit {
  kind: "split";
  id: string;
  axis: SplitAxis;
  ratio: number;
  first: PaneNode;
  second: PaneNode;
}

export type PaneNode = PaneLeaf | PaneSplit;

export const layoutId = (prefix: string): string => `${prefix}-${crypto.randomUUID()}`;
export const pane = (id: string, session: SessionSummary): PaneLeaf => ({ kind: "pane", id, session });

function savedPaneSessionId(candidate: Record<string, unknown>): string | undefined {
  if (typeof candidate.sessionId === "string") return candidate.sessionId;
  const savedSession = candidate.session as { id?: unknown } | undefined;
  return typeof savedSession?.id === "string" ? savedSession.id : undefined;
}

export function restoreNode(
  value: unknown,
  sessions: Map<string, SessionSummary>,
  revivals?: ReadonlyMap<string, SessionSummary>,
): PaneNode | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "pane" && typeof candidate.id === "string") {
    const sessionId = savedPaneSessionId(candidate);
    if (sessionId === undefined) return null;
    const session = sessions.get(sessionId) ?? revivals?.get(candidate.id);
    return session ? pane(candidate.id, session) : null;
  }
  if (
    candidate.kind !== "split" ||
    typeof candidate.id !== "string" ||
    (candidate.axis !== "horizontal" && candidate.axis !== "vertical")
  )
    return null;
  const first = restoreNode(candidate.first, sessions, revivals);
  const second = restoreNode(candidate.second, sessions, revivals);
  if (!first) return second;
  if (!second) return first;
  const ratio =
    typeof candidate.ratio === "number" && Number.isFinite(candidate.ratio)
      ? Math.max(0.1, Math.min(0.9, candidate.ratio))
      : 0.5;
  return { kind: "split", id: candidate.id, axis: candidate.axis, ratio, first, second };
}

export interface DeadPane {
  paneId: string;
  sessionId: string;
  meta: unknown;
}

/** Persisted panes that restoreNode would drop, in tree order. Mirrors restoreNode's parsing. */
export function collectDeadPanes(value: unknown, sessions: ReadonlyMap<string, SessionSummary>): DeadPane[] {
  if (!value || typeof value !== "object") return [];
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "pane" && typeof candidate.id === "string") {
    const sessionId = savedPaneSessionId(candidate);
    if (sessionId === undefined || sessions.has(sessionId)) return [];
    return [{ paneId: candidate.id, sessionId, meta: candidate.meta }];
  }
  if (
    candidate.kind !== "split" ||
    typeof candidate.id !== "string" ||
    (candidate.axis !== "horizontal" && candidate.axis !== "vertical")
  )
    return [];
  return [...collectDeadPanes(candidate.first, sessions), ...collectDeadPanes(candidate.second, sessions)];
}

export function appendPane(root: PaneNode, next: PaneLeaf): PaneNode {
  return { kind: "split", id: layoutId("split"), axis: "horizontal", ratio: 0.5, first: root, second: next };
}

export function leaves(node: PaneNode | undefined): PaneLeaf[] {
  if (!node) return [];
  return node.kind === "pane" ? [node] : [...leaves(node.first), ...leaves(node.second)];
}

export function replacePane(node: PaneNode, paneId: string, replacement: PaneNode): PaneNode {
  if (node.kind === "pane") return node.id === paneId ? replacement : node;
  return {
    ...node,
    first: replacePane(node.first, paneId, replacement),
    second: replacePane(node.second, paneId, replacement),
  };
}

export function insertPane(
  root: PaneNode | undefined,
  next: PaneLeaf,
  activePaneId: string | undefined,
  axis: SplitAxis,
  splitId: string,
  sizing: SplitSizing = "halves",
): PaneNode {
  if (!root) return next;
  const active = leaves(root).find((candidate) => candidate.id === activePaneId) ?? leaves(root)[0]!;
  const updated = replacePane(root, active.id, {
    kind: "split",
    id: splitId,
    axis,
    ratio: 0.5,
    first: active,
    second: next,
  });
  if (sizing === "halves") return updated;

  // Find the contiguous row/column containing the new pane. A perpendicular
  // split starts a separate group, whose surrounding geometry stays intact.
  let group = updated;
  let current = updated;
  while (current.kind === "split") {
    const child = containsPane(current.first, next.id) ? current.first : current.second;
    if (current.axis !== axis) group = child;
    current = child;
  }
  if (group.kind === "pane") return updated;
  const [balanced] = equalizeSplitGroup(group);
  return updateSplit(updated, group.id, () => balanced);
}

/** Count perpendicular subtrees as one column/row, preserving their own ratios. */
function equalizeSplitGroup(split: PaneSplit): [PaneSplit, number] {
  const [first, firstCount] =
    split.first.kind === "split" && split.first.axis === split.axis
      ? equalizeSplitGroup(split.first)
      : ([split.first, 1] as const);
  const [second, secondCount] =
    split.second.kind === "split" && split.second.axis === split.axis
      ? equalizeSplitGroup(split.second)
      : ([split.second, 1] as const);
  const count = firstCount + secondCount;
  return [{ ...split, ratio: firstCount / count, first, second }, count];
}

export function mountSessionInPane(root: PaneNode, paneId: string, session: SessionSummary): PaneNode {
  const target = leaves(root).find((candidate) => candidate.id === paneId);
  if (!target) return root;
  return replacePane(root, target.id, { ...target, session });
}

/** @deprecated Use mountSessionInPane; panes no longer own or move sessions. */
export const placeSessionInPane = mountSessionInPane;

export function updateSession(node: PaneNode, session: SessionSummary): PaneNode {
  if (node.kind === "pane") return node.session.id === session.id ? { ...node, session } : node;
  return { ...node, first: updateSession(node.first, session), second: updateSession(node.second, session) };
}

export function removePane(node: PaneNode, paneId: string): PaneNode | null {
  if (node.kind === "pane") return node.id === paneId ? null : node;
  const first = removePane(node.first, paneId);
  const second = removePane(node.second, paneId);
  if (!first) return second;
  if (!second) return first;
  return { ...node, first, second };
}

export function updateSplit(node: PaneNode, splitId: string, update: (split: PaneSplit) => PaneSplit): PaneNode {
  if (node.kind === "pane") return node;
  if (node.id === splitId) return update(node);
  return {
    ...node,
    first: updateSplit(node.first, splitId, update),
    second: updateSplit(node.second, splitId, update),
  };
}

export function equalize(node: PaneNode): PaneNode {
  if (node.kind === "pane") return node;
  return { ...node, ratio: 0.5, first: equalize(node.first), second: equalize(node.second) };
}

export function containsPane(node: PaneNode, paneId: string): boolean {
  return node.kind === "pane"
    ? node.id === paneId
    : containsPane(node.first, paneId) || containsPane(node.second, paneId);
}

export function resizeForPane(node: PaneNode, paneId: string, axis: SplitAxis, delta: number): [PaneNode, boolean] {
  if (node.kind === "pane") return [node, false];
  const inFirst = containsPane(node.first, paneId);
  const inSecond = containsPane(node.second, paneId);
  if (inFirst) {
    const [first, changed] = resizeForPane(node.first, paneId, axis, delta);
    if (changed) return [{ ...node, first }, true];
  }
  if (inSecond) {
    const [second, changed] = resizeForPane(node.second, paneId, axis, delta);
    if (changed) return [{ ...node, second }, true];
  }
  if (node.axis === axis && (inFirst || inSecond)) {
    return [{ ...node, ratio: Math.max(0.1, Math.min(0.9, node.ratio + delta)) }, true];
  }
  return [node, false];
}

export function persistedWorkspace(
  root: PaneNode,
  activePaneId: string,
  zoomedPaneId: string | null,
  paneMeta?: (session: SessionSummary, paneId: string) => unknown,
): WorkspaceDocumentV1 {
  const persistNode = (node: PaneNode): WorkspaceNode => {
    if (node.kind === "pane") {
      const meta = paneMeta?.(node.session, node.id);
      return { kind: "pane", id: node.id, sessionId: node.session.id, ...(meta !== undefined ? { meta } : {}) };
    }
    return {
      kind: "split",
      id: node.id,
      axis: node.axis,
      ratio: node.ratio,
      first: persistNode(node.first),
      second: persistNode(node.second),
    };
  };
  return { version: WORKSPACE_SCHEMA_VERSION, root: persistNode(root), activePaneId, zoomedPaneId };
}
