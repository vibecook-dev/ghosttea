import Foundation
import GhostteaFrame
import GhostteaPerformance
import Metal

struct GhostteaMetalColor: Equatable, Sendable {
  let red: Float
  let green: Float
  let blue: Float
  let alpha: Float

  static let clear = Self(red: 0, green: 0, blue: 0, alpha: 0)

  var components: [Float] { [red, green, blue, alpha] }

  func withAlpha(_ alpha: Float) -> Self {
    Self(red: red, green: green, blue: blue, alpha: alpha)
  }
}

struct GhostteaMetalTheme: Equatable, Sendable {
  var background = GhostteaMetalColor(red: 40 / 255, green: 44 / 255, blue: 52 / 255, alpha: 1)
  var foreground = GhostteaMetalColor(red: 1, green: 1, blue: 1, alpha: 1)
  var cursor = GhostteaMetalColor(red: 1, green: 1, blue: 1, alpha: 1)
  var cursorText = GhostteaMetalColor(red: 40 / 255, green: 44 / 255, blue: 52 / 255, alpha: 1)
  var selection = GhostteaMetalColor(red: 1, green: 1, blue: 1, alpha: 1)
  var selectionForeground = GhostteaMetalColor(
    red: 40 / 255, green: 44 / 255, blue: 52 / 255, alpha: 1)
  var backgroundOpacityCells = false
  var shaderEffects: [GhostteaMetalShaderEffect] = []
  var shaderAnimation = false
  /// Restyle panes a dark-painted application fills under a light theme
  /// (`ghosttea-light-adaptation = auto`).
  var lightAdaptation = false
  /// WCAG ratio text keeps against its cell background (`minimum-contrast`, 1 = off).
  var minimumContrast: Float = 1
}

enum GhostteaMetalShaderEffect: UInt32, CaseIterable, Equatable, Sendable {
  case betterCRT = 1
  case crt = 2
  case vhs = 3
  case sparksFromFire = 4

  init?(configurationID: String) {
    switch configurationID {
    case "ghosttea:better-crt": self = .betterCRT
    case "ghosttea:crt": self = .crt
    case "ghosttea:vhs": self = .vhs
    case "ghosttea:sparks-from-fire": self = .sparksFromFire
    default: return nil
    }
  }

  var isAnimated: Bool {
    self == .vhs || self == .sparksFromFire
  }
}

struct GhostteaMetalCellPoint: Equatable, Sendable {
  let column: UInt16
  let row: UInt16
}

struct GhostteaMetalSelection: Equatable, Sendable {
  let anchor: GhostteaMetalCellPoint
  let focus: GhostteaMetalCellPoint
}

struct GhostteaTerminalDamageFlags: OptionSet, Equatable, Sendable {
  let rawValue: UInt8

  static let full = Self(rawValue: 1 << 0)
  static let cursor = Self(rawValue: 1 << 1)
  static let selection = Self(rawValue: 1 << 2)
  static let geometry = Self(rawValue: 1 << 3)
  static let atlas = Self(rawValue: 1 << 4)
}

struct GhostteaTerminalRenderDamage: Equatable, Sendable {
  var flags: GhostteaTerminalDamageFlags = []
  var rows: Set<UInt16> = []

  static let full = Self(flags: [.full])
  static let cursor = Self(flags: [.cursor])
  static let selection = Self(flags: [.selection])
  static let geometry = Self(flags: [.geometry])
  static let atlas = Self(flags: [.atlas])

  static func rows(_ rows: some Sequence<UInt16>) -> Self {
    Self(rows: Set(rows))
  }

  var isEmpty: Bool { flags.isEmpty && rows.isEmpty }

  mutating func formUnion(_ other: Self) {
    flags.formUnion(other.flags)
    rows.formUnion(other.rows)
  }
}

struct GhostteaMetalRenderResult: Equatable, Sendable {
  let width: Int
  let height: Int
  let rectangleVertexCount: Int
  let alphaGlyphVertexCount: Int
  let colorGlyphVertexCount: Int
  let nonBackgroundPixelCount: Int
  let pixelHash: UInt64
  let visualFingerprint: GhostteaVisualFingerprint
  let atlasUpload: GhostteaMetalUploadResult
  let vertexUploadBytes: Int
  let bufferAllocationCount: Int
  let rowCacheHits: Int
  let rowCacheAdmissions: Int
  let rowCacheEvictions: Int
  let residentBytes: Int
}

struct GhostteaMetalDrawResult: Equatable, Sendable {
  let rectangleVertexCount: Int
  let alphaGlyphVertexCount: Int
  let colorGlyphVertexCount: Int
  let atlasUpload: GhostteaMetalUploadResult
  let vertexUploadBytes: Int
  let bufferAllocationCount: Int
  let drawCallCount: Int
  let commandBufferCount: Int
  let damage: GhostteaTerminalRenderDamage
  let rowCacheHits: Int
  let rowCacheAdmissions: Int
  let rowCacheEvictions: Int
}

private struct GhostteaResolvedMetalStyle {
  let foreground: GhostteaMetalColor
  let background: GhostteaMetalColor?
  /// Foreground used as an area fill (block elements); differs only under light adaptation.
  let fill: GhostteaMetalColor
  /// Foreground for text glyphs and their decorations, after `minimum-contrast`.
  let text: GhostteaMetalColor
  let underline: Bool
  let strikethrough: Bool
  let invisible: Bool
}

private struct GhostteaMetalMesh {
  var backgrounds: [GhostteaMetalRectangleInstance] = []
  var selection: [GhostteaMetalRectangleInstance] = []
  var cursorBackground: [GhostteaMetalRectangleInstance] = []
  var alphaGlyphs: [GhostteaMetalGlyphInstance] = []
  var colorGlyphs: [GhostteaMetalGlyphInstance] = []
  var decorations: [GhostteaMetalRectangleInstance] = []
  var cursorAlphaGlyphs: [GhostteaMetalGlyphInstance] = []
  var cursorColorGlyphs: [GhostteaMetalGlyphInstance] = []
  var cursorDecorations: [GhostteaMetalRectangleInstance] = []
  var cursor: [GhostteaMetalRectangleInstance] = []
}

private struct GhostteaMetalRowMesh {
  var backgrounds: [GhostteaMetalRectangleInstance] = []
  var alphaGlyphs: [GhostteaMetalGlyphInstance] = []
  var colorGlyphs: [GhostteaMetalGlyphInstance] = []
  var decorations: [GhostteaMetalRectangleInstance] = []
  var cursorAlphaGlyphs: [GhostteaMetalGlyphInstance] = []
  var cursorColorGlyphs: [GhostteaMetalGlyphInstance] = []
  var cursorDecorations: [GhostteaMetalRectangleInstance] = []

  var residentBytes: Int {
    backgrounds.count * MemoryLayout<GhostteaMetalRectangleInstance>.stride
      + alphaGlyphs.count * MemoryLayout<GhostteaMetalGlyphInstance>.stride
      + colorGlyphs.count * MemoryLayout<GhostteaMetalGlyphInstance>.stride
      + decorations.count * MemoryLayout<GhostteaMetalRectangleInstance>.stride
      + cursorAlphaGlyphs.count * MemoryLayout<GhostteaMetalGlyphInstance>.stride
      + cursorColorGlyphs.count * MemoryLayout<GhostteaMetalGlyphInstance>.stride
      + cursorDecorations.count * MemoryLayout<GhostteaMetalRectangleInstance>.stride
  }
}

private struct GhostteaMetalRowCacheContext: Equatable {
  let sessionHandle: UInt64
  let sessionEpoch: UInt64
  let layoutEpoch: UInt64
  let width: Int
  let height: Int
  let scale: Float
  let theme: GhostteaMetalTheme
  let contentInsets: GhostteaTerminalContentInsets
  let selection: GhostteaMetalSelection?
  let lightAdaptationKey: String?
  let alphaAtlasResetCount: Int
  let colorAtlasResetCount: Int
}

private struct GhostteaMetalRowCacheEntry {
  let revision: UInt64
  let blockCursorColumn: UInt16?
  let mesh: GhostteaMetalRowMesh
}

private struct GhostteaMetalRowCacheActivity {
  var hits = 0
  var admissions = 0
  var evictions = 0
}

private struct GhostteaMetalRectangleInstance {
  let bounds: SIMD4<Float>
  let color: SIMD4<Float>
}

private struct GhostteaMetalGlyphInstance {
  let bounds: SIMD4<Float>
  let uvBounds: SIMD4<Float>
  let color: SIMD4<Float>
}

private struct GhostteaMetalEffectUniforms {
  let mode: UInt32
  let frame: UInt32
  let effectIndex: UInt32
  let effectCount: UInt32
  let resolution: SIMD2<Float>
  let time: Float
  let timeDelta: Float
  let cursor: SIMD4<Float>
}

private struct GhostteaMetalGeometryKey: Equatable {
  let sessionHandle: UInt64
  let sessionEpoch: UInt64
  let layoutEpoch: UInt64
  let frameSequence: UInt64
  let width: Int
  let height: Int
  let scale: Float
  let theme: GhostteaMetalTheme
  let contentInsets: GhostteaTerminalContentInsets
  let selection: GhostteaMetalSelection?
  let focused: Bool
  let lightAdaptationKey: String?
  let alphaAtlasResetCount: Int
  let colorAtlasResetCount: Int
}

private struct GhostteaMetalBufferSlice {
  let buffer: any MTLBuffer
  let offset: Int
  let vertexCount: Int
  let instanceCount: Int
}

private struct GhostteaMetalEncodedMesh {
  let backgrounds: GhostteaMetalBufferSlice?
  let selection: GhostteaMetalBufferSlice?
  let cursorBackground: GhostteaMetalBufferSlice?
  let alphaGlyphs: GhostteaMetalBufferSlice?
  let colorGlyphs: GhostteaMetalBufferSlice?
  let decorations: GhostteaMetalBufferSlice?
  let cursorAlphaGlyphs: GhostteaMetalBufferSlice?
  let cursorColorGlyphs: GhostteaMetalBufferSlice?
  let cursorDecorations: GhostteaMetalBufferSlice?
  let cursor: GhostteaMetalBufferSlice?
  let rectangleVertexCount: Int
  let alphaGlyphVertexCount: Int
  let colorGlyphVertexCount: Int
  let uploadedBytes: Int
  let allocationCount: Int
  let instanced: Bool
  let uploadLease: GhostteaMetalUploadLease?

  var populatedSliceCount: Int {
    [
      backgrounds, selection, cursorBackground, alphaGlyphs, colorGlyphs, decorations,
      cursorAlphaGlyphs, cursorColorGlyphs, cursorDecorations, cursor,
    ].compactMap { $0 }.count
  }

  func drawCallCount(showCursor: Bool) -> Int {
    populatedSliceCount
      - (!showCursor && cursor != nil ? 1 : 0)
      - (!showCursor && cursorBackground != nil ? 1 : 0)
      - (!showCursor && cursorAlphaGlyphs != nil ? 1 : 0)
      - (!showCursor && cursorColorGlyphs != nil ? 1 : 0)
      - (!showCursor && cursorDecorations != nil ? 1 : 0)
  }

  func rectangleVertexCount(showCursor: Bool) -> Int {
    rectangleVertexCount
      - (!showCursor ? cursor?.vertexCount ?? 0 : 0)
      - (!showCursor ? cursorBackground?.vertexCount ?? 0 : 0)
      - (!showCursor ? cursorDecorations?.vertexCount ?? 0 : 0)
  }

  func alphaGlyphVertexCount(showCursor: Bool) -> Int {
    alphaGlyphVertexCount - (!showCursor ? cursorAlphaGlyphs?.vertexCount ?? 0 : 0)
  }

  func colorGlyphVertexCount(showCursor: Bool) -> Int {
    colorGlyphVertexCount - (!showCursor ? cursorColorGlyphs?.vertexCount ?? 0 : 0)
  }
}

private final class GhostteaMetalUploadLease: @unchecked Sendable {
  private let lock = NSLock()
  private var releaseAction: (() -> Void)?

  init(release: @escaping () -> Void) {
    releaseAction = release
  }

  func release() {
    lock.lock()
    let action = releaseAction
    releaseAction = nil
    lock.unlock()
    action?()
  }

  deinit { release() }
}

private final class GhostteaMetalUploadArena {
  private final class Slot: @unchecked Sendable {
    let available = DispatchSemaphore(value: 1)
    var buffer: (any MTLBuffer)?
    var capacity = 0
  }

  struct Allocation {
    let buffer: any MTLBuffer
    let allocationCount: Int
    let lease: GhostteaMetalUploadLease
  }

  private static let slotCount = 3
  private static let maximumSlotBytes = 8 * 1024 * 1024
  private let device: any MTLDevice
  private let slots: [Slot]
  private let slotSelectionLock = NSLock()
  private var nextSlot = 0

  init(device: any MTLDevice) {
    self.device = device
    slots = (0..<Self.slotCount).map { _ in Slot() }
  }

  var residentBytes: Int { slots.reduce(0) { $0 + $1.capacity } }

  func acquire(minimumBytes: Int) throws -> Allocation {
    guard minimumBytes > 0, minimumBytes <= Self.maximumSlotBytes else {
      throw GhostteaMetalError.bufferUnavailable("bounded upload arena")
    }
    slotSelectionLock.lock()
    let slot = slots[nextSlot]
    nextSlot = (nextSlot + 1) % slots.count
    slotSelectionLock.unlock()
    slot.available.wait()
    var allocationCount = 0
    if slot.buffer == nil || slot.capacity < minimumBytes {
      let capacity = min(Self.maximumSlotBytes, roundedCapacity(minimumBytes))
      guard
        let buffer = device.makeBuffer(length: capacity, options: .storageModeShared)
      else {
        slot.available.signal()
        throw GhostteaMetalError.bufferUnavailable("upload arena slot")
      }
      buffer.label = "Ghosttea upload arena"
      slot.buffer = buffer
      slot.capacity = capacity
      allocationCount = 1
    }
    guard let buffer = slot.buffer else {
      slot.available.signal()
      throw GhostteaMetalError.bufferUnavailable("upload arena slot")
    }
    return Allocation(
      buffer: buffer,
      allocationCount: allocationCount,
      lease: GhostteaMetalUploadLease { slot.available.signal() }
    )
  }

  private func roundedCapacity(_ minimumBytes: Int) -> Int {
    var capacity = 64 * 1024
    while capacity < minimumBytes { capacity *= 2 }
    return capacity
  }
}

private final class GhostteaMetalUploadArenaPool: @unchecked Sendable {
  static let shared = GhostteaMetalUploadArenaPool()

  private let lock = NSLock()
  private weak var arena: GhostteaMetalUploadArena?

  func arena(for device: any MTLDevice) -> GhostteaMetalUploadArena {
    lock.lock()
    defer { lock.unlock() }
    if let arena { return arena }
    let arena = GhostteaMetalUploadArena(device: device)
    self.arena = arena
    return arena
  }
}

private struct GhostteaMetalGeometryCache {
  let key: GhostteaMetalGeometryKey
  let mesh: GhostteaMetalEncodedMesh
}

final class GhostteaMetalRenderer {
  static let originX = GhostteaTerminalLayout.horizontalPadding
  static let originY = GhostteaTerminalLayout.verticalPadding

  let runtime: GhostteaMetalRuntime
  let atlases: GhostteaMetalAtlasSet
  let shaderFunctionNames: Set<String>
  let cellWidth: Float
  let lineHeight: Float
  private let rectanglePipeline: any MTLRenderPipelineState
  private let alphaGlyphPipeline: any MTLRenderPipelineState
  private let colorGlyphPipeline: any MTLRenderPipelineState
  private let instancedRectanglePipeline: any MTLRenderPipelineState
  private let instancedAlphaGlyphPipeline: any MTLRenderPipelineState
  private let instancedColorGlyphPipeline: any MTLRenderPipelineState
  private let effectPipeline: any MTLRenderPipelineState
  private let sampler: any MTLSamplerState
  private let encodedGeometryReuseEnabled: Bool
  private let instancedSubmissionEnabled: Bool
  private let rowGeometryReuseEnabled: Bool
  private let uploadArena: GhostteaMetalUploadArena
  private var geometryCache: GhostteaMetalGeometryCache?
  private var pendingGeometryKey: GhostteaMetalGeometryKey?
  private var rowCacheContext: GhostteaMetalRowCacheContext?
  private var rowCache: [Int: GhostteaMetalRowCacheEntry] = [:]
  private var pendingRowRevisions: [Int: UInt64] = [:]
  private var rowCacheBytes = 0
  private var lightRemap: GhostteaLightRemap?
  private var lightRemaps: [String: GhostteaLightRemap] = [:]
  private var lightRemapOrder: [String] = []
  private var effectSceneTexture: (any MTLTexture)?
  private var effectIntermediateTextures: [any MTLTexture] = []
  private var effectTextureSize = SIMD2<Int>(repeating: 0)
  private var effectSignature = ""
  private var effectAnimationEnabled = false
  private var effectSceneValid = false
  private var effectFrame: UInt32 = 0
  private var effectStartTime: TimeInterval?
  private var lastEffectTime: Float = 0

  init(
    runtime: GhostteaMetalRuntime,
    alphaAtlasSize: Int = 2048,
    colorAtlasSize: Int = 2048,
    cellWidth: Float = GhostteaTerminalLayout.cellWidth,
    lineHeight: Float = GhostteaTerminalLayout.lineHeight,
    encodedGeometryReuseEnabled: Bool = true,
    instancedSubmissionEnabled: Bool = true,
    rowGeometryReuseEnabled: Bool = true,
    lazyColorAtlasEnabled: Bool = true
  ) throws {
    guard cellWidth.isFinite, cellWidth > 0, lineHeight.isFinite, lineHeight > 0 else {
      throw GhostteaMetalError.invalidTextMetrics(
        cellWidth: cellWidth,
        lineHeight: lineHeight
      )
    }
    self.runtime = runtime
    self.cellWidth = cellWidth
    self.lineHeight = lineHeight
    self.encodedGeometryReuseEnabled = encodedGeometryReuseEnabled
    self.instancedSubmissionEnabled = instancedSubmissionEnabled
    self.rowGeometryReuseEnabled = rowGeometryReuseEnabled
    uploadArena = GhostteaMetalUploadArenaPool.shared.arena(for: runtime.device)
    atlases = try GhostteaMetalAtlasSet(
      runtime: runtime,
      alphaSize: alphaAtlasSize,
      colorSize: colorAtlasSize,
      lazyColor: lazyColorAtlasEnabled
    )
    let library: any MTLLibrary
    do {
      guard
        let libraryURL = Bundle.module.url(
          forResource: "GhostteaTerminal",
          withExtension: "metallib"
        )
      else {
        throw GhostteaMetalError.shaderUnavailable("packaged GhostteaTerminal.metallib")
      }
      library = try runtime.device.makeLibrary(URL: libraryURL)
    } catch {
      throw GhostteaMetalError.shaderUnavailable("packaged Metal library")
    }
    shaderFunctionNames = Set(library.functionNames)
    rectanglePipeline = try Self.makeRectanglePipeline(runtime: runtime, library: library)
    alphaGlyphPipeline = try Self.makeGlyphPipeline(
      runtime: runtime,
      library: library,
      fragment: "ghosttea_alpha_glyph_fragment",
      label: "Ghosttea alpha glyph pipeline"
    )
    colorGlyphPipeline = try Self.makeGlyphPipeline(
      runtime: runtime,
      library: library,
      fragment: "ghosttea_color_glyph_fragment",
      label: "Ghosttea color glyph pipeline"
    )
    instancedRectanglePipeline = try Self.makeInstancedRectanglePipeline(
      runtime: runtime,
      library: library
    )
    instancedAlphaGlyphPipeline = try Self.makeInstancedGlyphPipeline(
      runtime: runtime,
      library: library,
      fragment: "ghosttea_alpha_glyph_fragment",
      label: "Ghosttea instanced alpha glyph pipeline"
    )
    instancedColorGlyphPipeline = try Self.makeInstancedGlyphPipeline(
      runtime: runtime,
      library: library,
      fragment: "ghosttea_color_glyph_fragment",
      label: "Ghosttea instanced color glyph pipeline"
    )
    effectPipeline = try Self.makeEffectPipeline(runtime: runtime, library: library)
    let samplerDescriptor = MTLSamplerDescriptor()
    samplerDescriptor.minFilter = .linear
    samplerDescriptor.magFilter = .linear
    samplerDescriptor.sAddressMode = .clampToEdge
    samplerDescriptor.tAddressMode = .clampToEdge
    guard let sampler = runtime.device.makeSamplerState(descriptor: samplerDescriptor) else {
      throw GhostteaMetalError.shaderUnavailable("glyph atlas sampler")
    }
    self.sampler = sampler
  }

  func render(
    state: RetainedTRF1State,
    width: Int,
    height: Int,
    scale: Float = 1,
    theme: GhostteaMetalTheme = GhostteaMetalTheme(),
    contentInsets: GhostteaTerminalContentInsets = .zero,
    selection: GhostteaMetalSelection? = nil,
    focused: Bool = true,
    cursorBlinkVisible: Bool = true,
    damage: GhostteaTerminalRenderDamage = .full
  ) throws -> GhostteaMetalRenderResult {
    let textureDescriptor = MTLTextureDescriptor.texture2DDescriptor(
      pixelFormat: .rgba8Unorm,
      width: width,
      height: height,
      mipmapped: false
    )
    textureDescriptor.storageMode = .shared
    textureDescriptor.usage = [.renderTarget]
    guard let target = runtime.device.makeTexture(descriptor: textureDescriptor) else {
      throw GhostteaMetalError.renderTargetUnavailable
    }
    target.label = "Ghosttea offscreen terminal target"
    let draw = try render(
      state: state,
      target: target,
      scale: scale,
      theme: theme,
      contentInsets: contentInsets,
      selection: selection,
      focused: focused,
      cursorBlinkVisible: cursorBlinkVisible,
      damage: damage
    )
    let pixels = readPixels(texture: target, width: width, height: height)
    let nonBackgroundPixelCount = countNonBackgroundPixels(
      pixels, background: theme.background)
    return GhostteaMetalRenderResult(
      width: width,
      height: height,
      rectangleVertexCount: draw.rectangleVertexCount,
      alphaGlyphVertexCount: draw.alphaGlyphVertexCount,
      colorGlyphVertexCount: draw.colorGlyphVertexCount,
      nonBackgroundPixelCount: nonBackgroundPixelCount,
      pixelHash: fnv1a64(pixels),
      visualFingerprint: GhostteaVisualFingerprint(
        pixels: pixels,
        width: width,
        height: height,
        nonBackgroundPixelCount: nonBackgroundPixelCount
      ),
      atlasUpload: draw.atlasUpload,
      vertexUploadBytes: draw.vertexUploadBytes,
      bufferAllocationCount: draw.bufferAllocationCount,
      rowCacheHits: draw.rowCacheHits,
      rowCacheAdmissions: draw.rowCacheAdmissions,
      rowCacheEvictions: draw.rowCacheEvictions,
      residentBytes: atlases.residentBytes + pixels.count
    )
  }

  func render(
    state: RetainedTRF1State,
    target: any MTLTexture,
    scale: Float = 1,
    theme: GhostteaMetalTheme = GhostteaMetalTheme(),
    contentInsets: GhostteaTerminalContentInsets = .zero,
    selection: GhostteaMetalSelection? = nil,
    focused: Bool = true,
    cursorBlinkVisible: Bool = true,
    damage: GhostteaTerminalRenderDamage = .full,
    presenting drawable: (any MTLDrawable)? = nil
  ) throws -> GhostteaMetalDrawResult {
    let width = target.width
    let height = target.height
    guard width > 0, height > 0, target.pixelFormat == .rgba8Unorm, scale.isFinite, scale > 0 else {
      throw GhostteaMetalError.invalidViewport
    }
    let showCursor =
      state.cursor.map {
        $0.visible && (!focused || !$0.blinking || cursorBlinkVisible)
      } ?? false
    let effectCursor =
      state.cursor.map {
        SIMD4<Float>(
          (Self.originX + contentInsets.left + Float($0.x) * cellWidth) * scale,
          (Self.originY + contentInsets.top + Float($0.y) * lineHeight) * scale,
          showCursor ? 1 : 0,
          Float((focused ? $0.style : TRF1CursorStyle.hollowBlock).rawValue)
        )
      } ?? SIMD4<Float>(repeating: 0)
    prepareLightAdaptation(state: state, theme: theme)
    let recorder = GhostteaPerformanceRecorder.shared
    let lookupKey =
      encodedGeometryReuseEnabled
      ? geometryKey(
        state: state,
        width: width,
        height: height,
        scale: scale,
        theme: theme,
        contentInsets: contentInsets,
        selection: selection,
        focused: focused
      ) : nil
    let encodedMesh: GhostteaMetalEncodedMesh
    let atlasUpload: GhostteaMetalUploadResult
    let vertexUploadBytes: Int
    let bufferAllocationCount: Int
    let rowCacheActivity: GhostteaMetalRowCacheActivity
    let effectDrawCallCount: Int
    if let lookupKey, let geometryCache, geometryCache.key == lookupKey {
      if recorder.isEnabled {
        recorder.record(.glyphVisibility, durationNanoseconds: 0)
        recorder.record(.atlasSynchronization, durationNanoseconds: 0)
        recorder.record(.meshBuild, durationNanoseconds: 0)
      }
      encodedMesh = geometryCache.mesh
      atlasUpload = GhostteaMetalUploadResult(
        uploadedBytes: 0,
        alphaGlyphCount: atlases.alpha.glyphCount,
        colorGlyphCount: atlases.colorGlyphCount,
        alphaReset: false,
        colorReset: false
      )
      vertexUploadBytes = 0
      bufferAllocationCount = 0
      rowCacheActivity = GhostteaMetalRowCacheActivity()
      effectDrawCallCount = try recorder.measure(.metalEncoding) {
        try encode(
          mesh: encodedMesh,
          target: target,
          theme: theme,
          showCursor: showCursor,
          effectCursor: effectCursor,
          presenting: drawable
        )
      }
    } else {
      geometryCache = nil
      let visibleDefinitions = try recorder.measure(.glyphVisibility) {
        try visibleGlyphDefinitions(state)
      }
      let atlasStarted = recorder.isEnabled ? DispatchTime.now().uptimeNanoseconds : nil
      atlasUpload = try atlases.synchronize(visible: visibleDefinitions)
      if let atlasStarted {
        recorder.record(
          .atlasSynchronization,
          durationNanoseconds: DispatchTime.now().uptimeNanoseconds &- atlasStarted,
          byteCount: atlasUpload.uploadedBytes
        )
      }
      let completedKey =
        encodedGeometryReuseEnabled
        ? geometryKey(
          state: state,
          width: width,
          height: height,
          scale: scale,
          theme: theme,
          contentInsets: contentInsets,
          selection: selection,
          focused: focused
        ) : nil
      let willAdmit = completedKey.map { pendingGeometryKey == $0 } ?? false
      let meshBuild = try recorder.measure(.meshBuild) {
        try buildMesh(
          state: state,
          width: width,
          height: height,
          scale: scale,
          theme: theme,
          contentInsets: contentInsets,
          selection: selection,
          focused: focused,
          damage: damage
        )
      }
      let mesh = meshBuild.mesh
      rowCacheActivity = meshBuild.activity
      var encodedEffectDrawCallCount = 0
      encodedMesh = try recorder.measure(.metalEncoding) {
        let encodedMesh = try makeEncodedMesh(
          mesh,
          includeCursor: showCursor || willAdmit,
          persistent: willAdmit
        )
        encodedEffectDrawCallCount = try encode(
          mesh: encodedMesh,
          target: target,
          theme: theme,
          showCursor: showCursor,
          effectCursor: effectCursor,
          presenting: drawable
        )
        return encodedMesh
      }
      effectDrawCallCount = encodedEffectDrawCallCount
      if willAdmit, let completedKey {
        geometryCache = GhostteaMetalGeometryCache(key: completedKey, mesh: encodedMesh)
        pendingGeometryKey = nil
      } else {
        pendingGeometryKey = completedKey
      }
      vertexUploadBytes = encodedMesh.uploadedBytes
      bufferAllocationCount = encodedMesh.allocationCount
    }
    return GhostteaMetalDrawResult(
      rectangleVertexCount: encodedMesh.rectangleVertexCount(showCursor: showCursor),
      alphaGlyphVertexCount: encodedMesh.alphaGlyphVertexCount(showCursor: showCursor),
      colorGlyphVertexCount: encodedMesh.colorGlyphVertexCount(showCursor: showCursor),
      atlasUpload: atlasUpload,
      vertexUploadBytes: vertexUploadBytes,
      bufferAllocationCount: bufferAllocationCount,
      drawCallCount: encodedMesh.drawCallCount(showCursor: showCursor) + effectDrawCallCount,
      commandBufferCount: 1,
      damage: damage,
      rowCacheHits: rowCacheActivity.hits,
      rowCacheAdmissions: rowCacheActivity.admissions,
      rowCacheEvictions: rowCacheActivity.evictions
    )
  }

  private func geometryKey(
    state: RetainedTRF1State,
    width: Int,
    height: Int,
    scale: Float,
    theme: GhostteaMetalTheme,
    contentInsets: GhostteaTerminalContentInsets,
    selection: GhostteaMetalSelection?,
    focused: Bool
  ) -> GhostteaMetalGeometryKey {
    GhostteaMetalGeometryKey(
      sessionHandle: state.sessionHandle,
      sessionEpoch: state.sessionEpoch,
      layoutEpoch: state.layoutEpoch,
      frameSequence: state.sequence,
      width: width,
      height: height,
      scale: scale,
      theme: theme,
      contentInsets: contentInsets,
      selection: selection,
      focused: focused,
      lightAdaptationKey: lightRemap?.key,
      alphaAtlasResetCount: atlases.alpha.resetCount,
      colorAtlasResetCount: atlases.colorResetCount
    )
  }

  /// Engages, re-keys, or releases light adaptation for this pane. The remap
  /// key is part of the geometry key and row-cache context, so any change
  /// rebuilds every row with the new colors.
  private func prepareLightAdaptation(state: RetainedTRF1State, theme: GhostteaMetalTheme) {
    guard
      let base = GhostteaLightColor.darkPaintedBase(
        state: state, theme: theme, engaged: lightRemap != nil)
    else {
      lightRemap = nil
      return
    }
    let key = "\(base.hex)|\(theme.background.components)|\(theme.foreground.components)"
    if let cached = lightRemaps[key] {
      lightRemap = cached
      return
    }
    let remap = GhostteaLightRemap(base: base, paper: theme.background, ink: theme.foreground)
    lightRemaps[key] = remap
    lightRemapOrder.append(key)
    if lightRemapOrder.count > 8 {
      lightRemaps[lightRemapOrder.removeFirst()] = nil
    }
    lightRemap = remap
  }

  private func visibleGlyphDefinitions(_ state: RetainedTRF1State) throws -> [TRF1GlyphDefinition] {
    var ids: Set<UInt32> = []
    for row in state.rows {
      for glyph in row.glyphs {
        guard glyph.x.isFinite, glyph.y.isFinite, glyph.width.isFinite, glyph.height.isFinite,
          glyph.width > 0, glyph.height > 0
        else {
          throw GhostteaMetalError.invalidGeometry(glyph.glyphID)
        }
        ids.insert(glyph.glyphID)
      }
    }
    return try ids.sorted().map { id in
      guard let definition = state.glyphDefinitions[id] else {
        throw TRF1DecodingError("row references undefined glyph \(id)")
      }
      return definition
    }
  }

  private func buildMesh(
    state: RetainedTRF1State,
    width: Int,
    height: Int,
    scale: Float,
    theme: GhostteaMetalTheme,
    contentInsets: GhostteaTerminalContentInsets,
    selection: GhostteaMetalSelection?,
    focused: Bool,
    damage: GhostteaTerminalRenderDamage
  ) throws -> (mesh: GhostteaMetalMesh, activity: GhostteaMetalRowCacheActivity) {
    var mesh = GhostteaMetalMesh()
    var activity = GhostteaMetalRowCacheActivity()
    let originX = Self.originX + contentInsets.left
    let originY = Self.originY + contentInsets.top
    let orderedSelection = ordered(selection)
    let effectiveCursorStyle = state.cursor.map {
      focused ? $0.style : TRF1CursorStyle.hollowBlock
    }
    let blockCursor = state.cursor.flatMap { cursor -> GhostteaMetalCellPoint? in
      guard cursor.visible, effectiveCursorStyle == .block else { return nil }
      return GhostteaMetalCellPoint(column: cursor.x, row: cursor.y)
    }
    let context = GhostteaMetalRowCacheContext(
      sessionHandle: state.sessionHandle,
      sessionEpoch: state.sessionEpoch,
      layoutEpoch: state.layoutEpoch,
      width: width,
      height: height,
      scale: scale,
      theme: theme,
      contentInsets: contentInsets,
      selection: orderedSelection,
      lightAdaptationKey: lightRemap?.key,
      alphaAtlasResetCount: atlases.alpha.resetCount,
      colorAtlasResetCount: atlases.colorResetCount
    )
    let contextChanged = context != rowCacheContext
    if contextChanged {
      activity.evictions += clearRowCache()
      pendingRowRevisions.removeAll(keepingCapacity: true)
      rowCacheContext = context
    }
    let broadDamage =
      !rowGeometryReuseEnabled || contextChanged
      || !damage.flags.intersection([.full, .geometry, .atlas]).isEmpty
      || damage.rows.count * 2 >= state.rows.count
    if broadDamage, !contextChanged {
      activity.evictions += clearRowCache()
      pendingRowRevisions.removeAll(keepingCapacity: true)
    }
    let styles = GhostteaMetalStyleResolver(
      definitions: state.styleDefinitions, theme: theme, adaptation: lightRemap)

    for (rowIndex, row) in state.rows.enumerated() {
      let rowDamaged = damage.rows.contains(UInt16(clamping: rowIndex))
      let blockCursorColumn =
        blockCursor?.row == UInt16(rowIndex) ? blockCursor?.column : nil
      if !broadDamage, !rowDamaged, let entry = rowCache[rowIndex],
        entry.revision == row.revision,
        entry.blockCursorColumn == blockCursorColumn
      {
        append(entry.mesh, to: &mesh)
        activity.hits += 1
        continue
      }
      if let removed = rowCache.removeValue(forKey: rowIndex) {
        rowCacheBytes -= removed.mesh.residentBytes
        activity.evictions += 1
      }
      let rowMesh = try buildRowMesh(
        row,
        rowIndex: rowIndex,
        state: state,
        width: width,
        height: height,
        scale: scale,
        theme: theme,
        originX: originX,
        originY: originY,
        selection: orderedSelection,
        blockCursorColumn: blockCursorColumn,
        styles: styles
      )
      append(rowMesh, to: &mesh)
      if !broadDamage, pendingRowRevisions[rowIndex] == row.revision,
        rowCache.count < 128,
        rowCacheBytes + rowMesh.residentBytes <= 4 * 1024 * 1024
      {
        rowCache[rowIndex] = GhostteaMetalRowCacheEntry(
          revision: row.revision,
          blockCursorColumn: blockCursorColumn,
          mesh: rowMesh
        )
        rowCacheBytes += rowMesh.residentBytes
        activity.admissions += 1
      }
      pendingRowRevisions[rowIndex] = row.revision
    }
    if broadDamage, rowGeometryReuseEnabled {
      pendingRowRevisions = Dictionary(
        uniqueKeysWithValues: state.rows.enumerated().map { ($0.offset, $0.element.revision) }
      )
    }

    if let orderedSelection {
      for row in Int(orderedSelection.anchor.row)...Int(orderedSelection.focus.row) {
        guard row < state.rows.count else { break }
        let first =
          row == Int(orderedSelection.anchor.row) ? Int(orderedSelection.anchor.column) : 0
        let last =
          row == Int(orderedSelection.focus.row)
          ? Int(orderedSelection.focus.column)
          : max(0, Int(state.columns) - 1)
        pushRectangle(
          into: &mesh.selection,
          x: (originX + Float(first) * cellWidth) * scale,
          y: (originY + Float(row) * lineHeight) * scale,
          width: Float(max(1, last - first + 1)) * cellWidth * scale,
          height: lineHeight * scale,
          color: theme.selection,
          viewportWidth: width,
          viewportHeight: height
        )
      }
    }
    if let cursor = state.cursor, cursor.visible {
      guard Int(cursor.x) < Int(state.columns), Int(cursor.y) < state.rows.count else {
        throw TRF1DecodingError("cursor exceeds viewport")
      }
      let x = (originX + Float(cursor.x) * cellWidth) * scale
      let y = (originY + Float(cursor.y) * lineHeight) * scale
      let cursorStyle = effectiveCursorStyle ?? .hollowBlock
      let cellPixelWidth = cellWidth * scale
      let cellPixelHeight = lineHeight * scale
      let stroke = max(2, (2 * scale).rounded())
      switch cursorStyle {
      case .block:
        pushRectangle(
          into: &mesh.cursorBackground,
          x: x, y: y,
          width: cellPixelWidth, height: cellPixelHeight,
          color: theme.cursor,
          viewportWidth: width, viewportHeight: height)
      case .bar:
        pushRectangle(
          into: &mesh.cursor,
          x: x, y: y,
          width: stroke, height: cellPixelHeight,
          color: theme.cursor,
          viewportWidth: width, viewportHeight: height)
      case .underline:
        pushRectangle(
          into: &mesh.cursor,
          x: x, y: y + cellPixelHeight - stroke,
          width: cellPixelWidth, height: stroke,
          color: theme.cursor,
          viewportWidth: width, viewportHeight: height)
      case .hollowBlock:
        pushRectangle(
          into: &mesh.cursor,
          x: x, y: y,
          width: cellPixelWidth, height: stroke,
          color: theme.cursor,
          viewportWidth: width, viewportHeight: height)
        pushRectangle(
          into: &mesh.cursor,
          x: x, y: y + cellPixelHeight - stroke,
          width: cellPixelWidth, height: stroke,
          color: theme.cursor,
          viewportWidth: width, viewportHeight: height)
        pushRectangle(
          into: &mesh.cursor,
          x: x, y: y + stroke,
          width: stroke, height: max(0, cellPixelHeight - stroke * 2),
          color: theme.cursor,
          viewportWidth: width, viewportHeight: height)
        pushRectangle(
          into: &mesh.cursor,
          x: x + cellPixelWidth - stroke, y: y + stroke,
          width: stroke, height: max(0, cellPixelHeight - stroke * 2),
          color: theme.cursor,
          viewportWidth: width, viewportHeight: height)
      }
    }
    return (mesh, activity)
  }

  private func buildRowMesh(
    _ row: RetainedTRF1Row,
    rowIndex: Int,
    state: RetainedTRF1State,
    width: Int,
    height: Int,
    scale: Float,
    theme: GhostteaMetalTheme,
    originX: Float,
    originY: Float,
    selection: GhostteaMetalSelection?,
    blockCursorColumn: UInt16?,
    styles: GhostteaMetalStyleResolver
  ) throws -> GhostteaMetalRowMesh {
    var mesh = GhostteaMetalRowMesh()
    // Graphics (box drawing, block elements) keep the raw foreground rather
    // than the contrast-adjusted text color, as in Ghostty; block elements
    // are areas, so light adaptation maps them as surfaces. Only computed
    // when those colors can differ.
    let graphics =
      styles.distinguishesGraphics ? GhostteaMetalGraphicCells.cells(in: row.text) : [:]
    for run in row.styles {
      let style = styles[run.styleID]
      if let background = style.background {
        pushRectangle(
          into: &mesh.backgrounds,
          x: (originX + Float(run.cellStart) * cellWidth) * scale,
          y: (originY + Float(rowIndex) * lineHeight) * scale,
          width: Float(run.cellSpan) * cellWidth * scale,
          height: lineHeight * scale,
          color: background,
          viewportWidth: width,
          viewportHeight: height
        )
      }
    }
    for instance in row.glyphs {
      guard let definition = state.glyphDefinitions[instance.glyphID] else { continue }
      let style = styles[instance.styleID]
      if style.invisible { continue }
      let glyphStart = Int(instance.cellStart)
      let glyphEnd = glyphStart + max(1, Int(instance.cellSpan))
      let cursorCoversGlyph =
        blockCursorColumn.map {
          glyphStart <= Int($0) && Int($0) < glyphEnd
        } ?? false
      let selected = selectionContains(selection, row: rowIndex, column: glyphStart)
      let foreground = selected ? theme.selectionForeground : style.foreground
      guard let location = atlases.location(for: definition) else {
        throw TRF1DecodingError("visible glyph \(definition.id) is absent from its atlas")
      }
      if definition.format == .alpha8 {
        let glyphColor: GhostteaMetalColor
        if selected {
          glyphColor = foreground
        } else {
          switch graphics[glyphStart] {
          case .box: glyphColor = style.foreground
          case .block: glyphColor = style.fill
          case nil: glyphColor = style.text
          }
        }
        pushGlyph(
          into: &mesh.alphaGlyphs,
          x: (originX + instance.x) * scale,
          y: (originY + Float(rowIndex) * lineHeight + instance.y) * scale,
          width: instance.width * scale,
          height: instance.height * scale,
          location: location,
          color: glyphColor,
          viewportWidth: width,
          viewportHeight: height
        )
        if cursorCoversGlyph {
          pushGlyph(
            into: &mesh.cursorAlphaGlyphs,
            x: (originX + instance.x) * scale,
            y: (originY + Float(rowIndex) * lineHeight + instance.y) * scale,
            width: instance.width * scale,
            height: instance.height * scale,
            location: location,
            color: theme.cursorText,
            viewportWidth: width,
            viewportHeight: height
          )
        }
      } else {
        pushGlyph(
          into: &mesh.colorGlyphs,
          x: (originX + instance.x) * scale,
          y: (originY + Float(rowIndex) * lineHeight + instance.y) * scale,
          width: instance.width * scale,
          height: instance.height * scale,
          location: location,
          color: foreground,
          viewportWidth: width,
          viewportHeight: height
        )
        if cursorCoversGlyph {
          // Color glyphs cannot be meaningfully tinted with cursor-text, but
          // must be replayed after the block background so they remain visible.
          pushGlyph(
            into: &mesh.cursorColorGlyphs,
            x: (originX + instance.x) * scale,
            y: (originY + Float(rowIndex) * lineHeight + instance.y) * scale,
            width: instance.width * scale,
            height: instance.height * scale,
            location: location,
            color: foreground,
            viewportWidth: width,
            viewportHeight: height
          )
        }
      }
    }
    for run in row.styles {
      let style = styles[run.styleID]
      if style.invisible { continue }
      let x = (originX + Float(run.cellStart) * cellWidth) * scale
      let rowTop = (originY + Float(rowIndex) * lineHeight) * scale
      let runWidth = Float(run.cellSpan) * cellWidth * scale
      let stroke = max(1, scale.rounded())
      let metricScale = lineHeight / GhostteaTerminalLayout.lineHeight
      let cursorCoversRun =
        blockCursorColumn.map {
          Int(run.cellStart) <= Int($0)
            && Int($0) < Int(run.cellStart) + max(1, Int(run.cellSpan))
        } ?? false
      if style.underline {
        pushRectangle(
          into: &mesh.decorations,
          x: x,
          y: (rowTop + 16 * metricScale * scale).rounded(),
          width: runWidth,
          height: stroke,
          color: style.text,
          viewportWidth: width,
          viewportHeight: height
        )
        if cursorCoversRun, let blockCursorColumn {
          pushRectangle(
            into: &mesh.cursorDecorations,
            x: (originX + Float(blockCursorColumn) * cellWidth) * scale,
            y: (rowTop + 16 * metricScale * scale).rounded(),
            width: cellWidth * scale,
            height: stroke,
            color: theme.cursorText,
            viewportWidth: width,
            viewportHeight: height
          )
        }
      }
      if style.strikethrough {
        pushRectangle(
          into: &mesh.decorations,
          x: x,
          y: (rowTop + 9 * metricScale * scale).rounded(),
          width: runWidth,
          height: stroke,
          color: style.text,
          viewportWidth: width,
          viewportHeight: height
        )
        if cursorCoversRun, let blockCursorColumn {
          pushRectangle(
            into: &mesh.cursorDecorations,
            x: (originX + Float(blockCursorColumn) * cellWidth) * scale,
            y: (rowTop + 9 * metricScale * scale).rounded(),
            width: cellWidth * scale,
            height: stroke,
            color: theme.cursorText,
            viewportWidth: width,
            viewportHeight: height
          )
        }
      }
    }
    return mesh
  }

  private func append(_ row: GhostteaMetalRowMesh, to mesh: inout GhostteaMetalMesh) {
    mesh.backgrounds.append(contentsOf: row.backgrounds)
    mesh.alphaGlyphs.append(contentsOf: row.alphaGlyphs)
    mesh.colorGlyphs.append(contentsOf: row.colorGlyphs)
    mesh.decorations.append(contentsOf: row.decorations)
    mesh.cursorAlphaGlyphs.append(contentsOf: row.cursorAlphaGlyphs)
    mesh.cursorColorGlyphs.append(contentsOf: row.cursorColorGlyphs)
    mesh.cursorDecorations.append(contentsOf: row.cursorDecorations)
  }

  @discardableResult
  private func clearRowCache() -> Int {
    let count = rowCache.count
    rowCache.removeAll(keepingCapacity: true)
    rowCacheBytes = 0
    return count
  }

  private func makeEncodedMesh(
    _ mesh: GhostteaMetalMesh,
    includeCursor: Bool,
    persistent: Bool
  ) throws -> GhostteaMetalEncodedMesh {
    if instancedSubmissionEnabled {
      return try makeInstancedEncodedMesh(
        mesh, includeCursor: includeCursor, persistent: persistent)
    }
    return try makeLegacyEncodedMesh(mesh, includeCursor: includeCursor)
  }

  private func makeInstancedEncodedMesh(
    _ mesh: GhostteaMetalMesh,
    includeCursor: Bool,
    persistent: Bool
  ) throws -> GhostteaMetalEncodedMesh {
    let cursorBackground = includeCursor ? mesh.cursorBackground : []
    let cursorAlphaGlyphs = includeCursor ? mesh.cursorAlphaGlyphs : []
    let cursorColorGlyphs = includeCursor ? mesh.cursorColorGlyphs : []
    let cursorDecorations = includeCursor ? mesh.cursorDecorations : []
    let cursor = includeCursor ? mesh.cursor : []
    var requiredBytes = 0
    func reserve<T>(_ values: [T]) -> Int {
      let offset = alignedUploadOffset(requiredBytes)
      requiredBytes = offset + values.count * MemoryLayout<T>.stride
      return offset
    }
    let backgroundOffset = reserve(mesh.backgrounds)
    let selectionOffset = reserve(mesh.selection)
    let cursorBackgroundOffset = reserve(cursorBackground)
    let alphaGlyphOffset = reserve(mesh.alphaGlyphs)
    let colorGlyphOffset = reserve(mesh.colorGlyphs)
    let decorationOffset = reserve(mesh.decorations)
    let cursorAlphaGlyphOffset = reserve(cursorAlphaGlyphs)
    let cursorColorGlyphOffset = reserve(cursorColorGlyphs)
    let cursorDecorationOffset = reserve(cursorDecorations)
    let cursorOffset = reserve(cursor)
    let uploadedBytes =
      mesh.backgrounds.count * MemoryLayout<GhostteaMetalRectangleInstance>.stride
      + mesh.selection.count * MemoryLayout<GhostteaMetalRectangleInstance>.stride
      + cursorBackground.count * MemoryLayout<GhostteaMetalRectangleInstance>.stride
      + mesh.alphaGlyphs.count * MemoryLayout<GhostteaMetalGlyphInstance>.stride
      + mesh.colorGlyphs.count * MemoryLayout<GhostteaMetalGlyphInstance>.stride
      + mesh.decorations.count * MemoryLayout<GhostteaMetalRectangleInstance>.stride
      + cursorAlphaGlyphs.count * MemoryLayout<GhostteaMetalGlyphInstance>.stride
      + cursorColorGlyphs.count * MemoryLayout<GhostteaMetalGlyphInstance>.stride
      + cursorDecorations.count * MemoryLayout<GhostteaMetalRectangleInstance>.stride
      + cursor.count * MemoryLayout<GhostteaMetalRectangleInstance>.stride
    guard requiredBytes > 0 else {
      return GhostteaMetalEncodedMesh(
        backgrounds: nil,
        selection: nil,
        cursorBackground: nil,
        alphaGlyphs: nil,
        colorGlyphs: nil,
        decorations: nil,
        cursorAlphaGlyphs: nil,
        cursorColorGlyphs: nil,
        cursorDecorations: nil,
        cursor: nil,
        rectangleVertexCount: 0,
        alphaGlyphVertexCount: 0,
        colorGlyphVertexCount: 0,
        uploadedBytes: 0,
        allocationCount: 0,
        instanced: true,
        uploadLease: nil
      )
    }

    let buffer: any MTLBuffer
    let allocationCount: Int
    let lease: GhostteaMetalUploadLease?
    if persistent {
      guard
        let persistentBuffer = runtime.device.makeBuffer(
          length: requiredBytes,
          options: .storageModeShared
        )
      else {
        throw GhostteaMetalError.bufferUnavailable("persistent geometry")
      }
      persistentBuffer.label = "Ghosttea persistent geometry"
      buffer = persistentBuffer
      allocationCount = 1
      lease = nil
    } else {
      let allocation = try uploadArena.acquire(minimumBytes: requiredBytes)
      buffer = allocation.buffer
      allocationCount = allocation.allocationCount
      lease = allocation.lease
    }
    write(mesh.backgrounds, to: buffer, at: backgroundOffset)
    write(mesh.selection, to: buffer, at: selectionOffset)
    write(cursorBackground, to: buffer, at: cursorBackgroundOffset)
    write(mesh.alphaGlyphs, to: buffer, at: alphaGlyphOffset)
    write(mesh.colorGlyphs, to: buffer, at: colorGlyphOffset)
    write(mesh.decorations, to: buffer, at: decorationOffset)
    write(cursorAlphaGlyphs, to: buffer, at: cursorAlphaGlyphOffset)
    write(cursorColorGlyphs, to: buffer, at: cursorColorGlyphOffset)
    write(cursorDecorations, to: buffer, at: cursorDecorationOffset)
    write(cursor, to: buffer, at: cursorOffset)

    return GhostteaMetalEncodedMesh(
      backgrounds: instanceSlice(mesh.backgrounds, buffer: buffer, offset: backgroundOffset),
      selection: instanceSlice(mesh.selection, buffer: buffer, offset: selectionOffset),
      cursorBackground: instanceSlice(
        cursorBackground,
        buffer: buffer,
        offset: cursorBackgroundOffset
      ),
      alphaGlyphs: instanceSlice(mesh.alphaGlyphs, buffer: buffer, offset: alphaGlyphOffset),
      colorGlyphs: instanceSlice(mesh.colorGlyphs, buffer: buffer, offset: colorGlyphOffset),
      decorations: instanceSlice(mesh.decorations, buffer: buffer, offset: decorationOffset),
      cursorAlphaGlyphs: instanceSlice(
        cursorAlphaGlyphs, buffer: buffer, offset: cursorAlphaGlyphOffset),
      cursorColorGlyphs: instanceSlice(
        cursorColorGlyphs, buffer: buffer, offset: cursorColorGlyphOffset),
      cursorDecorations: instanceSlice(
        cursorDecorations, buffer: buffer, offset: cursorDecorationOffset),
      cursor: instanceSlice(cursor, buffer: buffer, offset: cursorOffset),
      rectangleVertexCount: (mesh.backgrounds.count + mesh.selection.count
        + cursorBackground.count
        + mesh.decorations.count + cursorDecorations.count + cursor.count) * 6,
      alphaGlyphVertexCount: (mesh.alphaGlyphs.count + cursorAlphaGlyphs.count) * 6,
      colorGlyphVertexCount: (mesh.colorGlyphs.count + cursorColorGlyphs.count) * 6,
      uploadedBytes: uploadedBytes,
      allocationCount: allocationCount,
      instanced: true,
      uploadLease: lease
    )
  }

  private func makeLegacyEncodedMesh(
    _ mesh: GhostteaMetalMesh,
    includeCursor: Bool
  ) throws -> GhostteaMetalEncodedMesh {
    let backgrounds = expandedRectangleVertices(mesh.backgrounds)
    let selection = expandedRectangleVertices(mesh.selection)
    let cursorBackground = includeCursor ? expandedRectangleVertices(mesh.cursorBackground) : []
    let alphaGlyphs = expandedGlyphVertices(mesh.alphaGlyphs)
    let colorGlyphs = expandedGlyphVertices(mesh.colorGlyphs)
    let decorations = expandedRectangleVertices(mesh.decorations)
    let cursorAlphaGlyphs = includeCursor ? expandedGlyphVertices(mesh.cursorAlphaGlyphs) : []
    let cursorColorGlyphs = includeCursor ? expandedGlyphVertices(mesh.cursorColorGlyphs) : []
    let cursorDecorations =
      includeCursor ? expandedRectangleVertices(mesh.cursorDecorations) : []
    let cursor = includeCursor ? expandedRectangleVertices(mesh.cursor) : []
    let slices = try (
      backgrounds: makeBufferSlice(backgrounds, label: "backgrounds", stride: 6),
      selection: makeBufferSlice(selection, label: "selection", stride: 6),
      cursorBackground: makeBufferSlice(
        cursorBackground,
        label: "cursor background",
        stride: 6
      ),
      alphaGlyphs: makeBufferSlice(alphaGlyphs, label: "alpha glyphs", stride: 8),
      colorGlyphs: makeBufferSlice(colorGlyphs, label: "color glyphs", stride: 8),
      decorations: makeBufferSlice(decorations, label: "decorations", stride: 6),
      cursorAlphaGlyphs: makeBufferSlice(
        cursorAlphaGlyphs, label: "cursor alpha glyphs", stride: 8),
      cursorColorGlyphs: makeBufferSlice(
        cursorColorGlyphs, label: "cursor color glyphs", stride: 8),
      cursorDecorations: makeBufferSlice(
        cursorDecorations, label: "cursor decorations", stride: 6),
      cursor: makeBufferSlice(cursor, label: "cursor", stride: 6)
    )
    let allocationCount = [
      slices.backgrounds,
      slices.selection,
      slices.cursorBackground,
      slices.alphaGlyphs,
      slices.colorGlyphs,
      slices.decorations,
      slices.cursorAlphaGlyphs,
      slices.cursorColorGlyphs,
      slices.cursorDecorations,
      slices.cursor,
    ].compactMap { $0 }.count
    return GhostteaMetalEncodedMesh(
      backgrounds: slices.backgrounds,
      selection: slices.selection,
      cursorBackground: slices.cursorBackground,
      alphaGlyphs: slices.alphaGlyphs,
      colorGlyphs: slices.colorGlyphs,
      decorations: slices.decorations,
      cursorAlphaGlyphs: slices.cursorAlphaGlyphs,
      cursorColorGlyphs: slices.cursorColorGlyphs,
      cursorDecorations: slices.cursorDecorations,
      cursor: slices.cursor,
      rectangleVertexCount: backgrounds.count / 6 + selection.count / 6
        + cursorBackground.count / 6
        + decorations.count / 6 + cursorDecorations.count / 6 + cursor.count / 6,
      alphaGlyphVertexCount: (alphaGlyphs.count + cursorAlphaGlyphs.count) / 8,
      colorGlyphVertexCount: (colorGlyphs.count + cursorColorGlyphs.count) / 8,
      uploadedBytes: (backgrounds.count + selection.count + cursorBackground.count
        + alphaGlyphs.count
        + colorGlyphs.count + decorations.count + cursorAlphaGlyphs.count
        + cursorColorGlyphs.count + cursorDecorations.count + cursor.count)
        * MemoryLayout<Float>.stride,
      allocationCount: allocationCount,
      instanced: false,
      uploadLease: nil
    )
  }

  private func encode(
    mesh: GhostteaMetalEncodedMesh,
    target: any MTLTexture,
    theme: GhostteaMetalTheme,
    showCursor: Bool,
    effectCursor: SIMD4<Float>,
    presenting drawable: (any MTLDrawable)?
  ) throws -> Int {
    var uploadSubmitted = false
    defer {
      if !uploadSubmitted { mesh.uploadLease?.release() }
    }
    guard let commandBuffer = runtime.commandQueue.makeCommandBuffer() else {
      throw GhostteaMetalError.commandQueueUnavailable
    }
    let stack = Array(theme.shaderEffects.prefix(16))
    let terminalTarget: any MTLTexture
    if stack.isEmpty {
      terminalTarget = target
      effectSceneValid = false
      effectSignature = ""
      effectFrame = 0
      effectStartTime = nil
      lastEffectTime = 0
    } else {
      terminalTarget = try ensureEffectResources(
        width: target.width,
        height: target.height,
        stack: stack,
        animationEnabled: theme.shaderAnimation
      )
    }
    let descriptor = MTLRenderPassDescriptor()
    descriptor.colorAttachments[0].texture = terminalTarget
    descriptor.colorAttachments[0].loadAction = .clear
    descriptor.colorAttachments[0].storeAction = .store
    descriptor.colorAttachments[0].clearColor = MTLClearColor(
      red: Double(theme.background.red * theme.background.alpha),
      green: Double(theme.background.green * theme.background.alpha),
      blue: Double(theme.background.blue * theme.background.alpha),
      alpha: Double(theme.background.alpha)
    )
    guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor) else {
      throw GhostteaMetalError.renderTargetUnavailable
    }
    encoder.label = "Ghosttea terminal pass"
    let activeRectanglePipeline = mesh.instanced ? instancedRectanglePipeline : rectanglePipeline
    let activeAlphaGlyphPipeline = mesh.instanced ? instancedAlphaGlyphPipeline : alphaGlyphPipeline
    let activeColorGlyphPipeline = mesh.instanced ? instancedColorGlyphPipeline : colorGlyphPipeline
    draw(mesh.backgrounds, pipeline: activeRectanglePipeline, encoder: encoder)
    draw(mesh.selection, pipeline: activeRectanglePipeline, encoder: encoder)
    drawGlyphs(
      mesh.alphaGlyphs,
      pipeline: activeAlphaGlyphPipeline,
      texture: atlases.alpha.texture,
      encoder: encoder
    )
    if mesh.colorGlyphs != nil {
      guard let colorTexture = atlases.colorTexture else {
        throw GhostteaMetalError.textureUnavailable("Ghosttea color glyph atlas")
      }
      drawGlyphs(
        mesh.colorGlyphs,
        pipeline: activeColorGlyphPipeline,
        texture: colorTexture,
        encoder: encoder
      )
    }
    draw(mesh.decorations, pipeline: activeRectanglePipeline, encoder: encoder)
    if showCursor {
      draw(mesh.cursorBackground, pipeline: activeRectanglePipeline, encoder: encoder)
      drawGlyphs(
        mesh.cursorAlphaGlyphs,
        pipeline: activeAlphaGlyphPipeline,
        texture: atlases.alpha.texture,
        encoder: encoder
      )
      if mesh.cursorColorGlyphs != nil {
        guard let colorTexture = atlases.colorTexture else {
          throw GhostteaMetalError.textureUnavailable("Ghosttea color glyph atlas")
        }
        drawGlyphs(
          mesh.cursorColorGlyphs,
          pipeline: activeColorGlyphPipeline,
          texture: colorTexture,
          encoder: encoder
        )
      }
      draw(mesh.cursorDecorations, pipeline: activeRectanglePipeline, encoder: encoder)
      draw(mesh.cursor, pipeline: activeRectanglePipeline, encoder: encoder)
    }
    encoder.endEncoding()
    let effectDrawCallCount = try encodeEffectStack(
      stack,
      theme: theme,
      target: target,
      cursor: effectCursor,
      commandBuffer: commandBuffer
    )
    effectSceneValid = !stack.isEmpty
    if GhostteaPerformanceRecorder.shared.isEnabled {
      let started = DispatchTime.now().uptimeNanoseconds
      commandBuffer.addCompletedHandler { _ in
        GhostteaPerformanceRecorder.shared.record(
          .metalGPUCompletion,
          durationNanoseconds: DispatchTime.now().uptimeNanoseconds &- started
        )
      }
    }
    if let uploadLease = mesh.uploadLease {
      commandBuffer.addCompletedHandler { _ in uploadLease.release() }
    }
    if let drawable {
      commandBuffer.present(drawable)
      commandBuffer.commit()
      uploadSubmitted = true
      return effectDrawCallCount
    }
    commandBuffer.commit()
    uploadSubmitted = true
    commandBuffer.waitUntilCompleted()
    guard commandBuffer.status == .completed else {
      throw GhostteaMetalError.commandBufferFailed("Metal command did not complete")
    }
    return effectDrawCallCount
  }

  /// Re-runs an animated effect stack against the last complete terminal
  /// scene. This preserves the event-driven terminal path: animation frames do
  /// not rebuild meshes, upload atlases, or redraw the terminal pass.
  func renderEffectsOnly(
    state: RetainedTRF1State,
    target: any MTLTexture,
    scale: Float,
    theme: GhostteaMetalTheme,
    contentInsets: GhostteaTerminalContentInsets,
    focused: Bool,
    cursorBlinkVisible: Bool,
    presenting drawable: (any MTLDrawable)?
  ) throws -> GhostteaMetalDrawResult? {
    let stack = Array(theme.shaderEffects.prefix(16))
    guard !stack.isEmpty, effectSceneValid,
      effectTextureSize == SIMD2(target.width, target.height),
      effectSignature == stack.map({ String($0.rawValue) }).joined(separator: ","),
      effectAnimationEnabled == theme.shaderAnimation
    else { return nil }
    let showCursor =
      state.cursor.map {
        $0.visible && (!focused || !$0.blinking || cursorBlinkVisible)
      } ?? false
    let cursor =
      state.cursor.map {
        SIMD4<Float>(
          (Self.originX + contentInsets.left + Float($0.x) * cellWidth) * scale,
          (Self.originY + contentInsets.top + Float($0.y) * lineHeight) * scale,
          showCursor ? 1 : 0,
          Float((focused ? $0.style : TRF1CursorStyle.hollowBlock).rawValue)
        )
      } ?? SIMD4<Float>(repeating: 0)
    guard let commandBuffer = runtime.commandQueue.makeCommandBuffer() else {
      throw GhostteaMetalError.commandQueueUnavailable
    }
    let effectPassCount = try encodeEffectStack(
      stack,
      theme: theme,
      target: target,
      cursor: cursor,
      commandBuffer: commandBuffer
    )
    if let drawable { commandBuffer.present(drawable) }
    commandBuffer.commit()
    if drawable == nil {
      commandBuffer.waitUntilCompleted()
      guard commandBuffer.status == .completed else {
        throw GhostteaMetalError.commandBufferFailed("Metal effect command did not complete")
      }
    }
    return GhostteaMetalDrawResult(
      rectangleVertexCount: 0,
      alphaGlyphVertexCount: 0,
      colorGlyphVertexCount: 0,
      atlasUpload: GhostteaMetalUploadResult(
        uploadedBytes: 0,
        alphaGlyphCount: atlases.alpha.glyphCount,
        colorGlyphCount: atlases.colorGlyphCount,
        alphaReset: false,
        colorReset: false
      ),
      vertexUploadBytes: 0,
      bufferAllocationCount: 0,
      drawCallCount: effectPassCount,
      commandBufferCount: 1,
      damage: GhostteaTerminalRenderDamage(),
      rowCacheHits: 0,
      rowCacheAdmissions: 0,
      rowCacheEvictions: 0
    )
  }

  private func ensureEffectResources(
    width: Int,
    height: Int,
    stack: [GhostteaMetalShaderEffect],
    animationEnabled: Bool
  ) throws -> any MTLTexture {
    let size = SIMD2(width, height)
    if effectTextureSize != size || effectSceneTexture == nil {
      let descriptor = MTLTextureDescriptor.texture2DDescriptor(
        pixelFormat: .rgba8Unorm,
        width: width,
        height: height,
        mipmapped: false
      )
      descriptor.storageMode = .private
      descriptor.usage = [.renderTarget, .shaderRead]
      guard let scene = runtime.device.makeTexture(descriptor: descriptor) else {
        throw GhostteaMetalError.textureUnavailable("terminal shader scene")
      }
      scene.label = "Ghosttea terminal scene before effects"
      effectSceneTexture = scene
      effectIntermediateTextures.removeAll(keepingCapacity: false)
      effectTextureSize = size
      effectSceneValid = false
    }
    let intermediateCount = min(2, max(0, stack.count - 1))
    while effectIntermediateTextures.count > intermediateCount {
      effectIntermediateTextures.removeLast()
    }
    while effectIntermediateTextures.count < intermediateCount {
      let descriptor = MTLTextureDescriptor.texture2DDescriptor(
        pixelFormat: .rgba8Unorm,
        width: width,
        height: height,
        mipmapped: false
      )
      descriptor.storageMode = .private
      descriptor.usage = [.renderTarget, .shaderRead]
      guard let texture = runtime.device.makeTexture(descriptor: descriptor) else {
        throw GhostteaMetalError.textureUnavailable("terminal shader ping-pong target")
      }
      texture.label = "Ghosttea terminal shader ping-pong \(effectIntermediateTextures.count)"
      effectIntermediateTextures.append(texture)
    }
    let signature = stack.map { String($0.rawValue) }.joined(separator: ",")
    if signature != effectSignature || animationEnabled != effectAnimationEnabled {
      effectSignature = signature
      effectAnimationEnabled = animationEnabled
      effectFrame = 0
      effectStartTime = nil
      lastEffectTime = 0
    }
    guard let effectSceneTexture else {
      throw GhostteaMetalError.textureUnavailable("terminal shader scene")
    }
    return effectSceneTexture
  }

  private func encodeEffectStack(
    _ stack: [GhostteaMetalShaderEffect],
    theme: GhostteaMetalTheme,
    target: any MTLTexture,
    cursor: SIMD4<Float>,
    commandBuffer: any MTLCommandBuffer
  ) throws -> Int {
    guard !stack.isEmpty else { return 0 }
    guard let scene = effectSceneTexture else {
      throw GhostteaMetalError.textureUnavailable("terminal shader scene")
    }
    let elapsed: Float
    let delta: Float
    if theme.shaderAnimation {
      let now = ProcessInfo.processInfo.systemUptime
      let start = effectStartTime ?? now
      effectStartTime = start
      elapsed = Float(now - start)
      delta = lastEffectTime > 0 ? min(0.1, max(0, elapsed - lastEffectTime)) : 0
      lastEffectTime = elapsed
    } else {
      elapsed = 0
      delta = 0
      lastEffectTime = 0
    }
    for (index, effect) in stack.enumerated() {
      let input: any MTLTexture =
        index == 0 ? scene : effectIntermediateTextures[(index - 1) % 2]
      let isLast = index == stack.count - 1
      let output: any MTLTexture =
        isLast ? target : effectIntermediateTextures[index % 2]
      let descriptor = MTLRenderPassDescriptor()
      descriptor.colorAttachments[0].texture = output
      descriptor.colorAttachments[0].loadAction = .clear
      descriptor.colorAttachments[0].storeAction = .store
      descriptor.colorAttachments[0].clearColor = MTLClearColorMake(0, 0, 0, 0)
      guard let encoder = commandBuffer.makeRenderCommandEncoder(descriptor: descriptor) else {
        throw GhostteaMetalError.renderTargetUnavailable
      }
      encoder.label = "Ghosttea shader effect \(index + 1)/\(stack.count)"
      var uniforms = GhostteaMetalEffectUniforms(
        mode: effect.rawValue,
        frame: effectFrame,
        effectIndex: UInt32(index),
        effectCount: UInt32(stack.count),
        resolution: SIMD2(Float(target.width), Float(target.height)),
        time: elapsed,
        timeDelta: delta,
        cursor: cursor
      )
      encoder.setRenderPipelineState(effectPipeline)
      encoder.setFragmentTexture(input, index: 0)
      encoder.setFragmentSamplerState(sampler, index: 0)
      encoder.setFragmentBytes(
        &uniforms,
        length: MemoryLayout<GhostteaMetalEffectUniforms>.stride,
        index: 0
      )
      encoder.drawPrimitives(type: .triangle, vertexStart: 0, vertexCount: 3)
      encoder.endEncoding()
    }
    effectFrame &+= 1
    return stack.count
  }

  private func draw(
    _ slice: GhostteaMetalBufferSlice?,
    pipeline: any MTLRenderPipelineState,
    encoder: any MTLRenderCommandEncoder
  ) {
    guard let slice else { return }
    encoder.setRenderPipelineState(pipeline)
    encoder.setVertexBuffer(slice.buffer, offset: slice.offset, index: 0)
    encoder.drawPrimitives(
      type: .triangle,
      vertexStart: 0,
      vertexCount: slice.vertexCount,
      instanceCount: slice.instanceCount
    )
  }

  private func drawGlyphs(
    _ slice: GhostteaMetalBufferSlice?,
    pipeline: any MTLRenderPipelineState,
    texture: any MTLTexture,
    encoder: any MTLRenderCommandEncoder
  ) {
    guard let slice else { return }
    encoder.setRenderPipelineState(pipeline)
    encoder.setVertexBuffer(slice.buffer, offset: slice.offset, index: 0)
    encoder.setFragmentTexture(texture, index: 0)
    encoder.setFragmentSamplerState(sampler, index: 0)
    encoder.drawPrimitives(
      type: .triangle,
      vertexStart: 0,
      vertexCount: slice.vertexCount,
      instanceCount: slice.instanceCount
    )
  }

  private func makeBufferSlice(
    _ vertices: [Float], label: String, stride: Int
  ) throws -> GhostteaMetalBufferSlice? {
    guard !vertices.isEmpty else { return nil }
    let buffer = vertices.withUnsafeBufferPointer { values in
      runtime.device.makeBuffer(
        bytes: values.baseAddress!,
        length: values.count * MemoryLayout<Float>.stride,
        options: .storageModeShared
      )
    }
    guard let buffer else { throw GhostteaMetalError.bufferUnavailable(label) }
    buffer.label = "Ghosttea \(label) vertices"
    return GhostteaMetalBufferSlice(
      buffer: buffer,
      offset: 0,
      vertexCount: vertices.count / stride,
      instanceCount: 1
    )
  }

  private func instanceSlice<T>(
    _ instances: [T],
    buffer: any MTLBuffer,
    offset: Int
  ) -> GhostteaMetalBufferSlice? {
    guard !instances.isEmpty else { return nil }
    return GhostteaMetalBufferSlice(
      buffer: buffer,
      offset: offset,
      vertexCount: 6,
      instanceCount: instances.count
    )
  }

  private func write<T>(_ values: [T], to buffer: any MTLBuffer, at offset: Int) {
    guard !values.isEmpty else { return }
    values.withUnsafeBytes { source in
      guard let baseAddress = source.baseAddress else { return }
      buffer.contents().advanced(by: offset).copyMemory(
        from: baseAddress,
        byteCount: source.count
      )
    }
  }

  private static func makeRectanglePipeline(
    runtime: GhostteaMetalRuntime,
    library: any MTLLibrary
  ) throws -> any MTLRenderPipelineState {
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.label = "Ghosttea rectangle pipeline"
    descriptor.vertexFunction = library.makeFunction(name: "ghosttea_rectangle_vertex")
    descriptor.fragmentFunction = library.makeFunction(name: "ghosttea_rectangle_fragment")
    let vertex = MTLVertexDescriptor()
    vertex.attributes[0].format = .float2
    vertex.attributes[0].offset = 0
    vertex.attributes[0].bufferIndex = 0
    vertex.attributes[1].format = .float4
    vertex.attributes[1].offset = 2 * MemoryLayout<Float>.stride
    vertex.attributes[1].bufferIndex = 0
    vertex.layouts[0].stride = 6 * MemoryLayout<Float>.stride
    descriptor.vertexDescriptor = vertex
    configureColorAttachment(descriptor.colorAttachments[0])
    do {
      return try runtime.device.makeRenderPipelineState(descriptor: descriptor)
    } catch {
      throw GhostteaMetalError.pipelineUnavailable("rectangle pipeline")
    }
  }

  private static func makeGlyphPipeline(
    runtime: GhostteaMetalRuntime,
    library: any MTLLibrary,
    fragment: String,
    label: String
  ) throws -> any MTLRenderPipelineState {
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.label = label
    descriptor.vertexFunction = library.makeFunction(name: "ghosttea_glyph_vertex")
    descriptor.fragmentFunction = library.makeFunction(name: fragment)
    let vertex = MTLVertexDescriptor()
    vertex.attributes[0].format = .float2
    vertex.attributes[0].offset = 0
    vertex.attributes[0].bufferIndex = 0
    vertex.attributes[1].format = .float2
    vertex.attributes[1].offset = 2 * MemoryLayout<Float>.stride
    vertex.attributes[1].bufferIndex = 0
    vertex.attributes[2].format = .float4
    vertex.attributes[2].offset = 4 * MemoryLayout<Float>.stride
    vertex.attributes[2].bufferIndex = 0
    vertex.layouts[0].stride = 8 * MemoryLayout<Float>.stride
    descriptor.vertexDescriptor = vertex
    configureColorAttachment(descriptor.colorAttachments[0])
    do {
      return try runtime.device.makeRenderPipelineState(descriptor: descriptor)
    } catch {
      throw GhostteaMetalError.pipelineUnavailable("glyph pipeline")
    }
  }

  private static func makeInstancedRectanglePipeline(
    runtime: GhostteaMetalRuntime,
    library: any MTLLibrary
  ) throws -> any MTLRenderPipelineState {
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.label = "Ghosttea instanced rectangle pipeline"
    descriptor.vertexFunction = library.makeFunction(name: "ghosttea_rectangle_instanced_vertex")
    descriptor.fragmentFunction = library.makeFunction(name: "ghosttea_rectangle_fragment")
    configureColorAttachment(descriptor.colorAttachments[0])
    do {
      return try runtime.device.makeRenderPipelineState(descriptor: descriptor)
    } catch {
      throw GhostteaMetalError.pipelineUnavailable("instanced rectangle pipeline")
    }
  }

  private static func makeInstancedGlyphPipeline(
    runtime: GhostteaMetalRuntime,
    library: any MTLLibrary,
    fragment: String,
    label: String
  ) throws -> any MTLRenderPipelineState {
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.label = label
    descriptor.vertexFunction = library.makeFunction(name: "ghosttea_glyph_instanced_vertex")
    descriptor.fragmentFunction = library.makeFunction(name: fragment)
    configureColorAttachment(descriptor.colorAttachments[0])
    do {
      return try runtime.device.makeRenderPipelineState(descriptor: descriptor)
    } catch {
      throw GhostteaMetalError.pipelineUnavailable("instanced glyph pipeline")
    }
  }

  private static func makeEffectPipeline(
    runtime: GhostteaMetalRuntime,
    library: any MTLLibrary
  ) throws -> any MTLRenderPipelineState {
    let descriptor = MTLRenderPipelineDescriptor()
    descriptor.label = "Ghosttea terminal shader effect pipeline"
    descriptor.vertexFunction = library.makeFunction(name: "ghosttea_effect_vertex")
    descriptor.fragmentFunction = library.makeFunction(name: "ghosttea_effect_fragment")
    descriptor.colorAttachments[0].pixelFormat = .rgba8Unorm
    descriptor.colorAttachments[0].isBlendingEnabled = false
    do {
      return try runtime.device.makeRenderPipelineState(descriptor: descriptor)
    } catch {
      throw GhostteaMetalError.pipelineUnavailable("terminal shader effect pipeline")
    }
  }

  private static func configureColorAttachment(
    _ attachment: MTLRenderPipelineColorAttachmentDescriptor?
  ) {
    attachment?.pixelFormat = .rgba8Unorm
    attachment?.isBlendingEnabled = true
    attachment?.rgbBlendOperation = .add
    attachment?.alphaBlendOperation = .add
    attachment?.sourceRGBBlendFactor = .one
    attachment?.sourceAlphaBlendFactor = .one
    attachment?.destinationRGBBlendFactor = .oneMinusSourceAlpha
    attachment?.destinationAlphaBlendFactor = .oneMinusSourceAlpha
  }
}

/// Resolves each style once per mesh build. Light adaptation and
/// `minimum-contrast` search colors, so per-glyph resolution would repeat that
/// work for every cell sharing a style.
private final class GhostteaMetalStyleResolver {
  private let definitions: [UInt32: TRF1StyleDefinition]
  private let theme: GhostteaMetalTheme
  private let adaptation: GhostteaLightRemap?
  private var resolved: [UInt32: GhostteaResolvedMetalStyle] = [:]

  init(
    definitions: [UInt32: TRF1StyleDefinition],
    theme: GhostteaMetalTheme,
    adaptation: GhostteaLightRemap?
  ) {
    self.definitions = definitions
    self.theme = theme
    self.adaptation = adaptation
  }

  /// Whether graphics cells can need a color other than the text color.
  var distinguishesGraphics: Bool { adaptation != nil || theme.minimumContrast > 1 }

  subscript(id: UInt32) -> GhostteaResolvedMetalStyle {
    if let style = resolved[id] { return style }
    let style = resolveStyle(definitions[id], theme: theme, adaptation: adaptation)
    resolved[id] = style
    return style
  }
}

private enum GhostteaMetalGraphicCell {
  case box
  case block
}

enum GhostteaMetalGraphicCells {
  /// Columns holding box-drawing (U+2500–257F) or block-element (U+2580–259F)
  /// characters, found by walking the row text with the desktop's cell widths.
  fileprivate static func cells(in text: String) -> [Int: GhostteaMetalGraphicCell] {
    if text.utf8.allSatisfy({ $0 < 0x80 }) { return [:] }
    var cells: [Int: GhostteaMetalGraphicCell] = [:]
    var column = 0
    for character in text {
      switch character.unicodeScalars.first?.value ?? 0 {
      case 0x2500...0x257F: cells[column] = .box
      case 0x2580...0x259F: cells[column] = .block
      default: break
      }
      column += cellWidth(character)
    }
    return cells
  }

  /// Mirrors `graphemeCellWidth` in `@vibecook/ghosttea-react`. Swift has no
  /// Extended_Pictographic property, so non-ASCII emoji other than regional
  /// indicators stand in for it.
  static func cellWidth(_ character: Character) -> Int {
    let pictographic = character.unicodeScalars.contains {
      $0.value > 0x7F && $0.properties.isEmoji && !(0x1F1E6...0x1F1FF).contains($0.value)
    }
    if pictographic { return 2 }
    switch character.unicodeScalars.first?.value ?? 0 {
    case 0x1100...0x115F, 0x2E80...0xA4CF, 0xAC00...0xD7A3, 0xF900...0xFAFF, 0xFE10...0xFE6F,
      0xFF00...0xFF60, 0x1F300...0x1FAFF, 0x20000...0x3FFFD:
      return 2
    default:
      return 1
    }
  }
}

private func resolveStyle(
  _ style: TRF1StyleDefinition?,
  theme: GhostteaMetalTheme,
  adaptation: GhostteaLightRemap? = nil
) -> GhostteaResolvedMetalStyle {
  var foreground = style?.foreground.map(metalColor) ?? theme.foreground
  var background = style?.background.map(metalColor)
  var fill = foreground
  if let adaptation {
    // Application colors were designed on the app's dark base; theme-owned
    // defaults already belong to the light theme and pass through.
    let sourceForeground = style?.foreground.map { GhostteaLightRGB($0) }
    let sourceBackground = style?.background.map { GhostteaLightRGB($0) }
    if style?.inverse == true {
      background = sourceForeground.map { adaptation.surface($0) } ?? theme.foreground
      foreground =
        sourceBackground.map {
          adaptation.ink(
            $0,
            sourceBackground: sourceForeground ?? adaptation.base,
            paletteIndex: style?.backgroundPalette)
        } ?? theme.background
      fill = foreground
    } else {
      foreground =
        sourceForeground.map {
          adaptation.ink(
            $0,
            sourceBackground: sourceBackground ?? adaptation.base,
            paletteIndex: style?.foregroundPalette)
        } ?? theme.foreground
      background = sourceBackground.map { adaptation.surface($0) }
      fill = sourceForeground.map { adaptation.surface($0) } ?? theme.foreground
    }
  } else if style?.inverse == true {
    let originalForeground = foreground
    foreground = background ?? theme.background
    background = originalForeground
    fill = foreground
  }
  if let cellBackground = background, theme.backgroundOpacityCells {
    background = GhostteaMetalColor(
      red: cellBackground.red,
      green: cellBackground.green,
      blue: cellBackground.blue,
      alpha: theme.background.alpha
    )
  }
  // Graphics and color glyphs keep the raw foreground, as in Ghostty; the
  // backdrop ignores window transparency.
  var text = GhostteaLightColor.ensureContrast(
    foreground,
    background: over(background ?? theme.background, theme.background),
    ratio: theme.minimumContrast
  )
  if style?.faint == true {
    foreground = foreground.withAlpha(foreground.alpha * 0.55)
    fill = fill.withAlpha(fill.alpha * 0.55)
    text = text.withAlpha(text.alpha * 0.55)
  }
  return GhostteaResolvedMetalStyle(
    foreground: foreground,
    background: background,
    fill: fill,
    text: text,
    underline: style?.underline ?? false,
    strikethrough: style?.strikethrough ?? false,
    invisible: style?.invisible ?? false
  )
}

/// Source-over composite of straight-alpha colors.
private func over(
  _ source: GhostteaMetalColor,
  _ backdrop: GhostteaMetalColor
) -> GhostteaMetalColor {
  if source.alpha >= 1 { return source }
  if source.alpha <= 0 { return backdrop }
  let alpha = source.alpha + backdrop.alpha * (1 - source.alpha)
  if alpha <= Float.ulpOfOne { return .clear }
  func channel(_ s: Float, _ b: Float) -> Float {
    (s * source.alpha + b * backdrop.alpha * (1 - source.alpha)) / alpha
  }
  return GhostteaMetalColor(
    red: channel(source.red, backdrop.red),
    green: channel(source.green, backdrop.green),
    blue: channel(source.blue, backdrop.blue),
    alpha: alpha
  )
}

private func metalColor(_ color: TRF1RGB) -> GhostteaMetalColor {
  GhostteaMetalColor(
    red: Float(color.red) / 255,
    green: Float(color.green) / 255,
    blue: Float(color.blue) / 255,
    alpha: 1
  )
}

private func ordered(_ selection: GhostteaMetalSelection?) -> GhostteaMetalSelection? {
  guard let selection else { return nil }
  let anchor = selection.anchor
  let focus = selection.focus
  if anchor.row < focus.row || (anchor.row == focus.row && anchor.column <= focus.column) {
    return selection
  }
  return GhostteaMetalSelection(anchor: focus, focus: anchor)
}

private func selectionContains(_ selection: GhostteaMetalSelection?, row: Int, column: Int) -> Bool
{
  guard let selection, row >= Int(selection.anchor.row), row <= Int(selection.focus.row) else {
    return false
  }
  let first = row == Int(selection.anchor.row) ? Int(selection.anchor.column) : 0
  let last = row == Int(selection.focus.row) ? Int(selection.focus.column) : Int.max
  return column >= first && column <= last
}

private func clipX(_ pixel: Float, width: Int) -> Float {
  pixel / Float(width) * 2 - 1
}

private func clipY(_ pixel: Float, height: Int) -> Float {
  1 - pixel / Float(height) * 2
}

private func pushRectangle(
  into output: inout [GhostteaMetalRectangleInstance],
  x: Float,
  y: Float,
  width: Float,
  height: Float,
  color: GhostteaMetalColor,
  viewportWidth: Int,
  viewportHeight: Int
) {
  let left = clipX(x, width: viewportWidth)
  let right = clipX(x + width, width: viewportWidth)
  let top = clipY(y, height: viewportHeight)
  let bottom = clipY(y + height, height: viewportHeight)
  output.append(
    GhostteaMetalRectangleInstance(
      bounds: SIMD4(left, top, right, bottom),
      color: SIMD4(color.red, color.green, color.blue, color.alpha)
    )
  )
}

private func pushGlyph(
  into output: inout [GhostteaMetalGlyphInstance],
  x: Float,
  y: Float,
  width: Float,
  height: Float,
  location: GhostteaAtlasLocation,
  color: GhostteaMetalColor,
  viewportWidth: Int,
  viewportHeight: Int
) {
  let left = clipX(x, width: viewportWidth)
  let right = clipX(x + width, width: viewportWidth)
  let top = clipY(y, height: viewportHeight)
  let bottom = clipY(y + height, height: viewportHeight)
  output.append(
    GhostteaMetalGlyphInstance(
      bounds: SIMD4(left, top, right, bottom),
      uvBounds: SIMD4(location.u0, location.v0, location.u1, location.v1),
      color: SIMD4(color.red, color.green, color.blue, color.alpha)
    )
  )
}

private func alignedUploadOffset(_ value: Int) -> Int {
  (value + 15) & ~15
}

private func expandedRectangleVertices(
  _ instances: [GhostteaMetalRectangleInstance]
) -> [Float] {
  var output: [Float] = []
  output.reserveCapacity(instances.count * 6 * 6)
  let corners = [(0, 1), (2, 1), (0, 3), (0, 3), (2, 1), (2, 3)]
  for instance in instances {
    for (xIndex, yIndex) in corners {
      output.append(instance.bounds[xIndex])
      output.append(instance.bounds[yIndex])
      output.append(instance.color.x)
      output.append(instance.color.y)
      output.append(instance.color.z)
      output.append(instance.color.w)
    }
  }
  return output
}

private func expandedGlyphVertices(_ instances: [GhostteaMetalGlyphInstance]) -> [Float] {
  var output: [Float] = []
  output.reserveCapacity(instances.count * 6 * 8)
  let corners = [(0, 1), (2, 1), (0, 3), (0, 3), (2, 1), (2, 3)]
  for instance in instances {
    for (xIndex, yIndex) in corners {
      output.append(instance.bounds[xIndex])
      output.append(instance.bounds[yIndex])
      output.append(instance.uvBounds[xIndex])
      output.append(instance.uvBounds[yIndex])
      output.append(instance.color.x)
      output.append(instance.color.y)
      output.append(instance.color.z)
      output.append(instance.color.w)
    }
  }
  return output
}

private func readPixels(texture: any MTLTexture, width: Int, height: Int) -> [UInt8] {
  var pixels = [UInt8](repeating: 0, count: width * height * 4)
  pixels.withUnsafeMutableBytes { bytes in
    texture.getBytes(
      bytes.baseAddress!,
      bytesPerRow: width * 4,
      from: MTLRegionMake2D(0, 0, width, height),
      mipmapLevel: 0
    )
  }
  return pixels
}

private func countNonBackgroundPixels(_ pixels: [UInt8], background: GhostteaMetalColor) -> Int {
  let expected = [background.red, background.green, background.blue, background.alpha].map {
    UInt8(max(0, min(255, ($0 * 255).rounded())))
  }
  var count = 0
  for offset in stride(from: 0, to: pixels.count, by: 4) {
    if pixels[offset] != expected[0] || pixels[offset + 1] != expected[1]
      || pixels[offset + 2] != expected[2] || pixels[offset + 3] != expected[3]
    {
      count += 1
    }
  }
  return count
}

private func fnv1a64(_ bytes: [UInt8]) -> UInt64 {
  var hash: UInt64 = 0xcbf2_9ce4_8422_2325
  for byte in bytes {
    hash ^= UInt64(byte)
    hash &*= 0x0000_0100_0000_01b3
  }
  return hash
}
