import Foundation
import GhostteaCoreNative
import GhostteaFonts
import GhostteaPerformance

public enum GhostteaCoreError: Error, CustomStringConvertible, Sendable {
  case native(status: UInt32, message: String)
  case malformedUpdate(String)

  public var description: String {
    switch self {
    case .native(let status, let message): "Ghosttea native status \(status): \(message)"
    case .malformedUpdate(let message): "Malformed Ghosttea update: \(message)"
    }
  }
}

public struct GhostteaTextMetrics: Sendable {
  public var fontSizePixels: Float
  public var cellWidthPixels: Float
  public var lineHeightPixels: Float
  public var baselinePixels: Float
  public var rasterScale: Float

  public init(
    fontSizePixels: Float = 13,
    cellWidthPixels: Float = 7.83,
    lineHeightPixels: Float = 19,
    baselinePixels: Float = 14,
    rasterScale: Float = 2
  ) {
    self.fontSizePixels = fontSizePixels
    self.cellWidthPixels = cellWidthPixels
    self.lineHeightPixels = lineHeightPixels
    self.baselinePixels = baselinePixels
    self.rasterScale = rasterScale
  }
}

public final class GhostteaRuntime: @unchecked Sendable {
  fileprivate let handle: OpaquePointer

  public convenience init(metrics: GhostteaTextMetrics = .init()) throws {
    try self.init(fonts: GhostteaBundledFonts.load(), metrics: metrics)
  }

  public init(fonts: [GhostteaBundledFont], metrics: GhostteaTextMetrics) throws {
    let retained = fonts.map { $0.data as NSData }
    let descriptors = zip(fonts, retained).map { font, data in
      ghosttea_font_t(
        data: ghosttea_bytes_view_t(
          data: data.bytes.assumingMemoryBound(to: UInt8.self), len: data.length),
        face_index: font.faceIndex,
        role: font.role.rawValue
      )
    }
    var created: OpaquePointer?
    let status = descriptors.withUnsafeBufferPointer { buffer in
      var config = ghosttea_runtime_config_t(
        abi_version: GHOSTTEA_ABI_VERSION,
        struct_size: UInt32(MemoryLayout<ghosttea_runtime_config_t>.size),
        fonts: buffer.baseAddress,
        font_count: buffer.count,
        font_size_px: metrics.fontSizePixels,
        cell_width_px: metrics.cellWidthPixels,
        line_height_px: metrics.lineHeightPixels,
        baseline_px: metrics.baselinePixels,
        raster_scale: metrics.rasterScale
      )
      return ghosttea_runtime_create(&config, &created)
    }
    try check(status)
    guard let created else {
      throw GhostteaCoreError.malformedUpdate("runtime creation returned no handle")
    }
    handle = created
    _fixLifetime(retained)
  }

  deinit {
    ghosttea_runtime_destroy(handle)
  }

  public var isPoisoned: Bool {
    ghosttea_runtime_is_poisoned(handle)
  }
}

public struct GhostteaTerminalConfiguration: Sendable {
  public var sessionHandle: UInt64
  public var sessionEpoch: UInt64
  public var layoutEpoch: UInt64
  public var scrollbackBytes: UInt64
  public var columns: UInt16
  public var rows: UInt16

  public init(
    sessionHandle: UInt64,
    sessionEpoch: UInt64 = 1,
    layoutEpoch: UInt64 = 1,
    scrollbackBytes: UInt64 = 10_000_000,
    columns: UInt16 = 80,
    rows: UInt16 = 24
  ) {
    self.sessionHandle = sessionHandle
    self.sessionEpoch = sessionEpoch
    self.layoutEpoch = layoutEpoch
    self.scrollbackBytes = scrollbackBytes
    self.columns = columns
    self.rows = rows
  }
}

public enum GhostteaRenderRequest: UInt32, Sendable {
  case none = 0
  case damage = 1
  case full = 2
}

public enum GhostteaEffectKind: UInt32, Sendable {
  case writeToTransport = 1
  case metadataChangedJSON = 2
  case bell = 3
  case clipboardWrite = 4
  case frameReady = 5
  case logicalSnapshotJSON = 6
}

public final class GhostteaUpdateArena: @unchecked Sendable {
  private var update: ghosttea_update_t?

  fileprivate init(_ update: ghosttea_update_t) {
    self.update = update
  }

  deinit {
    if let update {
      ghosttea_update_destroy(update)
    }
  }

  fileprivate var count: Int { update?.storage.len ?? 0 }

  public func withUnsafeBytes<T>(
    offset: Int,
    count: Int,
    _ body: (UnsafeRawBufferPointer) throws -> T
  ) rethrows -> T {
    guard let storage = update?.storage.data else {
      return try body(UnsafeRawBufferPointer(start: nil, count: 0))
    }
    return try body(UnsafeRawBufferPointer(start: storage.advanced(by: offset), count: count))
  }

  fileprivate func copy(offset: Int, count: Int) -> Data {
    withUnsafeBytes(offset: offset, count: count) { Data($0) }
  }
}

public struct GhostteaOrderedEffect: Sendable {
  public let sequence: UInt32
  public let kind: GhostteaEffectKind
  public let payloadOffset: Int
  public let payloadLength: Int
  private let arena: GhostteaUpdateArena

  fileprivate init(
    sequence: UInt32,
    kind: GhostteaEffectKind,
    payloadOffset: Int,
    payloadLength: Int,
    arena: GhostteaUpdateArena
  ) {
    self.sequence = sequence
    self.kind = kind
    self.payloadOffset = payloadOffset
    self.payloadLength = payloadLength
    self.arena = arena
  }

  public var payload: Data {
    arena.copy(offset: payloadOffset, count: payloadLength)
  }

  public func withUnsafePayload<T>(
    _ body: (UnsafeRawBufferPointer) throws -> T
  ) rethrows -> T {
    try arena.withUnsafeBytes(offset: payloadOffset, count: payloadLength, body)
  }
}

public struct GhostteaUpdate: Sendable {
  public let effects: [GhostteaOrderedEffect]
}

public struct GhostteaKeyEvent: Sendable {
  public var code: String
  public var text: String
  public var unshiftedCodepoint: UInt32
  public var modifiers: UInt16
  public var action: UInt8
  /// `ghosttea_key_flag_t` bits. Zero, the default, keeps Option acting as Alt.
  public var flags: UInt8

  public init(
    code: String,
    text: String = "",
    unshiftedCodepoint: UInt32 = 0,
    modifiers: UInt16 = 0,
    action: UInt8 = 1,
    flags: UInt8 = 0
  ) {
    self.code = code
    self.text = text
    self.unshiftedCodepoint = unshiftedCodepoint
    self.modifiers = modifiers
    self.action = action
    self.flags = flags
  }
}

public struct GhostteaMouseEvent: Sendable {
  public var action: UInt8
  public var button: UInt8
  public var modifiers: UInt16
  public var x: Float
  public var y: Float
  public var screenWidth: UInt32
  public var screenHeight: UInt32
  public var cellWidth: UInt32
  public var cellHeight: UInt32
  public var paddingLeft: UInt32
  public var paddingTop: UInt32

  public init(
    action: UInt8,
    button: UInt8,
    modifiers: UInt16 = 0,
    x: Float,
    y: Float,
    screenWidth: UInt32,
    screenHeight: UInt32,
    cellWidth: UInt32,
    cellHeight: UInt32,
    paddingLeft: UInt32 = 0,
    paddingTop: UInt32 = 0
  ) {
    self.action = action
    self.button = button
    self.modifiers = modifiers
    self.x = x
    self.y = y
    self.screenWidth = screenWidth
    self.screenHeight = screenHeight
    self.cellWidth = cellWidth
    self.cellHeight = cellHeight
    self.paddingLeft = paddingLeft
    self.paddingTop = paddingTop
  }
}

public struct GhostteaTextEnginePerformanceSnapshot: Equatable, Sendable {
  public let sequence: UInt64
  public let acquisitionCount: UInt64
  public let waitNanoseconds: UInt64
  public let holdNanoseconds: UInt64

  fileprivate init(_ native: ghosttea_text_engine_performance_t) {
    sequence = native.sequence
    acquisitionCount = native.acquisition_count
    waitNanoseconds = native.wait_nanoseconds
    holdNanoseconds = native.hold_nanoseconds
  }
}

private final class GhostteaNativeTerminalHandle: @unchecked Sendable {
  let pointer: OpaquePointer

  init(_ pointer: OpaquePointer) {
    self.pointer = pointer
  }

  deinit {
    ghosttea_terminal_destroy(pointer)
  }
}

private final class GhostteaNativeReplicaHandle: @unchecked Sendable {
  let pointer: OpaquePointer

  init(_ pointer: OpaquePointer) {
    self.pointer = pointer
  }

  deinit {
    ghosttea_replica_destroy(pointer)
  }
}

public actor GhostteaTerminal {
  public let runtime: GhostteaRuntime
  private let nativeHandle: GhostteaNativeTerminalHandle
  private var lastTextEnginePerformanceSequence: UInt64 = 0
  private var handle: OpaquePointer { nativeHandle.pointer }

  public init(runtime: GhostteaRuntime, configuration: GhostteaTerminalConfiguration) throws {
    self.runtime = runtime
    var config = ghosttea_terminal_config_t(
      abi_version: GHOSTTEA_ABI_VERSION,
      struct_size: UInt32(MemoryLayout<ghosttea_terminal_config_t>.size),
      session_handle: configuration.sessionHandle,
      session_epoch: configuration.sessionEpoch,
      layout_epoch: configuration.layoutEpoch,
      scrollback_bytes: configuration.scrollbackBytes,
      cols: configuration.columns,
      rows: configuration.rows,
      reserved: 0
    )
    var created: OpaquePointer?
    try check(ghosttea_terminal_create(runtime.handle, &config, &created))
    guard let created else {
      throw GhostteaCoreError.malformedUpdate("terminal creation returned no handle")
    }
    nativeHandle = GhostteaNativeTerminalHandle(created)
  }

  public var isPoisoned: Bool {
    ghosttea_terminal_is_poisoned(handle)
  }

  public func textEnginePerformanceSnapshot() throws -> GhostteaTextEnginePerformanceSnapshot {
    var native = ghosttea_text_engine_performance_t(
      sequence: 0,
      acquisition_count: 0,
      wait_nanoseconds: 0,
      hold_nanoseconds: 0
    )
    try check(ghosttea_terminal_text_engine_performance(handle, &native))
    return GhostteaTextEnginePerformanceSnapshot(native)
  }

  public func feed(_ bytes: Data, render: GhostteaRenderRequest = .damage) throws -> GhostteaUpdate
  {
    try GhostteaPerformanceRecorder.shared.measure(.nativeFeed, byteCount: bytes.count) {
      try bytes.withUnsafeBytes { raw in
        let typed = raw.bindMemory(to: UInt8.self)
        return try performUpdate { output in
          ghosttea_terminal_feed(
            handle,
            ghosttea_bytes_view_t(data: typed.baseAddress, len: typed.count),
            render.rawValue,
            &output
          )
        }
      }
    }
  }

  public func refresh(_ render: GhostteaRenderRequest = .full) throws -> GhostteaUpdate {
    try performUpdate { output in
      ghosttea_terminal_refresh(handle, render.rawValue, &output)
    }
  }

  public func resize(
    columns: UInt16,
    rows: UInt16,
    layoutEpoch: UInt64,
    render: GhostteaRenderRequest = .full
  ) throws -> GhostteaUpdate {
    try performUpdate { output in
      ghosttea_terminal_resize(handle, columns, rows, layoutEpoch, render.rawValue, &output)
    }
  }

  public func setColors(
    foreground: (UInt8, UInt8, UInt8),
    background: (UInt8, UInt8, UInt8),
    cursor: (UInt8, UInt8, UInt8),
    render: GhostteaRenderRequest = .full
  ) throws -> GhostteaUpdate {
    let foreground = [foreground.0, foreground.1, foreground.2]
    let background = [background.0, background.1, background.2]
    let cursor = [cursor.0, cursor.1, cursor.2]
    return try foreground.withUnsafeBufferPointer { foreground in
      try background.withUnsafeBufferPointer { background in
        try cursor.withUnsafeBufferPointer { cursor in
          try performUpdate { output in
            ghosttea_terminal_set_colors(
              handle,
              foreground.baseAddress,
              background.baseAddress,
              cursor.baseAddress,
              render.rawValue,
              &output
            )
          }
        }
      }
    }
  }

  public func setAppearance(
    foreground: (UInt8, UInt8, UInt8),
    background: (UInt8, UInt8, UInt8),
    cursor: (UInt8, UInt8, UInt8),
    palette: [GhostteaPaletteConfigEntry],
    render: GhostteaRenderRequest = .full
  ) throws -> GhostteaUpdate {
    guard palette.count <= 256, palette.allSatisfy({ $0.color.count == 3 }) else {
      throw GhostteaCoreError.malformedUpdate(
        "configuration palette must contain at most 256 RGB entries")
    }
    let foreground = [foreground.0, foreground.1, foreground.2]
    let background = [background.0, background.1, background.2]
    let cursor = [cursor.0, cursor.1, cursor.2]
    let indices = palette.map(\.index)
    let colors = palette.flatMap(\.color)
    return try foreground.withUnsafeBufferPointer { foreground in
      try background.withUnsafeBufferPointer { background in
        try cursor.withUnsafeBufferPointer { cursor in
          try indices.withUnsafeBufferPointer { indices in
            try colors.withUnsafeBufferPointer { colors in
              try performUpdate { output in
                ghosttea_terminal_set_appearance(
                  handle,
                  foreground.baseAddress,
                  background.baseAddress,
                  cursor.baseAddress,
                  indices.baseAddress,
                  colors.baseAddress,
                  indices.count,
                  render.rawValue,
                  &output
                )
              }
            }
          }
        }
      }
    }
  }

  public func scroll(
    rows: Int64,
    render: GhostteaRenderRequest = .damage
  ) throws -> GhostteaUpdate {
    try performUpdate { output in
      ghosttea_terminal_scroll(handle, rows, render.rawValue, &output)
    }
  }

  public func scrollTo(
    row: UInt64,
    render: GhostteaRenderRequest = .damage
  ) throws -> GhostteaUpdate {
    try performUpdate { output in
      ghosttea_terminal_scroll_to(handle, row, render.rawValue, &output)
    }
  }

  /// Synchronously compresses eligible Ghostty scrollback without changing
  /// terminal contents. Hosts should call this only for inactive sessions.
  public func compressScrollbackFull() throws -> Bool {
    var supported = false
    try check(ghosttea_terminal_compress_scrollback_full(handle, &supported))
    return supported
  }

  public func encodePaste(_ text: String) throws -> Data {
    try withUTF8(text) { view in
      try performBytes { output in ghosttea_terminal_encode_paste(handle, view, &output) }
    }
  }

  public func encodeKey(_ event: GhostteaKeyEvent) throws -> Data {
    try withUTF8(event.code) { code in
      try withUTF8(event.text) { text in
        var native = ghosttea_key_event_t(
          abi_version: GHOSTTEA_ABI_VERSION,
          struct_size: UInt32(MemoryLayout<ghosttea_key_event_t>.size),
          code_utf8: code,
          text_utf8: text,
          unshifted_codepoint: event.unshiftedCodepoint,
          modifiers: event.modifiers,
          action: event.action,
          flags: event.flags
        )
        return try performBytes { output in ghosttea_terminal_encode_key(handle, &native, &output) }
      }
    }
  }

  public func encodeFocus(_ focused: Bool) throws -> Data {
    try performBytes { output in ghosttea_terminal_encode_focus(handle, focused, &output) }
  }

  public func encodeMouse(_ event: GhostteaMouseEvent) throws -> Data {
    var native = ghosttea_mouse_event_t(
      abi_version: GHOSTTEA_ABI_VERSION,
      struct_size: UInt32(MemoryLayout<ghosttea_mouse_event_t>.size),
      x: event.x,
      y: event.y,
      screen_width: event.screenWidth,
      screen_height: event.screenHeight,
      cell_width: event.cellWidth,
      cell_height: event.cellHeight,
      padding_left: event.paddingLeft,
      padding_top: event.paddingTop,
      modifiers: event.modifiers,
      action: event.action,
      button: event.button
    )
    return try performBytes { output in ghosttea_terminal_encode_mouse(handle, &native, &output) }
  }

  public var alternateScroll: Bool {
    get throws {
      var enabled = false
      try check(ghosttea_terminal_alternate_scroll(handle, &enabled))
      return enabled
    }
  }

  public func selectionText(
    startColumn: UInt16,
    startRow: UInt32,
    endColumn: UInt16,
    endRow: UInt32,
    selectAll: Bool = false
  ) throws -> String {
    let data = try selectionTextBytes(
      startColumn: startColumn,
      startRow: startRow,
      endColumn: endColumn,
      endRow: endRow,
      selectAll: selectAll)
    guard let text = String(data: data, encoding: .utf8) else {
      throw GhostteaCoreError.malformedUpdate("selection text is not UTF-8")
    }
    return text
  }

  /// UTF-8 selection bytes for strict-concurrency clients that decode the
  /// value after it crosses the terminal actor boundary.
  public func selectionTextBytes(
    startColumn: UInt16,
    startRow: UInt32,
    endColumn: UInt16,
    endRow: UInt32,
    selectAll: Bool = false
  ) throws -> Data {
    try performBytes { output in
      ghosttea_terminal_selection_text(
        handle, startColumn, startRow, endColumn, endRow, selectAll, &output)
    }
  }

  public func accessibilityRows(start: UInt16, count: UInt16) throws -> Data {
    try performBytes { output in
      ghosttea_terminal_accessibility_rows(handle, start, count, &output)
    }
  }

  private func performUpdate(
    _ operation: (inout ghosttea_update_t) -> ghosttea_status_t
  ) throws -> GhostteaUpdate {
    var native = ghosttea_update_t(
      storage: ghosttea_owned_bytes_t(data: nil, len: 0, capacity: 0),
      effects: nil,
      effect_count: 0
    )
    let status = operation(&native)
    guard status == GHOSTTEA_STATUS_OK else {
      ghosttea_update_destroy(native)
      try check(status)
      fatalError("unreachable")
    }
    let update = try decodeUpdate(native)
    recordTextEnginePerformance()
    return update
  }

  private func recordTextEnginePerformance() {
    let recorder = GhostteaPerformanceRecorder.shared
    guard recorder.isEnabled else { return }
    var native = ghosttea_text_engine_performance_t(
      sequence: 0,
      acquisition_count: 0,
      wait_nanoseconds: 0,
      hold_nanoseconds: 0
    )
    guard ghosttea_terminal_text_engine_performance(handle, &native) == GHOSTTEA_STATUS_OK,
      native.sequence != 0,
      native.sequence != lastTextEnginePerformanceSequence
    else { return }
    lastTextEnginePerformanceSequence = native.sequence
    recorder.record(.textEngineLockWait, durationNanoseconds: native.wait_nanoseconds)
    recorder.record(.textEngineLockHold, durationNanoseconds: native.hold_nanoseconds)
  }

  private func performBytes(
    _ operation: (inout ghosttea_owned_bytes_t) -> ghosttea_status_t
  ) throws -> Data {
    var output = ghosttea_owned_bytes_t(data: nil, len: 0, capacity: 0)
    let status = operation(&output)
    guard status == GHOSTTEA_STATUS_OK else {
      ghosttea_owned_bytes_free(output)
      try check(status)
      fatalError("unreachable")
    }
    defer { ghosttea_owned_bytes_free(output) }
    guard let data = output.data else { return Data() }
    return Data(bytes: data, count: output.len)
  }
}

/// Renders logical state received from an authoritative remote Ghosttea
/// session into the same TRF1 frames used by a local terminal. The caller owns
/// snapshot-gap recovery; a rejected patch must be followed by a full snapshot.
public actor GhostteaLogicalReplica {
  public private(set) var runtime: GhostteaRuntime
  private let nativeHandle: GhostteaNativeReplicaHandle
  private var lastTextEnginePerformanceSequence: UInt64 = 0
  private var handle: OpaquePointer { nativeHandle.pointer }

  public init(
    runtime: GhostteaRuntime,
    sessionHandle: UInt64,
    palette: [GhostteaPaletteConfigEntry] = []
  ) throws {
    self.runtime = runtime
    var created: OpaquePointer?
    try check(ghosttea_replica_create(runtime.handle, sessionHandle, &created))
    guard let created else {
      throw GhostteaCoreError.malformedUpdate("replica creation returned no handle")
    }
    nativeHandle = GhostteaNativeReplicaHandle(created)
    if !palette.isEmpty {
      _ = try Self.performReconfiguration(
        handle: created, runtime: nil, palette: palette)
    }
  }

  public var isPoisoned: Bool {
    ghosttea_replica_is_poisoned(handle)
  }

  public func textEnginePerformanceSnapshot() throws -> GhostteaTextEnginePerformanceSnapshot {
    var native = ghosttea_text_engine_performance_t(
      sequence: 0,
      acquisition_count: 0,
      wait_nanoseconds: 0,
      hold_nanoseconds: 0
    )
    try check(ghosttea_replica_text_engine_performance(handle, &native))
    return GhostteaTextEnginePerformanceSnapshot(native)
  }

  public func publishSnapshotJSON(_ snapshot: Data) throws -> GhostteaUpdate {
    try publish(snapshot, using: ghosttea_replica_publish_snapshot_json)
  }

  public func publishPatchJSON(_ patch: Data) throws -> GhostteaUpdate {
    try publish(patch, using: ghosttea_replica_publish_patch_json)
  }

  public func publishSelection(
    anchorColumn: UInt16,
    anchorRow: UInt32,
    focusColumn: UInt16,
    focusRow: UInt32
  ) throws -> GhostteaUpdate {
    try performUpdate { output in
      ghosttea_replica_publish_selection(
        handle, true, anchorColumn, anchorRow, focusColumn, focusRow, &output)
    }
  }

  public func clearSelection() throws -> GhostteaUpdate {
    try performUpdate { output in
      ghosttea_replica_publish_selection(handle, false, 0, 0, 0, 0, &output)
    }
  }

  /// Applies local presentation resources without replacing logical state.
  /// A nil runtime is the recolor-only path and never acquires the text engine.
  public func reconfigure(
    runtime nextRuntime: GhostteaRuntime? = nil,
    palette: [GhostteaPaletteConfigEntry]
  ) throws -> GhostteaUpdate {
    let update = try reconfigureNative(runtime: nextRuntime, palette: palette)
    if let nextRuntime { runtime = nextRuntime }
    return update
  }

  public func refresh() throws -> GhostteaUpdate {
    try performUpdate { output in ghosttea_replica_refresh(handle, &output) }
  }

  private func reconfigureNative(
    runtime: GhostteaRuntime?,
    palette: [GhostteaPaletteConfigEntry]
  ) throws -> GhostteaUpdate {
    let update = try Self.performReconfiguration(
      handle: handle, runtime: runtime, palette: palette)
    recordTextEnginePerformance()
    return update
  }

  /// Actor initializers cannot call an isolated instance method. Keeping the
  /// raw ABI operation stateless also makes that initialization path identical
  /// to later reconfiguration without weakening actor isolation.
  nonisolated private static func performReconfiguration(
    handle: OpaquePointer,
    runtime: GhostteaRuntime?,
    palette: [GhostteaPaletteConfigEntry]
  ) throws -> GhostteaUpdate {
    let nativePalette = try palette.map { entry in
      guard entry.color.count == 3 else {
        throw GhostteaCoreError.malformedUpdate("palette color must contain exactly three bytes")
      }
      return ghosttea_palette_entry_t(
        index: entry.index,
        red: entry.color[0],
        green: entry.color[1],
        blue: entry.color[2]
      )
    }
    return try nativePalette.withUnsafeBufferPointer { palette in
      var output = ghosttea_update_t(
        storage: ghosttea_owned_bytes_t(data: nil, len: 0, capacity: 0),
        effects: nil,
        effect_count: 0
      )
      let status =
        ghosttea_replica_reconfigure(
          handle,
          runtime?.handle,
          palette.baseAddress,
          palette.count,
          &output
        )
      guard status == GHOSTTEA_STATUS_OK else {
        ghosttea_update_destroy(output)
        try check(status)
        fatalError("unreachable")
      }
      return try decodeUpdate(output)
    }
  }

  private func publish(
    _ json: Data,
    using operation: (
      OpaquePointer?, ghosttea_bytes_view_t, UnsafeMutablePointer<ghosttea_update_t>?
    ) -> ghosttea_status_t
  ) throws -> GhostteaUpdate {
    try json.withUnsafeBytes { raw in
      let bytes = raw.bindMemory(to: UInt8.self)
      return try performUpdate { output in
        operation(
          handle,
          ghosttea_bytes_view_t(data: bytes.baseAddress, len: bytes.count),
          &output
        )
      }
    }
  }

  private func performUpdate(
    _ operation: (inout ghosttea_update_t) -> ghosttea_status_t
  ) throws -> GhostteaUpdate {
    var native = ghosttea_update_t(
      storage: ghosttea_owned_bytes_t(data: nil, len: 0, capacity: 0),
      effects: nil,
      effect_count: 0
    )
    let status = operation(&native)
    guard status == GHOSTTEA_STATUS_OK else {
      ghosttea_update_destroy(native)
      try check(status)
      fatalError("unreachable")
    }
    let update = try decodeUpdate(native)
    recordTextEnginePerformance()
    return update
  }

  private func recordTextEnginePerformance() {
    let recorder = GhostteaPerformanceRecorder.shared
    guard recorder.isEnabled else { return }
    var native = ghosttea_text_engine_performance_t(
      sequence: 0,
      acquisition_count: 0,
      wait_nanoseconds: 0,
      hold_nanoseconds: 0
    )
    guard ghosttea_replica_text_engine_performance(handle, &native) == GHOSTTEA_STATUS_OK,
      native.sequence != 0,
      native.sequence != lastTextEnginePerformanceSequence
    else { return }
    lastTextEnginePerformanceSequence = native.sequence
    recorder.record(.textEngineLockWait, durationNanoseconds: native.wait_nanoseconds)
    recorder.record(.textEngineLockHold, durationNanoseconds: native.hold_nanoseconds)
  }
}

private func decodeUpdate(_ native: ghosttea_update_t) throws -> GhostteaUpdate {
  let arena = GhostteaUpdateArena(native)
  guard native.effect_count == 0 || native.effects != nil else {
    throw GhostteaCoreError.malformedUpdate("effect table is null")
  }
  let descriptors =
    native.effect_count == 0
    ? []
    : Array(UnsafeBufferPointer(start: native.effects, count: native.effect_count))
  let effects = try descriptors.enumerated().map { index, descriptor in
    guard descriptor.sequence == UInt32(index),
      let kind = GhostteaEffectKind(rawValue: descriptor.kind)
    else {
      throw GhostteaCoreError.malformedUpdate("invalid ordered effect descriptor")
    }
    let offset = Int(descriptor.payload_offset)
    let length = Int(descriptor.payload_length)
    guard offset <= arena.count, length <= arena.count - offset else {
      throw GhostteaCoreError.malformedUpdate("effect payload is outside its arena")
    }
    return GhostteaOrderedEffect(
      sequence: descriptor.sequence,
      kind: kind,
      payloadOffset: offset,
      payloadLength: length,
      arena: arena
    )
  }
  return GhostteaUpdate(effects: effects)
}

func withUTF8<T>(
  _ string: String,
  _ body: (ghosttea_bytes_view_t) throws -> T
) rethrows -> T {
  try Data(string.utf8).withUnsafeBytes { raw in
    let typed = raw.bindMemory(to: UInt8.self)
    return try body(ghosttea_bytes_view_t(data: typed.baseAddress, len: typed.count))
  }
}

func check(_ status: ghosttea_status_t) throws {
  guard status == GHOSTTEA_STATUS_OK else {
    let message = ghosttea_last_error_message().map(String.init(cString:)) ?? "unknown native error"
    throw GhostteaCoreError.native(status: status.rawValue, message: message)
  }
}
