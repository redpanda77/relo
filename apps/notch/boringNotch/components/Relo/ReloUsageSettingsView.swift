//
//  ReloUsageSettingsView.swift
//  Relo Notch
//
//  Settings > Usage: the accounts Relo reads plan usage from (the agents already signed in on this Mac), each
//  switchable in the Usage tab and mutable for alerts, and how to add another account.
//

import AppKit
import Defaults
import ReloNotchKit
import SwiftUI

struct ReloUsageSettingsView: View {
    private let usage = ReloNotch.usage
    @Default(.usageHiddenAccounts) private var hidden
    @Default(.usageMutedAccounts) private var muted
    @State private var copied: String?

    private static let commands = [
        "CLAUDE_CONFIG_DIR=~/.claude-work claude",
        "CODEX_HOME=~/.codex-work codex login",
    ]

    var body: some View {
        let connected = usage.accounts.filter(\.connected)
        let missing = usage.accounts.filter { !$0.connected }
        ReloGlassPage(title: "Usage", detail: "Plan limits of the agents signed in on this Mac") {
            VStack(alignment: .leading, spacing: 22) {
                Text("Relo reads usage from the agents already signed in on this Mac. It never asks for a password.")
                    .font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.6)).padding(.horizontal, 4)
                if !connected.isEmpty {
                    ReloGlassGroup(title: "Connected") {
                        ForEach(Array(connected.enumerated()), id: \.element.id) { index, account in
                            if index > 0 { ReloGlassDivider() }
                            connectedRow(account)
                        }
                    }
                }
                if !missing.isEmpty {
                    ReloGlassGroup(title: "Not connected") {
                        ForEach(Array(missing.enumerated()), id: \.element.id) { index, account in
                            if index > 0 { ReloGlassDivider() }
                            missingRow(account)
                        }
                    }
                }
                if usage.accounts.isEmpty {
                    Text("Usage shows here once Claude Code or Codex has run on this Mac.")
                        .font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.55)).padding(.horizontal, 4)
                }
                ReloUsageMomentSettings()
                ReloUsageRailSettings()
                ReloGlassGroup(title: "Another account",
                               footer: "It shows up here on its own once you have signed in.") {
                    ForEach(Array(Self.commands.enumerated()), id: \.offset) { index, command in
                        if index > 0 { ReloGlassDivider() }
                        HStack(spacing: 12) {
                            Text(command).font(.system(size: 11.5, design: .monospaced)).foregroundStyle(.white.opacity(0.8))
                                .textSelection(.enabled)
                            Spacer(minLength: 8)
                            copyButton(command, label: "Copy")
                        }
                        .reloGlassRow()
                    }
                }
            }
        }
        .task { await usage.refreshNow() }
    }

    private func connectedRow(_ account: UsageAccount) -> some View {
        let via = account.agentName
        let detail = [account.email, account.planName, "via \(via)"].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
        let isMuted = muted.contains(account.id)
        return HStack(spacing: 12) {
            Toggle(isOn: Binding(get: { !hidden.contains(account.id) }, set: { on in
                hidden.removeAll { $0 == account.id }
                if !on { hidden.append(account.id) }
            })) {
                ReloGlassLabel(title: account.displayName, detail: detail)
            }
            .toggleStyle(ReloGlassToggleStyle())
            Button {
                muted.removeAll { $0 == account.id }
                if !isMuted { muted.append(account.id) }
            } label: {
                Image(systemName: isMuted ? "bell.slash.fill" : "bell.fill")
                    .font(.system(size: 13)).foregroundStyle(.white.opacity(isMuted ? 0.4 : 0.85)).frame(width: 24, height: 24)
            }
            .buttonStyle(.plain)
            .help(isMuted ? "Alerts muted. Click to turn them on." : "Mute this account's alerts")
        }
        .reloGlassRow()
    }

    private func missingRow(_ account: UsageAccount) -> some View {
        HStack(spacing: 12) {
            ReloGlassLabel(title: account.displayName, detail: account.hint ?? "Not signed in on this Mac.")
            Spacer(minLength: 8)
            if let hint = account.hint, let command = Self.command(in: hint) {
                copyButton(command, label: "Copy command")
            }
        }
        .reloGlassRow()
    }

    private func copyButton(_ command: String, label: String) -> some View {
        Button(copied == command ? "Copied" : label) {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(command, forType: .string)
            copied = command
        }
        .buttonStyle(ReloGlassButtonStyle())
    }

    /// The command a hint names: the text in backticks, else a hint that is itself a command.
    static func command(in hint: String) -> String? {
        let parts = hint.split(separator: "`", omittingEmptySubsequences: false)
        if parts.count >= 3 { return String(parts[1]) }
        // `relo usage` hints are bare commands ("CLAUDE_CONFIG_DIR=… relo setup --level optimize --statusline on").
        let trimmed = hint.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.contains("relo ") && !trimmed.contains(". ") ? trimmed : nil
    }
}
