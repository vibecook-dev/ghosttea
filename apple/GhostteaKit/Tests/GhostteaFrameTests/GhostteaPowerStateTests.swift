#if os(iOS)
  import Foundation
  import GhostteaTerminal
  import Testing

  @Test @MainActor func backgroundPowerNotificationUpdatesTheTerminalFrameRate() async throws {
    let view = try GhostteaTerminalMetalView()
    let expected = ProcessInfo.processInfo.isLowPowerModeEnabled ? 30 : 60
    view.preferredFramesPerSecond = 1
    #expect(view.preferredFramesPerSecond != expected)

    await withCheckedContinuation { posted in
      DispatchQueue.global(qos: .utility).async {
        NotificationCenter.default.post(name: .NSProcessInfoPowerStateDidChange, object: nil)
        posted.resume()
      }
    }

    let deadline = ContinuousClock.now + .seconds(2)
    while view.preferredFramesPerSecond != expected && ContinuousClock.now < deadline {
      try await Task.sleep(for: .milliseconds(5))
    }
    #expect(view.preferredFramesPerSecond == expected)
    #expect(view.isPaused)
  }
#endif
