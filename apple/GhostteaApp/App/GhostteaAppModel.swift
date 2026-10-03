import Combine
import Foundation
import GhostteaCore
import GhostteaDiagnostics
import GhostteaTerminal
import GhostteaTruffle
import SwiftUI
import UIKit

@MainActor
final class GhostteaAppModel: ObservableObject {
  @Published private(set) var sessions: [GhostteaSharedSessionSummary] = []
  @Published private(set) var selectedHostName: String?
  @Published private(set) var selectedSession: GhostteaSharedSessionSummary?
  @Published private(set) var selectedActivity = GhostteaSessionActivity.unknown
  @Published private(set) var frame: Data?
  @Published private(set) var presentationConfiguration: GhostteaTerminalPresentationConfig
  @Published private(set) var hasControl = false
  @Published private(set) var readWriteAllowed = false
  @Published private(set) var isClaimingControl = false
  /// The §8.1 outage banner, or `nil` when the session needs no explanation.
  @Published private(set) var banner: GhostteaAttachmentBanner?
  /// A transient note that a keystroke was dropped (§4.3).
  @Published private(set) var inputCue: GhostteaAttachmentInputCue?
  @Published private var localStatus: String?
  @Published private var localBusy = false

  private let sharedRuntime: GhostteaSharedRuntimeModel
  let diagnostics: GhostteaDiagnosticRecorder
  private(set) var configuration: GhostteaConfigSnapshot
  private let sceneIdentity: GhostteaSceneTerminalIdentity
  private var runtimeObservation: AnyCancellable?
  private var hostObservation: AnyCancellable?
  private var selectedHost: GhostteaTruffleHostCandidate?
  /// The device the attached session lives on, so a peer set that regains it
  /// can wake the reconnect engine.
  private var attachedHostDeviceID: String?
  /// The §3 state machine for the attached session. It owns the connection, the
  /// heartbeat, and every sequence space the wire orders; this model owns only
  /// the presentation of what it reports.
  private var lifecycle: GhostteaAttachmentLifecycle?
  /// Held for §4.4's offline copy: it retains the rows that are on screen, so
  /// a frozen session stays copyable without the wire.
  private var replicaSink: GhostteaAttachmentReplicaSink?
  private var pendingAttachmentTask: Task<Void, Never>?
  private var lifecycleTask: Task<Void, Never>?
  /// Orders live device-presentation updates independently of the host state
  /// generation. A settings edit is local renderer state, never a network ack.
  private var presentationTask: Task<Void, Never>?
  private var pendingPresentationConfiguration: GhostteaTerminalPresentationConfig?
  private var presentationGeneration: UInt64 = 0
  /// Wakes the banner when it would change without a new event — the grace
  /// window opening, a countdown ticking, the resumed flash closing.
  private var bannerRefreshTask: Task<Void, Never>?
  private var bannerPresenter: GhostteaAttachmentBannerPresenter?
  private let clock = GhostteaSystemClock()
  private var renderRuntime: GhostteaRuntime?
  private var nextSessionHandle: UInt64 = 1
  /// Identifies the current attach. A sink outlives the attachment it was built
  /// for by however long its last callback takes to land, and without this a
  /// retired sink can repaint a session it has nothing to do with.
  private var attachID: UInt64 = 0
  /// The highest state generation already applied for ``attachID``. Generations
  /// only ever advance inside the lifecycle, so anything lower is a frame from
  /// a reader that has since been retired.
  private var appliedGeneration: UInt64 = 0
  /// Bumped each time a *new* attachment reaches Live, which is what a reclaim
  /// is single-flighted against (§4.2.3).
  private var attachmentGeneration: UInt64 = 0
  private var lastControlClaim: GhostteaControlReclaimAttempt?
  /// Meaningful focus, iOS-shaped: this scene shows one session at a time, so
  /// focus is "the session is on screen and the app is frontmost".
  private var sceneIsActive = true
  /// The lifecycle's own verdict on whether input would land, cached from the
  /// last snapshot so a gesture does not have to await the actor to be dropped.
  private var inputAccepted = false
  private var currentPhase: GhostteaAttachmentPhase?
  private var grid = GhostteaTerminalGridSize(columns: 80, rows: 24)

  var phase: GhostteaTruffleRuntimePhase { sharedRuntime.phase }
  var status: String { localStatus ?? sharedRuntime.status }
  var hosts: [GhostteaTruffleHostCandidate] { sharedRuntime.hosts }
  var isBusy: Bool { localBusy || sharedRuntime.isBusy }
  var canTakeControl: Bool {
    guard readWriteAllowed, !hasControl else { return false }
    if case .live? = currentPhase { return true }
    return false
  }
  var terminalViewID: String { sceneIdentity.viewID }
  var authPage: GhostteaLoginPage? {
    get { sharedRuntime.authPage }
    set { sharedRuntime.authPage = newValue }
  }

  init(
    sharedRuntime: GhostteaSharedRuntimeModel,
    diagnostics: GhostteaDiagnosticRecorder,
    configuration: GhostteaConfigSnapshot,
    sceneID: UUID = UUID()
  ) {
    self.sharedRuntime = sharedRuntime
    self.diagnostics = diagnostics
    self.configuration = configuration
    presentationConfiguration = configuration.terminalPresentation
    sceneIdentity = GhostteaSceneTerminalIdentity(sceneID: sceneID)
    runtimeObservation = sharedRuntime.objectWillChange.sink { [weak self] _ in
      self?.objectWillChange.send()
    }
    // §12's advertisement fast path, and the only thing that ends a
    // `suspended(.hostAbsent)` rest without the user tapping Retry: the engine
    // stops dialing after `suspendAfterMs` and waits to be told the host is
    // back. Nothing else in the app tells it.
    hostObservation = sharedRuntime.$hosts.sink { [weak self] hosts in
      self?.hostsChanged(hosts)
    }
  }

  func start() {
    #if DEBUG
      if ProcessInfo.processInfo.environment["GHOSTTEA_AUTORUN_MULTISCENE"] == "1"
        || ghostteaAutomationDirectory() != nil
      {
        return
      }
    #endif
    if renderRuntime == nil {
      do { renderRuntime = try GhostteaRuntime(config: configuration) } catch {
        fail("Could not start terminal renderer", code: .rendererStartFailed)
        return
      }
    }
    sharedRuntime.start()
  }

  /// Validated device configuration owns presentation for both local and
  /// shared terminals. Shared-session semantics remain host-owned; colors,
  /// opacity, padding, and shaders do not.
  func deviceConfigurationChanged(_ next: GhostteaConfigSnapshot) {
    guard next.revision != configuration.revision else { return }
    configuration = next
    let presentation = next.terminalPresentation
    if let pendingPresentationConfiguration,
      presentation.hasSameDevicePresentation(as: pendingPresentationConfiguration)
    {
      // Document revisions are not renderer revisions. Let an already-ordered
      // transaction finish when the values it will apply are still current.
      return
    }
    let supersededTask = presentationTask
    let supersededPresentation = pendingPresentationConfiguration
    guard
      !presentation.hasSameDevicePresentation(as: presentationConfiguration)
        || supersededTask != nil
    else { return }
    supersededTask?.cancel()
    presentationGeneration &+= 1
    let generation = presentationGeneration
    let attachedSink = replicaSink
    let attachedID = attachID
    let needsRuntime =
      renderRuntime == nil
      || presentation.requiresNewRuntime(comparedTo: presentationConfiguration)
      || supersededPresentation.map {
        presentation.requiresNewRuntime(comparedTo: $0)
      } == true
    pendingPresentationConfiguration = presentation
    presentationTask = Task { [weak self] in
      // A native reconfiguration is atomic but not itself cancellable. Let an
      // in-flight predecessor leave the replica before applying its successor;
      // this makes generation order physical, not merely an output filter.
      await supersededTask?.value
      guard let self else { return }
      defer {
        if generation == presentationGeneration {
          presentationTask = nil
          pendingPresentationConfiguration = nil
        }
      }
      do {
        // A superseded task can be canceled while it is waiting for its
        // predecessor. Stop here so rapid raw-config edits do not build every
        // intermediate font runtime in sequence.
        try Task.checkCancellation()
        let runtime = try await Self.makeRuntimeIfNeeded(
          needsRuntime, presentation: presentation)
        try Task.checkCancellation()
        guard generation == presentationGeneration,
          presentation.hasSameDevicePresentation(as: configuration.terminalPresentation)
        else { return }

        if let attachedSink {
          guard replicaSink === attachedSink, attachID == attachedID else { return }
          _ = try await attachedSink.reconfigureDevicePresentation(
            presentation,
            runtime: runtime,
            generation: generation
          ) { [weak self] result in
            await self?.publishDevicePresentation(
              result,
              presentation: presentation,
              runtime: runtime,
              generation: generation,
              sink: attachedSink,
              attach: attachedID
            )
          }
        } else {
          guard replicaSink == nil else { return }
          if let runtime { renderRuntime = runtime }
          presentationConfiguration = presentation
        }
      } catch is CancellationError {
        return
      } catch {
        guard generation == presentationGeneration else { return }
        record(.rendererStartFailed, severity: .warning)
        localStatus = "Could not reload terminal appearance"
      }
    }
  }

  /// Runs from inside the sink's replica transaction. Applying the Metal
  /// configuration and its optional frame before returning prevents a newer
  /// host frame from being overwritten by a delayed settings continuation.
  private func publishDevicePresentation(
    _ result: GhostteaDevicePresentationResult,
    presentation: GhostteaTerminalPresentationConfig,
    runtime: GhostteaRuntime?,
    generation: UInt64,
    sink: GhostteaAttachmentReplicaSink,
    attach: UInt64
  ) {
    guard result.applied,
      generation == presentationGeneration,
      presentation.hasSameDevicePresentation(as: configuration.terminalPresentation),
      replicaSink === sink,
      attachID == attach
    else { return }
    if let runtime { renderRuntime = runtime }
    // `updateUIView` applies the configuration before the frame. Publishing
    // both on this MainActor turn keeps new metrics and reshaped cells in one
    // SwiftUI transaction.
    presentationConfiguration = presentation
    if let rendered = result.update?.effects.last(where: {
      $0.kind == .frameReady
    })?.payload {
      frame = rendered
    }
  }

  nonisolated private static func makeRuntimeIfNeeded(
    _ needed: Bool,
    presentation: GhostteaTerminalPresentationConfig
  ) async throws -> GhostteaRuntime? {
    guard needed else { return nil }
    let creation = Task.detached(priority: .userInitiated) {
      try Task.checkCancellation()
      return try GhostteaRuntime(presentation: presentation)
    }
    return try await withTaskCancellationHandler {
      try await creation.value
    } onCancel: {
      creation.cancel()
    }
  }

  func stop() {
    Task {
      await disconnectAttachment(clearSelection: true)
      await sharedRuntime.stop()
      sessions = []
      localStatus = nil
    }
  }

  func loginSheetDismissed() {
    sharedRuntime.loginSheetDismissed()
  }

  func refreshHosts() async {
    await sharedRuntime.refreshHosts()
  }

  func loadSessions(from candidate: GhostteaTruffleHostCandidate) {
    guard let directory = sharedRuntime.directory, !isBusy else { return }
    localBusy = true
    selectedHost = candidate
    selectedHostName = candidate.displayName
    sessions = []
    localStatus = "Loading sessions from \(candidate.displayName)…"
    Task {
      do {
        let client = try await directory.connect(to: candidate)
        do {
          sessions = try await client.listSessions().filter(\.attachable)
          trace("host \(candidate.displayName) advertised \(sessions.count) attachable session(s)")
          await client.close()
        } catch {
          await client.close()
          throw error
        }
        localStatus =
          sessions.isEmpty
          ? "This host has no attachable sessions."
          : "Choose a desktop session"
        localBusy = false
      } catch {
        fail("Could not list shared sessions", code: .truffleSessionListFailed)
      }
    }
  }

  func attach(to session: GhostteaSharedSessionSummary) {
    guard
      let directory = sharedRuntime.directory,
      let selectedHost,
      renderRuntime != nil,
      !isBusy
    else { return }
    // The reconnect engine re-resolves the host on every dial, so it needs the
    // durable device id rather than the peer value discovery happened to see.
    guard let hostReference = selectedHost.persistentReference else {
      fail("This desktop has not confirmed its identity yet", code: .truffleAttachFailed)
      return
    }
    localBusy = true
    localStatus = "Attaching to \(session.title)…"
    pendingAttachmentTask?.cancel()
    pendingAttachmentTask = Task { [weak self] in
      guard let self else { return }
      await disconnectAttachment(clearSelection: false, cancelPending: false)
      do {
        let handle = nextSessionHandle
        nextSessionHandle = handle == UInt64.max ? 1 : handle + 1
        let localDeviceID = try await directory.localDeviceID()
        // Presentation is sampled after the last suspension point so a valid
        // Settings edit made while the directory lookup was in flight cannot
        // seed the attachment with stale device resources.
        let presentation = configuration.terminalPresentation
        let attachmentRuntime = try GhostteaRuntime(presentation: presentation)
        attachID &+= 1
        let attach = attachID
        appliedGeneration = 0
        let sink = try GhostteaAttachmentReplicaSink(
          runtime: attachmentRuntime,
          sessionHandle: handle,
          presentation: presentation,
          presentationAuthority: .device
        ) { [weak self] event, token in
          await self?.handle(event, token: token, attach: attach)
        }
        let engine = GhostteaAttachmentLifecycle(
          sessionID: session.sessionID,
          localViewID: terminalViewID,
          cols: grid.columns,
          rows: grid.rows,
          dialer: GhostteaTruffleAttachmentDialer(
            directory: directory, host: hostReference, localDeviceID: localDeviceID),
          sink: sink)
        guard !Task.isCancelled else {
          await engine.close()
          localBusy = false
          pendingAttachmentTask = nil
          return
        }
        renderRuntime = attachmentRuntime
        presentationConfiguration = presentation
        lifecycle = engine
        replicaSink = sink
        bannerPresenter = GhostteaAttachmentBannerPresenter(
          deviceName: selectedHost.displayName)
        selectedSession = session
        selectedActivity = session.activity
        readWriteAllowed = false
        frame = nil
        hasControl = false
        attachmentGeneration = 0
        lastControlClaim = nil
        attachedHostDeviceID = hostReference.deviceID
        banner = nil
        inputCue = nil
        trace("opening \(session.sessionID) on \(selectedHost.displayName)")
        lifecycleTask = Task { [weak self] in
          for await event in await engine.events() {
            guard let self else { return }
            self.handle(event, from: engine)
          }
        }
        await engine.start()
        localBusy = false
        pendingAttachmentTask = nil
      } catch {
        pendingAttachmentTask = nil
        await disconnectAttachment(clearSelection: false, cancelPending: false)
        if Task.isCancelled || error is CancellationError {
          localBusy = false
          return
        }
        fail("Could not attach to session", code: .truffleAttachFailed)
      }
    }
  }

  /// Retry, resume, browse, or close — whichever the current banner offered.
  func perform(_ action: GhostteaAttachmentBannerAction) {
    switch action {
    case .retryNow:
      guard let lifecycle else { return }
      Task { await lifecycle.retryNow() }
    case .resume:
      guard let lifecycle else { return }
      Task { await lifecycle.resumeFromForeground() }
    case .browseSessions:
      Task { [weak self] in
        guard let self else { return }
        await disconnectAttachment(clearSelection: false)
        selectedSession = nil
        if let selectedHost { loadSessions(from: selectedHost) }
      }
    case .close:
      disconnect()
    }
  }

  func disconnect() {
    Task { await disconnectAttachment(clearSelection: true) }
  }

  func sceneDisconnected() {
    Task { await disconnectAttachment(clearSelection: true) }
  }

  func updateGrid(_ value: GhostteaTerminalGridSize) {
    guard value != grid else { return }
    grid = value
    guard let lifecycle else { return }
    Task {
      // Recorded first so a resize typed during an outage still shapes the
      // attach that ends it, rather than being lost with the connection.
      await lifecycle.setViewport(cols: value.columns, rows: value.rows)
      guard await lifecycle.heldControlEpoch != nil else {
        // Not ours to resize. Claiming here unconditionally would take control
        // from whichever view legitimately holds it; the funnel decides whether
        // a claim is allowed at all (§4.2.3).
        self.reevaluateReclaim()
        return
      }
      do {
        try await lifecycle.resize(cols: value.columns, rows: value.rows)
      } catch {
        // Control refusals are thrown to the caller and deliberately kept off
        // the event stream, so this is the only place they can become visible.
        noteControlFailure(error, action: "Resize")
      }
    }
  }

  /// A user-directed takeover is intentionally separate from automatic
  /// reclaim. Focus and geometry changes never fight another controller, while
  /// this explicit action compare-and-swaps against the state the phone
  /// actually observed and includes its current viewport in the claim.
  func takeControl() {
    guard
      canTakeControl, !isClaimingControl, let lifecycle
    else { return }
    isClaimingControl = true
    let size = grid
    let attach = attachID
    Task { [weak self] in
      do {
        try await lifecycle.claimControl(cols: size.columns, rows: size.rows)
      } catch {
        guard let self, attach == attachID else { return }
        noteControlFailure(error, action: "Take Control")
        isClaimingControl = false
        return
      }
      // The write only submits the fenced request; the controller
      // announcement is its authoritative answer. Keep the button
      // single-flight until that arrives, but do not strand the UI if a peer
      // remains connected without answering.
      try? await Task.sleep(nanoseconds: 5_000_000_000)
      guard let self, attach == attachID else { return }
      guard isClaimingControl else { return }
      isClaimingControl = false
      bannerPresenter?.noteCue("Control request timed out. Try again.", at: clock.nowMs)
      republishBanner()
    }
  }

  func handleHardwareKey(_ event: GhostteaHardwareKeyEvent) -> Bool {
    // Deliberately not gated on read-write or phase: the lifecycle rejects what
    // it must and says so, and a silent local drop would teach the user nothing
    // (§4.3).
    guard lifecycle != nil else { return false }
    let modifiers = event.modifiers
    let operation = GhostteaTunnelInput.key(
      GhostteaKeyInput(
        type: event.action == .up ? "up" : "down",
        key: event.text.isEmpty ? event.code : event.text,
        code: event.code,
        repeat: event.action == .repeated,
        shift: modifiers.contains(.shift),
        control: modifiers.contains(.control),
        alt: modifiers.contains(.option),
        meta: modifiers.contains(.command),
        unshiftedCodepoint: event.unshiftedCodepoint))
    send(operation)
    return true
  }

  func handleSoftwareInput(_ event: GhostteaSoftwareInputEvent) {
    switch event {
    case .text(let text): send(.text(text))
    case .enter: send(.text("\r"))
    case .deleteBackward:
      send(
        .key(
          GhostteaKeyInput(
            type: "down", key: "Backspace", code: "Backspace", repeat: false,
            shift: false, control: false, alt: false, meta: false,
            unshiftedCodepoint: 0)))
    case .paste(let text): send(.paste(text))
    case .key(let key): _ = handleHardwareKey(key)
    }
  }

  func handleMouse(_ event: GhostteaTerminalMouseEvent) {
    let modifiers = event.modifiers
    let action: String
    switch event.action {
    case .press: action = "press"
    case .release: action = "release"
    case .motion: action = "motion"
    }
    sendGesture(
      .mouse(
        GhostteaMouseInput(
          action: action, button: event.button.rawValue, x: event.x, y: event.y,
          screenWidth: event.screenWidth, screenHeight: event.screenHeight,
          cellWidth: event.cellWidth, cellHeight: event.cellHeight,
          paddingLeft: event.paddingLeft, paddingTop: event.paddingTop,
          shift: modifiers.contains(.shift), control: modifiers.contains(.control),
          alt: modifiers.contains(.option), meta: modifiers.contains(.command))))
  }

  func handleScroll(_ rows: Int) {
    guard rows != 0 else { return }
    sendGesture(.scroll(Int64(rows)))
  }

  func handleClipboardWrite(_ text: String) {
    UIPasteboard.general.string = text
    traceSelection("clipboard wrote bytes=\(text.utf8.count) source=terminal")
    localStatus = "Copied \(text.utf8.count) bytes"
  }

  func copySelection(_ selection: GhostteaTerminalSelection) {
    traceSelection(
      "ui commit (\(selection.anchor.column),\(selection.anchor.row))->(\(selection.focus.column),\(selection.focus.row))"
    )
    copy(
      GhostteaSelectionRequest(
        startColumn: selection.anchor.column,
        startRow: selection.anchor.row,
        endColumn: selection.focus.column,
        endRow: selection.focus.row),
      failure: "Copy failed")
  }

  func copyAll() {
    copy(GhostteaSelectionRequest(selectAll: true), failure: "Copy all failed")
  }

  func sceneChanged(_ scenePhase: ScenePhase) {
    switch scenePhase {
    case .active:
      record(.applicationBecameActive, severity: .info)
      sceneIsActive = true
      // Focus is a reclaim input: coming back frontmost is when this pane's
      // claim becomes due again (§4.2.3).
      reevaluateReclaim()
      guard let lifecycle else { return }
      Task {
        // §8.2: foreground dials immediately rather than waiting out a
        // schedule. A session that never suspended only wants a fresh frame.
        if case .suspended(.suspendedByApp) = await lifecycle.currentSnapshot.phase {
          await lifecycle.resumeFromForeground()
        } else {
          await lifecycle.requestSnapshot()
        }
      }
    case .background:
      record(.applicationEnteredBackground, severity: .info)
      sceneIsActive = false
      // §8.2: an orderly suspend, not a connection left to rot — the heartbeat
      // stops, the compact connection closes, and the reason is recorded.
      guard let lifecycle else { return }
      Task { await lifecycle.suspendForBackground() }
    // Transient on iOS (the app switcher, a notification shade); suspending
    // here would tear the connection down every time a banner slid past.
    case .inactive: break
    @unknown default: break
    }
  }

  func requestFullRefresh() {
    guard let lifecycle else { return }
    Task { await lifecycle.requestSnapshot() }
  }

  func terminationRecorded() {
    Task { try? await diagnostics.markTerminationRecorded() }
  }

  private func send(_ operation: GhostteaTunnelInput) {
    guard let lifecycle else { return }
    // The throw is the lifecycle's private half of the §4.3 contract; the half
    // the user sees arrives as `.inputRejected` on the event stream, which
    // ``handle(_:from:)`` turns into the visible cue.
    Task { try? await lifecycle.send(operation) }
  }

  /// Pointer and scroll gestures, which are viewport-shaped rather than
  /// keystroke-shaped. §4.3's replay hazard is about typed input, and
  /// "keystrokes are not delivered" is the wrong sentence for a swipe — so
  /// these are dropped quietly rather than rejected loudly. They also arrive
  /// continuously, which would turn the cue into a strobe.
  private func sendGesture(_ operation: GhostteaTunnelInput) {
    guard inputAccepted else { return }
    send(operation)
  }

  /// §4.4. Live copy is a host RPC because only the host can reach scrollback;
  /// anything else is answered from the retained screen, so a frozen session
  /// stays copyable. A live copy that fails falls back rather than losing the
  /// selection — the usual reason it fails is the connection dying, which is
  /// exactly when the retained screen becomes the right answer — but it says
  /// so, because viewport-only is a smaller promise than the user asked for.
  private func copy(_ request: GhostteaSelectionRequest, failure: String) {
    guard let sink = replicaSink else { return }
    let isLive: Bool
    if case .live = currentPhase { isLive = true } else { isLive = false }
    Task { [weak self] in
      guard let self else { return }
      if isLive, let lifecycle {
        do {
          let text = try await lifecycle.selectionText(request)
          traceSelection("rpc completed bytes=\(text.utf8.count)")
          commit(text, scopedToViewport: false)
          return
        } catch {
          traceSelection("rpc failed diagnostic=truffleSelectionFailed")
          record(.truffleSelectionFailed)
        }
      }
      guard let text = await sink.retainedSelection(request) else {
        // No frame has ever arrived, so there is no screen to have selected.
        // Distinct from an empty string, which is a real selection over blank
        // cells and copies normally.
        localStatus = failure
        bannerPresenter?.noteCue("Nothing to copy yet.", at: clock.nowMs)
        republishBanner()
        return
      }
      commit(text, scopedToViewport: true)
    }
  }

  private func commit(_ text: String, scopedToViewport: Bool) {
    UIPasteboard.general.string = text
    traceSelection(
      "clipboard wrote bytes=\(text.utf8.count) source=\(scopedToViewport ? "retained" : "host")"
    )
    localStatus = "Copied \(text.utf8.count) bytes"
    guard scopedToViewport else { return }
    bannerPresenter?.noteCue("Copied the visible screen.", at: clock.nowMs)
    republishBanner()
  }

  /// Surface a refusal the lifecycle threw rather than published. Keystroke
  /// rejections arrive on the event stream instead and must not come through
  /// here, or they would render twice.
  private func noteControlFailure(_ error: Error, action: String) {
    guard let rejection = error as? GhostteaAttachmentInputRejection else { return }
    let message: String
    switch rejection.reason {
    case .readOnly:
      message = "This session is read-only."
    case .writeFailed:
      message = "\(action) failed — reconnecting."
    case .noControl:
      message = "Take control before resizing the terminal."
    case .attachmentEnded:
      message = "\(action) did not finish before the connection dropped."
    case .notLive:
      message = "\(action) is unavailable while the session reconnects."
    }
    bannerPresenter?.noteCue(message, at: clock.nowMs)
    republishBanner()
  }

  /// One lifecycle transition, or one refusal (§3, §4.3).
  private func handle(
    _ event: GhostteaAttachmentLifecycleEvent,
    from engine: GhostteaAttachmentLifecycle
  ) {
    // A stream outlives the attachment it belongs to by however long the last
    // event takes to arrive; a superseded engine must not repaint the new one.
    guard lifecycle === engine else { return }
    bannerPresenter?.apply(event, at: clock.nowMs)
    if case .state(let snapshot) = event {
      readWriteAllowed = snapshot.readWrite
      inputAccepted = snapshot.acceptsInput
      currentPhase = snapshot.phase
      switch snapshot.phase {
      case .live:
        // A resume invalidates this view's controller record, so every new
        // attachment re-arms the claim rather than trusting a once-per-session
        // flag (§4.2.1 takeover, §4.2.3 reclaim).
        attachmentGeneration &+= 1
        reevaluateReclaim()
      case .ended(let reason):
        isClaimingControl = false
        trace("session \(snapshot.sessionID) ended: \(reason.rawValue)")
        // Only the endings nobody asked for are diagnostics. A process that
        // exited, a session someone closed, and a local disconnect are the
        // system working, and recording them as stream failures would bury the
        // real ones.
        switch reason {
        case .hostRestarted, .hostShutdown, .sessionUnavailable:
          record(.truffleStreamFailed)
        case .sessionExited, .sessionClosed, .closedLocally:
          break
        }
      case .opening, .synchronizing, .reconnecting, .suspended:
        isClaimingControl = false
        break
      }
    }
    republishBanner()
  }

  /// §4.2.3's reclaim funnel. Every input that can change the answer — the
  /// session lifecycle, controller state, focus, and pane dimensions — calls
  /// this; ``GhostteaControlReclaim`` decides, and the single-flight record
  /// keeps re-evaluation idempotent rather than chatty.
  ///
  /// Passing the observation in, rather than reading it here, keeps the one
  /// unavoidable actor hop at the call sites that already had one.
  private func maybeReclaim(
    observing state: (controller: GhostteaControllerInfo?, revision: UInt64),
    held: Bool
  ) {
    guard let lifecycle, let phase = currentPhase else { return }
    let observation: GhostteaControlObservation
    if held {
      observation = .selfHolds
    } else if state.controller == nil {
      // Revision 0 is the legacy "cannot report revisions" sentinel, which
      // nothing may compare-and-swap against.
      observation = .noController(revision: state.revision == 0 ? nil : state.revision)
    } else {
      observation = .otherHolds
    }
    let decision = GhostteaControlReclaim.decide(
      phase: phase,
      readWrite: readWriteAllowed,
      hasFocus: sceneIsActive && selectedSession != nil,
      observation: observation,
      attachmentGeneration: attachmentGeneration,
      lastClaim: lastControlClaim)
    guard case .claim(let expected) = decision else { return }
    lastControlClaim = GhostteaControlReclaimAttempt(
      attachmentGeneration: attachmentGeneration, expectedRevision: expected)
    let size = grid
    Task { [weak self] in
      do {
        try await lifecycle.claimControl(cols: size.columns, rows: size.rows)
      } catch {
        self?.noteControlFailure(error, action: "Control")
      }
    }
  }

  /// A refreshed peer set. When it contains the attached session's host, the
  /// engine is told the device is reachable so it can short-circuit its backoff
  /// — or leave `suspended(.hostAbsent)`, which it otherwise never does on its
  /// own.
  private func hostsChanged(_ hosts: [GhostteaTruffleHostCandidate]) {
    guard let attachedHostDeviceID, let lifecycle else { return }
    guard
      hosts.contains(where: {
        $0.isOnline && $0.persistentReference?.deviceID == attachedHostDeviceID
      })
    else { return }
    Task { await lifecycle.noteDeviceReachable() }
  }

  /// Read the controller state and run the funnel. Used by the inputs that do
  /// not already hold an observation.
  private func reevaluateReclaim() {
    guard let lifecycle else { return }
    let attach = attachID
    Task { [weak self] in
      let held = await lifecycle.heldControlEpoch != nil
      let state = await lifecycle.currentControlState
      guard let self, attach == attachID else { return }
      maybeReclaim(observing: state, held: held)
    }
  }

  /// One applied frame, or one thing the frame said about the session.
  ///
  /// Nothing here mutates before the event is proved current. Two things can
  /// make it stale: the sink may belong to a previous attach entirely, and even
  /// within one attach a retired reader's frame can still be in flight — so the
  /// attach identity and the state generation are both checked. Comparing the
  /// generation against the highest already applied, rather than asking the
  /// actor for its current token, keeps this off the actor for every frame.
  private func handle(
    _ event: GhostteaAttachmentSinkEvent,
    token: GhostteaAttachmentStateToken,
    attach: UInt64
  ) {
    guard attach == attachID, token.generation >= appliedGeneration else { return }
    appliedGeneration = token.generation
    switch event {
    case .frame(let update, _):
      if let rendered = update.effects.last(where: { $0.kind == .frameReady })?.payload {
        frame = rendered
      }
    case .controller:
      guard let lifecycle else { return }
      Task { [weak self] in
        // Asked rather than compared locally: against a legacy host the wire
        // view id rotates under the stable one this model knows, and only the
        // lifecycle knows which identity is currently attached.
        let held = await lifecycle.heldControlEpoch != nil
        let state = await lifecycle.currentControlState
        guard let self, attach == attachID else { return }
        hasControl = held
        isClaimingControl = false
        localStatus = held ? "Read-write control" : "Read-only · another view has control"
        // Controller state is one of the funnel's inputs (§4.2.3): a clear that
        // arrives while this pane is focused is exactly when a reclaim is due.
        maybeReclaim(observing: state, held: held)
      }
    case .activity(let activity):
      selectedActivity = activity
    case .presentation:
      // Device-authoritative sinks consume host presentation events without
      // publishing them. Keep this defensive boundary in case an older/custom
      // sink is ever wired into the iOS scene.
      break
    }
  }

  /// Recompute what the banner says now, and arm the next wake it needs.
  private func republishBanner() {
    bannerRefreshTask?.cancel()
    bannerRefreshTask = nil
    guard let bannerPresenter else {
      banner = nil
      inputCue = nil
      return
    }
    let now = clock.nowMs
    banner = bannerPresenter.banner(at: now)
    inputCue = bannerPresenter.inputCue(at: now)
    if let title = banner?.title { localStatus = title }
    guard let delay = bannerPresenter.nextRefreshMs(at: now) else { return }
    bannerRefreshTask = Task { [weak self] in
      try? await Task.sleep(nanoseconds: delay * 1_000_000)
      guard !Task.isCancelled else { return }
      self?.republishBanner()
    }
  }

  private func disconnectAttachment(
    clearSelection: Bool,
    cancelPending: Bool = true
  ) async {
    presentationTask?.cancel()
    presentationTask = nil
    pendingPresentationConfiguration = nil
    presentationGeneration &+= 1
    if cancelPending {
      pendingAttachmentTask?.cancel()
      pendingAttachmentTask = nil
    }
    lifecycleTask?.cancel()
    lifecycleTask = nil
    bannerRefreshTask?.cancel()
    bannerRefreshTask = nil
    let current = lifecycle
    lifecycle = nil
    replicaSink = nil
    bannerPresenter = nil
    banner = nil
    inputCue = nil
    await current?.close()
    frame = nil
    presentationConfiguration = configuration.terminalPresentation
    localBusy = false
    hasControl = false
    readWriteAllowed = false
    isClaimingControl = false
    inputAccepted = false
    currentPhase = nil
    attachedHostDeviceID = nil
    attachmentGeneration = 0
    lastControlClaim = nil
    if clearSelection {
      selectedSession = nil
      selectedActivity = .unknown
      selectedHost = nil
      selectedHostName = nil
      sessions = []
      localStatus = phase == .running ? "Choose a Ghosttea desktop" : nil
    }
  }

  private func fail(_ message: String, code: GhostteaDiagnosticCode) {
    record(code)
    trace(message)
    localBusy = false
    localStatus = message
  }

  private func record(
    _ code: GhostteaDiagnosticCode,
    severity: GhostteaDiagnosticSeverity = .error
  ) {
    Task { try? await diagnostics.record(code, severity: severity) }
  }

  private func trace(_ message: String) {
    #if DEBUG
      print("[Ghosttea] \(message)")
    #endif
  }

  private func traceSelection(_ message: @autoclosure () -> String) {
    #if DEBUG
      guard ProcessInfo.processInfo.environment["GHOSTTEA_SELECTION_TRACE"] == "1" else {
        return
      }
      print("[GhostteaSelection] app \(message())")
    #endif
  }

}

extension GhostteaTerminalPresentationConfig {
  /// Revision is a document identity, not a renderer value. Ignoring it keeps
  /// unrelated config edits off the Metal and replica paths.
  fileprivate func hasSameDevicePresentation(as other: Self) -> Bool {
    foreground == other.foreground
      && background == other.background
      && cursor == other.cursor
      && cursorText == other.cursorText
      && selectionBackground == other.selectionBackground
      && selectionForeground == other.selectionForeground
      && palette == other.palette
      && backgroundOpacity == other.backgroundOpacity
      && backgroundOpacityCells == other.backgroundOpacityCells
      && minimumContrast == other.minimumContrast
      && lightAdaptation == other.lightAdaptation
      && fontSize == other.fontSize
      && fontFamilies == other.fontFamilies
      && paddingX == other.paddingX
      && paddingY == other.paddingY
      && postProcess == other.postProcess
      && shaderEffects == other.shaderEffects
      && customShaderAnimation == other.customShaderAnimation
      && customShaderCount == other.customShaderCount
  }

  /// Apple currently shapes with bundled fonts; only the resolved size changes
  /// native text metrics. Font-family values remain presentation metadata until
  /// arbitrary family loading is supported on this platform.
  fileprivate func requiresNewRuntime(comparedTo other: Self) -> Bool {
    fontSize != other.fontSize
  }
}
