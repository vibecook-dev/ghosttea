import type { GlyphInstance, StyleRun } from "@vibecook/ghosttea-frame";
import type { CellSelection } from "./renderers/types.js";

interface Rows {
  rows: readonly string[];
  nativeRows: readonly (readonly GlyphInstance[])[];
  nativeStyleRows: readonly (readonly StyleRun[])[];
}

function sameRow(before: Rows, from: number, after: Rows, to: number): boolean {
  if (from < 0 || from >= before.rows.length || before.rows[from] !== after.rows[to]) return false;
  const a = before.nativeRows[from] ?? [],
    b = after.nativeRows[to] ?? [];
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!,
      y = b[i]!;
    if (
      x.glyphId !== y.glyphId ||
      x.styleId !== y.styleId ||
      x.x !== y.x ||
      x.y !== y.y ||
      x.width !== y.width ||
      x.height !== y.height ||
      x.cellStart !== y.cellStart ||
      x.cellSpan !== y.cellSpan
    )
      return false;
  }
  const as = before.nativeStyleRows[from] ?? [],
    bs = after.nativeStyleRows[to] ?? [];
  if (as.length !== bs.length) return false;
  return as.every(
    (x, i) => x.styleId === bs[i]!.styleId && x.cellStart === bs[i]!.cellStart && x.cellSpan === bs[i]!.cellSpan,
  );
}

/** Infer scrolling only from exact row content, never from a matching text
 * label alone. Unique text anchors keep candidate discovery linear even on a
 * screen full of repeated/blank lines. The final comparison includes geometry
 * and style. Callers fence catalog, layout and style-definition changes. */
export function rowDamage(before: Rows, after: Rows): { scrollRows: number; rows: number[] } {
  const positions = new Map<string, number>();
  for (let row = 0; row < before.rows.length; row++) {
    const text = before.rows[row]!;
    positions.set(text, positions.has(text) ? -1 : row);
  }
  const votes = new Map<number, number>();
  for (let row = 0; row < after.rows.length; row++) {
    const from = positions.get(after.rows[row]!);
    if (from !== undefined && from >= 0) {
      const delta = from - row;
      votes.set(delta, (votes.get(delta) ?? 0) + 1);
    }
  }
  let scrollRows = 0,
    best = votes.get(0) ?? 0;
  for (const [delta, count] of votes)
    if (count > best) {
      best = count;
      scrollRows = delta;
    }
  const changed = (delta: number): number[] =>
    after.rows.flatMap((_, row) => (sameRow(before, row + delta, after, row) ? [] : [row]));
  if (scrollRows !== 0) {
    const rows = changed(scrollRows);
    if (after.rows.length - rows.length >= Math.ceil(after.rows.length / 2)) return { scrollRows, rows };
  }
  return { scrollRows: 0, rows: changed(0) };
}

/** Compose shifts before the next paint, moving pending damage with the rows.
 * No intermediate decoded scene has been painted yet. */
export function shiftDamage(rows: Set<number>, shift: number, rowCount: number): void {
  const moved = [...rows].map((row) => row - shift).filter((row) => row >= 0 && row < rowCount);
  rows.clear();
  for (const row of moved) rows.add(row);
}

export function selectionDamageRows(
  before: CellSelection | null,
  after: CellSelection | null,
  count: number,
): number[] {
  const rows = new Set<number>();
  for (const selection of [before, after]) {
    if (!selection) continue;
    const start = Math.max(0, Math.min(selection.anchor.row, selection.focus.row));
    const end = Math.min(count - 1, Math.max(selection.anchor.row, selection.focus.row));
    for (let row = start; row <= end; row++) rows.add(row);
  }
  return [...rows];
}
