//
//  ReloMenuItems.swift
//  Relo Notch
//
//  The menu bar's Relo lines: what needs the owner, the account, the Dashboard, pausing alerts, and
//  sign-in or sign-out.
//

import AppKit
import Defaults
import ReloNotchKit
import SwiftUI

struct ReloMenuItems: View {
    private let store = ReloNotch.store
    @Default(.reloPeeksPausedUntil) private var pausedUntil

    var body: some View {
        if store.isLocal { localBody } else { remoteBody }
    }

    /// Relo on this Mac: no sign-in, no account, no Dashboard. A lost link is one Repair.
    @ViewBuilder private var localBody: some View {
        if store.localStarting {
            Text(LocalMode.starting)
        } else if store.localStartFailed {
            Text(LocalMode.startFailedTitle)
            Button("Try again") { Task { _ = await ReloLocalMode.retryStart() } }
        } else {
            if let pending = store.pendingApproval {
                Text("Waiting for approval on \(pending.host)")
                Button(PendingApproval.cancelRequest) { store.cancelPendingApproval() }
                Divider()
            }
            switch store.connection {
            case .signedOut, .needsSignIn:
                Text(LocalMode.needsRepair)
                Button(LocalMode.repair) { Task { _ = await ReloLocalMode.reconnect() } }
            case .starting, .signingIn:
                Text(LocalMode.starting)
            case .connecting, .live, .offline:
                if let line = needsYouLine { Text(line) }
                if let line = runningLine { Text(line) }
                Divider()
                pauseButton
                Divider()
                Text(statusLine)
            }
        }
    }

    @ViewBuilder private var pauseButton: some View {
        if (pausedUntil ?? .distantPast) > Date() {
            Button("Resume alerts") { pausedUntil = nil }
        } else {
            Button("Pause alerts for 1 hour") { pausedUntil = Date().addingTimeInterval(3600) }
        }
    }

    @ViewBuilder private var remoteBody: some View {
        if let pending = store.pendingApproval {
            Text("Waiting for approval on \(pending.host)")
            Button(PendingApproval.cancelRequest) { store.cancelPendingApproval() }
            Divider()
        }
        switch store.connection {
        case .signedOut, .needsSignIn, .starting:
            if OnboardingWindow.isOpen {
                Button("Continue setup") { OnboardingWindow.bringForward() }
            } else {
            Button(store.connection == .needsSignIn ? "Sign in to Relo again…" : "Sign in to Relo…") {
                ReloLocalMode.signInOrSetUp()
            }
            if ReloLocalMode.canRunHere { Button("Run Relo on this Mac…") { ReloLocalMode.runHere() } }
            }
        case .signingIn:
            Text("Signing in to Relo…")
            Button("Cancel sign-in") { store.cancelSignIn() }
            if OnboardingWindow.isOpen {
                Button("Continue setup") { OnboardingWindow.bringForward() }
            } else if ReloLocalMode.canRunHere { Button("Run Relo on this Mac…") { ReloLocalMode.runHere() } }
        case .connecting, .live, .offline:
            if let line = needsYouLine { Text(line) }
            if let line = runningLine { Text(line) }
            Divider()
            if let url = store.dashboardURL {
                Button("Open Dashboard") { NSWorkspace.shared.open(url) }
            }
            pauseButton
            Divider()
            Text(statusLine)
            Button("Sign out of Relo") { Task { await store.signOut() } }
        }
    }

    private var needsYouLine: String? {
        let presentation = store.presentation
        guard let count = presentation.counts.needsYouText else { return nil }
        // A title nothing could name yet (a bare handle) is left out: the count alone says it.
        let first = presentation.sections.first { $0.kind == .needsYou }?.rows.first.flatMap { $0.unreadable ? nil : ReloDisplayName.readable($0.title) }
        return first.map { "\(count): \($0)" } ?? count
    }

    private var runningLine: String? {
        store.presentation.counts.runningText
    }

    private var statusLine: String {
        if store.isLocal {
            switch store.connection {
            case .offline: return "Relo isn't answering on this Mac"
            case .connecting: return LocalMode.starting
            default: return "Relo on this Mac"
            }
        }
        let who = store.accountEmail.map { "Relo · \($0)" } ?? "Relo"
        switch store.connection {
        case .offline: return "\(who) (offline)"
        case .connecting: return "\(who) (connecting)"
        default: return who
        }
    }
}
