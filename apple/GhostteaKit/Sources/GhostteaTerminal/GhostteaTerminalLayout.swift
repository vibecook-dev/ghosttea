import CoreGraphics
import Foundation

public struct GhostteaTerminalContentInsets: Equatable, Sendable {
  public var top: Float
  public var left: Float
  public var bottom: Float
  public var right: Float

  public init(top: Float = 0, left: Float = 0, bottom: Float = 0, right: Float = 0) {
    self.top = top
    self.left = left
    self.bottom = bottom
    self.right = right
  }

  public static let zero = Self()
}

public struct GhostteaTerminalGridSize: Equatable, Sendable {
  public let columns: UInt16
  public let rows: UInt16

  public init(columns: UInt16, rows: UInt16) {
    self.columns = columns
    self.rows = rows
  }
}

/// Where a terminal view draws a grid whose row count differs from the grid it
/// measured — a session whose PTY size another device holds.
public enum GhostteaTerminalGridAlignment: Equatable, Sendable {
  /// The grid's first row sits where the measured grid's first row would. A
  /// shorter grid leaves its empty rows at the foot; a taller one runs past the
  /// foot and clips there.
  case top
  /// The grid's last row sits where the measured grid's last row would, so its
  /// live end — the prompt — sits at the foot. A shorter grid leaves its empty
  /// rows at the top. A taller one clips its top rows, not its foot: the live
  /// end is what a held session is read for, and clipping the foot would hide
  /// the prompt this alignment exists to show.
  case bottom
}

/// Where a view draws the grid it holds, beside the grid it measured: the one
/// computation the renderer's origin and every point↔cell map read the grid's
/// top from. Measurement never reads it.
struct GhostteaTerminalGridPlacement: Equatable, Sendable {
  /// The content insets with the top moved by `offset`. The renderer draws from
  /// these; nothing measures with them.
  let insets: GhostteaTerminalContentInsets
  /// How far the alignment moved the grid's top, in points — down when
  /// positive, up when negative.
  let offset: Float
  /// The drawn rows a point inside the measured grid lands on, first to past
  /// the last.
  let rows: Range<Int>

  /// The drawn grid's first row, in points below the view's top edge.
  var top: Float { GhostteaTerminalLayout.gridOrigin(contentInsets: insets).y }
  var firstRow: Int { rows.lowerBound }
  var lastRow: Int { max(rows.lowerBound, rows.upperBound - 1) }
}

public enum GhostteaTerminalLayout {
  public static let cellWidth: Float = 7.83
  public static let lineHeight: Float = 19
  public static let horizontalPadding: Float = 2
  public static let verticalPadding: Float = 2

  public static func gridSize(
    width: Float,
    height: Float,
    contentInsets: GhostteaTerminalContentInsets = .zero,
    cellWidth: Float = GhostteaTerminalLayout.cellWidth,
    lineHeight: Float = GhostteaTerminalLayout.lineHeight
  ) -> GhostteaTerminalGridSize {
    let usableWidth = width - contentInsets.left - contentInsets.right - horizontalPadding * 2
    let usableHeight = height - contentInsets.top - contentInsets.bottom - verticalPadding * 2
    return GhostteaTerminalGridSize(
      columns: terminalDimension(usableWidth, step: cellWidth),
      rows: terminalDimension(usableHeight, step: lineHeight)
    )
  }

  private static func terminalDimension(_ available: Float, step: Float) -> UInt16 {
    guard available.isFinite, available > 0, step.isFinite, step > 0 else { return 1 }
    let cells = floor(Double(available) / Double(step) + 0.000_001)
    return UInt16(Int(max(1, min(Double(UInt16.max), cells))))
  }
}

// The drawn grid's placement and the maps that read it. Each map keeps the
// arithmetic and the types its view site had, so `.top` reproduces every number
// the view computed before the alignment existed.
extension GhostteaTerminalLayout {
  /// The top-left of a grid's first cell, in points, inside `contentInsets`: the
  /// one origin the renderer draws from and every point↔cell map reads.
  static func gridOrigin(contentInsets: GhostteaTerminalContentInsets) -> (x: Float, y: Float) {
    (x: horizontalPadding + contentInsets.left, y: verticalPadding + contentInsets.top)
  }

  /// Where a view that measured `measuredRows` draws a grid of `drawnRows`.
  /// `.bottom` moves a grid of another height by (measured − drawn) ×
  /// `lineHeight`, so its last row sits where the measured grid's last row
  /// would. `.top`, an equal grid, no grid drawn yet and no measurement yet
  /// leave it where the measured grid sits.
  static func gridPlacement(
    contentInsets: GhostteaTerminalContentInsets,
    alignment: GhostteaTerminalGridAlignment,
    measuredRows: UInt16?,
    drawnRows: Int,
    lineHeight: Float = GhostteaTerminalLayout.lineHeight
  ) -> GhostteaTerminalGridPlacement {
    let drawn = max(0, drawnRows)
    let measured = measuredRows.map { Int($0) } ?? drawn
    let shift = alignment == .bottom && drawn > 0 ? drawn - measured : 0
    guard shift != 0, lineHeight.isFinite, lineHeight > 0 else {
      return GhostteaTerminalGridPlacement(insets: contentInsets, offset: 0, rows: 0..<measured)
    }
    let offset = -Float(shift) * lineHeight
    var insets = contentInsets
    insets.top += offset
    return GhostteaTerminalGridPlacement(
      insets: insets,
      offset: offset,
      rows: max(0, shift)..<drawn
    )
  }

  /// The drawn grid's cell under `point`: its column clamped to `columns`, its
  /// row to the rows the measured grid covers. The view's hit test.
  static func viewportCell(
    at point: CGPoint,
    placement: GhostteaTerminalGridPlacement,
    columns: UInt16,
    cellWidth: CGFloat,
    lineHeight: CGFloat
  ) -> GhostteaViewportCellPoint {
    let origin = gridOrigin(contentInsets: placement.insets)
    let x = point.x - CGFloat(origin.x)
    let y = point.y - CGFloat(origin.y)
    let maximumColumn = max(0, Int(columns) - 1)
    let column = max(0, min(maximumColumn, Int(floor(x / cellWidth))))
    let row = max(placement.firstRow, min(placement.lastRow, Int(floor(y / lineHeight))))
    return GhostteaViewportCellPoint(column: UInt16(column), row: UInt16(row))
  }

  /// The vertical half of a mouse report for a pointer `y` points below the top
  /// of a view `height` points tall: the position, the screen height, and the
  /// top padding the core subtracts before it divides by the cell height. A grid
  /// the alignment moved down widens the padding by as much. One it moved up
  /// would need a padding below zero, which the report cannot carry, so the
  /// position and the screen move down by as much instead — the core lands on
  /// the same row either way.
  static func mouseReportVertical(
    y: CGFloat,
    height: CGFloat,
    placement: GhostteaTerminalGridPlacement
  ) -> (y: CGFloat, screenHeight: CGFloat, paddingTop: CGFloat) {
    let position = max(0, min(height, y))
    guard placement.offset < 0 else {
      return (y: position, screenHeight: height, paddingTop: CGFloat(placement.top))
    }
    let lift = CGFloat(-placement.offset)
    return (
      y: position + lift,
      screenHeight: height + lift,
      paddingTop: CGFloat(placement.top) + lift
    )
  }

  /// A drawn row's frame in a view `width` points wide — where VoiceOver finds
  /// the row.
  static func rowFrame(
    row: UInt16,
    width: CGFloat,
    placement: GhostteaTerminalGridPlacement,
    lineHeight: CGFloat
  ) -> CGRect {
    let insets = placement.insets
    let origin = gridOrigin(contentInsets: insets)
    let sides: Float = insets.left + insets.right + 2 * horizontalPadding
    let rowWidth: CGFloat = max(0, width - CGFloat(sides))
    let rowTop: CGFloat = CGFloat(origin.y) + CGFloat(row) * lineHeight
    return CGRect(x: CGFloat(origin.x), y: rowTop, width: rowWidth, height: lineHeight)
  }

  /// The top-left of the drawn grid's cell at `column`, `row` — where the text
  /// input's caret and its marked text sit.
  static func cellOrigin(
    column: UInt16,
    row: UInt16,
    placement: GhostteaTerminalGridPlacement,
    cellWidth: CGFloat,
    lineHeight: CGFloat
  ) -> CGPoint {
    let origin = gridOrigin(contentInsets: placement.insets)
    return CGPoint(
      x: CGFloat(origin.x) + CGFloat(column) * cellWidth,
      y: CGFloat(origin.y) + CGFloat(row) * lineHeight
    )
  }
}
