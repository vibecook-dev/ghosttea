#if os(iOS)
  import Foundation
  import GhostteaCore
  import GhostteaFrame
  import GhostteaPerformance
  import MetalKit
  import UIKit

  public struct GhostteaTerminalMetalDiagnostics: Equatable, Sendable {
    public let acceptedFrames: Int
    public let renderedFrames: Int
    public let staleFrames: Int
    public let fullRefreshRequests: Int
    public let resourceEvictions: Int
    public let resourceRebuilds: Int
    public let residentAtlasBytes: Int
    public let residentGlyphBytes: Int
    public let reconstructibleBytesEvicted: Int
    public let vertexUploadBytes: UInt64
    public let atlasUploadBytes: UInt64
    public let bufferAllocations: UInt64
    public let drawCalls: UInt64
    public let commandBufferCommits: UInt64
    public let fullDamageSubmissions: Int
    public let rowDamageSubmissions: Int
    public let damagedRowsSubmitted: Int
    public let cursorDamageSubmissions: Int
    public let selectionDamageSubmissions: Int
    public let geometryDamageSubmissions: Int
    public let rowCacheHits: Int
    public let rowCacheAdmissions: Int
    public let rowCacheEvictions: Int
    public let lastError: String?

    init(
      acceptedFrames: Int = 0,
      renderedFrames: Int = 0,
      staleFrames: Int = 0,
      fullRefreshRequests: Int = 0,
      resourceEvictions: Int = 0,
      resourceRebuilds: Int = 0,
      residentAtlasBytes: Int = 0,
      residentGlyphBytes: Int = 0,
      reconstructibleBytesEvicted: Int = 0,
      vertexUploadBytes: UInt64 = 0,
      atlasUploadBytes: UInt64 = 0,
      bufferAllocations: UInt64 = 0,
      drawCalls: UInt64 = 0,
      commandBufferCommits: UInt64 = 0,
      fullDamageSubmissions: Int = 0,
      rowDamageSubmissions: Int = 0,
      damagedRowsSubmitted: Int = 0,
      cursorDamageSubmissions: Int = 0,
      selectionDamageSubmissions: Int = 0,
      geometryDamageSubmissions: Int = 0,
      rowCacheHits: Int = 0,
      rowCacheAdmissions: Int = 0,
      rowCacheEvictions: Int = 0,
      lastError: String? = nil
    ) {
      self.acceptedFrames = acceptedFrames
      self.renderedFrames = renderedFrames
      self.staleFrames = staleFrames
      self.fullRefreshRequests = fullRefreshRequests
      self.resourceEvictions = resourceEvictions
      self.resourceRebuilds = resourceRebuilds
      self.residentAtlasBytes = residentAtlasBytes
      self.residentGlyphBytes = residentGlyphBytes
      self.reconstructibleBytesEvicted = reconstructibleBytesEvicted
      self.vertexUploadBytes = vertexUploadBytes
      self.atlasUploadBytes = atlasUploadBytes
      self.bufferAllocations = bufferAllocations
      self.drawCalls = drawCalls
      self.commandBufferCommits = commandBufferCommits
      self.fullDamageSubmissions = fullDamageSubmissions
      self.rowDamageSubmissions = rowDamageSubmissions
      self.damagedRowsSubmitted = damagedRowsSubmitted
      self.cursorDamageSubmissions = cursorDamageSubmissions
      self.selectionDamageSubmissions = selectionDamageSubmissions
      self.geometryDamageSubmissions = geometryDamageSubmissions
      self.rowCacheHits = rowCacheHits
      self.rowCacheAdmissions = rowCacheAdmissions
      self.rowCacheEvictions = rowCacheEvictions
      self.lastError = lastError
    }
  }

  @MainActor
  public final class GhostteaTerminalMetalView: MTKView, MTKViewDelegate {
    private struct EffectiveGeometry: Equatable {
      let drawableSize: CGSize
      let scale: CGFloat
      let contentInsets: GhostteaTerminalContentInsets
      let gridSize: GhostteaTerminalGridSize
      let cellWidth: Float
      let lineHeight: Float
    }

    private struct PressedHardwareKey {
      let event: GhostteaHardwareKeyEvent
      let handled: Bool
    }

    private enum PointerInteraction {
      case none
      /// The application owns the visible interaction. Direct touch also
      /// records its terminal anchor so iOS can copy authoritatively on lift;
      /// indirect pointers leave it nil and retain desktop's OSC 52 path.
      case remote(copyAnchor: GhostteaTerminalCellPoint?)
      case selection(anchor: GhostteaTerminalCellPoint)
    }

    private enum SelectionSource {
      case host
      case local
      case awaitingHost(
        expected: GhostteaTerminalSelection,
        previous: TRF1SelectionState?
      )
    }

    private final class ScrollMomentumDisplayLinkTarget: NSObject {
      weak var owner: GhostteaTerminalMetalView?

      @MainActor @objc func tick(_ displayLink: CADisplayLink) {
        guard let owner else {
          displayLink.invalidate()
          return
        }
        owner.advanceScrollMomentum(displayLink)
      }
    }

    public var onNeedsFullRefresh: (() -> Void)?
    public var onHardwareKeyEvent: ((GhostteaHardwareKeyEvent) -> Bool)?
    public var onSoftwareInputEvent: ((GhostteaSoftwareInputEvent) -> Void)?
    public var onMarkedTextChange: ((GhostteaMarkedTextState?) -> Void)?
    public var onMouseInputEvent: ((GhostteaTerminalMouseEvent) -> Void)?
    public var onScrollRows: ((Int) -> Void)?
    public var onClipboardWrite: ((String) -> Void)?
    public var onSelectionChange: ((GhostteaTerminalSelection?) -> Void)?
    public var onSelectionCommit: ((GhostteaTerminalSelection) -> Void)?
    public var onSelectAll: (() -> Void)?
    public var onAccessibilityReconnect: (() -> Void)? {
      didSet { scheduleAccessibilityElementUpdate(force: true) }
    }
    public var accessibilityTerminalTitle = "Terminal" {
      didSet { scheduleAccessibilityElementUpdate(force: true) }
    }
    public var accessibilityConnectionState: String? {
      didSet { scheduleAccessibilityElementUpdate(force: true) }
    }
    public var terminalAccessibilitySelectionText: String? {
      didSet { scheduleAccessibilityElementUpdate(force: true) }
    }
    public var forceLocalSelection = false
    public weak var inputDelegate: UITextInputDelegate?
    public var markedTextStyle: [NSAttributedString.Key: Any]? {
      didSet { updateMarkedTextOverlay() }
    }
    public var autocapitalizationType: UITextAutocapitalizationType = .none
    public var autocorrectionType: UITextAutocorrectionType = .no
    public var spellCheckingType: UITextSpellCheckingType = .no
    public var smartQuotesType: UITextSmartQuotesType = .no
    public var smartDashesType: UITextSmartDashesType = .no
    public var smartInsertDeleteType: UITextSmartInsertDeleteType = .no
    public var keyboardType: UIKeyboardType = .default
    public var keyboardAppearance: UIKeyboardAppearance = .dark
    public var returnKeyType: UIReturnKeyType = .default
    public var enablesReturnKeyAutomatically = false
    public var isSecureTextEntry = false
    public var textContentType: UITextContentType?
    public var showsTerminalAccessoryRow = true {
      didSet {
        guard showsTerminalAccessoryRow != oldValue else { return }
        if isFirstResponder { reloadInputViews() }
      }
    }
    public var terminalAccessoryKeys = GhostteaAccessoryKey.terminalDefaults {
      didSet {
        terminalAccessoryInputView.setKeys(terminalAccessoryKeys)
        if isFirstResponder { reloadInputViews() }
      }
    }
    public var focusesInputOnTap = true {
      didSet { inputFocusTapRecognizer.isEnabled = focusesInputOnTap }
    }
    public var onGridSizeChange: ((GhostteaTerminalGridSize) -> Void)? {
      didSet { updateGridSize(notifyUnchanged: true) }
    }
    public var includesSafeAreaInsets = true {
      didSet {
        guard includesSafeAreaInsets != oldValue else { return }
        geometryDidChange()
      }
    }
    public var terminalContentInsets = UIEdgeInsets.zero {
      didSet {
        guard terminalContentInsets != oldValue else { return }
        geometryDidChange()
      }
    }
    public private(set) var terminalTextMetrics = GhostteaTextMetrics()
    public private(set) var configurationWarnings: [String] = []
    public private(set) var diagnostics = GhostteaTerminalMetalDiagnostics()
    public private(set) var currentGridSize: GhostteaTerminalGridSize?
    public private(set) var accessibilitySnapshot = GhostteaTerminalAccessibilitySnapshot(
      rows: [],
      viewportOffset: 0,
      totalRows: 0
    )

    private let metalRuntime: GhostteaMetalRuntime
    private let encodedGeometryReuseEnabled: Bool
    private let inPlaceRetainedStateCommitEnabled: Bool
    private let instancedSubmissionEnabled: Bool
    private let rowGeometryReuseEnabled: Bool
    private let lazyColorAtlasEnabled: Bool
    private var terminalRenderer: GhostteaMetalRenderer?
    private var terminalTheme = GhostteaMetalTheme()
    private var pendingDamage = GhostteaTerminalRenderDamage.full
    private var effectiveGeometry: EffectiveGeometry?
    private var awaitingMemoryPressureRefresh = false
    private var retainedState = RetainedTRF1State()
    private var terminalSelection: GhostteaMetalSelection?
    private var terminalFocused = true
    private var terminalVisible = true
    private var cursorBlinkVisible = true
    private var gpuSuspended = false
    private var compositionBuffer = GhostteaCompositionBuffer()
    private var accessoryInputState = GhostteaAccessoryInputState()
    private var pointerInteraction = PointerInteraction.none
    private var absoluteSelection: GhostteaTerminalSelection?
    private var selectionSource = SelectionSource.host
    private var wheelAccumulator = GhostteaWheelAccumulator()
    private var terminalCellWidth: CGFloat {
      CGFloat(terminalTextMetrics.cellWidthPixels)
    }
    private var terminalLineHeight: CGFloat {
      CGFloat(terminalTextMetrics.lineHeightPixels)
    }
    private var previousScrollTranslation: CGFloat = 0
    private var previousDirectScrollTranslation: CGFloat = 0
    private var scrollMomentumDisplayLink: CADisplayLink?
    private var scrollMomentumVelocity: CGFloat = 0
    private var scrollMomentumLastTimestamp: CFTimeInterval = 0
    private var scrollMomentumLocation = CGPoint.zero
    private lazy var scrollMomentumTarget: ScrollMomentumDisplayLinkTarget = {
      let target = ScrollMomentumDisplayLinkTarget()
      target.owner = self
      return target
    }()
    private var selectionAutoScrollDirection = 0
    private var selectionAutoScrollColumn: UInt16 = 0
    private var selectionAutoScrollTask: Task<Void, Never>?
    private let selectionFeedbackGenerator = UISelectionFeedbackGenerator()
    private var accessibilityElementUpdateTask: Task<Void, Never>?
    private var accessibilityPageScrollPending = false
    private var pressedHardwareKeys: [UInt16: PressedHardwareKey] = [:]
    private let markedTextLabel = UILabel()
    private lazy var textInputTokenizer = UITextInputStringTokenizer(textInput: self)
    private lazy var terminalAccessoryInputView: GhostteaTerminalAccessoryView = {
      let view = GhostteaTerminalAccessoryView(keys: terminalAccessoryKeys)
      view.onKey = { [weak self] key in self?.activateAccessoryKey(key) }
      return view
    }()
    private lazy var inputFocusTapRecognizer = UITapGestureRecognizer(
      target: self,
      action: #selector(handleInputFocusTap)
    )
    private lazy var pointerPanRecognizer: UIPanGestureRecognizer = {
      let recognizer = UIPanGestureRecognizer(target: self, action: #selector(handlePointerPan(_:)))
      recognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
      recognizer.allowedScrollTypesMask = .all
      recognizer.maximumNumberOfTouches = 1
      recognizer.cancelsTouchesInView = false
      return recognizer
    }()
    private lazy var touchSelectionRecognizer: UILongPressGestureRecognizer = {
      let recognizer = UILongPressGestureRecognizer(
        target: self,
        action: #selector(handleTouchSelection(_:))
      )
      recognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
      recognizer.minimumPressDuration = 0.35
      // A resting finger moves more than a mirrored mouse pointer. Keep the
      // pre-recognition tolerance slightly above UIKit's default so ordinary
      // finger jitter does not turn a deliberate hold into a scroll.
      recognizer.allowableMovement = 12
      recognizer.numberOfTouchesRequired = 1
      recognizer.cancelsTouchesInView = false
      recognizer.delaysTouchesBegan = false
      return recognizer
    }()
    private lazy var directScrollRecognizer: UIPanGestureRecognizer = {
      let recognizer = UIPanGestureRecognizer(
        target: self,
        action: #selector(handleDirectScrollPan(_:))
      )
      recognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.direct.rawValue)]
      recognizer.maximumNumberOfTouches = 1
      recognizer.cancelsTouchesInView = false
      return recognizer
    }()
    private lazy var pointerHoverRecognizer = UIHoverGestureRecognizer(
      target: self,
      action: #selector(handlePointerHover(_:))
    )
    private lazy var contextMenuTapRecognizer: UITapGestureRecognizer = {
      let recognizer = UITapGestureRecognizer(
        target: self,
        action: #selector(handleContextMenuTap(_:))
      )
      recognizer.allowedTouchTypes = [NSNumber(value: UITouch.TouchType.indirectPointer.rawValue)]
      recognizer.buttonMaskRequired = .secondary
      recognizer.cancelsTouchesInView = false
      return recognizer
    }()
    private lazy var editMenuInteraction = UIEditMenuInteraction(delegate: self)
    private lazy var cursorBlinkController = GhostteaCursorBlinkController { [weak self] visible in
      self?.applyCursorBlinkVisibility(visible)
    }

    public init(
      terminalFrame: CGRect = .zero,
      encodedGeometryReuseEnabled: Bool = true,
      inPlaceRetainedStateCommitEnabled: Bool = true,
      instancedSubmissionEnabled: Bool = true,
      rowGeometryReuseEnabled: Bool = true,
      lazyColorAtlasEnabled: Bool = true
    ) throws {
      let runtime = try GhostteaMetalRuntime()
      metalRuntime = runtime
      self.encodedGeometryReuseEnabled = encodedGeometryReuseEnabled
      self.inPlaceRetainedStateCommitEnabled = inPlaceRetainedStateCommitEnabled
      self.instancedSubmissionEnabled = instancedSubmissionEnabled
      self.rowGeometryReuseEnabled = rowGeometryReuseEnabled
      self.lazyColorAtlasEnabled = lazyColorAtlasEnabled
      super.init(frame: terminalFrame, device: runtime.device)
      colorPixelFormat = .rgba8Unorm
      clearColor = MTLClearColor(red: 40 / 255, green: 44 / 255, blue: 52 / 255, alpha: 1)
      framebufferOnly = true
      isOpaque = false
      layer.isOpaque = false
      backgroundColor = .clear
      autoResizeDrawable = true
      isPaused = true
      enableSetNeedsDisplay = true
      delegate = self
      inputFocusTapRecognizer.cancelsTouchesInView = false
      addGestureRecognizer(inputFocusTapRecognizer)
      addGestureRecognizer(pointerPanRecognizer)
      // Let UIKit arbitrate physical finger intent. A pan waits only while the
      // long press remains possible: moving beyond its tolerance fails the
      // hold immediately and starts scrolling, while a steady 350 ms hold
      // claims the gesture and keeps the later drag in selection mode.
      directScrollRecognizer.require(toFail: touchSelectionRecognizer)
      addGestureRecognizer(touchSelectionRecognizer)
      addGestureRecognizer(directScrollRecognizer)
      addGestureRecognizer(pointerHoverRecognizer)
      addGestureRecognizer(contextMenuTapRecognizer)
      addInteraction(editMenuInteraction)
      isAccessibilityElement = false
      accessibilityContainerType = .semanticGroup
      markedTextLabel.backgroundColor = UIColor(
        red: 40 / 255,
        green: 44 / 255,
        blue: 52 / 255,
        alpha: 1
      )
      markedTextLabel.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
      markedTextLabel.textColor = UIColor(red: 0.75, green: 0.78, blue: 0.82, alpha: 1)
      markedTextLabel.isHidden = true
      markedTextLabel.isUserInteractionEnabled = false
      markedTextLabel.accessibilityElementsHidden = true
      addSubview(markedTextLabel)
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(applicationDidEnterBackground),
        name: UIApplication.didEnterBackgroundNotification,
        object: nil
      )
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(powerStateDidChange),
        name: .NSProcessInfoPowerStateDidChange,
        object: nil
      )
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(applicationWillEnterForeground),
        name: UIApplication.willEnterForegroundNotification,
        object: nil
      )
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(applicationDidReceiveMemoryWarning),
        name: UIApplication.didReceiveMemoryWarningNotification,
        object: nil
      )
      NotificationCenter.default.addObserver(
        self,
        selector: #selector(voiceOverStatusDidChange),
        name: UIAccessibility.voiceOverStatusDidChangeNotification,
        object: nil
      )
    }

    @available(*, unavailable)
    required init(coder: NSCoder) {
      fatalError("GhostteaTerminalMetalView must be initialized programmatically")
    }

    deinit {
      selectionAutoScrollTask?.cancel()
      accessibilityElementUpdateTask?.cancel()
      NotificationCenter.default.removeObserver(self)
    }

    public override func layoutSubviews() {
      super.layoutSubviews()
      geometryDidChange()
    }

    public override func safeAreaInsetsDidChange() {
      super.safeAreaInsetsDidChange()
      geometryDidChange()
    }

    public override func didMoveToWindow() {
      super.didMoveToWindow()
      updateCursorBlinkSurfaceVisibility()
      updateEffectAnimationState()
    }

    public override var canBecomeFirstResponder: Bool { true }

    public override var inputAccessoryView: UIView? {
      showsTerminalAccessoryRow && !terminalAccessoryKeys.isEmpty
        ? terminalAccessoryInputView : nil
    }

    public var latchedAccessoryModifiers: GhostteaInputModifiers {
      accessoryInputState.modifiers
    }

    public var terminalMouseTrackingEnabled: Bool { retainedState.mouseTracking }

    public func pointerOwner(forceLocalSelection: Bool = false) -> GhostteaPointerOwner {
      .resolve(
        mouseTracking: terminalMouseTrackingEnabled,
        forceLocalSelection: forceLocalSelection
      )
    }

    public func viewportCell(at location: CGPoint) -> GhostteaViewportCellPoint {
      let insets = effectiveContentInsets()
      let x = location.x - CGFloat(insets.left + GhostteaTerminalLayout.horizontalPadding)
      let y = location.y - CGFloat(insets.top + GhostteaTerminalLayout.verticalPadding)
      let maximumColumn = max(0, Int(currentGridSize?.columns ?? retainedState.columns) - 1)
      let maximumRow = max(0, Int(currentGridSize?.rows ?? UInt16(retainedState.rows.count)) - 1)
      let column = max(
        0,
        min(maximumColumn, Int(floor(x / terminalCellWidth)))
      )
      let row = max(
        0,
        min(maximumRow, Int(floor(y / terminalLineHeight)))
      )
      return GhostteaViewportCellPoint(column: UInt16(column), row: UInt16(row))
    }

    public func terminalMouseEvent(
      action: GhostteaMouseAction,
      button: GhostteaMouseButton,
      at location: CGPoint,
      modifiers: GhostteaInputModifiers = []
    ) -> GhostteaTerminalMouseEvent {
      let insets = effectiveContentInsets()
      return GhostteaTerminalMouseEvent(
        action: action,
        button: button,
        modifiers: modifiers,
        x: Float(max(0, min(bounds.width, location.x))),
        y: Float(max(0, min(bounds.height, location.y))),
        screenWidth: Self.boundedGeometry(bounds.width),
        screenHeight: Self.boundedGeometry(bounds.height),
        cellWidth: Self.boundedGeometry(terminalCellWidth),
        cellHeight: Self.boundedGeometry(terminalLineHeight),
        paddingLeft: Self.boundedGeometry(
          CGFloat(insets.left + GhostteaTerminalLayout.horizontalPadding)),
        paddingTop: Self.boundedGeometry(
          CGFloat(insets.top + GhostteaTerminalLayout.verticalPadding))
      )
    }

    @discardableResult
    public func focusTerminalInput() -> Bool {
      let focused = becomeFirstResponder()
      if focused { setTerminalFocused(true) }
      return focused
    }

    @objc private func handleInputFocusTap() {
      _ = focusTerminalInput()
    }

    public override func resignFirstResponder() -> Bool {
      let resigned = super.resignFirstResponder()
      if resigned {
        stopSelectionAutoScroll()
        commitMarkedTextIfNeeded()
        clearAccessoryModifiers()
        releaseHandledHardwareKeys()
        setTerminalFocused(false)
      }
      return resigned
    }

    public override func pressesBegan(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
      let unhandled = handleHardwarePresses(presses, ending: false)
      if !unhandled.isEmpty { super.pressesBegan(unhandled, with: event) }
    }

    public override func pressesEnded(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
      let unhandled = handleHardwarePresses(presses, ending: true)
      if !unhandled.isEmpty { super.pressesEnded(unhandled, with: event) }
    }

    public override func pressesCancelled(_ presses: Set<UIPress>, with event: UIPressesEvent?) {
      let unhandled = handleHardwarePresses(presses, ending: true)
      if !unhandled.isEmpty { super.pressesCancelled(unhandled, with: event) }
    }

    public override func paste(_ sender: Any?) {
      guard let text = UIPasteboard.general.string, !text.isEmpty else { return }
      commitMarkedTextIfNeeded()
      emitSoftwareInputEvents([.paste(text)])
    }

    public func activateAccessoryKey(_ key: GhostteaAccessoryKey) {
      switch key {
      case .control, .option:
        break
      default:
        commitMarkedTextIfNeeded()
      }
      let event = accessoryInputState.activate(key)
      updateAccessoryModifierPresentation()
      if let event { emitSoftwareInputEvents([event]) }
    }

    private static func boundedGeometry(_ value: CGFloat) -> UInt32 {
      UInt32(max(0, min(CGFloat(UInt32.max), value.rounded())))
    }

    @discardableResult
    public func apply(frame data: Data) throws -> Bool {
      do {
        let previousCursor = retainedState.cursor
        let previousSelection = retainedState.selection
        let applyResult = try GhostteaPerformanceRecorder.shared.measure(
          .frameDecode, byteCount: data.count
        ) {
          try retainedState.apply(
            data,
            inPlaceCommitEnabled: inPlaceRetainedStateCommitEnabled
          )
        }
        switch applyResult {
        case .applied(let fullSnapshot, let changedRows, _, let clipboardWrites):
          if fullSnapshot { awaitingMemoryPressureRefresh = false }
          if previousSelection != retainedState.selection {
            traceSelection(
              "frame applied previous=\(Self.describe(previousSelection)) next=\(Self.describe(retainedState.selection))"
            )
          }
          synchronizeTrackedSelection()
          updateAccessibilitySnapshot()
          if accessibilityPageScrollPending {
            accessibilityPageScrollPending = false
            UIAccessibility.post(
              notification: .pageScrolled,
              argument: accessibilitySnapshot.visibleRangeDescription
            )
          }
          updateAutoScrollSelectionAfterFrame()
          updateRenderedSelection()
          updateCursorBlinkSurfaceVisibility()
          cursorBlinkController.updateCursor(retainedState.cursor)
          updateMarkedTextOverlay()
          for text in clipboardWrites { onClipboardWrite?(text) }
          updateDiagnostics(
            acceptedFrames: diagnostics.acceptedFrames + 1,
            residentGlyphBytes: retainedState.residentGlyphPixelBytes,
            clearError: true)
          var damage =
            fullSnapshot
            ? GhostteaTerminalRenderDamage.full : GhostteaTerminalRenderDamage.rows(changedRows)
          if previousCursor != retainedState.cursor { damage.formUnion(.cursor) }
          requestEventDrivenDraw(damage: damage)
          return true
        case .stale:
          updateDiagnostics(staleFrames: diagnostics.staleFrames + 1)
          return false
        case .needsFullRefresh:
          requestFullRefresh()
          return false
        }
      } catch {
        updateDiagnostics(lastError: "Terminal frame rejected")
        requestFullRefresh()
        throw error
      }
    }

    public func setSelection(
      anchorColumn: UInt16,
      anchorRow: UInt16,
      focusColumn: UInt16,
      focusRow: UInt16
    ) {
      let offset = retainedState.scrollbar?.offset ?? 0
      setSelection(
        GhostteaTerminalSelection(
          anchor: GhostteaTerminalCellPoint(
            column: anchorColumn,
            row: UInt32(min(UInt64(UInt32.max), offset + UInt64(anchorRow)))
          ),
          focus: GhostteaTerminalCellPoint(
            column: focusColumn,
            row: UInt32(min(UInt64(UInt32.max), offset + UInt64(focusRow)))
          )
        )
      )
    }

    public func clearSelection() {
      guard absoluteSelection != nil || terminalSelection != nil else { return }
      absoluteSelection = nil
      selectionSource = .local
      terminalSelection = nil
      onSelectionChange?(nil)
      updateAccessibilitySnapshot()
      requestEventDrivenDraw(damage: .selection)
    }

    public var selection: GhostteaTerminalSelection? { absoluteSelection }

    public func setSelection(_ selection: GhostteaTerminalSelection?) {
      absoluteSelection = selection
      selectionSource = .local
      updateRenderedSelection()
      onSelectionChange?(selection)
      updateAccessibilitySnapshot()
    }

    public func selectAllTerminal() {
      let total = retainedState.scrollbar?.total ?? UInt64(retainedState.rows.count)
      let columns = max(1, currentGridSize?.columns ?? retainedState.columns)
      guard
        let selection = GhostteaTerminalSelection.selectAll(
          totalRows: total,
          columns: columns
        )
      else { return }
      setSelection(selection)
      onSelectAll?()
    }

    public override func accessibilityScroll(_ direction: UIAccessibilityScrollDirection) -> Bool {
      guard let onScrollRows else { return false }
      let pageRows = max(1, Int(currentGridSize?.rows ?? UInt16(retainedState.rows.count)))
      let delta: Int
      switch direction {
      case .up, .next:
        delta = pageRows
      case .down, .previous:
        delta = -pageRows
      default:
        return false
      }
      accessibilityPageScrollPending = true
      onScrollRows(delta)
      return true
    }

    public override func accessibilityPerformEscape() -> Bool {
      resignFirstResponder()
    }

    private func updateAccessibilitySnapshot() {
      let next = GhostteaPerformanceRecorder.shared.measure(.accessibilityUpdate) {
        GhostteaTerminalAccessibilitySnapshot(
          retainedState: retainedState,
          selection: absoluteSelection
        )
      }
      guard next != accessibilitySnapshot else { return }
      accessibilitySnapshot = next
      scheduleAccessibilityElementUpdate()
    }

    private func scheduleAccessibilityElementUpdate(force: Bool = false) {
      guard retainedState.sessionHandle != 0 else { return }
      accessibilityElementUpdateTask?.cancel()
      guard UIAccessibility.isVoiceOverRunning else {
        accessibilityElementUpdateTask = nil
        accessibilityElements = nil
        return
      }
      if force {
        rebuildAccessibilityElements()
        return
      }
      accessibilityElementUpdateTask = Task { [weak self] in
        try? await Task.sleep(for: .milliseconds(100))
        guard !Task.isCancelled else { return }
        self?.rebuildAccessibilityElements()
      }
    }

    @objc private func voiceOverStatusDidChange() {
      scheduleAccessibilityElementUpdate(force: true)
    }

    private func rebuildAccessibilityElements() {
      accessibilityElementUpdateTask?.cancel()
      accessibilityElementUpdateTask = nil
      let insets = effectiveContentInsets()
      let rowActions = accessibilityRowActions()
      var elements: [UIAccessibilityElement] = [accessibilitySummaryElement()]
      elements += accessibilitySnapshot.rows.map { row in
        let element = UIAccessibilityElement(accessibilityContainer: self)
        element.accessibilityIdentifier = "ghosttea.terminal.row.\(row.absoluteRow)"
        element.accessibilityLabel = row.text.isEmpty ? "Blank" : row.text
        var values = ["Row \(row.absoluteRow + 1) of \(accessibilitySnapshot.totalRows)"]
        if let cursorColumn = row.cursorColumn {
          values.append("Cursor column \(cursorColumn + 1)")
        }
        if row.isSelected { values.append("Selected") }
        element.accessibilityValue = values.joined(separator: ", ")
        element.accessibilityTraits =
          row.isSelected
          ? [.staticText, .updatesFrequently, .selected] : [.staticText, .updatesFrequently]
        element.accessibilityFrameInContainerSpace = CGRect(
          x: CGFloat(insets.left + GhostteaTerminalLayout.horizontalPadding),
          y: CGFloat(insets.top + GhostteaTerminalLayout.verticalPadding)
            + CGFloat(row.viewportRow) * terminalLineHeight,
          width: max(
            0,
            bounds.width
              - CGFloat(insets.left + insets.right + 2 * GhostteaTerminalLayout.horizontalPadding)
          ),
          height: terminalLineHeight
        )
        element.accessibilityCustomActions = rowActions
        return element
      }
      accessibilityElements = elements
    }

    private func accessibilitySummaryElement() -> UIAccessibilityElement {
      let element = UIAccessibilityElement(accessibilityContainer: self)
      element.accessibilityIdentifier = "ghosttea.terminal.summary"
      element.accessibilityLabel = accessibilityTerminalTitle
      var values = [accessibilitySnapshot.visibleRangeDescription]
      if let accessibilityConnectionState, !accessibilityConnectionState.isEmpty {
        values.insert(accessibilityConnectionState, at: 0)
      }
      if let terminalAccessibilitySelectionText, !terminalAccessibilitySelectionText.isEmpty {
        values.append("Selected text: \(terminalAccessibilitySelectionText)")
      }
      element.accessibilityValue = values.joined(separator: ". ")
      element.accessibilityTraits = .header
      var actions = [
        UIAccessibilityCustomAction(
          name: "Focus Terminal",
          target: self,
          selector: #selector(accessibilityFocusTerminal)
        )
      ]
      if onAccessibilityReconnect != nil {
        actions.append(
          UIAccessibilityCustomAction(
            name: "Reconnect",
            target: self,
            selector: #selector(accessibilityReconnect)
          )
        )
      }
      element.accessibilityCustomActions = actions
      return element
    }

    private func accessibilityRowActions() -> [UIAccessibilityCustomAction] {
      [
        UIAccessibilityCustomAction(
          name: "Copy",
          target: self,
          selector: #selector(accessibilityCopySelection)
        ),
        UIAccessibilityCustomAction(
          name: "Select All",
          target: self,
          selector: #selector(accessibilitySelectAllTerminal)
        ),
        UIAccessibilityCustomAction(
          name: "Paste",
          target: self,
          selector: #selector(accessibilityPaste)
        ),
      ]
    }

    @objc private func accessibilityCopySelection() -> Bool {
      guard let selection = absoluteSelection else { return false }
      onSelectionCommit?(selection)
      return true
    }

    @objc private func accessibilitySelectAllTerminal() -> Bool {
      selectAllTerminal()
      return absoluteSelection != nil
    }

    @objc private func accessibilityPaste() -> Bool {
      guard UIPasteboard.general.hasStrings else { return false }
      paste(nil)
      return true
    }

    @objc private func accessibilityFocusTerminal() -> Bool {
      focusTerminalInput()
    }

    @objc private func accessibilityReconnect() -> Bool {
      guard let onAccessibilityReconnect else { return false }
      onAccessibilityReconnect()
      return true
    }

    public func setTerminalFocused(_ focused: Bool) {
      guard terminalFocused != focused else { return }
      terminalFocused = focused
      cursorBlinkController.setFocused(focused)
      requestEventDrivenDraw(damage: .cursor)
    }

    public func setTerminalVisible(_ visible: Bool) {
      guard terminalVisible != visible else { return }
      terminalVisible = visible
      if !visible { stopScrollMomentum() }
      updateCursorBlinkSurfaceVisibility()
      updateEffectAnimationState()
      if visible { requestEventDrivenDraw(damage: .full) }
    }

    public func noteCursorActivity() {
      cursorBlinkController.noteCursorActivity()
    }

    private func handleHardwarePresses(
      _ presses: Set<UIPress>,
      ending: Bool
    ) -> Set<UIPress> {
      var unhandled: Set<UIPress> = []
      for press in presses {
        guard let key = press.key else {
          unhandled.insert(press)
          continue
        }
        let usage = UInt16(key.keyCode.rawValue)
        let action: GhostteaHardwareKeyAction
        if ending {
          action = .up
        } else if pressedHardwareKeys[usage] == nil {
          action = .down
        } else {
          action = .repeated
        }
        guard
          let hardwareEvent = GhostteaHardwareKeyEvent(
            hidUsage: usage,
            characters: key.characters,
            charactersIgnoringModifiers: key.charactersIgnoringModifiers,
            modifiers: GhostteaInputModifiers(key.modifierFlags),
            action: action
          )
        else {
          unhandled.insert(press)
          continue
        }
        let pressed = pressedHardwareKeys[usage]
        let handled: Bool
        if let pressed {
          handled = pressed.handled
          if handled { _ = onHardwareKeyEvent?(hardwareEvent) }
        } else {
          handled = onHardwareKeyEvent?(hardwareEvent) == true
        }
        if ending {
          pressedHardwareKeys[usage] = nil
        } else if pressed == nil {
          pressedHardwareKeys[usage] = PressedHardwareKey(event: hardwareEvent, handled: handled)
        }
        guard handled else {
          unhandled.insert(press)
          continue
        }
        noteCursorActivity()
      }
      return unhandled
    }

    private func releaseHandledHardwareKeys() {
      let handled = pressedHardwareKeys.values.filter(\.handled)
      pressedHardwareKeys.removeAll(keepingCapacity: true)
      for pressed in handled {
        _ = onHardwareKeyEvent?(pressed.event.replacingAction(.up))
      }
    }

    @objc private func handlePointerPan(_ recognizer: UIPanGestureRecognizer) {
      if recognizer.state == .began { stopScrollMomentum() }
      if recognizer.numberOfTouches == 0, case .none = pointerInteraction {
        handleScrollPan(recognizer)
        return
      }
      let location = recognizer.location(in: self)
      let modifiers = currentPointerModifiers
      switch recognizer.state {
      case .began:
        _ = focusTerminalInput()
        if pointerOwner(
          forceLocalSelection: forceLocalSelection || modifiers.contains(.shift)
        ) == .remoteApplication {
          pointerInteraction = .remote(copyAnchor: nil)
          emitMouse(action: .press, button: .left, at: location, modifiers: modifiers)
        } else {
          let anchor = terminalCell(at: location)
          pointerInteraction = .selection(anchor: anchor)
          updateLocalSelection(anchor: anchor, focus: anchor)
        }
      case .changed:
        switch pointerInteraction {
        case .remote:
          emitMouse(action: .motion, button: .left, at: location, modifiers: modifiers)
        case .selection(let anchor):
          updateLocalSelection(anchor: anchor, focus: terminalCell(at: location))
          updateSelectionAutoScroll(at: location)
        case .none:
          break
        }
      case .ended, .cancelled, .failed:
        finishPointerInteraction(at: location, modifiers: modifiers)
      default:
        break
      }
    }

    @objc private func handleTouchSelection(_ recognizer: UILongPressGestureRecognizer) {
      let location = recognizer.location(in: self)
      let modifiers = currentPointerModifiers
      switch recognizer.state {
      case .began:
        stopScrollMomentum()
        _ = focusTerminalInput()
        selectionFeedbackGenerator.prepare()
        selectionFeedbackGenerator.selectionChanged()
        if pointerOwner(
          forceLocalSelection: forceLocalSelection || modifiers.contains(.shift)
        ) == .remoteApplication {
          clearSelection()
          // The host copy requested on lift creates tracked pins for this
          // view. Claude still owns the visible selection, so do not adopt
          // those pins as a second, fixed-row overlay.
          selectionSource = .local
          pointerInteraction = .remote(copyAnchor: terminalCell(at: location))
          emitMouse(action: .press, button: .left, at: location, modifiers: modifiers)
          traceSelection("physical hold began owner=application")
        } else {
          let anchor = terminalCell(at: location)
          pointerInteraction = .selection(anchor: anchor)
          updateLocalSelection(anchor: anchor, focus: anchor)
          traceSelection(
            "physical hold began owner=terminal at=(\(anchor.column),\(anchor.row))"
          )
        }
      case .changed:
        switch pointerInteraction {
        case .remote:
          emitMouse(action: .motion, button: .left, at: location, modifiers: modifiers)
        case .selection(let anchor):
          updateLocalSelection(anchor: anchor, focus: terminalCell(at: location))
          updateSelectionAutoScroll(at: location)
        case .none:
          break
        }
      case .ended, .cancelled, .failed:
        finishPointerInteraction(at: location, modifiers: modifiers)
      default:
        break
      }
    }

    @objc private func handleDirectScrollPan(_ recognizer: UIPanGestureRecognizer) {
      let location = recognizer.location(in: self)
      let translation = recognizer.translation(in: self).y
      switch recognizer.state {
      case .began:
        stopScrollMomentum()
        _ = focusTerminalInput()
        previousDirectScrollTranslation = 0
        wheelAccumulator.reset()
        traceSelection("physical pan won gesture arbitration")
        emitDirectScrollDelta(translation, at: location)
      case .changed:
        emitDirectScrollDelta(
          translation - previousDirectScrollTranslation,
          at: location
        )
      case .ended:
        emitDirectScrollDelta(
          translation - previousDirectScrollTranslation,
          at: location
        )
        previousDirectScrollTranslation = 0
        let velocity = -recognizer.velocity(in: self).y
        if abs(velocity) >= CGFloat(GhostteaScrollMomentum.launchVelocityPointsPerSecond) {
          startScrollMomentum(velocity: velocity, at: location)
        } else {
          wheelAccumulator.reset()
        }
      case .cancelled, .failed:
        previousDirectScrollTranslation = 0
        wheelAccumulator.reset()
      default:
        break
      }
    }

    private func emitDirectScrollDelta(_ delta: CGFloat, at location: CGPoint) {
      previousDirectScrollTranslation += delta
      guard abs(delta) > .ulpOfOne else { return }
      emitScroll(
        deltaPoints: GhostteaScrollGesture.deltaPoints(
          translationDelta: Double(delta), directTouch: true),
        at: location
      )
    }

    @objc private func handlePointerHover(_ recognizer: UIHoverGestureRecognizer) {
      guard terminalMouseTrackingEnabled, !forceLocalSelection else { return }
      switch recognizer.state {
      case .began, .changed:
        emitMouse(
          action: .motion,
          button: .none,
          at: recognizer.location(in: self),
          modifiers: currentPointerModifiers
        )
      default:
        break
      }
    }

    @objc private func handleContextMenuTap(_ recognizer: UITapGestureRecognizer) {
      guard recognizer.state == .ended else { return }
      _ = focusTerminalInput()
      editMenuInteraction.presentEditMenu(
        with: UIEditMenuConfiguration(
          identifier: nil,
          sourcePoint: recognizer.location(in: self)
        )
      )
    }

    private func handleScrollPan(_ recognizer: UIPanGestureRecognizer) {
      let translation = recognizer.translation(in: self).y
      if recognizer.state == .began {
        previousScrollTranslation = 0
        wheelAccumulator.reset()
      }
      let delta = translation - previousScrollTranslation
      previousScrollTranslation = translation
      let completesGesture =
        recognizer.state == .ended || recognizer.state == .cancelled
        || recognizer.state == .failed
      defer {
        if completesGesture {
          previousScrollTranslation = 0
          wheelAccumulator.reset()
        }
      }
      let rows = wheelAccumulator.consume(
        deltaPoints: GhostteaScrollGesture.deltaPoints(
          translationDelta: Double(delta), directTouch: false),
        lineHeight: Double(terminalLineHeight)
      )
      emitScrollRows(rows, at: recognizer.location(in: self))
    }

    private func emitScroll(deltaPoints: Double, at location: CGPoint) {
      let rows = wheelAccumulator.consume(
        deltaPoints: deltaPoints,
        lineHeight: Double(terminalLineHeight)
      )
      emitScrollRows(rows, at: location)
    }

    private func emitScrollRows(_ rows: Int, at location: CGPoint) {
      guard rows != 0 else { return }
      let modifiers = currentPointerModifiers
      let routesToApplication =
        terminalMouseTrackingEnabled && !(forceLocalSelection || modifiers.contains(.shift))
      if routesToApplication {
        let button: GhostteaMouseButton = rows < 0 ? .scrollUp : .scrollDown
        for _ in 0..<min(12, abs(rows)) {
          emitMouse(
            action: .press,
            button: button,
            at: location,
            modifiers: modifiers
          )
        }
      } else {
        onScrollRows?(rows)
      }
    }

    private func startScrollMomentum(velocity: CGFloat, at location: CGPoint) {
      stopScrollMomentum(resetAccumulator: false)
      scrollMomentumVelocity = velocity
      scrollMomentumLocation = location
      scrollMomentumLastTimestamp = 0
      let displayLink = CADisplayLink(
        target: scrollMomentumTarget,
        selector: #selector(ScrollMomentumDisplayLinkTarget.tick(_:))
      )
      displayLink.preferredFrameRateRange = CAFrameRateRange(
        minimum: 30,
        maximum: 120,
        preferred: 120
      )
      scrollMomentumDisplayLink = displayLink
      displayLink.add(to: .main, forMode: .common)
    }

    private func advanceScrollMomentum(_ displayLink: CADisplayLink) {
      guard displayLink === scrollMomentumDisplayLink else {
        displayLink.invalidate()
        return
      }
      guard terminalVisible, window != nil else {
        stopScrollMomentum()
        return
      }
      guard scrollMomentumLastTimestamp != 0 else {
        scrollMomentumLastTimestamp = displayLink.timestamp
        return
      }
      let elapsed = min(0.05, max(0, displayLink.timestamp - scrollMomentumLastTimestamp))
      scrollMomentumLastTimestamp = displayLink.timestamp
      guard elapsed > 0 else { return }
      emitScroll(
        deltaPoints: Double(scrollMomentumVelocity) * elapsed,
        at: scrollMomentumLocation
      )
      scrollMomentumVelocity = CGFloat(
        GhostteaScrollMomentum.deceleratedVelocity(
          Double(scrollMomentumVelocity),
          elapsedSeconds: elapsed
        )
      )
      if !GhostteaScrollMomentum.shouldContinue(velocity: Double(scrollMomentumVelocity)) {
        stopScrollMomentum()
      }
    }

    private func stopScrollMomentum(resetAccumulator: Bool = true) {
      scrollMomentumDisplayLink?.invalidate()
      scrollMomentumDisplayLink = nil
      scrollMomentumVelocity = 0
      scrollMomentumLastTimestamp = 0
      if resetAccumulator { wheelAccumulator.reset() }
    }

    private var currentPointerModifiers: GhostteaInputModifiers {
      pressedHardwareKeys.values.reduce(into: GhostteaInputModifiers()) { result, pressed in
        result.formUnion(pressed.event.modifiers)
      }
    }

    private func terminalCell(at location: CGPoint) -> GhostteaTerminalCellPoint {
      let viewport = viewportCell(at: location)
      let offset = retainedState.scrollbar?.offset ?? 0
      let row = UInt32(min(UInt64(UInt32.max), offset + UInt64(viewport.row)))
      return GhostteaTerminalCellPoint(column: viewport.column, row: row)
    }

    private func updateLocalSelection(
      anchor: GhostteaTerminalCellPoint,
      focus: GhostteaTerminalCellPoint
    ) {
      let selection = GhostteaTerminalSelection(anchor: anchor, focus: focus)
      absoluteSelection = selection
      selectionSource = .local
      updateRenderedSelection()
      onSelectionChange?(selection)
      updateAccessibilitySnapshot()
    }

    private func finishPointerInteraction(
      at location: CGPoint,
      modifiers: GhostteaInputModifiers
    ) {
      stopSelectionAutoScroll()
      switch pointerInteraction {
      case .remote(let copyAnchor):
        emitMouse(action: .release, button: .left, at: location, modifiers: modifiers)
        if let copyAnchor,
          let selection = GhostteaSelectionCompletion.resolve(
            anchor: copyAnchor,
            focus: terminalCell(at: location)
          )
        {
          traceSelection("application selection fallback copy=\(Self.describe(selection))")
          onSelectionCommit?(selection)
        }
      case .selection(let anchor):
        let focus = terminalCell(at: location)
        if let selection = GhostteaSelectionCompletion.resolve(
          anchor: anchor,
          focus: focus
        ) {
          absoluteSelection = selection
          updateRenderedSelection()
          onSelectionChange?(selection)
          updateAccessibilitySnapshot()
          selectionSource = .awaitingHost(
            expected: selection,
            previous: retainedState.selection
          )
          traceSelection(
            "commit expected=\(Self.describe(selection)) previous=\(Self.describe(retainedState.selection))"
          )
          onSelectionCommit?(selection)
        } else {
          absoluteSelection = nil
          selectionSource = .local
          updateRenderedSelection()
          onSelectionChange?(nil)
          updateAccessibilitySnapshot()
        }
      case .none:
        break
      }
      pointerInteraction = .none
    }

    private func updateSelectionAutoScroll(at location: CGPoint) {
      let direction = GhostteaSelectionAutoScroll.direction(
        y: Double(location.y),
        minimum: Double(bounds.minY),
        maximum: Double(bounds.maxY)
      )
      guard direction != 0 else {
        stopSelectionAutoScroll()
        return
      }
      selectionAutoScrollColumn = viewportCell(at: location).column
      guard selectionAutoScrollDirection != direction || selectionAutoScrollTask == nil else {
        return
      }
      selectionAutoScrollDirection = direction
      selectionAutoScrollTask?.cancel()
      selectionAutoScrollTask = Task { [weak self] in
        while !Task.isCancelled {
          try? await Task.sleep(for: .milliseconds(40))
          guard !Task.isCancelled, let self else { return }
          self.onScrollRows?(direction)
        }
      }
    }

    private func stopSelectionAutoScroll() {
      selectionAutoScrollDirection = 0
      selectionAutoScrollTask?.cancel()
      selectionAutoScrollTask = nil
    }

    private func updateAutoScrollSelectionAfterFrame() {
      guard selectionAutoScrollDirection != 0,
        case .selection(let anchor) = pointerInteraction
      else { return }
      let offset = retainedState.scrollbar?.offset ?? 0
      let viewportRows = max(1, currentGridSize?.rows ?? UInt16(retainedState.rows.count))
      let viewportRow: UInt16 = selectionAutoScrollDirection < 0 ? 0 : viewportRows - 1
      let focus = GhostteaTerminalCellPoint(
        column: selectionAutoScrollColumn,
        row: UInt32(min(UInt64(UInt32.max), offset + UInt64(viewportRow)))
      )
      updateLocalSelection(anchor: anchor, focus: focus)
    }

    private func emitMouse(
      action: GhostteaMouseAction,
      button: GhostteaMouseButton,
      at location: CGPoint,
      modifiers: GhostteaInputModifiers
    ) {
      onMouseInputEvent?(
        terminalMouseEvent(
          action: action,
          button: button,
          at: location,
          modifiers: modifiers
        )
      )
      noteCursorActivity()
    }

    private func updateRenderedSelection() {
      guard let absoluteSelection,
        let viewport = absoluteSelection.viewportSelection(
          offset: retainedState.scrollbar?.offset ?? 0,
          columns: currentGridSize?.columns ?? retainedState.columns,
          rows: currentGridSize?.rows ?? UInt16(retainedState.rows.count)
        )
      else {
        guard terminalSelection != nil else { return }
        terminalSelection = nil
        requestEventDrivenDraw(damage: .selection)
        return
      }
      let next = GhostteaMetalSelection(
        anchor: GhostteaMetalCellPoint(
          column: viewport.anchor.column,
          row: viewport.anchor.row
        ),
        focus: GhostteaMetalCellPoint(
          column: viewport.focus.column,
          row: viewport.focus.row
        )
      )
      guard next != terminalSelection else { return }
      terminalSelection = next
      requestEventDrivenDraw(damage: .selection)
    }

    private func synchronizeTrackedSelection() {
      let tracked = retainedState.selection.map(Self.terminalSelection)
      switch selectionSource {
      case .local:
        return
      case .host:
        guard absoluteSelection != tracked else { return }
        traceSelection("adopt host=\(Self.describe(tracked))")
        replaceSelectionFromHost(tracked)
      case .awaitingHost(let expected, let previous):
        guard let tracked else {
          traceSelection("awaiting host expected=\(Self.describe(expected)); received clear")
          return
        }
        // Ordinary remote row frames can still contain the host's previous
        // selection while the selection RPC is in flight. Only hand control
        // back when the expected selection (or a newly tracked successor) has
        // actually arrived.
        guard tracked == expected || retainedState.selection != previous else {
          traceSelection(
            "awaiting host expected=\(Self.describe(expected)); retained previous selection"
          )
          return
        }
        selectionSource = .host
        traceSelection("host took ownership selection=\(Self.describe(tracked))")
        replaceSelectionFromHost(tracked)
      }
    }

    private func traceSelection(_ message: @autoclosure () -> String) {
      #if DEBUG
        guard ProcessInfo.processInfo.environment["GHOSTTEA_SELECTION_TRACE"] == "1" else {
          return
        }
        print("[GhostteaSelection] metal \(message())")
      #endif
    }

    private static func describe(_ selection: GhostteaTerminalSelection?) -> String {
      guard let selection else { return "nil" }
      let anchor = selection.anchor
      let focus = selection.focus
      return "(\(anchor.column),\(anchor.row))->(\(focus.column),\(focus.row))"
    }

    private static func describe(_ selection: TRF1SelectionState?) -> String {
      guard let selection else { return "nil" }
      let anchor = selection.anchor
      let focus = selection.focus
      return "(\(anchor.column),\(anchor.row))->(\(focus.column),\(focus.row))"
    }

    private func replaceSelectionFromHost(_ selection: GhostteaTerminalSelection?) {
      guard absoluteSelection != selection else { return }
      absoluteSelection = selection
      onSelectionChange?(selection)
    }

    private static func terminalSelection(
      _ selection: TRF1SelectionState
    ) -> GhostteaTerminalSelection {
      GhostteaTerminalSelection(
        anchor: GhostteaTerminalCellPoint(
          column: selection.anchor.column,
          row: selection.anchor.row
        ),
        focus: GhostteaTerminalCellPoint(
          column: selection.focus.column,
          row: selection.focus.row
        )
      )
    }

    private func applyCursorBlinkVisibility(_ visible: Bool) {
      guard cursorBlinkVisible != visible else { return }
      cursorBlinkVisible = visible
      requestEventDrivenDraw(damage: .cursor)
    }

    public func prepareGPUResources() throws {
      guard !gpuSuspended else { return }
      _ = try renderer()
    }

    /// Applies the renderer-owned portion of the shared Ghostty configuration.
    /// The runtime must be built from the same snapshot before terminal
    /// creation so shaping and this view's interactive geometry stay aligned.
    /// Host-local shader paths are surfaced rather than silently approximated.
    public func applyConfiguration(_ config: GhostteaConfigSnapshot) {
      applyConfiguration(config.terminalPresentation)
    }

    public func applyConfiguration(_ config: GhostteaTerminalPresentationConfig) {
      guard config.isValid else {
        configurationWarnings = ["remote terminal presentation configuration is invalid"]
        return
      }
      let nextMetrics = GhostteaTextMetrics(presentation: config)
      let metricsChanged =
        nextMetrics.cellWidthPixels != terminalTextMetrics.cellWidthPixels
        || nextMetrics.lineHeightPixels != terminalTextMetrics.lineHeightPixels
      terminalTextMetrics = nextMetrics
      if metricsChanged {
        evictRendererResources()
        effectiveGeometry = nil
      }
      markedTextLabel.font = .monospacedSystemFont(
        ofSize: CGFloat(terminalTextMetrics.fontSizePixels),
        weight: .regular
      )
      func color(_ components: [UInt8], alpha: Float = 1) -> GhostteaMetalColor? {
        guard components.count == 3 else { return nil }
        return GhostteaMetalColor(
          red: Float(components[0]) / 255,
          green: Float(components[1]) / 255,
          blue: Float(components[2]) / 255,
          alpha: alpha
        )
      }
      if let background = color(config.background, alpha: config.backgroundOpacity),
        let foreground = color(config.foreground),
        let cursor = color(config.cursor),
        let cursorText = color(config.cursorText),
        let selection = color(config.selectionBackground),
        let selectionForeground = color(config.selectionForeground)
      {
        var effects = config.shaderEffects.compactMap(GhostteaMetalShaderEffect.init)
        if effects.isEmpty, config.postProcess == .betterCRT { effects = [.betterCRT] }
        effects = Array(effects.prefix(16))
        terminalTheme = GhostteaMetalTheme(
          background: background,
          foreground: foreground,
          cursor: cursor,
          cursorText: cursorText,
          selection: selection,
          selectionForeground: selectionForeground,
          backgroundOpacityCells: config.backgroundOpacityCells,
          shaderEffects: effects,
          shaderAnimation: config.customShaderAnimation,
          lightAdaptation: config.lightAdaptation == .auto,
          minimumContrast: config.minimumContrast.isFinite
            ? min(21, max(1, config.minimumContrast)) : 1
        )
        clearColor = MTLClearColor(
          red: Double(background.red * background.alpha),
          green: Double(background.green * background.alpha),
          blue: Double(background.blue * background.alpha),
          alpha: Double(background.alpha)
        )
        markedTextLabel.backgroundColor = UIColor(
          red: CGFloat(background.red),
          green: CGFloat(background.green),
          blue: CGFloat(background.blue),
          alpha: CGFloat(background.alpha)
        )
        markedTextLabel.textColor = UIColor(
          red: CGFloat(foreground.red),
          green: CGFloat(foreground.green),
          blue: CGFloat(foreground.blue),
          alpha: CGFloat(foreground.alpha)
        )
      }
      if config.paddingX.count == 2, config.paddingY.count == 2 {
        terminalContentInsets = UIEdgeInsets(
          top: CGFloat(config.paddingY[0]),
          left: CGFloat(config.paddingX[0]),
          bottom: CGFloat(config.paddingY[1]),
          right: CGFloat(config.paddingX[1])
        )
      }
      configurationWarnings = []
      let unknownEffects = config.shaderEffects.filter {
        GhostteaMetalShaderEffect(configurationID: $0) == nil
      }
      if !unknownEffects.isEmpty {
        configurationWarnings.append(
          "unsupported built-in shader effects were ignored: \(unknownEffects.joined(separator: ", "))"
        )
      }
      if config.shaderEffects.count > 16 {
        configurationWarnings.append("only the first 16 shader effects are rendered")
      }
      if config.customShaderCount > 0 {
        configurationWarnings.append(
          "host-local custom-shader paths are not available in the Swift Metal renderer")
      }
      if !config.fontFamilies.isEmpty {
        configurationWarnings.append(
          "font-family is not available in the bundled-font Apple runtime")
      }
      updateEffectAnimationState()
      geometryDidChange()
      requestEventDrivenDraw(damage: .full)
    }

    public func bindResizeCoordinator(_ coordinator: GhostteaResizeCoordinator) {
      onGridSizeChange = { size in
        Task { await coordinator.request(size) }
      }
    }

    public func suspendGPU() {
      guard !gpuSuspended else { return }
      stopScrollMomentum()
      gpuSuspended = true
      updateCursorBlinkSurfaceVisibility()
      updateEffectAnimationState()
      evictRendererResources()
    }

    public func resumeGPU() {
      guard gpuSuspended else { return }
      gpuSuspended = false
      updateCursorBlinkSurfaceVisibility()
      updateEffectAnimationState()
      requestEventDrivenDraw(damage: .full)
    }

    public func mtkView(_ view: MTKView, drawableSizeWillChange size: CGSize) {
      guard size.width > 0, size.height > 0 else { return }
      geometryDidChange()
    }

    public func draw(in view: MTKView) {
      guard !gpuSuspended, retainedState.sessionHandle != 0, let drawable = currentDrawable else {
        return
      }
      do {
        let renderer = try renderer()
        let draw = try GhostteaPerformanceRecorder.shared.measure(.metalSubmission) {
          if pendingDamage.isEmpty,
            let effectDraw = try renderer.renderEffectsOnly(
              state: retainedState,
              target: drawable.texture,
              scale: Float(contentScaleFactor),
              theme: terminalTheme,
              contentInsets: effectiveContentInsets(),
              focused: terminalFocused,
              cursorBlinkVisible: cursorBlinkVisible,
              presenting: drawable
            )
          {
            return effectDraw
          }
          let submittedDamage = pendingDamage.isEmpty ? .full : pendingDamage
          return try renderer.render(
            state: retainedState,
            target: drawable.texture,
            scale: Float(contentScaleFactor),
            theme: terminalTheme,
            contentInsets: effectiveContentInsets(),
            selection: terminalSelection,
            focused: terminalFocused,
            cursorBlinkVisible: cursorBlinkVisible,
            damage: submittedDamage,
            presenting: drawable
          )
        }
        var completedDamage = draw.damage
        if draw.atlasUpload.alphaReset || draw.atlasUpload.colorReset {
          completedDamage.formUnion(.atlas)
        }
        pendingDamage = GhostteaTerminalRenderDamage()
        updateDiagnostics(
          renderedFrames: diagnostics.renderedFrames + 1,
          residentAtlasBytes: renderer.atlases.residentBytes,
          vertexUploadBytes: diagnostics.vertexUploadBytes
            &+ UInt64(max(0, draw.vertexUploadBytes)),
          atlasUploadBytes: diagnostics.atlasUploadBytes
            &+ UInt64(max(0, draw.atlasUpload.uploadedBytes)),
          bufferAllocations: diagnostics.bufferAllocations
            &+ UInt64(max(0, draw.bufferAllocationCount)),
          drawCalls: diagnostics.drawCalls &+ UInt64(max(0, draw.drawCallCount)),
          commandBufferCommits: diagnostics.commandBufferCommits
            &+ UInt64(max(0, draw.commandBufferCount)),
          fullDamageSubmissions: diagnostics.fullDamageSubmissions
            + (completedDamage.flags.contains(.full) ? 1 : 0),
          rowDamageSubmissions: diagnostics.rowDamageSubmissions
            + (completedDamage.rows.isEmpty ? 0 : 1),
          damagedRowsSubmitted: diagnostics.damagedRowsSubmitted + completedDamage.rows.count,
          cursorDamageSubmissions: diagnostics.cursorDamageSubmissions
            + (completedDamage.flags.contains(.cursor) ? 1 : 0),
          selectionDamageSubmissions: diagnostics.selectionDamageSubmissions
            + (completedDamage.flags.contains(.selection) ? 1 : 0),
          geometryDamageSubmissions: diagnostics.geometryDamageSubmissions
            + (completedDamage.flags.contains(.geometry) ? 1 : 0),
          rowCacheHits: diagnostics.rowCacheHits + draw.rowCacheHits,
          rowCacheAdmissions: diagnostics.rowCacheAdmissions + draw.rowCacheAdmissions,
          rowCacheEvictions: diagnostics.rowCacheEvictions + draw.rowCacheEvictions,
          clearError: true
        )
        _ = draw
      } catch {
        updateDiagnostics(lastError: "Metal render failed")
      }
    }

    private func renderer() throws -> GhostteaMetalRenderer {
      if let terminalRenderer { return terminalRenderer }
      let renderer = try GhostteaMetalRenderer(
        runtime: metalRuntime,
        cellWidth: terminalTextMetrics.cellWidthPixels,
        lineHeight: terminalTextMetrics.lineHeightPixels,
        encodedGeometryReuseEnabled: encodedGeometryReuseEnabled,
        instancedSubmissionEnabled: instancedSubmissionEnabled,
        rowGeometryReuseEnabled: rowGeometryReuseEnabled,
        lazyColorAtlasEnabled: lazyColorAtlasEnabled
      )
      terminalRenderer = renderer
      updateDiagnostics(
        resourceRebuilds: diagnostics.resourceRebuilds + 1,
        residentAtlasBytes: renderer.atlases.residentBytes
      )
      return renderer
    }

    private func requestEventDrivenDraw(damage: GhostteaTerminalRenderDamage = .full) {
      pendingDamage.formUnion(damage)
      guard !gpuSuspended, !awaitingMemoryPressureRefresh else { return }
      setNeedsDisplay()
    }

    private func updateCursorBlinkSurfaceVisibility() {
      cursorBlinkController.setSurfaceVisible(
        terminalVisible && window != nil && !isHidden && !gpuSuspended)
    }

    private func updateEffectAnimationState() {
      let hasAnimatedEffect = terminalTheme.shaderEffects.contains(where: \.isAnimated)
      let active =
        terminalTheme.shaderAnimation && hasAnimatedEffect
        && terminalVisible && window != nil && !isHidden && !gpuSuspended
      preferredFramesPerSecond = ProcessInfo.processInfo.isLowPowerModeEnabled ? 30 : 60
      // `enableSetNeedsDisplay` itself pauses MTKView's internal loop. Static
      // terminals stay event-driven; animated shader stacks opt into timed draws.
      enableSetNeedsDisplay = !active
      isPaused = !active
    }

    @objc private func powerStateDidChange() {
      updateEffectAnimationState()
    }

    private func geometryDidChange() {
      guard bounds.width > 0, bounds.height > 0 else { return }
      let grid = GhostteaTerminalLayout.gridSize(
        width: Float(bounds.width),
        height: Float(bounds.height),
        contentInsets: effectiveContentInsets(),
        cellWidth: terminalTextMetrics.cellWidthPixels,
        lineHeight: terminalTextMetrics.lineHeightPixels
      )
      let next = EffectiveGeometry(
        drawableSize: CGSize(
          width: drawableSize.width.rounded(),
          height: drawableSize.height.rounded()
        ),
        scale: contentScaleFactor,
        contentInsets: effectiveContentInsets(),
        gridSize: grid,
        cellWidth: terminalTextMetrics.cellWidthPixels,
        lineHeight: terminalTextMetrics.lineHeightPixels
      )
      guard next != effectiveGeometry else { return }
      effectiveGeometry = next
      if grid != currentGridSize {
        currentGridSize = grid
        onGridSizeChange?(grid)
      }
      updateMarkedTextOverlay()
      scheduleAccessibilityElementUpdate(force: true)
      requestEventDrivenDraw(damage: .geometry)
    }

    private func updateGridSize(notifyUnchanged: Bool = false) {
      guard bounds.width > 0, bounds.height > 0 else { return }
      let next = GhostteaTerminalLayout.gridSize(
        width: Float(bounds.width),
        height: Float(bounds.height),
        contentInsets: effectiveContentInsets(),
        cellWidth: terminalTextMetrics.cellWidthPixels,
        lineHeight: terminalTextMetrics.lineHeightPixels
      )
      guard next != currentGridSize else {
        if notifyUnchanged { onGridSizeChange?(next) }
        return
      }
      currentGridSize = next
      onGridSizeChange?(next)
    }

    private func effectiveContentInsets() -> GhostteaTerminalContentInsets {
      let safeArea = includesSafeAreaInsets ? safeAreaInsets : .zero
      return GhostteaTerminalContentInsets(
        top: Float(safeArea.top + terminalContentInsets.top),
        left: Float(safeArea.left + terminalContentInsets.left),
        bottom: Float(safeArea.bottom + terminalContentInsets.bottom),
        right: Float(safeArea.right + terminalContentInsets.right)
      )
    }

    private func requestFullRefresh() {
      updateDiagnostics(fullRefreshRequests: diagnostics.fullRefreshRequests + 1)
      onNeedsFullRefresh?()
    }

    private func evictRendererResources() {
      guard terminalRenderer != nil else { return }
      terminalRenderer = nil
      updateDiagnostics(
        resourceEvictions: diagnostics.resourceEvictions + 1,
        residentAtlasBytes: 0
      )
    }

    private func updateDiagnostics(
      acceptedFrames: Int? = nil,
      renderedFrames: Int? = nil,
      staleFrames: Int? = nil,
      fullRefreshRequests: Int? = nil,
      resourceEvictions: Int? = nil,
      resourceRebuilds: Int? = nil,
      residentAtlasBytes: Int? = nil,
      residentGlyphBytes: Int? = nil,
      reconstructibleBytesEvicted: Int? = nil,
      vertexUploadBytes: UInt64? = nil,
      atlasUploadBytes: UInt64? = nil,
      bufferAllocations: UInt64? = nil,
      drawCalls: UInt64? = nil,
      commandBufferCommits: UInt64? = nil,
      fullDamageSubmissions: Int? = nil,
      rowDamageSubmissions: Int? = nil,
      damagedRowsSubmitted: Int? = nil,
      cursorDamageSubmissions: Int? = nil,
      selectionDamageSubmissions: Int? = nil,
      geometryDamageSubmissions: Int? = nil,
      rowCacheHits: Int? = nil,
      rowCacheAdmissions: Int? = nil,
      rowCacheEvictions: Int? = nil,
      lastError: String? = nil,
      clearError: Bool = false
    ) {
      diagnostics = GhostteaTerminalMetalDiagnostics(
        acceptedFrames: acceptedFrames ?? diagnostics.acceptedFrames,
        renderedFrames: renderedFrames ?? diagnostics.renderedFrames,
        staleFrames: staleFrames ?? diagnostics.staleFrames,
        fullRefreshRequests: fullRefreshRequests ?? diagnostics.fullRefreshRequests,
        resourceEvictions: resourceEvictions ?? diagnostics.resourceEvictions,
        resourceRebuilds: resourceRebuilds ?? diagnostics.resourceRebuilds,
        residentAtlasBytes: residentAtlasBytes ?? diagnostics.residentAtlasBytes,
        residentGlyphBytes: residentGlyphBytes ?? diagnostics.residentGlyphBytes,
        reconstructibleBytesEvicted: reconstructibleBytesEvicted
          ?? diagnostics.reconstructibleBytesEvicted,
        vertexUploadBytes: vertexUploadBytes ?? diagnostics.vertexUploadBytes,
        atlasUploadBytes: atlasUploadBytes ?? diagnostics.atlasUploadBytes,
        bufferAllocations: bufferAllocations ?? diagnostics.bufferAllocations,
        drawCalls: drawCalls ?? diagnostics.drawCalls,
        commandBufferCommits: commandBufferCommits ?? diagnostics.commandBufferCommits,
        fullDamageSubmissions: fullDamageSubmissions ?? diagnostics.fullDamageSubmissions,
        rowDamageSubmissions: rowDamageSubmissions ?? diagnostics.rowDamageSubmissions,
        damagedRowsSubmitted: damagedRowsSubmitted ?? diagnostics.damagedRowsSubmitted,
        cursorDamageSubmissions: cursorDamageSubmissions ?? diagnostics.cursorDamageSubmissions,
        selectionDamageSubmissions: selectionDamageSubmissions
          ?? diagnostics.selectionDamageSubmissions,
        geometryDamageSubmissions: geometryDamageSubmissions
          ?? diagnostics.geometryDamageSubmissions,
        rowCacheHits: rowCacheHits ?? diagnostics.rowCacheHits,
        rowCacheAdmissions: rowCacheAdmissions ?? diagnostics.rowCacheAdmissions,
        rowCacheEvictions: rowCacheEvictions ?? diagnostics.rowCacheEvictions,
        lastError: clearError ? nil : (lastError ?? diagnostics.lastError)
      )
    }

    @objc private func applicationDidEnterBackground() {
      previousDirectScrollTranslation = 0
      stopScrollMomentum()
      stopSelectionAutoScroll()
      suspendGPU()
    }

    @objc private func applicationWillEnterForeground() {
      resumeGPU()
    }

    @objc private func applicationDidReceiveMemoryWarning() {
      let refreshAlreadyRequested = awaitingMemoryPressureRefresh
      let released = retainedState.evictReconstructibleRenderState()
      awaitingMemoryPressureRefresh = retainedState.awaitingResync
      evictRendererResources()
      updateDiagnostics(
        residentGlyphBytes: 0,
        reconstructibleBytesEvicted: diagnostics.reconstructibleBytesEvicted + released)
      if awaitingMemoryPressureRefresh, !refreshAlreadyRequested { requestFullRefresh() }
    }
  }

  private final class GhostteaTextPosition: UITextPosition {
    let offset: Int

    init(_ offset: Int) {
      self.offset = offset
    }
  }

  private final class GhostteaTextRange: UITextRange {
    let lower: GhostteaTextPosition
    let upper: GhostteaTextPosition

    init(_ first: Int, _ second: Int) {
      lower = GhostteaTextPosition(min(first, second))
      upper = GhostteaTextPosition(max(first, second))
    }

    override var start: UITextPosition { lower }
    override var end: UITextPosition { upper }
    override var isEmpty: Bool { lower.offset == upper.offset }

    var nsRange: NSRange {
      NSRange(location: lower.offset, length: upper.offset - lower.offset)
    }
  }

  extension GhostteaTerminalMetalView: UITextInput {
    public var hasText: Bool { true }

    public var selectedTextRange: UITextRange? {
      get {
        GhostteaTextRange(
          compositionBuffer.selection.location,
          compositionBuffer.selection.location + compositionBuffer.selection.length
        )
      }
      set {
        guard let range = newValue as? GhostteaTextRange else { return }
        inputDelegate?.selectionWillChange(self)
        compositionBuffer.setSelectedRange(range.nsRange)
        inputDelegate?.selectionDidChange(self)
        updateMarkedTextOverlay()
      }
    }

    public var markedTextRange: UITextRange? {
      compositionBuffer.isMarked ? GhostteaTextRange(0, compositionBuffer.utf16Count) : nil
    }

    public var beginningOfDocument: UITextPosition { GhostteaTextPosition(0) }
    public var endOfDocument: UITextPosition { GhostteaTextPosition(compositionBuffer.utf16Count) }
    public var tokenizer: UITextInputTokenizer { textInputTokenizer }

    public func text(in range: UITextRange) -> String? {
      guard let range = range as? GhostteaTextRange else { return nil }
      return compositionBuffer.text(in: range.nsRange)
    }

    public func replace(_ range: UITextRange, withText text: String) {
      guard let range = range as? GhostteaTextRange else { return }
      inputDelegate?.textWillChange(self)
      inputDelegate?.selectionWillChange(self)
      let events = compositionBuffer.replace(range.nsRange, with: text)
      inputDelegate?.selectionDidChange(self)
      inputDelegate?.textDidChange(self)
      publishCompositionChange()
      emitSoftwareInputEvents(events)
    }

    public func setMarkedText(_ markedText: String?, selectedRange: NSRange) {
      if let markedText, !markedText.isEmpty { clearAccessoryModifiers() }
      inputDelegate?.textWillChange(self)
      inputDelegate?.selectionWillChange(self)
      let events = compositionBuffer.setMarkedText(markedText, selectedRange: selectedRange)
      inputDelegate?.selectionDidChange(self)
      inputDelegate?.textDidChange(self)
      publishCompositionChange()
      emitSoftwareInputEvents(events)
    }

    public func unmarkText() {
      inputDelegate?.textWillChange(self)
      inputDelegate?.selectionWillChange(self)
      let events = compositionBuffer.unmarkText()
      inputDelegate?.selectionDidChange(self)
      inputDelegate?.textDidChange(self)
      publishCompositionChange()
      emitSoftwareInputEvents(events)
    }

    public func insertText(_ text: String) {
      inputDelegate?.textWillChange(self)
      inputDelegate?.selectionWillChange(self)
      let events = compositionBuffer.insertText(text)
      inputDelegate?.selectionDidChange(self)
      inputDelegate?.textDidChange(self)
      publishCompositionChange()
      emitSoftwareInputEvents(events)
    }

    public func deleteBackward() {
      inputDelegate?.textWillChange(self)
      inputDelegate?.selectionWillChange(self)
      let events = compositionBuffer.deleteBackward()
      inputDelegate?.selectionDidChange(self)
      inputDelegate?.textDidChange(self)
      publishCompositionChange()
      emitSoftwareInputEvents(events)
    }

    public func textRange(
      from fromPosition: UITextPosition,
      to toPosition: UITextPosition
    ) -> UITextRange? {
      guard let from = fromPosition as? GhostteaTextPosition,
        let to = toPosition as? GhostteaTextPosition
      else { return nil }
      return GhostteaTextRange(clampTextOffset(from.offset), clampTextOffset(to.offset))
    }

    public func position(from position: UITextPosition, offset: Int) -> UITextPosition? {
      guard let position = position as? GhostteaTextPosition else { return nil }
      let target = position.offset + offset
      guard target >= 0, target <= compositionBuffer.utf16Count else { return nil }
      return GhostteaTextPosition(target)
    }

    public func position(
      from position: UITextPosition,
      in direction: UITextLayoutDirection,
      offset: Int
    ) -> UITextPosition? {
      let signedOffset = direction == .left || direction == .up ? -offset : offset
      return self.position(from: position, offset: signedOffset)
    }

    public func compare(_ position: UITextPosition, to other: UITextPosition) -> ComparisonResult {
      guard let first = position as? GhostteaTextPosition,
        let second = other as? GhostteaTextPosition
      else { return .orderedSame }
      if first.offset < second.offset { return .orderedAscending }
      if first.offset > second.offset { return .orderedDescending }
      return .orderedSame
    }

    public func offset(from: UITextPosition, to: UITextPosition) -> Int {
      guard let from = from as? GhostteaTextPosition, let to = to as? GhostteaTextPosition else {
        return 0
      }
      return to.offset - from.offset
    }

    public func position(
      within range: UITextRange,
      farthestIn direction: UITextLayoutDirection
    ) -> UITextPosition? {
      guard let range = range as? GhostteaTextRange else { return nil }
      return direction == .left || direction == .up ? range.start : range.end
    }

    public func characterRange(
      byExtending position: UITextPosition,
      in direction: UITextLayoutDirection
    ) -> UITextRange? {
      guard let position = position as? GhostteaTextPosition else { return nil }
      let offset = clampTextOffset(position.offset)
      let range = compositionBuffer.composedCharacterRange(
        adjoining: offset,
        towardStart: direction == .left || direction == .up
      )
      return GhostteaTextRange(range.location, range.location + range.length)
    }

    public func baseWritingDirection(
      for position: UITextPosition,
      in direction: UITextStorageDirection
    ) -> NSWritingDirection {
      .leftToRight
    }

    public func setBaseWritingDirection(
      _ writingDirection: NSWritingDirection,
      for range: UITextRange
    ) {}

    public func firstRect(for range: UITextRange) -> CGRect { terminalInputCaretRect() }

    public func caretRect(for position: UITextPosition) -> CGRect {
      guard let position = position as? GhostteaTextPosition else {
        return terminalInputCaretRect()
      }
      return terminalInputCaretRect(at: position.offset)
    }

    public func selectionRects(for range: UITextRange) -> [UITextSelectionRect] { [] }

    public func closestPosition(to point: CGPoint) -> UITextPosition? {
      GhostteaTextPosition(compositionBuffer.selection.location)
    }

    public func closestPosition(
      to point: CGPoint,
      within range: UITextRange
    ) -> UITextPosition? {
      guard let range = range as? GhostteaTextRange else { return nil }
      return range.start
    }

    public func characterRange(at point: CGPoint) -> UITextRange? {
      let offset = compositionBuffer.selection.location
      return GhostteaTextRange(offset, offset)
    }

    private func clampTextOffset(_ offset: Int) -> Int {
      max(0, min(compositionBuffer.utf16Count, offset))
    }

    private func commitMarkedTextIfNeeded() {
      guard compositionBuffer.isMarked else { return }
      unmarkText()
    }

    private func emitSoftwareInputEvents(_ events: [GhostteaSoftwareInputEvent]) {
      guard !events.isEmpty else { return }
      for event in events { onSoftwareInputEvent?(accessoryInputState.consume(event)) }
      updateAccessoryModifierPresentation()
      noteCursorActivity()
    }

    private func clearAccessoryModifiers() {
      guard !accessoryInputState.modifiers.isEmpty else { return }
      accessoryInputState.clear()
      updateAccessoryModifierPresentation()
    }

    private func updateAccessoryModifierPresentation() {
      terminalAccessoryInputView.updateModifiers(accessoryInputState.modifiers)
    }

    private func publishCompositionChange() {
      onMarkedTextChange?(compositionBuffer.markedState)
      updateMarkedTextOverlay()
    }

    private func updateMarkedTextOverlay() {
      guard let marked = compositionBuffer.markedState, !marked.text.isEmpty else {
        markedTextLabel.isHidden = true
        markedTextLabel.attributedText = nil
        return
      }
      let attributes =
        markedTextStyle ?? [
          .underlineStyle: NSUnderlineStyle.single.rawValue,
          .foregroundColor: markedTextLabel.textColor as Any,
        ]
      markedTextLabel.attributedText = NSAttributedString(
        string: marked.text, attributes: attributes)
      markedTextLabel.isHidden = false
      let origin = terminalInputCaretRect().origin
      let availableWidth = max(
        terminalCellWidth,
        bounds.width - origin.x - CGFloat(effectiveContentInsets().right)
      )
      let measured = markedTextLabel.sizeThatFits(
        CGSize(width: availableWidth, height: terminalLineHeight))
      markedTextLabel.frame = CGRect(
        x: origin.x,
        y: origin.y,
        width: min(availableWidth, max(terminalCellWidth, measured.width)),
        height: terminalLineHeight
      )
    }

    private func terminalInputCaretRect(at textOffset: Int? = nil) -> CGRect {
      let insets = effectiveContentInsets()
      let cursor = retainedState.cursor
      var x =
        CGFloat(insets.left + GhostteaTerminalLayout.horizontalPadding)
        + CGFloat(cursor?.x ?? 0) * terminalCellWidth
      let y =
        CGFloat(insets.top + GhostteaTerminalLayout.verticalPadding)
        + CGFloat(cursor?.y ?? 0) * terminalLineHeight
      if let textOffset, textOffset > 0, !compositionBuffer.text.isEmpty {
        let prefix = compositionBuffer.text(
          in: NSRange(location: 0, length: clampTextOffset(textOffset)))
        x += (prefix as NSString).size(withAttributes: [.font: markedTextLabel.font as Any]).width
      }
      return CGRect(
        x: x,
        y: y,
        width: max(1, terminalCellWidth),
        height: terminalLineHeight
      )
    }
  }

  extension GhostteaTerminalMetalView: @preconcurrency UIEditMenuInteractionDelegate {
    public func editMenuInteraction(
      _ interaction: UIEditMenuInteraction,
      menuFor configuration: UIEditMenuConfiguration,
      suggestedActions: [UIMenuElement]
    ) -> UIMenu? {
      let copy = UIAction(
        title: "Copy",
        image: UIImage(systemName: "doc.on.doc"),
        attributes: absoluteSelection == nil ? .disabled : []
      ) { [weak self] _ in
        guard let self, let selection = self.absoluteSelection else { return }
        self.onSelectionCommit?(selection)
      }
      let selectAll = UIAction(
        title: "Select All",
        image: UIImage(systemName: "selection.pin.in.out")
      ) { [weak self] _ in
        self?.selectAllTerminal()
      }
      let paste = UIAction(
        title: "Paste",
        image: UIImage(systemName: "doc.on.clipboard"),
        attributes: UIPasteboard.general.hasStrings ? [] : .disabled
      ) { [weak self] _ in
        self?.paste(nil)
      }
      return UIMenu(children: [copy, selectAll, paste])
    }
  }
#endif
