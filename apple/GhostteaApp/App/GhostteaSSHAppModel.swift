import Foundation
import GhostteaConnectionProfiles
import GhostteaCore
import GhostteaCredentials
import GhostteaDiagnostics
import GhostteaSSH
import GhostteaSSHWorkspace
import GhostteaSession
import GhostteaTerminal
import GhostteaTransport
import GhostteaWorkspace
import SwiftUI
import UIKit

#if DEBUG
  import Darwin
#endif

struct GhostteaPendingHostKey: Identifiable {
  let id = UUID()
  let challenge: GhostteaSSHHostKeyChallenge
}

struct GhostteaPendingKeyboardChallenge: Identifiable {
  let id = UUID()
  let challenge: GhostteaSSHKeyboardInteractiveChallenge
}

@MainActor
final class GhostteaSSHAppModel: ObservableObject {
  @Published private(set) var profiles: [GhostteaSSHConnectionProfile] = []
  @Published private(set) var workspace: GhostteaWorkspaceTabsDocument?
  @Published private(set) var frames: [String: Data] = [:]
  @Published private(set) var sessionStatuses: [String: String] = [:]
  @Published private(set) var status = "Loading saved connections…"
  @Published private(set) var isBusy = false
  @Published private(set) var presentationConfiguration: GhostteaTerminalPresentationConfig
  @Published var presentsProfileManager = false
  @Published var presentsCommandPalette = false
  @Published var pendingHostKey: GhostteaPendingHostKey?
  @Published var pendingKeyboardChallenge: GhostteaPendingKeyboardChallenge?

  private var runtime: GhostteaRuntime?
  private var runtimePresentation: GhostteaTerminalPresentationConfig?
  private var configurationTask: Task<Void, Never>?
  private var configurationGeneration = 0
  private let diagnostics: GhostteaDiagnosticRecorder
  private(set) var configuration: GhostteaConfigSnapshot
  private var factory: GhostteaSSHWorkspaceSessionFactory?
  private var coordinator: GhostteaWorkspaceSessionCoordinator<GhostteaSSHWorkspaceSession>?
  private var repository: GhostteaSSHConnectionProfileRepository?
  private var credentialStore: KeychainSSHCredentialStore?
  private var restorationStore: GhostteaWorkspaceRestorationStore?
  private var sessionProfileIDs: [String: String] = [:]
  private var grids: [String: GhostteaTerminalGridSize] = [:]
  private var layoutEpochs: [String: UInt64] = [:]
  private var coldSessionRequests: [String: GhostteaWorkspaceSessionRequest] = [:]
  private var coldSessionIDs: Set<String> = []
  private var evictionTasks: [String: Task<Void, Never>] = [:]
  private var rehydrationTasks: [String: Task<GhostteaSSHWorkspaceSession, Error>] = [:]
  private var residency = GhostteaWorkspaceSessionResidency()
  private var shortcutState = GhostteaWorkspaceShortcutState()
  private var requestedProfileID: String?
  private var networkTask: Task<Void, Never>?
  private var memoryWarningTask: Task<Void, Never>?
  private var networkPath = TerminalNetworkPath.unknown
  private var hostKeyContinuation: CheckedContinuation<GhostteaSSHHostKeyDecision, Never>?
  private var keyboardContinuation: CheckedContinuation<[String], Error>?
  private var nextFactoryHandle: UInt64 = 10_000
  private var started = false
  private let memoryBudget: GhostteaWorkspaceMemoryBudget
  #if DEBUG
    private var memoryRecoveryAutomationActive = false
    private var memoryRecoveryAllocations: [String: [GhostteaMemoryRecoveryAllocation]] = [:]
    private var memoryRecoveryEvictionOrder: [String] = []
  #endif

  init(
    diagnostics: GhostteaDiagnosticRecorder,
    configuration: GhostteaConfigSnapshot
  ) {
    self.diagnostics = diagnostics
    self.configuration = configuration
    presentationConfiguration = configuration.terminalPresentation
    memoryBudget = .recommended(
      forPhysicalMemoryBytes: ProcessInfo.processInfo.physicalMemory)
  }

  deinit {
    networkTask?.cancel()
    memoryWarningTask?.cancel()
    configurationTask?.cancel()
  }

  func configurationChanged(_ next: GhostteaConfigSnapshot) {
    guard next.revision != configuration.revision else { return }
    configuration = next
    presentationConfiguration = next.terminalPresentation.preservingRuntimeMetrics(
      from: runtimePresentation)
    configurationGeneration += 1
    let generation = configurationGeneration
    configurationTask?.cancel()
    configurationTask = Task { [weak self] in
      guard let self, !Task.isCancelled,
        generation == configurationGeneration,
        next.revision == configuration.revision
      else { return }
      await factory?.updateTerminalConfiguration(next)
      guard !Task.isCancelled, generation == configurationGeneration else { return }
      guard let coordinator else { return }
      for sessionID in await coordinator.sessionIDs {
        guard !Task.isCancelled, generation == configurationGeneration else { return }
        guard let resource = await coordinator.session(for: sessionID) else { continue }
        do {
          let update = try await resource.terminal.apply(config: next, render: .full)
          guard !Task.isCancelled, generation == configurationGeneration else { return }
          if let frame = update.effects.last(where: { $0.kind == .frameReady })?.payload {
            frames[sessionID] = frame
          }
        } catch {
          guard !Task.isCancelled, generation == configurationGeneration else { return }
          record(.sshSessionOperationFailed, severity: .warning)
        }
      }
    }
  }

  var selectedSessionID: String? {
    guard
      let workspace,
      let tab = workspace.tabs.first(where: { $0.id == workspace.selectedTabID })
    else { return nil }
    return tab.workspace.root.panes
      .first(where: { $0.id == tab.workspace.activePaneID })?.sessionID
  }

  var commandPaletteEntries: [GhostteaWorkspacePaletteEntry] {
    profiles.map { profile in
      GhostteaWorkspacePaletteEntry.connectionProfile(
        profileID: profile.id.uuidString.lowercased(),
        name: profile.name,
        subtitle: "\(profile.username)@\(profile.host):\(profile.port)",
        keywords: ["ssh", "remote", profile.host, profile.username])
    } + [.manageConnectionProfiles()] + GhostteaWorkspacePaletteEntry.workspaceCommands()
  }

  func start() {
    guard !started else { return }
    started = true
    networkTask = Task { [weak self] in
      for await path in AppleTerminalNetworkPathMonitor().updates() {
        guard let self else { return }
        await self.networkChanged(path)
      }
    }
    memoryWarningTask = Task { [weak self] in
      for await _ in NotificationCenter.default.notifications(
        named: UIApplication.didReceiveMemoryWarningNotification)
      {
        guard let self else { return }
        await self.handleMemoryWarning()
      }
    }
    Task {
      do {
        let store = try KeychainSSHCredentialStore()
        let root = try applicationSupportRoot()
        let profileStore = GhostteaSSHConnectionProfileStore(
          fileURL: root.appendingPathComponent("ssh-profiles.json"))
        let repository = GhostteaSSHConnectionProfileRepository(
          profileStore: profileStore,
          credentialVault: store)
        let restorationStore = GhostteaWorkspaceRestorationStore(
          fileURL: root.appendingPathComponent("ssh-workspace.json"))
        credentialStore = store
        self.repository = repository
        self.restorationStore = restorationStore
        profiles = try await repository.load()
        #if DEBUG
          if await runProcessRestorationAutomationIfRequested() { return }
          if await runMemoryRecoveryAutomationIfRequested() { return }
        #endif
        if try await restoreWorkspace() { return }
        status = profiles.isEmpty ? "Add an SSH connection to begin." : "Choose a saved connection"
      } catch {
        record(.sshRepositoryLoadFailed)
        status = "Could not load saved connections"
      }
    }
  }

  func connect(_ profile: GhostteaSSHConnectionProfile) {
    guard !isBusy else { return }
    isBusy = true
    status = "Preparing \(profile.name)…"
    Task {
      await disconnectWorkspace(clearPersistence: true)
      do {
        let runtime = try terminalRuntime()
        let factory = try makeFactory(runtime: runtime, defaultProfile: profile)
        let allocation = try await factory.allocate(.newTab)
        try await synchronizeTerminalConfiguration(
          factory: factory,
          sessions: [allocation.sessionID: allocation.session])
        let paneID = identity("pane")
        let tabID = identity("tab")
        let pane = GhostteaWorkspacePane(id: paneID, sessionID: allocation.sessionID)
        let terminal = try GhostteaWorkspaceDocument(root: .pane(pane), activePaneID: paneID)
        let document = try GhostteaWorkspaceTabsDocument(
          selectedTabID: tabID,
          tabs: [GhostteaWorkspaceTab(id: tabID, workspace: terminal)])

        sessionProfileIDs[allocation.sessionID] = profile.id.uuidString.lowercased()
        grids[allocation.sessionID] = GhostteaTerminalGridSize(
          columns: UInt16(profile.columns), rows: UInt16(profile.rows))
        sessionStatuses[allocation.sessionID] = "Connecting…"
        self.factory = factory
        coordinator = try makeCoordinator(
          document: document,
          sessions: [allocation.sessionID: allocation.session],
          factory: factory)
        workspace = document
        residency = GhostteaWorkspaceSessionResidency(sessionIDs: document.sessionIDs)
        residency.touch(document.selectedTabSessionIDs)
        status = "Workspace ready"
        isBusy = false
        try await persistWorkspace()
      } catch {
        isBusy = false
        record(.sshConnectFailed)
        status = GhostteaSSHFailurePolicy.description(error)
      }
    }
  }

  func createTab(profileID: String? = nil) {
    guard let coordinator, !isBusy else { return }
    isBusy = true
    requestedProfileID = profileID
    Task {
      defer {
        requestedProfileID = nil
        isBusy = false
      }
      do {
        let transition = try await coordinator.createTab()
        workspace = transition.document
        residency.touch(transition.document.selectedTabSessionIDs)
        try await persistWorkspace()
      } catch {
        record(.sshTabCreateFailed)
        status = "Could not create tab"
      }
    }
  }

  func split(_ axis: GhostteaWorkspaceSplitAxis) {
    guard let coordinator, !isBusy else { return }
    isBusy = true
    Task {
      do {
        let transition = try await coordinator.splitSelected(axis: axis)
        workspace = transition.document
        residency.touch(transition.document.selectedTabSessionIDs)
        try await persistWorkspace()
      } catch {
        record(.sshSplitFailed)
        status = "Could not split terminal"
      }
      isBusy = false
    }
  }

  func apply(_ action: GhostteaWorkspaceTabsAction) {
    guard let coordinator else { return }
    Task {
      do {
        let transition = try await coordinator.apply(action)
        if transition.shouldCloseWindow {
          await disconnectWorkspace(clearPersistence: true)
          return
        }
        workspace = transition.document
        for sessionID in transition.closedSessionIDs where coldSessionIDs.contains(sessionID) {
          sessionTerminated(sessionID)
        }
        residency.touch(transition.document.selectedTabSessionIDs)
        await rehydrateSelectedSessions(in: transition.document)
        try await persistWorkspace()
      } catch {
        record(.sshWorkspaceUpdateFailed)
        status = "Workspace update failed"
      }
    }
  }

  func invoke(_ invocation: GhostteaWorkspacePaletteInvocation) {
    switch invocation {
    case .connectionProfile(let profileID):
      createTab(profileID: profileID)
    case .manageConnectionProfiles:
      presentsProfileManager = true
    case .command(let command):
      route(command)
    }
  }

  func reconnect(_ sessionID: String? = nil) {
    guard let coordinator else { return }
    let target = sessionID ?? selectedSessionID
    guard let target else { return }
    sessionStatuses[target] = "Connecting…"
    Task {
      do {
        let resource = try await ensureResident(target, coordinator: coordinator)
        await resource.session.requestConnect()
      } catch {
        record(.terminalSessionRehydrationFailed)
        sessionStatuses[target] = "Could not restore terminal"
      }
    }
  }

  func disconnect() {
    Task { await disconnectWorkspace(clearPersistence: true) }
  }

  func saveProfile(_ request: GhostteaSSHConnectionProfileSaveRequest) {
    guard let repository else { return }
    Task {
      do {
        let mutation = try await repository.save(request)
        profiles = try await repository.load()
        status =
          mutation.credentialCleanupFailures.isEmpty
          ? "Saved connection"
          : "Saved connection; credential cleanup will be retried"
      } catch {
        record(.sshProfileSaveFailed)
        status = "Could not save connection"
      }
    }
  }

  func deleteProfile(_ id: UUID) {
    guard let repository else { return }
    Task {
      do {
        let profileID = id.uuidString.lowercased()
        if sessionProfileIDs.values.contains(profileID) {
          await disconnectWorkspace(clearPersistence: true)
        }
        _ = try await repository.delete(profileID: id)
        profiles = try await repository.load()
        status = profiles.isEmpty ? "Add an SSH connection to begin." : "Deleted connection"
      } catch {
        record(.sshProfileDeleteFailed)
        status = "Could not delete connection"
      }
    }
  }

  func resolveHostKey(_ decision: GhostteaSSHHostKeyDecision) {
    let continuation = hostKeyContinuation
    hostKeyContinuation = nil
    pendingHostKey = nil
    continuation?.resume(returning: decision)
  }

  func resolveKeyboardChallenge(_ responses: [String]) {
    let continuation = keyboardContinuation
    keyboardContinuation = nil
    pendingKeyboardChallenge = nil
    continuation?.resume(returning: responses)
  }

  func cancelKeyboardChallenge() {
    let continuation = keyboardContinuation
    keyboardContinuation = nil
    pendingKeyboardChallenge = nil
    continuation?.resume(throwing: CancellationError())
  }

  func frame(for sessionID: String) -> Data? { frames[sessionID] }

  func sessionStatus(for sessionID: String) -> String {
    sessionStatuses[sessionID] ?? "Reconnect available"
  }

  func title(for sessionID: String) -> String {
    guard
      let profileID = sessionProfileIDs[sessionID],
      let profile = profiles.first(where: { $0.id.uuidString.lowercased() == profileID })
    else { return "Terminal" }
    return profile.name
  }

  func updateGrid(_ value: GhostteaTerminalGridSize, sessionID: String) {
    guard value != grids[sessionID], let coordinator else { return }
    grids[sessionID] = value
    let epoch = (layoutEpochs[sessionID] ?? 0) &+ 1
    layoutEpochs[sessionID] = epoch
    Task {
      guard let resource = await coordinator.session(for: sessionID) else { return }
      try? await resource.session.resize(
        columns: Int(value.columns), rows: Int(value.rows), layoutEpoch: epoch)
    }
  }

  func handleHardwareKey(_ event: GhostteaHardwareKeyEvent, sessionID: String) -> Bool {
    guard coordinator != nil else { return false }
    let modifiers = event.modifiers
    let chord = GhostteaWorkspaceKeyChord(
      domCode: event.code,
      command: modifiers.contains(.command),
      shift: modifiers.contains(.shift),
      option: modifiers.contains(.option),
      control: modifiers.contains(.control))
    let phase: GhostteaWorkspaceKeyPhase
    switch event.action {
    case .down: phase = .down
    case .repeated: phase = .repeated
    case .up: phase = .up
    }
    let shortcut = shortcutState.handle(
      usage: event.hidUsage,
      phase: phase,
      chord: chord)
    if let command = shortcut.command { route(command) }
    if shortcut.handled { return true }
    guard !modifiers.contains(.command) else { return false }
    withSession(sessionID) { try? await $0.session.sendKey(event.coreEvent) }
    return true
  }

  func handleSoftwareInput(_ event: GhostteaSoftwareInputEvent, sessionID: String) {
    withSession(sessionID) { resource in
      switch event {
      case .text(let text): try await resource.session.send(Data(text.utf8))
      case .enter: try await resource.session.sendKey(Self.softwareKey(hidUsage: 0x28))
      case .deleteBackward:
        try await resource.session.sendKey(Self.softwareKey(hidUsage: 0x2a))
      case .paste(let text): try await resource.session.sendPaste(text)
      case .key(let key): try await resource.session.sendKey(key.coreEvent)
      }
    }
  }

  func handleMouse(_ event: GhostteaTerminalMouseEvent, sessionID: String) {
    withSession(sessionID) { try? await $0.session.sendMouse(event.coreEvent) }
  }

  func handleScroll(_ rows: Int, sessionID: String) {
    guard rows != 0 else { return }
    withSession(sessionID) { try? await $0.session.scroll(rows: Int64(rows)) }
  }

  func requestFullRefresh(sessionID: String) {
    withSession(sessionID) { try? await $0.session.refresh() }
  }

  func copySelection(_ selection: GhostteaTerminalSelection, sessionID: String) {
    withSession(sessionID) { resource in
      let data = try await resource.terminal.selectionTextBytes(
        startColumn: selection.anchor.column,
        startRow: selection.anchor.row,
        endColumn: selection.focus.column,
        endRow: selection.focus.row)
      await MainActor.run {
        UIPasteboard.general.string = String(decoding: data, as: UTF8.self)
      }
    }
  }

  func copyAll(sessionID: String) {
    withSession(sessionID) { resource in
      let data = try await resource.terminal.selectionTextBytes(
        startColumn: 0, startRow: 0, endColumn: 0, endRow: 0, selectAll: true)
      await MainActor.run {
        UIPasteboard.general.string = String(decoding: data, as: UTF8.self)
      }
    }
  }

  func sceneChanged(_ phase: ScenePhase) {
    guard coordinator != nil else { return }
    Task {
      await forEachSession { resource in
        switch phase {
        case .active: await resource.session.becameActive()
        case .background: await resource.session.enteredBackground()
        case .inactive: break
        @unknown default: break
        }
      }
    }
  }

  private func restoreWorkspace() async throws -> Bool {
    guard
      let restorationStore,
      let credentialStore,
      let persisted = try await restorationStore.load()
    else { return false }
    guard
      let defaultBinding = persisted.sessionProfiles.first,
      let defaultProfile = profile(id: defaultBinding.profileID)
    else {
      try await restorationStore.remove()
      return false
    }

    let runtime = try terminalRuntime()
    let factory = try makeFactory(runtime: runtime, defaultProfile: defaultProfile)
    let result = try await factory.restore(
      persisted,
      profiles: profiles,
      knownHostsPath: try knownHostsPath(),
      hostKeyPolicy: hostKeyPolicy(),
      credentialStore: credentialStore,
      keyboardInteractiveResponder: keyboardInteractiveResponder(),
      connect: false)
    guard let document = result.document else {
      try await restorationStore.remove()
      return false
    }
    try await synchronizeTerminalConfiguration(
      factory: factory,
      sessions: result.sessions)

    let liveIDs = Set(result.sessions.keys)
    sessionProfileIDs = persisted.profileIDBySessionID.filter { liveIDs.contains($0.key) }
    for (sessionID, resource) in result.sessions {
      let restoredProfile = resource.profileID.flatMap { profile(id: $0) } ?? defaultProfile
      grids[sessionID] = GhostteaTerminalGridSize(
        columns: UInt16(restoredProfile.columns),
        rows: UInt16(restoredProfile.rows))
      sessionStatuses[sessionID] = "Reconnect available"
    }
    self.factory = factory
    coordinator = try makeCoordinator(
      document: document, sessions: result.sessions, factory: factory)
    workspace = document
    residency = GhostteaWorkspaceSessionResidency(sessionIDs: document.sessionIDs)
    residency.touch(document.selectedTabSessionIDs)
    status =
      result.unavailableSessionIDs.isEmpty
      ? "Workspace restored · reconnect when ready"
      : "Workspace restored; \(result.unavailableSessionIDs.count) unavailable pane(s) removed"
    try await persistWorkspace()
    return true
  }

  private func makeFactory(
    runtime: GhostteaRuntime,
    defaultProfile: GhostteaSSHConnectionProfile
  ) throws -> GhostteaSSHWorkspaceSessionFactory {
    let initialHandle = nextFactoryHandle
    nextFactoryHandle = initialHandle > UInt64.max - 10_000 ? 10_000 : initialHandle + 10_000
    return try GhostteaSSHWorkspaceSessionFactory(
      runtime: runtime,
      ssh: try configuration(for: defaultProfile),
      profileID: defaultProfile.id.uuidString.lowercased(),
      sessionConfiguration: .ssh(initialPath: networkPath),
      initialSessionHandle: initialHandle,
      scrollbackBytes: min(
        UInt64(memoryBudget.scrollbackBytesPerSession),
        configuration.terminal.scrollbackBytes
      ),
      terminalConfiguration: configuration,
      eventHandler: { [weak self] event in await self?.handle(event) })
  }

  /// Brings a factory and every not-yet-published terminal to the latest
  /// device configuration. Configuration changes can arrive while allocation
  /// or restoration is suspended, before `configurationChanged(_:)` can see
  /// either object through the model's published workspace state.
  private func synchronizeTerminalConfiguration(
    factory: GhostteaSSHWorkspaceSessionFactory,
    sessions: [String: GhostteaSSHWorkspaceSession]
  ) async throws {
    do {
      while true {
        try Task.checkCancellation()
        let generation = configurationGeneration
        let latest = configuration
        await factory.updateTerminalConfiguration(latest)

        var renderedFrames: [String: Data] = [:]
        for (sessionID, resource) in sessions {
          let update = try await resource.terminal.apply(config: latest, render: .full)
          try Task.checkCancellation()
          if let frame = update.effects.last(where: { $0.kind == .frameReady })?.payload {
            renderedFrames[sessionID] = frame
          }
        }
        guard generation == configurationGeneration else { continue }
        for (sessionID, frame) in renderedFrames {
          frames[sessionID] = frame
        }
        return
      }
    } catch {
      // None of these sessions is coordinator-owned yet. Tear down the whole
      // unpublished allocation set so a failed reconciliation cannot leave a
      // connected transport or a reserved factory identity behind.
      for resource in sessions.values {
        await factory.evict(resource)
      }
      throw error
    }
  }

  private func makeCoordinator(
    document: GhostteaWorkspaceTabsDocument,
    sessions: [String: GhostteaSSHWorkspaceSession],
    factory: GhostteaSSHWorkspaceSessionFactory
  ) throws -> GhostteaWorkspaceSessionCoordinator<GhostteaSSHWorkspaceSession> {
    try GhostteaWorkspaceSessionCoordinator(
      document: document,
      sessions: sessions,
      allocator: { [weak self, factory] request in
        guard let self else { throw GhostteaSSHAppError.notReady }
        return try await self.allocate(request, factory: factory)
      },
      terminator: { [weak self] sessionID, resource in
        await GhostteaSSHWorkspaceSessionFactory.disconnect(resource)
        await self?.sessionTerminated(sessionID)
      })
  }

  private func allocate(
    _ request: GhostteaWorkspaceSessionRequest,
    factory: GhostteaSSHWorkspaceSessionFactory
  ) async throws -> GhostteaWorkspaceSessionAllocation<GhostteaSSHWorkspaceSession> {
    guard let profile = profileForAllocation(request, requestedProfileID: requestedProfileID) else {
      throw GhostteaSSHAppError.missingProfile
    }
    let profileID = profile.id.uuidString.lowercased()
    let allocation = try await factory.allocate(
      request,
      ssh: try configuration(for: profile),
      sessionID: nil,
      profileID: profileID,
      connect: true)
    try await synchronizeTerminalConfiguration(
      factory: factory,
      sessions: [allocation.sessionID: allocation.session])
    sessionProfileIDs[allocation.sessionID] = profileID
    grids[allocation.sessionID] = GhostteaTerminalGridSize(
      columns: UInt16(profile.columns), rows: UInt16(profile.rows))
    sessionStatuses[allocation.sessionID] = "Connecting…"
    return allocation
  }

  private func configuration(
    for profile: GhostteaSSHConnectionProfile
  ) throws -> GhostteaSSHConfiguration {
    guard let credentialStore else { throw GhostteaSSHAppError.notReady }
    return try profile.configuration(
      knownHostsPath: try knownHostsPath(),
      hostKeyPolicy: hostKeyPolicy(),
      credentialStore: credentialStore,
      keyboardInteractiveResponder: keyboardInteractiveResponder())
  }

  private func hostKeyPolicy() -> GhostteaSSHHostKeyPolicy {
    .ask { [weak self] challenge in
      guard let self else { return .reject }
      return await self.requestHostKeyDecision(challenge)
    }
  }

  private func keyboardInteractiveResponder() -> GhostteaSSHKeyboardInteractiveResponder {
    { [weak self] challenge in
      guard let self else { throw CancellationError() }
      return try await self.requestKeyboardResponses(challenge)
    }
  }

  private func profileForAllocation(
    _ request: GhostteaWorkspaceSessionRequest,
    requestedProfileID: String?
  ) -> GhostteaSSHConnectionProfile? {
    if case .newTab = request,
      let requestedProfileID,
      let requested = profile(id: requestedProfileID)
    {
      return requested
    }
    let sourceID: String?
    switch request {
    case .newTab: sourceID = selectedSessionID
    case .split(_, let sourceSessionID): sourceID = sourceSessionID
    }
    if let sourceID, let profileID = sessionProfileIDs[sourceID],
      let profile = profile(id: profileID)
    {
      return profile
    }
    return profiles.first
  }

  private func profile(id: String) -> GhostteaSSHConnectionProfile? {
    profiles.first { $0.id.uuidString.lowercased() == id.lowercased() }
  }

  private func route(_ command: GhostteaWorkspaceCommand) {
    guard let workspace, let route = command.route(in: workspace) else { return }
    switch route {
    case .reducer(let action): apply(action)
    case .requestNewTab: createTab()
    case .requestSplit(let axis): split(axis)
    case .openRemoteSessions: presentsCommandPalette = true
    }
  }

  private func persistWorkspace() async throws {
    guard let workspace, let restorationStore else { return }
    let document = try GhostteaWorkspaceRestorationDocument(
      workspace: workspace,
      sessionProfiles: workspace.uniqueSessionIDs.compactMap { sessionID in
        sessionProfileIDs[sessionID].map {
          GhostteaWorkspaceSessionProfileBinding(sessionID: sessionID, profileID: $0)
        }
      })
    try await restorationStore.save(document)
  }

  private func networkChanged(_ path: TerminalNetworkPath) async {
    networkPath = path
    await forEachSession { await $0.session.updateNetworkPath(path) }
  }

  private func handleMemoryWarning() async {
    guard let workspace, let coordinator else { return }
    for sessionID in workspace.inactiveSessionIDs {
      guard let resource = await coordinator.session(for: sessionID) else { continue }
      do {
        _ = try await resource.terminal.compressScrollbackFull()
      } catch {
        record(.terminalMemoryCompressionFailed, severity: .warning)
      }
    }
    await enforceResidentSessionCap(workspace: workspace, coordinator: coordinator)
  }

  private func enforceResidentSessionCap(
    workspace: GhostteaWorkspaceTabsDocument,
    coordinator: GhostteaWorkspaceSessionCoordinator<GhostteaSSHWorkspaceSession>
  ) async {
    let candidates = residency.evictionCandidates(
      in: workspace,
      residentSessionIDs: await coordinator.sessionIDs,
      maximumResidentSessions: memoryBudget.maximumResidentSessions)
    for sessionID in candidates {
      await evictSession(sessionID, coordinator: coordinator)
    }

    guard var footprint = GhostteaProcessMemoryFootprint.currentBytes() else {
      record(.terminalMemorySamplingFailed, severity: .warning)
      return
    }
    guard footprint > memoryBudget.softApplicationFootprintBytes else { return }

    let selectedCount = workspace.selectedTabUniqueSessionIDs.filter {
      !coldSessionIDs.contains($0)
    }.count
    let pressureCandidates = residency.evictionCandidates(
      in: workspace,
      residentSessionIDs: await coordinator.sessionIDs,
      maximumResidentSessions: selectedCount)
    for sessionID in pressureCandidates {
      await evictSession(sessionID, coordinator: coordinator)
      guard let sampled = GhostteaProcessMemoryFootprint.currentBytes() else {
        record(.terminalMemorySamplingFailed, severity: .warning)
        return
      }
      footprint = sampled
      if footprint <= memoryBudget.softApplicationFootprintBytes { return }
    }

    if footprint > memoryBudget.hardApplicationFootprintBytes {
      record(.terminalMemoryHardBudgetUnsatisfied)
    } else {
      record(.terminalMemorySoftBudgetUnsatisfied, severity: .warning)
    }
  }

  private func evictSession(
    _ sessionID: String,
    coordinator: GhostteaWorkspaceSessionCoordinator<GhostteaSSHWorkspaceSession>
  ) async {
    guard let factory else { return }
    do {
      let resource = try await coordinator.evictSession(sessionID)
      coldSessionRequests[sessionID] = resource.request
      coldSessionIDs.insert(sessionID)
      frames[sessionID] = nil
      sessionStatuses[sessionID] = "Evicted · reconnect available"
      let eviction = Task { await factory.evict(resource) }
      evictionTasks[sessionID] = eviction
      await eviction.value
      evictionTasks[sessionID] = nil
      #if DEBUG
        if memoryRecoveryAutomationActive {
          memoryRecoveryAllocations[sessionID] = nil
          memoryRecoveryEvictionOrder.append(sessionID)
        }
      #endif
      record(.terminalSessionEvicted, severity: .info)
    } catch {
      record(.terminalSessionEvictionFailed)
    }
  }

  private func rehydrateSelectedSessions(
    in workspace: GhostteaWorkspaceTabsDocument
  ) async {
    guard let coordinator else { return }
    for sessionID in workspace.selectedTabSessionIDs where coldSessionIDs.contains(sessionID) {
      do {
        _ = try await ensureResident(sessionID, coordinator: coordinator)
      } catch {
        record(.terminalSessionRehydrationFailed)
        sessionStatuses[sessionID] = "Could not restore terminal"
      }
    }
  }

  private func ensureResident(
    _ sessionID: String,
    coordinator: GhostteaWorkspaceSessionCoordinator<GhostteaSSHWorkspaceSession>
  ) async throws -> GhostteaSSHWorkspaceSession {
    if let eviction = evictionTasks[sessionID] {
      await eviction.value
    }
    if let resident = await coordinator.session(for: sessionID) {
      residency.touch(sessionID)
      return resident
    }
    if let task = rehydrationTasks[sessionID] {
      return try await task.value
    }
    guard coldSessionIDs.contains(sessionID) else {
      throw GhostteaSSHAppError.missingResidentSession
    }
    let task = Task { @MainActor [weak self] () throws -> GhostteaSSHWorkspaceSession in
      guard let self else { throw CancellationError() }
      return try await self.performRehydration(sessionID, coordinator: coordinator)
    }
    rehydrationTasks[sessionID] = task
    do {
      let resource = try await task.value
      rehydrationTasks[sessionID] = nil
      return resource
    } catch {
      rehydrationTasks[sessionID] = nil
      throw error
    }
  }

  private func performRehydration(
    _ sessionID: String,
    coordinator: GhostteaWorkspaceSessionCoordinator<GhostteaSSHWorkspaceSession>
  ) async throws -> GhostteaSSHWorkspaceSession {
    guard
      let factory,
      let profileID = sessionProfileIDs[sessionID],
      let profile = profile(id: profileID)
    else { throw GhostteaSSHAppError.missingResidentSession }
    let allocation = try await factory.allocate(
      coldSessionRequests[sessionID] ?? .newTab,
      ssh: try configuration(for: profile),
      sessionID: sessionID,
      profileID: profileID,
      connect: false)
    do {
      try await coordinator.rehydrateSession(sessionID, session: allocation.session)
    } catch {
      await factory.evict(allocation.session)
      throw error
    }
    coldSessionRequests[sessionID] = nil
    coldSessionIDs.remove(sessionID)
    residency.touch(sessionID)
    sessionStatuses[sessionID] = "Reconnect available"
    return allocation.session
  }

  private func handle(_ routed: GhostteaSSHWorkspaceSessionEvent) async {
    let sessionID = routed.sessionID
    guard !coldSessionIDs.contains(sessionID) else { return }
    switch routed.event {
    case .stateChanged(let snapshot):
      switch snapshot.reconnectState {
      case .idle:
        sessionStatuses[sessionID] =
          snapshot.lastExitStatus.map(Self.exitDescription) ?? "Disconnected"
      case .waitingForNetwork: sessionStatuses[sessionID] = "Waiting for network"
      case .connecting: sessionStatuses[sessionID] = "Connecting…"
      case .connected: sessionStatuses[sessionID] = "Connected"
      case .reconnectAvailable: sessionStatuses[sessionID] = "Reconnect available"
      case .suspended: sessionStatuses[sessionID] = "Suspended"
      case .failed: sessionStatuses[sessionID] = snapshot.lastFailure?.message ?? "SSH failed"
      }
    case .frameReady(let value): frames[sessionID] = value
    case .clipboardWrite(let data):
      UIPasteboard.general.string = String(decoding: data, as: UTF8.self)
    case .bell: sessionStatuses[sessionID] = "Bell"
    case .logicalSnapshot, .metadataChanged: break
    }
  }

  private func disconnectWorkspace(clearPersistence: Bool) async {
    resolveHostKey(.reject)
    cancelKeyboardChallenge()
    let current = coordinator
    coordinator = nil
    factory = nil
    await current?.closeAll()
    workspace = nil
    frames = [:]
    sessionStatuses = [:]
    sessionProfileIDs = [:]
    grids = [:]
    layoutEpochs = [:]
    requestedProfileID = nil
    for task in rehydrationTasks.values { task.cancel() }
    for task in evictionTasks.values { task.cancel() }
    rehydrationTasks = [:]
    evictionTasks = [:]
    coldSessionRequests = [:]
    coldSessionIDs = []
    residency = GhostteaWorkspaceSessionResidency()
    shortcutState = GhostteaWorkspaceShortcutState()
    runtime = nil
    runtimePresentation = nil
    presentationConfiguration = configuration.terminalPresentation
    if clearPersistence { try? await restorationStore?.remove() }
    status = profiles.isEmpty ? "Add an SSH connection to begin." : "Choose a saved connection"
  }

  private func sessionTerminated(_ sessionID: String) {
    frames[sessionID] = nil
    sessionStatuses[sessionID] = nil
    sessionProfileIDs[sessionID] = nil
    grids[sessionID] = nil
    layoutEpochs[sessionID] = nil
    coldSessionRequests[sessionID] = nil
    coldSessionIDs.remove(sessionID)
    rehydrationTasks[sessionID]?.cancel()
    rehydrationTasks[sessionID] = nil
    evictionTasks[sessionID]?.cancel()
    evictionTasks[sessionID] = nil
    residency.remove(sessionID)
  }

  private func withSession(
    _ sessionID: String,
    operation: @escaping @Sendable (GhostteaSSHWorkspaceSession) async throws -> Void
  ) {
    guard let coordinator else { return }
    Task {
      do {
        let resource = try await ensureResident(sessionID, coordinator: coordinator)
        try await operation(resource)
      } catch {
        record(.sshSessionOperationFailed)
        sessionStatuses[sessionID] = "Operation failed"
      }
    }
  }

  private func forEachSession(
    _ operation: @escaping @Sendable (GhostteaSSHWorkspaceSession) async -> Void
  ) async {
    guard let coordinator else { return }
    let sessionIDs = await coordinator.sessionIDs
    for sessionID in sessionIDs {
      if let resource = await coordinator.session(for: sessionID) {
        await operation(resource)
      }
    }
  }

  private func requestHostKeyDecision(
    _ challenge: GhostteaSSHHostKeyChallenge
  ) async -> GhostteaSSHHostKeyDecision {
    hostKeyContinuation?.resume(returning: .reject)
    return await withCheckedContinuation { continuation in
      hostKeyContinuation = continuation
      pendingHostKey = GhostteaPendingHostKey(challenge: challenge)
    }
  }

  private func requestKeyboardResponses(
    _ challenge: GhostteaSSHKeyboardInteractiveChallenge
  ) async throws -> [String] {
    keyboardContinuation?.resume(throwing: CancellationError())
    return try await withCheckedThrowingContinuation { continuation in
      keyboardContinuation = continuation
      pendingKeyboardChallenge = GhostteaPendingKeyboardChallenge(challenge: challenge)
    }
  }

  private func applicationSupportRoot() throws -> URL {
    try ghostteaApplicationSupportRoot()
  }

  private func knownHostsPath() throws -> String {
    #if DEBUG
      if ghostteaAutomationDirectory() != nil {
        return try applicationSupportRoot().appendingPathComponent("known-hosts").path
      }
    #endif
    return try GhostteaSSHKnownHostsFile().prepare()
  }

  #if DEBUG
    private func runProcessRestorationAutomationIfRequested() async -> Bool {
      guard let rootName = ghostteaProcessRestorationAutomationDirectory() else { return false }
      do {
        let environment = ProcessInfo.processInfo.environment
        if environment["GHOSTTEA_AUTORUN_PROCESS_RESTORATION_PREPARE"] == "1" {
          try await prepareProcessRestorationAutomation(rootName: rootName)
          print("GHOSTTEA_PROCESS_RESTORATION_PREPARED")
          fflush(nil)
          return true
        }
        try await verifyProcessRestorationAutomation(rootName: rootName)
        print("GHOSTTEA_PROCESS_RESTORATION_PASS")
        fflush(nil)
        Darwin.exit(EXIT_SUCCESS)
      } catch {
        print("GHOSTTEA_PROCESS_RESTORATION_FAIL")
        fflush(nil)
        Darwin.exit(EXIT_FAILURE)
      }
    }

    private func prepareProcessRestorationAutomation(rootName: String) async throws {
      guard credentialStore != nil else { throw GhostteaSSHAppError.automationInvariant }
      let root = try applicationSupportRoot()
      guard root.lastPathComponent == rootName else {
        throw GhostteaSSHAppError.automationInvariant
      }
      guard let profileID = UUID(uuidString: "00000000-0000-4000-8000-000000000001") else {
        throw GhostteaSSHAppError.automationInvariant
      }
      let profile = try GhostteaSSHConnectionProfile(
        id: profileID,
        name: "Process restoration fixture",
        host: "invalid.invalid",
        username: "restoration-fixture",
        authentication: .keyboardInteractive
      )
      let profileStore = GhostteaSSHConnectionProfileStore(
        fileURL: root.appendingPathComponent("ssh-profiles.json")
      )
      try await profileStore.save([profile])
      profiles = [profile]

      let runtime = try terminalRuntime()
      let factory = try makeFactory(runtime: runtime, defaultProfile: profile)
      let allocation = try await factory.allocate(.newTab, connect: false)
      try await synchronizeTerminalConfiguration(
        factory: factory,
        sessions: [allocation.sessionID: allocation.session])
      let pane = GhostteaWorkspacePane(id: "automation-pane", sessionID: allocation.sessionID)
      let terminal = try GhostteaWorkspaceDocument(root: .pane(pane), activePaneID: pane.id)
      let document = try GhostteaWorkspaceTabsDocument(
        selectedTabID: "automation-tab",
        tabs: [GhostteaWorkspaceTab(id: "automation-tab", workspace: terminal)]
      )
      let persistedProfileID = profile.id.uuidString.lowercased()
      sessionProfileIDs = [allocation.sessionID: persistedProfileID]
      grids = [
        allocation.sessionID: GhostteaTerminalGridSize(
          columns: UInt16(profile.columns), rows: UInt16(profile.rows))
      ]
      sessionStatuses = [allocation.sessionID: "Reconnect available"]
      self.factory = factory
      coordinator = try makeCoordinator(
        document: document,
        sessions: [allocation.sessionID: allocation.session],
        factory: factory
      )
      workspace = document
      residency = GhostteaWorkspaceSessionResidency(sessionIDs: document.sessionIDs)
      residency.touch(document.selectedTabSessionIDs)
      status = "Workspace ready"
      try await persistWorkspace()

      guard await allocation.session.session.snapshot().reconnectState == .idle else {
        throw GhostteaSSHAppError.automationInvariant
      }
      try await diagnostics.beginLaunch()
      let diagnosticsSnapshot = try await diagnostics.snapshot()
      guard diagnosticsSnapshot.launchActive,
        let sequence = diagnosticsSnapshot.events.last?.sequence
      else { throw GhostteaSSHAppError.automationInvariant }
      let checkpoint = ProcessRestorationAutomationCheckpoint(diagnosticSequence: sequence)
      let checkpointURL = root.appendingPathComponent("checkpoint.json")
      try JSONEncoder().encode(checkpoint).write(to: checkpointURL, options: .atomic)
      try FileManager.default.setAttributes(
        [.protectionKey: FileProtectionType.complete],
        ofItemAtPath: checkpointURL.path
      )
      try validateProcessRestorationFiles(root: root)
    }

    private func verifyProcessRestorationAutomation(rootName: String) async throws {
      let root = try applicationSupportRoot()
      guard root.lastPathComponent == rootName,
        try await restoreWorkspace(),
        let workspace,
        workspace.sessionIDs.count == 1,
        status == "Workspace restored · reconnect when ready",
        frames.isEmpty,
        let sessionID = workspace.sessionIDs.first,
        sessionStatuses[sessionID] == "Reconnect available",
        let coordinator,
        let resource = await coordinator.session(for: sessionID),
        await resource.session.snapshot().reconnectState == .idle
      else { throw GhostteaSSHAppError.automationInvariant }

      let restorationURL = root.appendingPathComponent("ssh-workspace.json")
      let restorationData = try Data(contentsOf: restorationURL)
      let restorationText = String(decoding: restorationData, as: UTF8.self)
      guard !restorationText.contains("invalid.invalid"),
        !restorationText.contains("restoration-fixture"),
        !restorationText.contains("\"host\""),
        !restorationText.contains("\"username\""),
        !restorationText.contains("\"authentication\"")
      else { throw GhostteaSSHAppError.automationInvariant }

      let checkpoint = try JSONDecoder().decode(
        ProcessRestorationAutomationCheckpoint.self,
        from: Data(contentsOf: root.appendingPathComponent("checkpoint.json"))
      )
      try await diagnostics.beginLaunch()
      let diagnosticsSnapshot = try await diagnostics.snapshot()
      guard
        diagnosticsSnapshot.events.contains(where: {
          $0.sequence > checkpoint.diagnosticSequence
            && $0.code == .previousTerminationUnrecorded
        })
      else { throw GhostteaSSHAppError.automationInvariant }

      try validateProcessRestorationFiles(root: root)
      await disconnectWorkspace(clearPersistence: true)
      try FileManager.default.removeItem(at: root)
    }

    private func validateProcessRestorationFiles(root: URL) throws {
      for name in ["ssh-profiles.json", "ssh-workspace.json", "checkpoint.json"] {
        let attributes = try FileManager.default.attributesOfItem(
          atPath: root.appendingPathComponent(name).path
        )
        guard attributes[.protectionKey] as? FileProtectionType == .complete else {
          throw GhostteaSSHAppError.automationInvariant
        }
      }
    }

    private func runMemoryRecoveryAutomationIfRequested() async -> Bool {
      guard let rootName = ghostteaMemoryRecoveryAutomationDirectory() else { return false }
      do {
        let result = try await runMemoryRecoveryAutomation(rootName: rootName)
        print(
          "GHOSTTEA_MEMORY_RECOVERY_PASS before=\(result.beforeBytes) after=\(result.afterBytes) evicted=\(result.evictedCount) tier=\(memoryBudget.tier.rawValue)"
        )
        fflush(nil)
        Darwin.exit(EXIT_SUCCESS)
      } catch {
        print("GHOSTTEA_MEMORY_RECOVERY_FAIL")
        fflush(nil)
        Darwin.exit(EXIT_FAILURE)
      }
    }

    private func runMemoryRecoveryAutomation(
      rootName: String
    ) async throws -> GhostteaMemoryRecoveryAutomationResult {
      guard credentialStore != nil else { throw GhostteaSSHAppError.automationInvariant }
      let root = try applicationSupportRoot()
      guard root.lastPathComponent == rootName,
        let profileUUID = UUID(uuidString: "00000000-0000-4000-8000-000000000002")
      else { throw GhostteaSSHAppError.automationInvariant }
      let profile = try GhostteaSSHConnectionProfile(
        id: profileUUID,
        name: "Memory recovery fixture",
        host: "invalid.invalid",
        username: "memory-fixture",
        authentication: .keyboardInteractive
      )
      let profileStore = GhostteaSSHConnectionProfileStore(
        fileURL: root.appendingPathComponent("ssh-profiles.json")
      )
      try await profileStore.save([profile])
      profiles = [profile]

      let runtime = try terminalRuntime()
      let factory = try makeFactory(runtime: runtime, defaultProfile: profile)
      var sessions: [String: GhostteaSSHWorkspaceSession] = [:]
      var tabs: [GhostteaWorkspaceTab] = []
      let persistedProfileID = profile.id.uuidString.lowercased()
      for index in 0..<5 {
        let allocation = try await factory.allocate(.newTab, connect: false)
        let pane = GhostteaWorkspacePane(
          id: "memory-pane-\(index)",
          sessionID: allocation.sessionID
        )
        let terminal = try GhostteaWorkspaceDocument(
          root: .pane(pane),
          activePaneID: pane.id
        )
        tabs.append(GhostteaWorkspaceTab(id: "memory-tab-\(index)", workspace: terminal))
        sessions[allocation.sessionID] = allocation.session
        sessionProfileIDs[allocation.sessionID] = persistedProfileID
        grids[allocation.sessionID] = GhostteaTerminalGridSize(
          columns: UInt16(profile.columns),
          rows: UInt16(profile.rows)
        )
        sessionStatuses[allocation.sessionID] = "Reconnect available"
      }
      let document = try GhostteaWorkspaceTabsDocument(
        selectedTabID: "memory-tab-4",
        tabs: tabs
      )
      try await synchronizeTerminalConfiguration(factory: factory, sessions: sessions)
      self.factory = factory
      coordinator = try makeCoordinator(
        document: document,
        sessions: sessions,
        factory: factory
      )
      workspace = document
      residency = GhostteaWorkspaceSessionResidency(sessionIDs: document.sessionIDs)
      residency.touch(document.selectedTabSessionIDs)
      status = "Workspace ready"
      try await persistWorkspace()

      let restorationData = try Data(
        contentsOf: root.appendingPathComponent("ssh-workspace.json")
      )
      let restorationText = String(decoding: restorationData, as: UTF8.self)
      guard !restorationText.contains("invalid.invalid"),
        !restorationText.contains("memory-fixture"),
        !restorationText.contains("\"host\""),
        !restorationText.contains("\"username\""),
        !restorationText.contains("\"authentication\"")
      else { throw GhostteaSSHAppError.automationInvariant }
      for name in ["ssh-profiles.json", "ssh-workspace.json"] {
        let attributes = try FileManager.default.attributesOfItem(
          atPath: root.appendingPathComponent(name).path
        )
        guard attributes[.protectionKey] as? FileProtectionType == .complete else {
          throw GhostteaSSHAppError.automationInvariant
        }
      }

      let hiddenSessionIDs = document.inactiveSessionIDs
      guard hiddenSessionIDs.count == 4,
        let selectedSessionID = document.selectedTabSessionIDs.first,
        let initialFootprint = GhostteaProcessMemoryFootprint.currentBytes()
      else { throw GhostteaSSHAppError.automationInvariant }
      try await diagnostics.beginLaunch()
      let diagnosticSnapshot = try await diagnostics.snapshot()
      let diagnosticBaseline = diagnosticSnapshot.events.last?.sequence ?? 0

      memoryRecoveryAutomationActive = true
      memoryRecoveryEvictionOrder = []
      let mebibyte = UInt64(1_048_576)
      let targetFootprint = min(
        memoryBudget.softApplicationFootprintBytes + 24 * mebibyte,
        memoryBudget.hardApplicationFootprintBytes - 16 * mebibyte
      )
      var loadedFootprint = initialFootprint
      var allocationIndex = 0
      while loadedFootprint <= targetFootprint {
        guard allocationIndex < 64 else { throw GhostteaSSHAppError.automationInvariant }
        let sessionID = hiddenSessionIDs[allocationIndex % hiddenSessionIDs.count]
        memoryRecoveryAllocations[sessionID, default: []].append(
          try GhostteaMemoryRecoveryAllocation(byteCount: 8 * Int(mebibyte))
        )
        allocationIndex += 1
        guard let sampled = GhostteaProcessMemoryFootprint.currentBytes() else {
          throw GhostteaSSHAppError.automationInvariant
        }
        loadedFootprint = sampled
      }
      guard loadedFootprint > memoryBudget.softApplicationFootprintBytes,
        loadedFootprint < memoryBudget.hardApplicationFootprintBytes
      else { throw GhostteaSSHAppError.automationInvariant }

      await handleMemoryWarning()
      try await Task.sleep(for: .milliseconds(100))
      guard let recoveredFootprint = GhostteaProcessMemoryFootprint.currentBytes(),
        recoveredFootprint <= memoryBudget.softApplicationFootprintBytes,
        !memoryRecoveryEvictionOrder.isEmpty,
        memoryRecoveryEvictionOrder
          == Array(hiddenSessionIDs.prefix(memoryRecoveryEvictionOrder.count)),
        !memoryRecoveryEvictionOrder.contains(selectedSessionID),
        workspace == document
      else { throw GhostteaSSHAppError.automationInvariant }
      guard let coordinator else { throw GhostteaSSHAppError.automationInvariant }
      let recoveredDocument = await coordinator.document
      guard recoveredDocument == document else {
        throw GhostteaSSHAppError.automationInvariant
      }

      let residentSessionIDs = await coordinator.sessionIDs
      guard !residentSessionIDs.contains(where: { memoryRecoveryEvictionOrder.contains($0) }),
        residentSessionIDs.contains(selectedSessionID),
        Set(memoryRecoveryEvictionOrder).isSubset(of: coldSessionIDs)
      else { throw GhostteaSSHAppError.automationInvariant }
      for sessionID in residentSessionIDs {
        guard let resource = await coordinator.session(for: sessionID) else {
          throw GhostteaSSHAppError.automationInvariant
        }
        let snapshot = await resource.session.snapshot()
        guard snapshot.reconnectState == .idle else {
          throw GhostteaSSHAppError.automationInvariant
        }
      }

      try await Task.sleep(for: .milliseconds(100))
      let recoveredDiagnostics = try await diagnostics.snapshot()
      let newDiagnostics = recoveredDiagnostics.events.filter {
        $0.sequence > diagnosticBaseline
      }
      guard
        newDiagnostics.filter({ $0.code == .terminalSessionEvicted }).count
          == memoryRecoveryEvictionOrder.count,
        !newDiagnostics.contains(where: {
          $0.code == .terminalMemorySamplingFailed
            || $0.code == .terminalMemorySoftBudgetUnsatisfied
            || $0.code == .terminalMemoryHardBudgetUnsatisfied
            || $0.code == .terminalSessionEvictionFailed
        })
      else { throw GhostteaSSHAppError.automationInvariant }

      let result = GhostteaMemoryRecoveryAutomationResult(
        beforeBytes: loadedFootprint,
        afterBytes: recoveredFootprint,
        evictedCount: memoryRecoveryEvictionOrder.count
      )
      memoryRecoveryAutomationActive = false
      memoryRecoveryAllocations.removeAll()
      await disconnectWorkspace(clearPersistence: true)
      try FileManager.default.removeItem(at: root)
      return result
    }
  #endif

  private func identity(_ kind: String) -> String {
    "ios-\(kind)-\(UUID().uuidString.lowercased())"
  }

  private func terminalRuntime() throws -> GhostteaRuntime {
    if let runtime { return runtime }
    let runtime = try GhostteaRuntime(config: configuration)
    self.runtime = runtime
    runtimePresentation = configuration.terminalPresentation
    presentationConfiguration = configuration.terminalPresentation
    return runtime
  }

  private func record(
    _ code: GhostteaDiagnosticCode,
    severity: GhostteaDiagnosticSeverity = .error
  ) {
    Task { try? await diagnostics.record(code, severity: severity) }
  }

  private static func softwareKey(hidUsage: UInt16) -> GhostteaKeyEvent {
    GhostteaHardwareKeyEvent(
      hidUsage: hidUsage,
      characters: "",
      charactersIgnoringModifiers: "",
      action: .down)!.coreEvent
  }

  private static func exitDescription(_ status: TerminalExitStatus) -> String {
    switch status {
    case .exited(let code): "Session ended · exit \(code)"
    case .signaled(let signal): "Session ended · signal \(signal)"
    }
  }
}

extension GhostteaTerminalPresentationConfig {
  fileprivate func preservingRuntimeMetrics(
    from runtime: GhostteaTerminalPresentationConfig?
  ) -> GhostteaTerminalPresentationConfig {
    guard let runtime else { return self }
    return GhostteaTerminalPresentationConfig(
      schemaVersion: schemaVersion,
      revision: revision,
      foreground: foreground,
      background: background,
      cursor: cursor,
      cursorText: cursorText,
      selectionBackground: selectionBackground,
      selectionForeground: selectionForeground,
      palette: palette,
      backgroundOpacity: backgroundOpacity,
      backgroundOpacityCells: backgroundOpacityCells,
      minimumContrast: minimumContrast,
      lightAdaptation: lightAdaptation,
      fontSize: runtime.fontSize,
      fontFamilies: runtime.fontFamilies,
      paddingX: paddingX,
      paddingY: paddingY,
      postProcess: postProcess,
      shaderEffects: shaderEffects,
      customShaderAnimation: customShaderAnimation,
      customShaderCount: customShaderCount
    )
  }
}

private enum GhostteaSSHAppError: Error {
  case notReady
  case missingProfile
  case missingResidentSession
  #if DEBUG
    case automationInvariant
  #endif
}

#if DEBUG
  private struct ProcessRestorationAutomationCheckpoint: Codable {
    let diagnosticSequence: UInt64
  }

  private struct GhostteaMemoryRecoveryAutomationResult {
    let beforeBytes: UInt64
    let afterBytes: UInt64
    let evictedCount: Int
  }

  private final class GhostteaMemoryRecoveryAllocation {
    private let pointer: UnsafeMutableRawPointer
    private let byteCount: Int

    init(byteCount: Int) throws {
      guard byteCount > 0,
        let mapped = mmap(
          nil,
          byteCount,
          PROT_READ | PROT_WRITE,
          MAP_PRIVATE | MAP_ANON,
          -1,
          0
        ),
        mapped != MAP_FAILED
      else { throw GhostteaSSHAppError.automationInvariant }
      pointer = mapped
      self.byteCount = byteCount
      memset(pointer, 0xA5, byteCount)
    }

    deinit {
      munmap(pointer, byteCount)
    }
  }
#endif
