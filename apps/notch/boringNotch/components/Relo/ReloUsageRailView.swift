//
//  ReloUsageRailView.swift
//  Relo Notch
//
//  The usage side rail's drawing: the sideways notch shape (concave curls joining the bezel), tucked ticks, compact
//  double rings, and the card beside the rail for a hovered ring. Black like the notch.
//

import ReloNotchKit
import SwiftUI

/// A vertical pill flush with the right edge (x = width), with concave curls of radius `curl` above and below
/// where it joins the bezel. Mirrored for the left edge.
struct ReloUsageRailShape: Shape {
    var rightEdge = true
    var curl: CGFloat = 12

    func path(in rect: CGRect) -> Path {
        let w = rect.width, h = rect.height
        let ry = min(curl, h / 2)
        let rx = min(curl, w)
        let cr = max(0, min(12, w / 2, w - rx))
        var p = Path()
        p.move(to: CGPoint(x: w, y: 0))
        p.addQuadCurve(to: CGPoint(x: w - rx, y: ry), control: CGPoint(x: w - rx * 0.45, y: ry * 0.45))
        p.addLine(to: CGPoint(x: cr, y: ry))
        if cr > 0 { p.addArc(center: CGPoint(x: cr, y: ry + cr), radius: cr, startAngle: .degrees(270), endAngle: .degrees(180), clockwise: true) }
        p.addLine(to: CGPoint(x: 0, y: h - ry - cr))
        if cr > 0 { p.addArc(center: CGPoint(x: cr, y: h - ry - cr), radius: cr, startAngle: .degrees(180), endAngle: .degrees(90), clockwise: true) }
        p.addLine(to: CGPoint(x: w - rx, y: h - ry))
        p.addQuadCurve(to: CGPoint(x: w, y: h), control: CGPoint(x: w - rx * 0.45, y: h - ry * 0.45))
        p.closeSubpath()
        if rightEdge { return p }
        return p.applying(CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: w, ty: 0))
    }
}

private enum RailPalette {
    static let idleTick = Color(red: 0x4A / 255, green: 0x46 / 255, blue: 0x54 / 255)
    static let track = Color(red: 0x26 / 255, green: 0x23 / 255, blue: 0x2E / 255)
}

private extension UsageAccount {
    var shortWindow: UsageWindow? {
        windows.filter { ($0.effectiveMinutes ?? .max) < 10080 }.min { ($0.effectiveMinutes ?? .max) < ($1.effectiveMinutes ?? .max) }
    }
    var weekWindow: UsageWindow? { windows.first { ($0.effectiveMinutes ?? 0) >= 10080 } }
    /// The ring's outer window: the shortest one, else the week.
    var outerWindow: UsageWindow? { shortWindow ?? weekWindow }
    /// The source-mark name for the plan; an unknown plan keeps its own name (drawn as a letter).
    var markName: String {
        switch plan.lowercased() {
        case "codex": "Codex"
        case "antigravity": "Antigravity"
        case "opencode": "OpenCode"
        case "claude", "claude code", "": "Claude Code"
        default: plan
        }
    }
}

struct ReloUsageRailView: View {
    let model: ReloUsageRailModel
    private let spring = Animation.spring(duration: 0.32, bounce: 0.12)

    var body: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            content(now: context.date)
        }
    }

    private func content(now: Date) -> some View {
        let right = model.rightEdge
        let width = model.bodyWidth
        return ZStack {
            rail(now: now)
                .frame(width: width, height: model.railHeight)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: right ? .trailing : .leading)
            if model.cardShown, let index = model.hoveredIndex, model.accounts.indices.contains(index) {
                ReloUsageRailCard(account: model.accounts[index], now: now)
                    .frame(width: ReloUsageRailModel.cardWidth, height: ReloUsageRailModel.cardHeight)
                    .padding(right ? .trailing : .leading, width + ReloUsageRailModel.cardGap)
                    .padding(.top, model.cardTop)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: right ? .topTrailing : .topLeading)
                    // One card that glides to the next ring: it opens and closes with the spring, never per ring.
                    .animation(.easeOut(duration: 0.16), value: model.cardTop)
                    .transition(.opacity.combined(with: .scale(scale: 0.96, anchor: right ? .trailing : .leading)))
            }
        }
        .animation(spring, value: model.level)
        .animation(spring, value: model.accounts.count)
        .animation(spring, value: model.cardShown)
    }

    private func rail(now: Date) -> some View {
        ZStack {
            ReloUsageRailShape(rightEdge: model.rightEdge).fill(Color.black)
            VStack(spacing: 0) {
                ForEach(model.accounts) { account in
                    row(account, now: now)
                        .frame(height: model.slot)
                }
            }
            .padding(.vertical, 8)
            .padding(.vertical, ReloUsageRailModel.curl)
        }
    }

    @ViewBuilder
    private func row(_ account: UsageAccount, now: Date) -> some View {
        let stale = account.isStale(now: now)
        let dim = model.cardShown && model.hoveredID != account.id
        Group {
            switch model.level {
            case .tucked: tick(account)
            case .compact: ReloUsageRing(account: account)
            }
        }
        .opacity((stale ? 0.55 : 1) * (dim ? 0.4 : 1))
        .animation(.easeOut(duration: 0.12), value: dim)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .contentShape(Rectangle())
    }

    private func tick(_ account: UsageAccount) -> some View {
        let percent = account.outerWindow?.usedPercent ?? 0
        let color = percent >= 50 ? UsageBand(percent: percent).color : RailPalette.idleTick
        return RoundedRectangle(cornerRadius: 1, style: .continuous).fill(color).frame(width: 2, height: 14)
    }

}

/// A 24 pt double ring: the shortest window outside, the week inside (thinner).
private struct ReloUsageRing: View {
    let account: UsageAccount

    var body: some View {
        let outer = account.outerWindow
        let inner = account.shortWindow != nil ? account.weekWindow : nil
        ZStack {
            ring(diameter: 21, line: 3, window: outer)
            if inner != nil || account.shortWindow != nil { ring(diameter: 14, line: 2, window: inner) }
            if ReloSourceLogo(sourceName: account.markName) != nil {
                ReloSourceMark(name: account.markName, size: 8)
            } else {
                Text(String(account.markName.prefix(1)).uppercased())
                    .font(.system(size: 8, weight: .bold)).foregroundStyle(.white.opacity(0.7))
            }
        }
        .frame(width: 24, height: 24)
    }

    private func ring(diameter: CGFloat, line: CGFloat, window: UsageWindow?) -> some View {
        let fraction = min(max((window?.usedPercent ?? 0) / 100, 0), 1)
        return ZStack {
            Circle().stroke(RailPalette.track, lineWidth: line)
            if window != nil, fraction > 0 {
                Circle().trim(from: 0, to: fraction)
                    .stroke(window?.band.color ?? .white, style: StrokeStyle(lineWidth: line, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }
        }
        .frame(width: diameter, height: diameter)
    }
}

/// The card beside the rail for a hovered ring.
private struct ReloUsageRailCard: View {
    let account: UsageAccount
    let now: Date

    var body: some View {
        let stale = account.isStale(now: now)
        VStack(alignment: .leading, spacing: 10) {
            Text(account.displayName).font(.system(size: 13, weight: .semibold)).foregroundStyle(.white).lineLimit(1)
            if let short = account.shortWindow { windowRow(short, stale: stale) }
            if let week = account.weekWindow { windowRow(week, stale: stale) }
            if account.windows.isEmpty, let activity = account.activity {
                activityRow("Today", activity.tokensToday)
                activityRow("This week", activity.tokensWeek)
                activityRow("This month", activity.tokensMonth)
            }
            Spacer(minLength: 0)
            if let email = account.email, !email.isEmpty {
                Text(email).font(.system(size: 10.5)).foregroundStyle(.white.opacity(0.45))
                    .lineLimit(1).truncationMode(.middle)
            }
        }
        .padding(14)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color.black))
    }

    /// Tokens used, for a plan with no limit to read.
    private func activityRow(_ title: String, _ tokens: Double?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Text(title).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.65))
            Spacer(minLength: 4)
            Text(tokens.map { "\(UsageActivity.tokens($0)) tokens" } ?? "—")
                .font(.system(size: 12.5, weight: .semibold, design: .rounded).monospacedDigit())
                .foregroundStyle(.white.opacity(0.9))
        }
    }

    private func windowRow(_ window: UsageWindow, stale: Bool) -> some View {
        let percent = Int(window.usedPercent.rounded())
        return VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(window.label).font(.system(size: 11.5)).foregroundStyle(.white.opacity(0.65))
                Spacer(minLength: 4)
                Text("\(percent)%").font(.system(size: 12.5, weight: .semibold, design: .rounded).monospacedDigit())
                    .foregroundStyle(window.band.color)
            }
            UsageBar(fraction: window.usedPercent / 100, color: window.band.color, height: 4)
            if let reset = stale ? account.ageText(now: now) : window.resetCopy(now: now) {
                Text(reset).font(.system(size: 10.5).monospacedDigit()).foregroundStyle(.white.opacity(0.45))
            }
        }
    }
}
