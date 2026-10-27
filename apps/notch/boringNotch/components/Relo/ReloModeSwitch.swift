//
//  ReloModeSwitch.swift
//  Relo Notch
//
//  Moving Relo for Mac from Relo on this Mac to a server of the owner's (this file), and back (`ReloLocalSetup` and
//  `ReloLocalMode.resumeLocal`). Both ways confirm in plain words, show progress, and never leave the Mac with neither:
//  a switch to a server that is not finished offers "Go back to Relo on this Mac".
//

import AppKit
import Foundation
import Observation
import ReloCore
import ReloNotchKit
import SwiftUI

/// The switch from Relo on this Mac to a server: sign-in, then connecting this Mac's agents, shown in Settings.
@MainActor @Observable
final class ReloModeSwitch {
    static let shared = ReloModeSwitch()

    enum Phase: Equatable {
        case idle
        /// Left Relo on this Mac; the owner signs in to a server.
        case signingIn
        /// Signed in; the relo command and the agents are being connected to the server.
        case connectingAgents
        case connected(host: String)
        /// Signed in, but the agents are not connected: what went wrong.
        case agentsFailed(String)
        /// The sign-in was closed or did not work: nothing runs here until the owner signs in or goes back.
        case cancelled
        case restoring
        case restoreFailed(String)
    }

    private(set) var phase: Phase = .idle
    @ObservationIgnored private var watcher: Task<Void, Never>?
    private let store = ReloNotch.store

    // MARK: The address Relo remembers

    /// Remembers the server this Mac is signed in to (the app's login, else the relo command's), for the way back.
    static func rememberCurrentServer() {
        let store = ReloNotch.store
        if !ReloLocalMode.isOn, [.connecting, .live, .offline, .needsSignIn].contains(store.connection), let origin = store.serverOrigin {
            ModeSwitch.remember(server: origin)
        } else if let host = ReloServerService.shared.server.existingRemoteLoginHost(), let url = URL(string: "https://\(host)") {
            ModeSwitch.remember(server: url)
        }
    }

    // MARK: Relo on this Mac to a server

    /// Asks, then leaves Relo on this Mac and takes the owner to sign in. True when it left.
    func useServer() async -> Bool {
        let alert = NSAlert()
        alert.messageText = ModeSwitch.useServerTitle
        alert.informativeText = ModeSwitch.useServerBody
        alert.addButton(withTitle: ModeSwitch.useServerButton)
        alert.addButton(withTitle: "Cancel")
        NSApp.activate(ignoringOtherApps: true)
        guard alert.runModal() == .alertFirstButtonReturn else { return false }
        if let problem = await ReloLocalMode.connectToServerInstead() {
            let failed = NSAlert()
            failed.messageText = "Relo is still running on this Mac"
            failed.informativeText = problem
            failed.runModal()
            return false
        }
        // The last server's address is filled in; the onboarding opens on its server screen.
        let address = ModeSwitch.lastServerAddress()
        if !address.isEmpty { _ = store.setServerOrigin(address) }
        phase = .signingIn
        NotificationCenter.default.post(name: .reloNeedsSetup, object: "server")
        watchSignIn()
        return true
    }

    /// The owner chose this Mac again (or left a server): nothing is waiting any more.
    func cancelPending() {
        watcher?.cancel()
        watcher = nil
        switch phase {
        case .signingIn, .cancelled, .agentsFailed: phase = .idle
        default: break
        }
    }

    func dismiss() {
        if case .restoring = phase { return }
        if case .connectingAgents = phase { return }
        watcher?.cancel()
        watcher = nil
        phase = .idle
    }

    /// Waits for the sign-in, then connects the agents. It keeps watching after a closed sign-in, so a sign-in made later
    /// (from the notch or Home) is followed by the same connection.
    private func watchSignIn() {
        watcher?.cancel()
        watcher = Task { @MainActor [weak self] in
            let started = Date()
            var windowSeen = false
            while !Task.isCancelled {
                guard let self else { return }
                if ReloLocalMode.isOn { self.phase = .idle; return }
                // The account waits for approval: Relo runs on this Mac meanwhile and moves by itself (ReloPendingApproval).
                if self.store.pendingApproval != nil { self.phase = .idle; return }
                let connection = self.store.connection
                if [.connecting, .live, .offline].contains(connection) {
                    await self.connectAgents()
                    return
                }
                let open = Self.onboardingIsOpen
                if open { windowSeen = true }
                if connection == .signingIn || open {
                    if self.phase == .cancelled { self.phase = .signingIn }
                } else if windowSeen || Date().timeIntervalSince(started) > 10 {
                    if self.phase == .signingIn { self.phase = .cancelled }
                }
                try? await Task.sleep(for: .seconds(1))
            }
        }
    }

    private static var onboardingIsOpen: Bool {
        NSApp.windows.contains { $0.identifier?.rawValue == "OnboardingWindow" && $0.isVisible }
    }

    /// Signed in to the server: the relo command and the agents report there from now on.
    func connectAgents() async {
        phase = .connectingAgents
        let agents = ReloAgents.shared
        // The app registers this Mac a moment after the sign-in; the connection needs its credential.
        let deadline = Date().addingTimeInterval(30)
        while store.deviceAccess == nil, Date() < deadline { try? await Task.sleep(for: .milliseconds(500)) }
        await agents.connect()
        await agents.refresh()
        if let note = agents.connectNote, note.failed {
            phase = .agentsFailed(note.text)
            return
        }
        guard agents.commandSignIn?.signedIn == true else {
            phase = .agentsFailed(ModeSwitch.agentsNotConnected)
            return
        }
        // Agents set up before now report through the relo command: bring their setup up to date (not worth failing for).
        try? await ReloServerService.shared.server.refreshAgents(timeout: 60)
        await agents.refresh()
        phase = .connected(host: store.serverOrigin?.host() ?? "your server")
    }

    /// The server's owner approved the account while this Mac waited (or ran Relo on this Mac meanwhile): leave Relo on
    /// this Mac without asking (the owner chose the server already), sign in with the approved session, connect the
    /// agents, and say so. Local history stays on this Mac. A sign-in that cannot finish goes back to Relo on this Mac.
    func connectApproved(session: AccountSession, pending: PendingSignIn) async {
        watcher?.cancel()
        watcher = nil
        phase = .connectingAgents
        _ = await ReloLocalMode.connectToServerInstead(ignoringProblems: true)
        var signedIn = false
        for pause in [0.0, 3, 10] {
            if pause > 0 { try? await Task.sleep(for: .seconds(pause)) }
            if await store.completeApprovedSignIn(session, pending: pending) { signedIn = true; break }
        }
        guard signedIn else {
            // The session is spent: nothing runs unless Relo on this Mac does. The owner can sign in again from Settings.
            phase = .restoring
            if let problem = await ReloLocalMode.resumeLocal() { phase = .restoreFailed(problem); watchApproval() } else { phase = .idle }
            ReloUpdater.shared.announce(PendingApproval.approvedNotFinished(host: pending.host))
            return
        }
        await connectAgents()
        if case .connected(let host) = phase {
            ReloUpdater.shared.announce(PendingApproval.approved(host: host))
        } else {
            ReloUpdater.shared.announce("You're approved on \(pending.host). \(ModeSwitch.agentsNotConnected)")
        }
    }

    func retryConnectAgents() {
        Task { await connectAgents() }
    }

    // MARK: Back to Relo on this Mac

    /// "Go back to Relo on this Mac": starts it again without the full setup. The Login Items approval, when macOS asks
    /// for it again, continues by itself.
    func goBack() async {
        guard phase != .restoring else { return }
        watcher?.cancel()
        watcher = nil
        phase = .restoring
        store.cancelSignIn()
        // The sign-in window has nothing left to do.
        NSApp.windows.first { $0.identifier?.rawValue == "OnboardingWindow" }?.close()
        if let problem = await ReloLocalMode.resumeLocal() {
            phase = .restoreFailed(problem)
            watchApproval()
        } else {
            phase = .idle
        }
    }

    private func watchApproval() {
        watcher?.cancel()
        watcher = Task { @MainActor [weak self] in
            let service = ReloServerService.shared
            while !Task.isCancelled {
                try? await Task.sleep(for: .seconds(1.5))
                service.refreshState()
                guard let self, case .restoreFailed = self.phase else { return }
                if service.state == .enabled { Task { await self.goBack() }; return }
            }
        }
    }
}

/// Settings: where a switch to a server stands, with the one button that fits (nothing when no switch is going on).
struct ReloModeSwitchGroup: View {
    private let model = ReloModeSwitch.shared
    private let service = ReloServerService.shared

    var body: some View {
        switch model.phase {
        case .idle:
            EmptyView()
        case .signingIn:
            group(spinner: true, ModeSwitch.signingIn, detail: "Relo on this Mac is stopped. Finish in the window that opened, or go back.") {
                goBackButton
            }
        case .connectingAgents:
            group(spinner: true, ModeSwitch.connectingAgents, detail: "This takes a few seconds.") { EmptyView() }
        case .connected(let host):
            group(done: true, ModeSwitch.connected(host: host), detail: "Your history from Relo on this Mac stays on this Mac.") {
                Button("OK") { model.dismiss() }.buttonStyle(ReloGlassButtonStyle())
            }
        case .agentsFailed(let problem):
            group(warning: true, ModeSwitch.agentsNotConnected, detail: problem) {
                Button(ModeSwitch.tryAgain) { model.retryConnectAgents() }.buttonStyle(ReloGlassButtonStyle())
            }
        case .cancelled:
            group(warning: true, ModeSwitch.cancelled, detail: "Sign in below, or go back to Relo on this Mac.") {
                goBackButton
            }
        case .restoring:
            group(spinner: true, ModeSwitch.restoring, detail: nil) { EmptyView() }
        case .restoreFailed(let problem):
            group(warning: true, "Relo could not start on this Mac", detail: problem) {
                HStack(spacing: 8) {
                    if service.state == .needsApproval {
                        Button("Open Login Items") { service.openLoginItems() }.buttonStyle(ReloGlassButtonStyle())
                    }
                    Button(ModeSwitch.tryAgain) { Task { await model.goBack() } }.buttonStyle(ReloGlassButtonStyle())
                }
            }
        }
    }

    @ViewBuilder private var goBackButton: some View {
        if ReloLocalMode.isBundled {
            Button(ModeSwitch.goBack) { Task { await model.goBack() } }.buttonStyle(ReloGlassButtonStyle())
        }
    }

    private func group<Action: View>(spinner: Bool = false, done: Bool = false, warning: Bool = false, _ title: String, detail: String?,
                                     @ViewBuilder action: () -> Action) -> some View {
        ReloGlassGroup(title: "Switching Relo") {
            HStack(spacing: 14) {
                if spinner { ProgressView().controlSize(.small).tint(.white) }
                else if done { Image(systemName: "checkmark.circle.fill").foregroundStyle(ReloNotchTheme.done) }
                else if warning { Image(systemName: "exclamationmark.circle.fill").foregroundStyle(ReloNotchTheme.warning) }
                ReloGlassLabel(title: title, detail: detail)
                Spacer(minLength: 8)
                action()
            }
            .reloGlassRow()
        }
    }
}
