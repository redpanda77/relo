//
//  ReloPendingApproval.swift
//  Relo Notch
//
//  A person who chose a server and created an account is left waiting for the server's owner to approve it. They are
//  never blocked: Relo starts on this Mac right away, every surface says plainly what is going on, and once the
//  approval goes through the app signs in by itself and moves to the server (the kit's `PendingApproval` asks the
//  server; this file is what the app does with the answers).
//

import AppKit
import Foundation
import Observation
import ReloCore
import ReloNotchKit
import SwiftUI

@MainActor @Observable
final class ReloPendingApproval {
    static let shared = ReloPendingApproval()

    private let store = ReloNotch.store
    /// Relo on this Mac is being started because the account waits (a moment, or until it failed).
    private(set) var startingLocal = false
    /// Why Relo could not start on this Mac meanwhile, in words (the waiting state stays plain).
    private(set) var localProblem: String?
    @ObservationIgnored private var quietSetup: ReloOnboardingSetup?

    /// Hooks the store's pending-sign-in events to the app; called before the store starts.
    func install() {
        store.onPendingStarted = { [weak self] _ in self?.waitingBegan() }
        store.onPendingApproved = { [weak self] session, pending in await self?.approved(session, pending) }
        store.onPendingEnded = { finish, pending in
            if let line = PendingApproval.endedLine(finish, host: pending.host) { ReloUpdater.shared.announce(line) }
        }
    }

    // MARK: What the surfaces say

    var pending: PendingSignIn? { store.pendingApproval }

    /// The one line: where the account waits, and that Relo works on this Mac meanwhile.
    var line: String? {
        pending.map { PendingApproval.waitingLine(host: $0.host, localWorks: ReloLocalMode.canRunHere) }
    }

    func cancelRequest() { store.cancelPendingApproval() }

    // MARK: Local first

    /// Relo ran on this Mac before (its setup is done): starting it again needs no choices.
    private var ranLocalBefore: Bool { UserDefaults.standard.string(forKey: ReloLocalMode.versionKey) != nil }

    /// The sign-in ended pending (or a waiting one was found at launch): nothing is blocked, Relo starts on this Mac.
    private func waitingBegan() {
        // A switch to a server that waited for its sign-in is over: the account waits instead.
        ReloModeSwitch.shared.cancelPending()
        startLocalQuietly()
    }

    /// Starts Relo on this Mac without asking anything: again when it ran here before, else the quiet setup with no
    /// agents (the owner adds agents later in Settings). Nothing happens when it already runs or cannot run here.
    func startLocalQuietly() {
        guard !ReloLocalMode.isOn, !startingLocal, ReloLocalMode.canRunHere, quietSetup?.running != true else { return }
        startingLocal = true
        localProblem = nil
        Task { @MainActor in
            defer { startingLocal = false }
            if ranLocalBefore {
                localProblem = await ReloLocalMode.resumeLocal()
            } else {
                let setup = ReloOnboardingSetup()
                quietSetup = setup
                setup.run(agents: [])
                // Until it is done; a step that waits for the owner (Login Items) is said, and the setup goes on by itself
                // once they do it. An approval that arrives meanwhile drops the setup (`quietSetup` is gone).
                while !setup.isDone, quietSetup === setup, !Task.isCancelled {
                    if case .failed(let words)? = setup.failedItem?.state { localProblem = words } else { localProblem = nil }
                    try? await Task.sleep(for: .milliseconds(700))
                }
                localProblem = nil
                if quietSetup === setup { quietSetup = nil }
            }
        }
    }

    /// A setup the owner did not finish in the onboarding (it ended on the server path with no sign-in) and Relo never
    /// ran here before: Relo starts on this Mac quietly, so the app is usable.
    func onboardingEndedWithoutSignIn() {
        guard !ReloLocalMode.isOn, store.pendingApproval == nil, !ranLocalBefore,
              ![.connecting, .live, .offline, .signingIn].contains(store.connection) else { return }
        startLocalQuietly()
    }

    // MARK: Approved

    /// The server's owner approved the account: this Mac moves to the server without asking again (the choice was made
    /// when the owner picked the server). Local history stays on this Mac.
    private func approved(_ session: AccountSession, _ pending: PendingSignIn) async {
        quietSetup?.abandon()
        quietSetup = nil
        await ReloModeSwitch.shared.connectApproved(session: session, pending: pending)
    }
}

// MARK: - Views

/// The waiting line and its small "Cancel request", as a capsule in the notch and the main window.
struct ReloPendingApprovalBanner: View {
    private let model = ReloPendingApproval.shared

    var body: some View {
        if let line = model.line {
            VStack(spacing: 4) {
                HStack(spacing: 10) {
                    Image(systemName: "hourglass").foregroundStyle(ReloNotchTheme.cyan)
                    Text(line).font(.system(size: 11.5, weight: .medium)).lineLimit(3).fixedSize(horizontal: false, vertical: true)
                    Spacer(minLength: 6)
                    ReloCancelRequestLink()
                }
                if let problem = model.localProblem {
                    Text(problem).font(.system(size: 11)).foregroundStyle(ReloNotchTheme.warning).lineLimit(2)
                }
            }
            .padding(.horizontal, 14).padding(.vertical, 8)
            .background(.black.opacity(0.85), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .padding(.horizontal, 12).padding(.bottom, 6)
            .accessibilityElement(children: .contain)
        }
    }
}

/// "Cancel request": forgets the ticket. A small link, never a main button.
struct ReloCancelRequestLink: View {
    var body: some View {
        Button(PendingApproval.cancelRequest) { ReloPendingApproval.shared.cancelRequest() }
            .buttonStyle(.plain).font(.system(size: 11, weight: .medium))
            .foregroundStyle(ReloNotchTheme.secondaryText).underline()
            .onHover { $0 ? NSCursor.pointingHand.push() : NSCursor.pop() }
    }
}

/// The signed-out panel while the account waits and Relo on this Mac is not up yet (starting, or it cannot run here):
/// no sign-in choices, just where things stand.
struct ReloPendingApprovalPanel: View {
    var compact = false
    private let model = ReloPendingApproval.shared

    var body: some View {
        VStack(spacing: compact ? 8 : 14) {
            if !compact { ReloOrb(mood: .clear).frame(width: 110, height: 110) }
            VStack(spacing: 4) {
                Text("Waiting for approval")
                    .font(.system(size: compact ? 14 : 17, weight: .semibold)).foregroundStyle(.white)
                if let line = model.line {
                    Text(line).font(compact ? ReloCardMetrics.status : .system(size: 12.5))
                        .foregroundStyle(ReloNotchTheme.secondaryText)
                        .multilineTextAlignment(.center).fixedSize(horizontal: false, vertical: true)
                }
                if let problem = model.localProblem {
                    Text(problem).font(.system(size: 11.5)).foregroundStyle(ReloNotchTheme.warning)
                        .multilineTextAlignment(.center).lineLimit(3)
                }
            }
            if model.startingLocal && model.localProblem == nil { HStack(spacing: 8) { ProgressView().controlSize(.small).tint(.white); Text(LocalMode.starting).font(.system(size: 11.5)).foregroundStyle(ReloNotchTheme.secondaryText) } }
            ReloCancelRequestLink()
        }
        .padding(.horizontal, 20)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }
}

/// Settings: the waiting account, with Cancel request (nothing when no account waits).
struct ReloPendingApprovalGroup: View {
    private let model = ReloPendingApproval.shared

    var body: some View {
        if let line = model.line {
            ReloGlassGroup(title: "Waiting for approval") {
                HStack(spacing: 14) {
                    ProgressView().controlSize(.small).tint(.white)
                    ReloGlassLabel(title: line, detail: model.localProblem)
                    Spacer(minLength: 8)
                    Button(PendingApproval.cancelRequest) { model.cancelRequest() }.buttonStyle(ReloGlassButtonStyle())
                }
                .reloGlassRow()
            }
        }
    }
}
