import type { TerminalLink } from "@vibecook/ghosttea-frame";

export type LinkModifiers = { metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean };

export function linkModifierPressed(event: LinkModifiers, platform: string): boolean {
  return !event.altKey && (platform === "darwin" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

export function linkAtCell(links: readonly TerminalLink[], column: number, row: number): TerminalLink | null {
  return (
    links.find((link) =>
      link.spans.some((span) => span.row === row && column >= span.startColumn && column < span.endColumn),
    ) ?? null
  );
}

/** A link click must finish on the same target without turning into a drag. */
export class TerminalLinkGesture {
  #press: { pointerId: number; link: TerminalLink; x: number; y: number; dragged: boolean } | null = null;

  begin(pointerId: number, link: TerminalLink, x: number, y: number): void {
    this.#press = { pointerId, link, x, y, dragged: false };
  }

  move(pointerId: number, x: number, y: number): void {
    const press = this.#press;
    if (press?.pointerId === pointerId && Math.hypot(x - press.x, y - press.y) > 4) press.dragged = true;
  }

  finish(pointerId: number, link: TerminalLink | null): string | null {
    const press = this.#press;
    this.#press = null;
    return press?.pointerId === pointerId && !press.dragged && press.link === link ? link.uri : null;
  }

  cancel(): void {
    this.#press = null;
  }
}
