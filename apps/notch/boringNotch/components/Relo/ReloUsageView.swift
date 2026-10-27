//
//  ReloUsageView.swift
//  Relo Notch
//
//  The Usage tab: a ledger with one row per account (Claude, Codex, a second login), the 5-hour and weekly limits
//  as a percent in its band colour, when it resets, and a thin bar. Read only from `relo usage --json`.
//

import Defaults
import ReloNotchKit
import SwiftUI

extension UsageBand {
    /// Quiet is near white; the others warn in the theme's colours.
    var color: Color {
        switch self {
        case .quiet: Color.white.opacity(0.9)
        case .watch: ReloNotchTheme.amber
        case .high: ReloNotchTheme.coral
        case .out: ReloNotchTheme.usageOut
        }
    }
}

struct ReloUsageView: View {
    private let usage = ReloNotch.usage
    private let store = ReloNotch.store
    @Default(.usageHiddenAccounts) private var hidden

    private let columns = [GridItem(.flexible(minimum: 150), spacing: 14, alignment: .leading),
                           GridItem(.flexible(minimum: 140), spacing: 14, alignment: .leading),
                           GridItem(.flexible(minimum: 140), spacing: 14, alignment: .leading)]

    var body: some View {
        let shown = usage.accounts.filter { !hidden.contains($0.id) }
        VStack(alignment: .leading, spacing: 6) {
            if shown.isEmpty {
                Text("Usage shows here once Claude Code or Codex has run on this Mac.")
                    .font(.system(size: 12.5)).foregroundStyle(.white.opacity(0.55))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                TimelineView(.periodic(from: .now, by: 30)) { context in
                    ledger(shown, now: context.date)
                }
            }
        }
        .padding(.horizontal, 6).padding(.top, 4)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .animation(.smooth(duration: 0.4), value: usage.accounts)
        .task { await usage.refreshBecauseLooking() }
    }

    private func ledger(_ accounts: [UsageAccount], now: Date) -> some View {
        let busyPlans = Set(store.presentation.machines.flatMap(\.harnesses).filter { $0.working > 0 }.map { $0.source.lowercased() })
        return VStack(alignment: .leading, spacing: 6) {
            LazyVGrid(columns: columns, alignment: .leading, spacing: 0) {
                ForEach(["Plan", "5-hour", "This week"], id: \.self) { title in
                    Text(title.uppercased()).font(.system(size: 10, weight: .heavy)).tracking(1.2)
                        .foregroundStyle(ReloNotchTheme.tertiaryText)
                }
            }
            ScrollView(.vertical, showsIndicators: false) {
                VStack(spacing: 6) {
                    ForEach(accounts) { account in
                        let working = accounts.filter { $0.plan == account.plan }.count == 1
                            && busyPlans.contains { $0.contains(account.plan.lowercased()) }
                        if account.connected {
                            row(account, now: now, working: working)
                        } else {
                            disconnected(account)
                        }
                    }
                }
            }
        }
    }

    private func planCell(_ account: UsageAccount, working: Bool) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(account.displayName).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
                if working { Circle().fill(ReloNotchTheme.violet).frame(width: 6, height: 6) }
            }
            let detail = [account.email, account.planName].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
            if !detail.isEmpty {
                Text(detail).font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.5)).lineLimit(1).truncationMode(.middle)
            }
        }
    }

    @ViewBuilder
    private func row(_ account: UsageAccount, now: Date, working: Bool) -> some View {
        if account.windows.isEmpty, let activity = account.activity {
            activityRow(account, activity, working: working)
        } else if account.windows.isEmpty {
            HStack(spacing: 14) {
                planCell(account, working: working).frame(minWidth: 150, alignment: .leading)
                Text(account.hint ?? "Waiting for the first reading. It comes in after the next reply in \(account.agentName).")
                    .font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.55)).lineLimit(2)
                Spacer(minLength: 0)
            }
            .padding(.horizontal, 10).padding(.vertical, 8)
            .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.055)))
        } else {
            readingRow(account, now: now, working: working)
        }
    }

    private func readingRow(_ account: UsageAccount, now: Date, working: Bool) -> some View {
        let stale = account.isStale(now: now)
        let short = account.windows.filter { ($0.effectiveMinutes ?? .max) < 10080 }.min { ($0.effectiveMinutes ?? .max) < ($1.effectiveMinutes ?? .max) }
        let week = account.windows.first { ($0.effectiveMinutes ?? 0) >= 10080 }
        return LazyVGrid(columns: columns, alignment: .leading, spacing: 0) {
            planCell(account, working: working)
            windowCell(short, stale: stale, account: account, now: now)
            windowCell(week, stale: stale, account: account, now: now)
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.055)))
        .opacity(stale ? 0.55 : 1)
    }

    /// A plan with no limit to read (OpenCode on Zen or API keys): the tokens it used, under the same columns.
    private func activityRow(_ account: UsageAccount, _ activity: UsageActivity, working: Bool) -> some View {
        LazyVGrid(columns: columns, alignment: .leading, spacing: 0) {
            planCell(account, working: working)
            tokenCell(activity.tokensToday, caption: "today")
            tokenCell(activity.tokensWeek, caption: activity.costMonth.map { $0 > 0 ? String(format: "this week · $%.2f this month", $0) : "this week" } ?? "this week")
        }
        .padding(.horizontal, 10).padding(.vertical, 8)
        .background(RoundedRectangle(cornerRadius: 12, style: .continuous).fill(Color.white.opacity(0.055)))
        .help(account.hint ?? "")
    }

    private func tokenCell(_ tokens: Double?, caption: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(tokens.map(UsageActivity.tokens) ?? "—")
                .font(.system(size: 15, weight: .semibold, design: .rounded).monospacedDigit())
                .foregroundStyle(.white.opacity(0.9))
            Text("tokens \(caption)").font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.5)).lineLimit(1)
        }
    }

    @ViewBuilder
    private func windowCell(_ window: UsageWindow?, stale: Bool, account: UsageAccount, now: Date) -> some View {
        if let window {
            let percent = Int(window.usedPercent.rounded())
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline) {
                    Text("\(percent)%")
                        .font(.system(size: 15, weight: .semibold, design: .rounded).monospacedDigit())
                        .foregroundStyle(window.band.color)
                        .contentTransition(.numericText(value: Double(percent)))
                    Spacer(minLength: 4)
                    Text((stale ? account.ageText(now: now) : window.resetCopy(now: now)) ?? "")
                        .font(.system(size: 10.5).monospacedDigit()).foregroundStyle(.white.opacity(0.5)).lineLimit(1)
                }
                UsageBar(fraction: window.usedPercent / 100, color: window.band.color)
            }
            .padding(.trailing, 4)
        } else {
            Text("—").font(.system(size: 13)).foregroundStyle(.white.opacity(0.3))
        }
    }

    private func disconnected(_ account: UsageAccount) -> some View {
        HStack(spacing: 8) {
            Text(account.displayName).font(.system(size: 12, weight: .semibold)).foregroundStyle(.white.opacity(0.7))
            Text(account.hint ?? "Not signed in on this Mac.").font(.system(size: 11)).foregroundStyle(.white.opacity(0.5)).lineLimit(1)
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 10).padding(.vertical, 9)
        .overlay(RoundedRectangle(cornerRadius: 12, style: .continuous)
            .strokeBorder(Color.white.opacity(0.18), style: StrokeStyle(lineWidth: 1, dash: [4, 3])))
    }
}

/// A capsule bar, 5 pt tall unless told otherwise.
struct UsageBar: View {
    var fraction: Double
    var color: Color
    var height: CGFloat = 5

    var body: some View {
        GeometryReader { geo in
            ZStack(alignment: .leading) {
                Capsule().fill(Color.white.opacity(0.1))
                Capsule().fill(color).frame(width: max(height, geo.size.width * min(max(fraction, 0), 1)))
            }
        }
        .frame(height: height)
    }
}
