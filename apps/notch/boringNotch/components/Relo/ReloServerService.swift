//
//  ReloServerService.swift
//  Relo Notch
//
//  The login agent that runs Relo's server on this Mac (plan 16): register it with macOS, read its state, remove it.
//  The server, CLI and Node live inside the app (`LocalServer`); a Debug build carries none, so local mode is hidden.
//

import AppKit
import Foundation
import Observation
import ReloNotchKit
import ServiceManagement

@MainActor @Observable
final class ReloServerService {
    static let shared = ReloServerService()

    @ObservationIgnored let server = LocalServer()
    @ObservationIgnored private var service: SMAppService { .agent(plistName: server.agentPlistName) }

    var isBundled: Bool { server.isBundled }

    enum State: Equatable {
        case notBundled, notRegistered, enabled, needsApproval, unavailable
    }

    /// The login item's state as macOS last said it; views that show it call `watchState()` so it stays current (the
    /// owner can switch Relo on under Login Items while the window is open).
    private(set) var state: State = .notRegistered

    init() { state = currentState() }

    private func currentState() -> State {
        guard isBundled else { return .notBundled }
        switch service.status {
        case .enabled: return .enabled
        case .requiresApproval: return .needsApproval
        case .notRegistered: return .notRegistered
        case .notFound: return .unavailable
        @unknown default: return .unavailable
        }
    }

    func refreshState() {
        let now = currentState()
        if now != state { state = now }
    }

    /// Keeps `state` current while the calling view is on screen (use as `.task { await service.watchState() }`).
    func watchState() async {
        while !Task.isCancelled {
            refreshState()
            try? await Task.sleep(for: .seconds(1.5))
        }
    }

    /// Registers the agent when it is not (macOS starts it at login from then on). Throws in plain words.
    func ensureRegistered() throws {
        guard isBundled else { throw LocalServer.Failure("This build of Relo does not carry the server.") }
        defer { refreshState() }
        switch service.status {
        case .enabled: return
        case .requiresApproval:
            throw LocalServer.Failure("macOS needs your approval: turn on Relo under Login Items in System Settings.")
        default:
            do {
                try service.register()
            } catch {
                if service.status == .requiresApproval {
                    throw LocalServer.Failure("macOS needs your approval: turn on Relo under Login Items in System Settings.")
                }
                throw LocalServer.Failure("macOS would not let Relo run in the background.")
            }
            if service.status == .requiresApproval {
                throw LocalServer.Failure("macOS needs your approval: turn on Relo under Login Items in System Settings.")
            }
        }
    }

    func unregister() async {
        guard isBundled else { return }
        try? await service.unregister()
        refreshState()
    }

    func openLoginItems() {
        SMAppService.openSystemSettingsLoginItems()
    }

    /// The server has stopped (after unregister): it no longer answers and its supervisor and PostgreSQL processes are
    /// gone, so the data can be removed. False when `timeout` seconds passed first.
    @discardableResult
    func waitUntilStopped(timeout: TimeInterval = 30) async -> Bool {
        let deadline = Date().addingTimeInterval(timeout)
        while Date() < deadline {
            if await server.currentHealth() == nil, !server.hasLiveProcess() { return true }
            try? await Task.sleep(for: .milliseconds(500))
        }
        return await server.currentHealth() == nil && !server.hasLiveProcess()
    }
}
