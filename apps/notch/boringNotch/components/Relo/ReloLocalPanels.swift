//
//  ReloLocalPanels.swift
//  Relo Notch
//
//  Local mode's recovery (plan 16): when Relo on this Mac did not start, or the app lost its link to it, the notch and
//  the home window say so in one line with one button. There is no account, no server address and no sign-in to offer:
//  the button does the linking itself.
//

import ReloNotchKit
import SwiftUI

/// One problem with Relo on this Mac and its one button, as the notch's panel (compact) or the home window's page.
struct ReloLocalProblemView: View {
    var compact = false
    private let store = ReloNotch.store
    @State private var working = false
    @State private var failure: String?

    private var startFailed: Bool { store.localStartFailed }
    private var starting: Bool { !startFailed && ([.starting, .signingIn].contains(store.connection) || store.localStarting) }

    private var title: String {
        if startFailed { return LocalMode.startFailedTitle }
        return starting ? LocalMode.starting : LocalMode.needsRepair
    }

    var body: some View {
        let content = VStack(alignment: compact ? .leading : .center, spacing: compact ? 3 : 10) {
            Text(title)
                .font(compact ? .system(size: 14, weight: .semibold) : .system(size: 16, weight: .semibold))
                .foregroundStyle(.white)
            if let failure = failure ?? (startFailed ? store.localStartDetail : nil) {
                Text(failure).font(compact ? ReloCardMetrics.status : .system(size: 12.5))
                    .foregroundStyle(ReloNotchTheme.warning).lineLimit(2)
                Button("Show details") { ReloLocalMode.showDetails() }
                    .buttonStyle(.plain).font(.system(size: 11)).foregroundStyle(ReloNotchTheme.tertiaryText)
            }
        }
        let button = Group {
            if starting {
                ProgressView().controlSize(.small).tint(.white)
            } else {
                Button(working ? "Working…" : (startFailed ? "Try again" : LocalMode.repair)) { act() }
                    .buttonStyle(compact ? AnyButtonStyle(ReloPillButtonStyle(prominent: true)) : AnyButtonStyle(ReloPrimaryButtonStyle()))
                    .disabled(working)
            }
        }
        if compact {
            HStack(spacing: 14) {
                ReloOrb(mood: .clear).frame(width: 44, height: 44)
                content
                Spacer(minLength: 8)
                button
            }
            .padding(.horizontal, 12)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        } else {
            VStack(spacing: 18) {
                Spacer()
                ReloOrb(mood: .clear).frame(width: 140, height: 140)
                ReloWordmark(size: 40)
                content
                button
                Spacer()
            }
            .multilineTextAlignment(.center)
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func act() {
        working = true
        failure = nil
        Task { @MainActor in
            if startFailed {
                if !(await ReloLocalMode.retryStart()) { failure = ReloNotch.store.localStartDetail ?? "Relo is still not running." }
            } else {
                failure = await ReloLocalMode.reconnect()
            }
            working = false
        }
    }
}

