import GhosttyVt

public struct GhosttyVtState: Equatable, Sendable {
  public let columns: UInt16
  public let rows: UInt16
  public let cursorColumn: UInt16
  public let cursorRow: UInt16
  public let totalRows: Int
  public let scrollbackRows: Int
}

private final class ReplyCollector {
  var bytes: [UInt8] = []
}

private let collectTerminalReply: GhosttyTerminalWritePtyFn = {
  _, userdata, data, length in
  guard let userdata, let data, length > 0 else { return }
  let collector = Unmanaged<ReplyCollector>.fromOpaque(userdata).takeUnretainedValue()
  collector.bytes.append(contentsOf: UnsafeBufferPointer(start: data, count: length))
}

/// Temporary direct wrapper used only to prove the pinned Ghostty VT artifact.
/// Production application code must use the future GhostteaCoreFFI wrapper.
public final class GhosttyVtProofSession {
  private let terminal: GhosttyTerminal
  private let replyCollector: ReplyCollector

  public init(
    columns: UInt16,
    rows: UInt16,
    maxScrollbackBytes: Int
  ) throws {
    var handle: GhosttyTerminal?
    try ghosttyRequireSuccess(
      ghostty_terminal_new(nil, &handle, columns, rows),
      operation: "create terminal"
    )
    guard let handle else {
      throw GhosttyVtProofError.operationFailed("create terminal returned no handle")
    }

    let collector = ReplyCollector()
    do {
      var scrollbackBytes = maxScrollbackBytes
      try ghosttyRequireSuccess(
        ghostty_terminal_set(handle, GHOSTTY_TERMINAL_OPT_SCROLLBACK_MAX_BYTES, &scrollbackBytes),
        operation: "set scrollback limit"
      )
      try ghosttyRequireSuccess(
        ghostty_terminal_set(
          handle,
          GHOSTTY_TERMINAL_OPT_USERDATA,
          Unmanaged.passUnretained(collector).toOpaque()
        ),
        operation: "set terminal callback context"
      )
      try ghosttyRequireSuccess(
        ghostty_terminal_set(
          handle,
          GHOSTTY_TERMINAL_OPT_WRITE_PTY,
          unsafeBitCast(collectTerminalReply, to: UnsafeRawPointer.self)
        ),
        operation: "set terminal reply callback"
      )
    } catch {
      ghostty_terminal_free(handle)
      throw error
    }

    terminal = handle
    replyCollector = collector
  }

  deinit {
    ghostty_terminal_free(terminal)
  }

  public func feed(_ bytes: [UInt8]) {
    bytes.withUnsafeBufferPointer { buffer in
      ghostty_terminal_vt_write(terminal, buffer.baseAddress, buffer.count)
    }
  }

  public func resize(
    columns: UInt16,
    rows: UInt16,
    cellWidth: UInt32 = 8,
    cellHeight: UInt32 = 16
  ) throws {
    try ghosttyRequireSuccess(
      ghostty_terminal_resize(terminal, columns, rows, cellWidth, cellHeight),
      operation: "resize terminal"
    )
  }

  public func state() throws -> GhosttyVtState {
    var columns: UInt16 = 0
    var rows: UInt16 = 0
    var cursorColumn: UInt16 = 0
    var cursorRow: UInt16 = 0
    var totalRows = 0
    var scrollbackRows = 0

    try ghosttyRequireSuccess(
      ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_COLS, &columns),
      operation: "read columns"
    )
    try ghosttyRequireSuccess(
      ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_ROWS, &rows),
      operation: "read rows"
    )
    try ghosttyRequireSuccess(
      ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_CURSOR_X, &cursorColumn),
      operation: "read cursor column"
    )
    try ghosttyRequireSuccess(
      ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_CURSOR_Y, &cursorRow),
      operation: "read cursor row"
    )
    try ghosttyRequireSuccess(
      ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_TOTAL_ROWS, &totalRows),
      operation: "read total rows"
    )
    try ghosttyRequireSuccess(
      ghostty_terminal_get(terminal, GHOSTTY_TERMINAL_DATA_SCROLLBACK_ROWS, &scrollbackRows),
      operation: "read scrollback rows"
    )

    return GhosttyVtState(
      columns: columns,
      rows: rows,
      cursorColumn: cursorColumn,
      cursorRow: cursorRow,
      totalRows: totalRows,
      scrollbackRows: scrollbackRows
    )
  }

  public func plainText() throws -> [UInt8] {
    let screenExtra = GhosttyFormatterScreenExtra(
      size: MemoryLayout<GhosttyFormatterScreenExtra>.size,
      cursor: false,
      style: false,
      hyperlink: false,
      protection: false,
      kitty_keyboard: false,
      charsets: false
    )
    let terminalExtra = GhosttyFormatterTerminalExtra(
      size: MemoryLayout<GhosttyFormatterTerminalExtra>.size,
      palette: false,
      modes: false,
      scrolling_region: false,
      tabstops: false,
      pwd: false,
      keyboard: false,
      screen: screenExtra
    )
    let options = GhosttyFormatterTerminalOptions(
      size: MemoryLayout<GhosttyFormatterTerminalOptions>.size,
      emit: GHOSTTY_FORMATTER_FORMAT_PLAIN,
      unwrap: false,
      trim: true,
      extra: terminalExtra,
      selection: nil
    )
    var formatter: GhosttyFormatter?
    try ghosttyRequireSuccess(
      ghostty_formatter_terminal_new(nil, &formatter, terminal, options),
      operation: "create plain-text formatter"
    )
    guard let formatter else {
      throw GhosttyVtProofError.operationFailed("create formatter returned no handle")
    }
    defer { ghostty_formatter_free(formatter) }

    var required = 0
    let sizingResult = ghostty_formatter_format_buf(formatter, nil, 0, &required)
    guard sizingResult == GHOSTTY_OUT_OF_SPACE || (sizingResult == GHOSTTY_SUCCESS && required == 0)
    else {
      throw GhosttyVtProofError.operationFailed("size plain-text snapshot")
    }
    guard required > 0 else { return [] }

    var output = [UInt8](repeating: 0, count: required)
    var written = 0
    let result = output.withUnsafeMutableBufferPointer { buffer in
      ghostty_formatter_format_buf(formatter, buffer.baseAddress, buffer.count, &written)
    }
    try ghosttyRequireSuccess(result, operation: "format plain-text snapshot")
    return Array(output.prefix(written))
  }

  public var replyBytes: [UInt8] {
    replyCollector.bytes
  }

  @discardableResult
  public func compressScrollbackFull() throws -> Bool {
    var compressionResult = GHOSTTY_TERMINAL_COMPRESSION_RESULT_UNSUPPORTED
    try ghosttyRequireSuccess(
      ghostty_terminal_compress(
        terminal,
        GHOSTTY_TERMINAL_COMPRESSION_MODE_FULL,
        &compressionResult
      ),
      operation: "compress terminal scrollback"
    )
    return compressionResult != GHOSTTY_TERMINAL_COMPRESSION_RESULT_UNSUPPORTED
  }

  public func encodeKeyA() throws -> [UInt8] {
    var encoder: GhosttyKeyEncoder?
    try ghosttyRequireSuccess(
      ghostty_key_encoder_new(nil, &encoder),
      operation: "create key encoder"
    )
    guard let encoder else {
      throw GhosttyVtProofError.operationFailed("create key encoder returned no handle")
    }
    defer { ghostty_key_encoder_free(encoder) }

    var event: GhosttyKeyEvent?
    try ghosttyRequireSuccess(
      ghostty_key_event_new(nil, &event),
      operation: "create key event"
    )
    guard let event else {
      throw GhosttyVtProofError.operationFailed("create key event returned no handle")
    }
    defer { ghostty_key_event_free(event) }

    ghostty_key_encoder_setopt_from_terminal(encoder, terminal)
    ghostty_key_event_set_action(event, GHOSTTY_KEY_ACTION_PRESS)
    ghostty_key_event_set_key(event, GHOSTTY_KEY_A)
    let utf8: [CChar] = [97]
    utf8.withUnsafeBufferPointer { buffer in
      ghostty_key_event_set_utf8(event, buffer.baseAddress, buffer.count)
    }

    var output = [CChar](repeating: 0, count: 128)
    var outputLength = 0
    let result = output.withUnsafeMutableBufferPointer { buffer in
      ghostty_key_encoder_encode(
        encoder,
        event,
        buffer.baseAddress,
        buffer.count,
        &outputLength
      )
    }
    try ghosttyRequireSuccess(result, operation: "encode key")
    return output.prefix(outputLength).map { UInt8(bitPattern: $0) }
  }
}

func ghosttyRequireSuccess(
  _ result: GhosttyResult,
  operation: String
) throws {
  guard result == GHOSTTY_SUCCESS else {
    throw GhosttyVtProofError.operationFailed(operation)
  }
}
