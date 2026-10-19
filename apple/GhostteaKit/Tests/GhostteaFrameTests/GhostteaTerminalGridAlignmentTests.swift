import Foundation
import Testing

@testable import GhostteaTerminal

// A phone in portrait: 390 × 844 points, the safe area 59 above and 34 below.
// The view measures 49 × 39 from it; the grids it draws are a desktop's 24 rows
// (shorter), its own 39 (equal) and 50 (taller). The measured grid's top is 61
// points down and its foot 802.
private let phoneInsets = GhostteaTerminalContentInsets(top: 59, bottom: 34)
private let phoneWidth: CGFloat = 390
private let phoneHeight: CGFloat = 844
private let phoneMeasuredRows: UInt16 = 39
private let phoneCellWidth = CGFloat(GhostteaTerminalLayout.cellWidth)
private let phoneLineHeight = CGFloat(GhostteaTerminalLayout.lineHeight)

private func placement(
  _ alignment: GhostteaTerminalGridAlignment,
  drawnRows: Int
) -> GhostteaTerminalGridPlacement {
  GhostteaTerminalLayout.gridPlacement(
    contentInsets: phoneInsets,
    alignment: alignment,
    measuredRows: phoneMeasuredRows,
    drawnRows: drawnRows
  )
}

@Test func gridAlignmentMovesTheDrawnGridAndNeverTheMeasuredOne() {
  // The view measures from its content insets alone — `geometryDidChange` and
  // `updateGridSize` never read a placement — so the grid it reports is the
  // same 49 × 39 whatever it draws.
  let measured = GhostteaTerminalLayout.gridSize(
    width: Float(phoneWidth),
    height: Float(phoneHeight),
    contentInsets: phoneInsets
  )
  #expect(measured == GhostteaTerminalGridSize(columns: 49, rows: phoneMeasuredRows))

  // `.top`, an equal grid, nothing drawn yet: the grid sits where the measured
  // one does — today's insets, rows 0 through 38.
  let unaligned = placement(.top, drawnRows: 24)
  #expect(unaligned.insets == phoneInsets)
  #expect(unaligned.offset == 0)
  #expect(unaligned.top == 61)
  #expect(unaligned.rows == 0..<39)
  #expect(unaligned.firstRow == 0)
  #expect(unaligned.lastRow == 38)
  #expect(placement(.top, drawnRows: 50) == unaligned)
  #expect(placement(.bottom, drawnRows: 39) == unaligned)
  #expect(placement(.bottom, drawnRows: 0) == unaligned)

  // Nothing measured yet: the drawn grid is all there is to align to.
  let unmeasured = GhostteaTerminalLayout.gridPlacement(
    contentInsets: phoneInsets,
    alignment: .bottom,
    measuredRows: nil,
    drawnRows: 24
  )
  #expect(unmeasured.insets == phoneInsets)
  #expect(unmeasured.rows == 0..<24)

  // `.bottom`, 24 rows: the 15 empty rows go to the top, and the grid's foot is
  // the measured grid's.
  let shorter = placement(.bottom, drawnRows: 24)
  #expect(shorter.offset == 285)
  #expect(shorter.insets == GhostteaTerminalContentInsets(top: 344, bottom: 34))
  #expect(shorter.top == 346)
  #expect(shorter.top + 24 * 19 == unaligned.top + 39 * 19)
  #expect(shorter.rows == 0..<24)
  #expect(shorter.firstRow == 0)
  #expect(shorter.lastRow == 23)

  // `.bottom`, 50 rows: rows 0 through 10 clip above the view; 11 through 49,
  // the live end, are the ones in it.
  let taller = placement(.bottom, drawnRows: 50)
  #expect(taller.offset == -209)
  #expect(taller.insets == GhostteaTerminalContentInsets(top: -150, bottom: 34))
  #expect(taller.top == -148)
  #expect(taller.top + 50 * 19 == unaligned.top + 39 * 19)
  #expect(taller.rows == 11..<50)
  #expect(taller.firstRow == 11)
  #expect(taller.lastRow == 49)

  // Measuring with the drawing insets would report the held grid back as the
  // view's own — the loop a host that moves the view instead walks into.
  let remeasuredShorter = GhostteaTerminalLayout.gridSize(
    width: Float(phoneWidth),
    height: Float(phoneHeight),
    contentInsets: shorter.insets
  )
  let remeasuredTaller = GhostteaTerminalLayout.gridSize(
    width: Float(phoneWidth),
    height: Float(phoneHeight),
    contentInsets: taller.insets
  )
  #expect(remeasuredShorter.rows == 24)
  #expect(remeasuredTaller.rows == 50)
}

@Test func gridAlignmentMovesTheCellHitTest() {
  func cell(
    _ alignment: GhostteaTerminalGridAlignment,
    drawnRows: Int,
    _ point: CGPoint
  ) -> GhostteaViewportCellPoint {
    GhostteaTerminalLayout.viewportCell(
      at: point,
      placement: placement(alignment, drawnRows: drawnRows),
      columns: 49,
      cellWidth: phoneCellWidth,
      lineHeight: phoneLineHeight
    )
  }
  // `viewportCell(at:)` as it stood before the alignment existed.
  func today(_ point: CGPoint) -> GhostteaViewportCellPoint {
    let x = point.x - CGFloat(phoneInsets.left + GhostteaTerminalLayout.horizontalPadding)
    let y = point.y - CGFloat(phoneInsets.top + GhostteaTerminalLayout.verticalPadding)
    let column = max(0, min(48, Int(floor(x / phoneCellWidth))))
    let row = max(0, min(38, Int(floor(y / phoneLineHeight))))
    return GhostteaViewportCellPoint(column: UInt16(column), row: UInt16(row))
  }
  let points = stride(from: CGFloat(-12), through: phoneHeight + 12, by: 7.25).flatMap { y in
    [CGFloat(-3), 0, 1.5, 120.4, 389, 402].map { x in CGPoint(x: x, y: y) }
  }
  let expected = points.map(today)

  // `.top` and an equal grid are today's map at every point, whatever is drawn.
  let topShorter = points.map { cell(.top, drawnRows: 24, $0) }
  let topTaller = points.map { cell(.top, drawnRows: 50, $0) }
  let bottomEqual = points.map { cell(.bottom, drawnRows: 39, $0) }
  #expect(topShorter == expected)
  #expect(topTaller == expected)
  #expect(bottomEqual == expected)

  // The alignment never moves a column.
  let bottomShorterColumns = points.map { cell(.bottom, drawnRows: 24, $0).column }
  let bottomTallerColumns = points.map { cell(.bottom, drawnRows: 50, $0).column }
  #expect(bottomShorterColumns == expected.map(\.column))
  #expect(bottomTallerColumns == expected.map(\.column))

  // `.bottom`, 24 rows from 346 to the measured foot at 802: the empty rows
  // above resolve to its first row, the inset below to its last.
  #expect(cell(.bottom, drawnRows: 24, CGPoint(x: 10, y: 346)).row == 0)
  #expect(cell(.bottom, drawnRows: 24, CGPoint(x: 10, y: 801.5)).row == 23)
  #expect(cell(.bottom, drawnRows: 24, CGPoint(x: 10, y: 120)).row == 0)
  #expect(cell(.bottom, drawnRows: 24, CGPoint(x: 10, y: 830)).row == 23)

  // `.bottom`, 50 rows from −148: row 11 is the first in view and 49 the last;
  // the top inset resolves to row 11 as `.top`'s foot resolves to row 38.
  #expect(cell(.bottom, drawnRows: 50, CGPoint(x: 10, y: 61)).row == 11)
  #expect(cell(.bottom, drawnRows: 50, CGPoint(x: 10, y: 801.5)).row == 49)
  #expect(cell(.bottom, drawnRows: 50, CGPoint(x: 10, y: 10)).row == 11)
  #expect(cell(.bottom, drawnRows: 50, CGPoint(x: 10, y: 830)).row == 49)
}

@Test func gridAlignmentMovesTheMouseReportPadding() {
  func report(
    _ alignment: GhostteaTerminalGridAlignment,
    drawnRows: Int,
    y: CGFloat
  ) -> (y: CGFloat, screenHeight: CGFloat, paddingTop: CGFloat) {
    GhostteaTerminalLayout.mouseReportVertical(
      y: y,
      height: phoneHeight,
      placement: placement(alignment, drawnRows: drawnRows)
    )
  }
  // `terminalMouseEvent` as it stood before: the clamped position, the view's
  // height, the content's top.
  let todayPadding = CGFloat(phoneInsets.top + GhostteaTerminalLayout.verticalPadding)
  for y: CGFloat in [-5, 0, 61, 400.25, 844, 900] {
    for unaligned in [
      report(.top, drawnRows: 24, y: y),
      report(.top, drawnRows: 50, y: y),
      report(.bottom, drawnRows: 39, y: y),
    ] {
      #expect(unaligned.y == max(0, min(phoneHeight, y)))
      #expect(unaligned.screenHeight == phoneHeight)
      #expect(unaligned.paddingTop == todayPadding)
    }
  }

  // `.bottom`, 24 rows: the padding widens by the 15 empty rows; nothing else
  // moves.
  let shorter = report(.bottom, drawnRows: 24, y: 400)
  #expect(shorter.y == 400)
  #expect(shorter.screenHeight == 844)
  #expect(shorter.paddingTop == 346)

  // `.bottom`, 50 rows: a padding of −148 cannot ride the unsigned report, so
  // the position and the screen move 209 points down and the padding stays 61.
  let taller = report(.bottom, drawnRows: 50, y: 400)
  #expect(taller.y == 609)
  #expect(taller.screenHeight == 1053)
  #expect(taller.paddingTop == 61)

  // Either way the row the core finds — (y − padding) ÷ cell height — is the row
  // the hit test finds, everywhere the drawn grid is in view.
  for drawnRows in [24, 39, 50] {
    let placed = placement(.bottom, drawnRows: drawnRows)
    let firstInView = max(CGFloat(placed.top), 61)
    for y in stride(from: firstInView + 0.5, to: 802, by: 9.5) {
      let reported = GhostteaTerminalLayout.mouseReportVertical(
        y: y,
        height: phoneHeight,
        placement: placed
      )
      let hit = GhostteaTerminalLayout.viewportCell(
        at: CGPoint(x: 10, y: y),
        placement: placed,
        columns: 49,
        cellWidth: phoneCellWidth,
        lineHeight: phoneLineHeight
      )
      let coreRow = Int(floor((reported.y - reported.paddingTop) / phoneLineHeight))
      #expect(coreRow == Int(hit.row))
    }
  }
}

@Test func gridAlignmentMovesTheAccessibilityRowFrames() {
  func frame(
    _ alignment: GhostteaTerminalGridAlignment,
    drawnRows: Int,
    row: UInt16
  ) -> CGRect {
    GhostteaTerminalLayout.rowFrame(
      row: row,
      width: phoneWidth,
      placement: placement(alignment, drawnRows: drawnRows),
      lineHeight: phoneLineHeight
    )
  }
  // `rebuildAccessibilityElements` as it stood before the alignment existed.
  func today(row: UInt16) -> CGRect {
    CGRect(
      x: CGFloat(phoneInsets.left + GhostteaTerminalLayout.horizontalPadding),
      y: CGFloat(phoneInsets.top + GhostteaTerminalLayout.verticalPadding)
        + CGFloat(row) * phoneLineHeight,
      width: max(
        0,
        phoneWidth
          - CGFloat(
            phoneInsets.left + phoneInsets.right + 2 * GhostteaTerminalLayout.horizontalPadding)
      ),
      height: phoneLineHeight
    )
  }
  for row: UInt16 in [0, 1, 23, 38, 49] {
    #expect(frame(.top, drawnRows: 24, row: row) == today(row: row))
    #expect(frame(.top, drawnRows: 50, row: row) == today(row: row))
    #expect(frame(.bottom, drawnRows: 39, row: row) == today(row: row))
  }

  // `.bottom`, 24 rows: VoiceOver finds row 0 at 346 and row 23 on the
  // measured grid's last row.
  #expect(frame(.bottom, drawnRows: 24, row: 0) == CGRect(x: 2, y: 346, width: 386, height: 19))
  #expect(frame(.bottom, drawnRows: 24, row: 23) == CGRect(x: 2, y: 783, width: 386, height: 19))

  // `.bottom`, 50 rows: row 0 lies above the view, 11 is the first in it and 49
  // sits on the measured grid's last row.
  #expect(frame(.bottom, drawnRows: 50, row: 0) == CGRect(x: 2, y: -148, width: 386, height: 19))
  #expect(frame(.bottom, drawnRows: 50, row: 11) == CGRect(x: 2, y: 61, width: 386, height: 19))
  #expect(frame(.bottom, drawnRows: 50, row: 49) == CGRect(x: 2, y: 783, width: 386, height: 19))
}

@Test func gridAlignmentMovesTheTextInputCaret() {
  func caret(
    _ alignment: GhostteaTerminalGridAlignment,
    drawnRows: Int,
    column: UInt16,
    row: UInt16
  ) -> CGPoint {
    GhostteaTerminalLayout.cellOrigin(
      column: column,
      row: row,
      placement: placement(alignment, drawnRows: drawnRows),
      cellWidth: phoneCellWidth,
      lineHeight: phoneLineHeight
    )
  }
  // `terminalInputCaretRect` as it stood before the alignment existed.
  func today(column: UInt16, row: UInt16) -> CGPoint {
    CGPoint(
      x: CGFloat(phoneInsets.left + GhostteaTerminalLayout.horizontalPadding)
        + CGFloat(column) * phoneCellWidth,
      y: CGFloat(phoneInsets.top + GhostteaTerminalLayout.verticalPadding)
        + CGFloat(row) * phoneLineHeight
    )
  }
  let cursors: [(column: UInt16, row: UInt16)] = [(0, 0), (4, 2), (48, 23), (12, 38)]
  for cursor in cursors {
    let expected = today(column: cursor.column, row: cursor.row)
    #expect(caret(.top, drawnRows: 24, column: cursor.column, row: cursor.row) == expected)
    #expect(caret(.top, drawnRows: 50, column: cursor.column, row: cursor.row) == expected)
    #expect(caret(.bottom, drawnRows: 39, column: cursor.column, row: cursor.row) == expected)
  }

  // `.bottom`: a prompt on the drawn grid's last row sits on the measured grid's
  // last row, whichever grid is drawn; the first row sits at the grid's top.
  let measuredLastRow = today(column: 4, row: 38)
  #expect(measuredLastRow.y == 783)
  #expect(caret(.bottom, drawnRows: 24, column: 4, row: 23) == measuredLastRow)
  #expect(caret(.bottom, drawnRows: 50, column: 4, row: 49) == measuredLastRow)
  #expect(caret(.bottom, drawnRows: 24, column: 0, row: 0).y == 346)
  #expect(caret(.bottom, drawnRows: 50, column: 0, row: 0).y == -148)
}

@Test func gridAlignmentMovesTheDrawingOrigin() {
  // The renderer draws from `gridOrigin` of the insets the view hands it — the
  // placement's. Before the alignment it drew from its padding plus the content
  // insets.
  let today = (
    x: GhostteaMetalRenderer.originX + phoneInsets.left,
    y: GhostteaMetalRenderer.originY + phoneInsets.top
  )
  for unaligned in [
    placement(.top, drawnRows: 24),
    placement(.top, drawnRows: 50),
    placement(.bottom, drawnRows: 39),
  ] {
    let origin = GhostteaTerminalLayout.gridOrigin(contentInsets: unaligned.insets)
    #expect(origin.x == today.x)
    #expect(origin.y == today.y)
  }

  // `.bottom` moves the drawing exactly as far as it moves every map: the
  // origin the renderer draws from is the top the maps read.
  let shorter = placement(.bottom, drawnRows: 24)
  let taller = placement(.bottom, drawnRows: 50)
  #expect(GhostteaTerminalLayout.gridOrigin(contentInsets: shorter.insets).y == 346)
  #expect(GhostteaTerminalLayout.gridOrigin(contentInsets: taller.insets).y == -148)
  for placed in [shorter, taller] {
    let origin = GhostteaTerminalLayout.gridOrigin(contentInsets: placed.insets)
    #expect(origin.x == today.x)
    #expect(origin.y == placed.top)
  }
}
