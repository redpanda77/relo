//
//  ReloUsageMoments.swift
//  Relo Notch
//
//  Plan-usage moments for the closed notch: a window crossing 80%, running out, or resetting (UsageStore's
//  crossings), as a short line under the notch like a notice. They play no sound: every new sound needs the
//  owner's approval on the Sound Bench first.
//

import Defaults
import Foundation
import Observation
import ReloNotchKit
import SwiftUI

struct UsageMoment: Equatable, Identifiable {
    enum Kind { case headsUp, limit, reset }
    let id = UUID()
    var kind: Kind
    var title: String
    var line: String?
    var chip: String
    var percent: Double
    var band: UsageBand

    var color: Color {
        switch kind {
        case .headsUp: ReloNotchTheme.coral
        case .limit: ReloNotchTheme.usageOut
        case .reset: Color.white.opacity(0.85)
        }
    }

    /// The light under the line, from the existing kinds.
    var light: ReloOpenKind {
        switch kind {
        case .headsUp: .needs
        case .limit: .failed
        case .reset: .started
        }
    }
}

@MainActor
@Observable
final class ReloUsageMoments {
    static let shared = ReloUsageMoments()

    struct Arrivals: Equatable {
        var serial = 0
        var moments: [UsageMoment] = []
    }

    private(set) var arrivals = Arrivals()

    /// Wires the store's crossings to moments, once at launch.
    static func install() {
        ReloNotch.usage.onCrossing = { shared.receive($0) }
    }

    private func receive(_ crossing: UsageCrossing, now: Date = Date()) {
        // Muted and hidden accounts play nothing.
        guard !Defaults[.usageMutedAccounts].contains(crossing.accountID),
              !Defaults[.usageHiddenAccounts].contains(crossing.accountID) else { return }
        switch crossing.kind {
        case .crossed80, .reached100: guard Defaults[.usageMomentLimits] else { return }
        case .reset: guard Defaults[.usageMomentResets] else { return }
        }
        let account = ReloNotch.usage.accounts.first { $0.id == crossing.accountID }
        let window = account?.windows.first { $0.kind == crossing.windowKind && $0.label == crossing.windowLabel }
        let name = crossing.accountName
        let moment: UsageMoment
        switch crossing.kind {
        case .crossed80:
            let reset = window?.resetCopy(now: now).map { " · resets \($0)" } ?? ""
            moment = UsageMoment(kind: .headsUp, title: "\(name) at \(Int(crossing.usedPercent.rounded()))%",
                                 line: "\(Self.windowName(crossing.windowLabel, capitalized: true))\(reset)",
                                 chip: "Heads-up", percent: crossing.usedPercent, band: UsageBand(percent: crossing.usedPercent))
        case .reached100:
            let other = account?.windows.first { $0.kind != crossing.windowKind || $0.label != crossing.windowLabel }
            moment = UsageMoment(kind: .limit,
                                 title: window?.resetsAt.map { "\(name) is out until \(Self.shortTime($0, now: now))" } ?? "\(name) is out",
                                 line: other.map { "\(Self.windowName($0.label, capitalized: true)) \(Int($0.usedPercent.rounded()))% used" },
                                 chip: "Limit", percent: 100, band: .out)
        case .reset:
            moment = UsageMoment(kind: .reset, title: "\(name) is back",
                                 line: "Fresh \(Self.windowName(crossing.windowLabel, capitalized: false))",
                                 chip: "Reset", percent: 0, band: .quiet)
        }
        arrivals = Arrivals(serial: arrivals.serial + 1, moments: [moment])
    }

    /// "5-hour window", "Weekly window".
    static func windowName(_ label: String, capitalized: Bool) -> String {
        let base = label == "Week" ? "weekly" : label
        let text = "\(base) window"
        return capitalized ? text.prefix(1).uppercased() + text.dropFirst() : text
    }

    /// "12:51", or "Thu 12:51" when it is not today.
    static func shortTime(_ date: Date, now: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = Calendar.current.isDate(date, inSameDayAs: now) ? "h:mm" : "EEE h:mm"
        return formatter.string(from: date)
    }
}

/// A small usage ring: one arc for how full the window is, in its band colour.
struct ReloUsageMiniRing: View {
    let percent: Double
    let color: Color

    var body: some View {
        ZStack {
            Circle().stroke(Color.white.opacity(0.16), lineWidth: 2.4)
            Circle().trim(from: 0, to: max(0.02, min(1, percent / 100)))
                .stroke(color, style: StrokeStyle(lineWidth: 2.4, lineCap: .round))
                .rotationEffect(.degrees(-90))
        }
        .frame(width: 18, height: 18)
    }
}

/// The notice-style line for a usage moment.
struct ReloUsagePill: View {
    let moment: UsageMoment
    let openedAt: Date

    var body: some View {
        ReloOpenClock(openedAt: openedAt) { e in
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 6) {
                    Text("Plan usage")
                        .font(ReloCardMetrics.origin)
                        .foregroundStyle(ReloNotchTheme.secondaryText)
                        .lineLimit(1)
                        .reloArrival(e, 0.16)
                    Spacer(minLength: 6)
                    ReloUsageMiniRing(percent: moment.percent, color: moment.band.color)
                        .reloBadgeArrival(.started, e)
                    Text(moment.chip)
                        .font(ReloCardMetrics.badge)
                        .foregroundStyle(moment.color)
                        .fixedSize()
                        .reloBadgeArrival(.started, e)
                }
                Text(moment.title)
                    .font(ReloCardMetrics.hero)
                    .foregroundStyle(.white)
                    .lineLimit(2)
                    .fixedSize(horizontal: false, vertical: true)
                    .reloArrival(e, 0.22)
                if let line = moment.line {
                    Text(line)
                        .font(ReloCardMetrics.status)
                        .foregroundStyle(ReloNotchTheme.secondaryText)
                        .lineLimit(1)
                        .reloArrival(e, 0.28)
                }
            }
            .padding(.horizontal, 18)
            .padding(.top, 6)
            .padding(.bottom, 12)
            .frame(width: 440, alignment: .leading)
        }
        .background {
            ReloOpenLight(kind: moment.light, openedAt: openedAt, bottomRadius: cornerRadiusInsets.closed.bottom)
                .padding(.horizontal, -cornerRadiusInsets.closed.bottom)
        }
    }
}
