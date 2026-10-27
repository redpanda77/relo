import ReloCore
import SwiftUI

/// The small monospaced caption that opens every Now section: the title in muted text and the
/// count in the section's meaning color, so "NEEDS YOU 2" is orange and "LIVE NOW 3" is cyan.
struct NowSectionCaption: View {
    let title: String
    var count: Int?
    var color: Color?

    var body: some View {
        HStack(spacing: 8) {
            Text(title.uppercased())
                .font(.system(size: 10.5, weight: .semibold, design: .monospaced))
                .tracking(1.4)
                .foregroundStyle(Color.white.opacity(0.42))
            if let count {
                Text(count.formatted())
                    .font(.system(size: 10.5, weight: .bold, design: .monospaced)).monospacedDigit()
                    .foregroundStyle(color ?? Color.reloSecondaryText)
                    .contentTransition(.numericText(value: Double(count)))
            }
            Spacer(minLength: 0)
        }
        .padding(.leading, 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(count.map { "\(title), \($0)" } ?? title)
        .accessibilityAddTraits(.isHeader)
    }
}

/// The end of Now, which shows only what is live: with nothing live, a calm "standing by"; always a way to History,
/// where today's settled work (the hourly strip and its log) lives.
struct NowAllClearView: View {
    /// Nothing needs you and nothing is live.
    let allClear: Bool
    /// The machines of the idle or ended sessions, for the standing-by card.
    var machines: [StandbyMachine] = []
    let viewHistory: () -> Void

    var body: some View {
        if allClear {
            VStack(alignment: .leading, spacing: 28) {
                StandingBy(machines: machines)
                HistoryLink(action: viewHistory)
            }
        } else {
            HistoryLink(action: viewHistory)
        }
    }
}

private struct HistoryLink: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                ReloMonoLabel("View history")
                Image(systemName: "arrow.right").font(.caption.weight(.semibold))
            }
            .foregroundStyle(Color.reloSecondaryText)
            .frame(maxWidth: .infinity, minHeight: 44)
            .overlay(alignment: .top) { Rectangle().fill(Color.primary.opacity(0.12)).frame(height: 0.5) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens everything that has happened")
    }
}

// MARK: Hourly strip

/// Flat and quiet: each hour is a thin stacked bar whose segments are the meaning colors, on a
/// faint track. The current hour gets a small tick; a one-line key names only what is present.
struct ActivityStrip: View {
    let activity: TodayActivity
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var risen = false
    private let barHeight: CGFloat = 52

    var body: some View {
        let mixes = activity.hourMixes
        VStack(alignment: .leading, spacing: 10) {
            VStack(spacing: 6) {
                HStack(alignment: .top, spacing: 3) {
                    ForEach(mixes, id: \.hour) { mix in column(mix) }
                }
                axis
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Activity by hour today")
            .accessibilityValue("\(activity.rows.count) items, busiest hour has \(activity.maxTotal)")
            legend
        }
        .onAppear {
            if reduceMotion { risen = true } else { withAnimation(.smooth(duration: 0.9)) { risen = true } }
        }
    }

    private func column(_ mix: NowHourMix) -> some View {
        let current = mix.hour == activity.currentHour
        let maxTotal = max(activity.maxTotal, 1)
        let height = mix.total == 0 ? 0 : max(8, CGFloat(mix.total) / CGFloat(maxTotal) * barHeight)
        return VStack(spacing: 4) {
            ZStack(alignment: .bottom) {
                Capsule().fill(Color.primary.opacity(mix.hour > activity.currentHour ? 0.03 : 0.06))
                    .frame(height: barHeight)
                if mix.total > 0 {
                    VStack(spacing: 0) {
                        // Top to bottom, so the first meaning in display order sits at the base.
                        ForEach(Array(NowSignal.allCases.reversed()), id: \.self) { signal in
                            if let count = mix.counts[signal], count > 0 {
                                Rectangle().fill(ReloHoloTheme.color(signal).opacity(0.85))
                                    .frame(height: (risen ? height : 3) * CGFloat(count) / CGFloat(mix.total))
                            }
                        }
                    }
                    .frame(height: risen ? height : 3)
                    .clipShape(Capsule())
                    .animation(reduceMotion ? nil : .smooth(duration: 0.8).delay(Double(mix.hour) * 0.02), value: risen)
                }
            }
            .frame(height: barHeight, alignment: .bottom)
            Capsule().fill(current ? Color.white.opacity(0.9) : .clear).frame(width: 8, height: 2)
        }
        .frame(maxWidth: .infinity)
    }

    private var axis: some View {
        GeometryReader { proxy in
            let width = proxy.size.width
            ZStack(alignment: .leading) {
                ForEach([0, 6, 12, 18], id: \.self) { hour in
                    if abs(hour - activity.currentHour) > 2 {
                        label(String(format: "%02d", hour), color: Color.reloSecondaryText.opacity(0.7))
                            .position(x: min(max(xPosition(hour, width), 8), width - 8), y: 7)
                    }
                }
                label("NOW", color: Color.primary.opacity(0.85))
                    .position(x: min(max(xPosition(activity.currentHour, width), 14), width - 14), y: 7)
            }
        }
        .frame(height: 14)
        .accessibilityHidden(true)
    }

    private func xPosition(_ hour: Int, _ width: CGFloat) -> CGFloat { (CGFloat(hour) + 0.5) / 24 * width }

    private func label(_ text: String, color: Color) -> some View {
        Text(text).font(.system(size: 9, design: .monospaced).weight(.medium)).tracking(0.8).foregroundStyle(color) // design: chart axis text
    }

    @ViewBuilder
    private var legend: some View {
        let entries = activity.legend
        if !entries.isEmpty {
            HStack(spacing: 14) {
                ForEach(entries, id: \.signal) { entry in
                    HStack(spacing: 5) {
                        Circle().fill(ReloHoloTheme.color(entry.signal)).frame(width: 6, height: 6)
                        Text(entry.text).foregroundStyle(Color.reloSecondaryText)
                    }
                }
                Spacer(minLength: 0)
            }
            .font(.system(.caption2, design: .monospaced))
            .lineLimit(1).minimumScaleFactor(0.8)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(activity.legendSpoken)
        }
    }
}

// MARK: Empty state

/// A machine on the standing-by card: its glyph and name, with a mint dot when it was seen lately.
struct StandbyMachine: Equatable, Identifiable {
    var name: String
    var icon: ComputerIcon?
    var seenRecently: Bool
    var id: String { name }

    /// The machines of these sessions in the order they first appear; seen "lately" is within 10 minutes of `now`.
    static func make(_ sessions: [NowSessionInput], now: Date) -> [StandbyMachine] {
        var order: [String] = []
        var seen: [String: Date] = [:]
        var icons: [String: ComputerIcon] = [:]
        for session in sessions {
            guard let name = session.computer else { continue }
            if seen[name] == nil { order.append(name) }
            seen[name] = max(seen[name] ?? .distantPast, session.lastSeenAt)
            if icons[name] == nil, let icon = session.computerIcon { icons[name] = icon }
        }
        return order.map { name in
            StandbyMachine(name: name, icon: icons[name], seenRecently: now.timeIntervalSince(seen[name] ?? .distantPast) <= 600)
        }
    }
}

/// The C4 standing-by card: a breathing blue dot, "STANDING BY", one calm line and the machines that are online.
private struct StandingBy: View {
    let machines: [StandbyMachine]
    @State private var bright = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private static let blue = Color(red: 0x7F / 255, green: 0xA9 / 255, blue: 1)

    var body: some View {
        VStack(spacing: 0) {
            HStack(spacing: 8) {
                Circle().fill(Self.blue).frame(width: 6, height: 6)
                    .shadow(color: Self.blue, radius: 4)
                    .opacity(reduceMotion ? 1 : (bright ? 1 : 0.4))
                Text("STANDING BY")
                    .font(.system(size: 10, weight: .bold, design: .monospaced)).tracking(2.2)
                    .foregroundStyle(Self.blue)
            }
            Text("Nothing is running. New work appears here the moment it starts.")
                .font(.system(size: 13)).foregroundStyle(Color.white.opacity(0.6))
                .multilineTextAlignment(.center).lineSpacing(2)
                .padding(.top, 8)
            if !machines.isEmpty {
                HStack(spacing: 14) {
                    ForEach(machines) { machine in
                        HStack(spacing: 5) {
                            Image(systemName: (machine.icon ?? .laptop).systemImageName).font(.system(size: 11, weight: .light))
                            Text(machine.name)
                            Circle().fill(machine.seenRecently ? ReloHoloTheme.mint : ReloHoloTheme.slate).frame(width: 6, height: 6)
                        }
                    }
                }
                .font(.system(size: 11, weight: .semibold)).foregroundStyle(Color.white.opacity(0.6))
                .lineLimit(1).minimumScaleFactor(0.8)
                .padding(.top, 12)
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.horizontal, 18).padding(.vertical, 22)
        .background {
            let shape = RoundedRectangle(cornerRadius: 18, style: .continuous)
            ZStack {
                shape.fill(LinearGradient(colors: [.white.opacity(0.06), .white.opacity(0.02)], startPoint: .top, endPoint: .bottom))
                shape.strokeBorder(Color.white.opacity(0.1), lineWidth: 0.5)
            }
        }
        .accessibilityElement(children: .combine)
        .reloLoop(.easeInOut(duration: 1.8).repeatForever(autoreverses: true), flag: $bright)
    }
}

// MARK: System cards

/// One C4 system card: a tinted glass shell with an icon tile, an eyebrow, a heading, a line of body and the actions.
struct SystemCard<Actions: View>: View {
    let tint: Color
    let symbol: String
    var spinning = false
    var edge = false
    let eyebrow: String
    let title: String
    var message: String?
    @ViewBuilder var actions: Actions
    @State private var turned = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            icon
            VStack(alignment: .leading, spacing: 0) {
                Text(eyebrow.uppercased())
                    .font(.system(size: 9.5, weight: .bold, design: .monospaced)).tracking(1.6).foregroundStyle(tint)
                Text(title).font(.system(size: 15, weight: .semibold)).foregroundStyle(Color(red: 0xF2 / 255, green: 0xF4 / 255, blue: 0xF8 / 255))
                    .fixedSize(horizontal: false, vertical: true).padding(.top, 3)
                if let message {
                    Text(message).font(.system(size: 12.5)).foregroundStyle(Color.white.opacity(0.6)).lineSpacing(2)
                        .fixedSize(horizontal: false, vertical: true).padding(.top, 3)
                }
                if Actions.self != EmptyView.self {
                    HStack(spacing: 8) { actions }.padding(.top, 11)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.horizontal, 16).padding(.vertical, 14)
        .reloCard(tint: tint, edge: edge)
        .accessibilityElement(children: .contain)
    }

    private var icon: some View {
        Group {
            if spinning {
                Circle().trim(from: 0, to: 0.75).stroke(tint, style: StrokeStyle(lineWidth: 1.8, lineCap: .round))
                    .frame(width: 16, height: 16)
                    .rotationEffect(.degrees(turned ? 360 : 0))
                    .reloLoop(.linear(duration: 1.2).repeatForever(autoreverses: false), flag: $turned)
            } else {
                Image(systemName: symbol).font(.system(size: 17, weight: .regular)).foregroundStyle(tint)
            }
        }
        .frame(width: 34, height: 34)
        .background(RoundedRectangle(cornerRadius: 11, style: .continuous).fill(tint.opacity(0.16)))
        .overlay(RoundedRectangle(cornerRadius: 11, style: .continuous).strokeBorder(tint.opacity(0.35), lineWidth: 0.5))
        .accessibilityHidden(true)
    }
}

/// Now's SYSTEM section (C4): what stops Relo working, above everything else, each with its way out. The bottom
/// banner covers the other tabs; on Now these cards replace it.
struct NowSystemSection: View {
    @Bindable var model: AppModel
    let showConnection: () -> Void

    private var offline: Bool { model.serverUnreachable }
    private var reconnecting: Bool {
        !offline && model.currentState?.connection == .connecting && model.pendingResponseCount > 0
    }
    private var notificationsOff: Bool { model.isRegistered && model.permission != .allowed }
    private var notSaved: Bool { model.currentState?.persistence == .unavailable }
    private var computerWaits: Bool { !model.devices.waitingRequests.isEmpty }

    #if RELO_FLOW_CAPTURE
    private var forced: Bool { ReloCaptureFlags.systemCards }
    #else
    private var forced: Bool { false }
    #endif

    var body: some View {
        let showOffline = offline || forced, showReconnecting = reconnecting || forced
        let showNotifications = notificationsOff || forced, showNotSaved = notSaved || forced
        if showOffline || showReconnecting || computerWaits || showNotifications || showNotSaved {
            VStack(alignment: .leading, spacing: 10) {
                NowSectionCaption(title: "System")
                if showOffline { offlineCard }
                if showReconnecting { reconnectingCard }
                DeviceAccessNeedsYouRow(model: model)
                if showNotifications { notificationsCard }
                if showNotSaved { notSavedCard }
            }
        }
    }

    private var offlineCard: some View {
        let since = model.lastSyncedAt.map { " \u{00B7} since " + $0.formatted(date: .omitted, time: .shortened) } ?? ""
        return SystemCard(tint: ReloHoloTheme.yellow, symbol: "wifi.slash", edge: true, eyebrow: "Offline" + since,
                          title: "Your server is out of reach",
                          message: "Cards show what was last known. Answers wait and send when it\u{2019}s back.") {
            CardAction("Retry", kind: .systemPrimary(ReloHoloTheme.yellow)) {
                Task { await model.retryDeviceRegistration(); _ = await model.refresh() }
            }
            CardAction("Details", kind: .systemSecondary, action: showConnection)
        }
    }

    private var reconnectingCard: some View {
        let count = max(model.pendingResponseCount, forced ? 2 : 0)
        return SystemCard(tint: ReloHoloTheme.cyan, symbol: "arrow.triangle.2.circlepath", spinning: true, eyebrow: "Reconnecting",
                          title: "Catching up with your server",
                          message: (count == 1 ? "1 answer is queued and will send in order." : "\(count) answers are queued and will send in order.")) {}
    }

    private var notificationsCard: some View {
        SystemCard(tint: ReloHoloTheme.sessionsViolet, symbol: "bell.slash", eyebrow: "Notifications off",
                   title: "Questions can\u{2019}t reach your Lock Screen",
                   message: "You\u{2019}ll only see them here, with the app open.") {
            CardAction("Turn on", kind: .systemPrimary(ReloHoloTheme.sessionsViolet)) {
                if model.permission == .denied, let url = URL(string: UIApplication.openSettingsURLString) {
                    UIApplication.shared.open(url)
                } else {
                    Task { await model.requestNotifications() }
                }
            }
        }
    }

    private var notSavedCard: some View {
        SystemCard(tint: ReloStateStyle.failed.color, symbol: "exclamationmark.triangle", edge: true, eyebrow: "Not saved",
                   title: "Couldn\u{2019}t save on this iPhone",
                   message: "Unlock it and retry; fetched requests can still be reviewed.") {
            CardAction("Retry saving", kind: .systemPrimary(ReloStateStyle.failed.color)) { model.retryCurrentStorage() }
        }
    }
}
