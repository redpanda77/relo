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
            Text(title.uppercased()).tracking(1.6).foregroundStyle(Color.reloSecondaryText)
            if let count {
                Text(count.formatted()).monospacedDigit().foregroundStyle(color ?? Color.reloSecondaryText)
                    .contentTransition(.numericText(value: Double(count)))
            }
            Spacer(minLength: 0)
        }
        .font(.system(.caption, design: .monospaced).weight(.semibold))
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(count.map { "\(title), \($0)" } ?? title)
        .accessibilityAddTraits(.isHeader)
    }
}

/// TODAY: the 24h activity strip with its key, and today's log. Shown whenever today has items,
/// whatever else is on screen; with nothing today and nothing live, a calm "standing by".
struct NowAllClearView: View {
    let activity: TodayActivity
    /// Nothing needs you and nothing is live: an empty day then shows the standing-by note.
    let allClear: Bool
    let openItem: (String) -> Void
    let viewHistory: () -> Void

    private static let logLimit = 5

    var body: some View {
        if activity.isEmpty {
            if allClear {
                VStack(alignment: .leading, spacing: 28) {
                    StandingBy()
                    HistoryLink(action: viewHistory)
                }
            }
        } else {
            VStack(alignment: .leading, spacing: 14) {
                NowSectionCaption(title: "Today", count: activity.rows.count)
                ActivityStrip(activity: activity)
                TodayLog(rows: Array(activity.rows.prefix(Self.logLimit)), openItem: openItem)
                HistoryLink(action: viewHistory)
            }
        }
    }
}

private struct HistoryLink: View {
    let action: () -> Void
    var body: some View {
        Button(action: action) {
            HStack(spacing: 6) {
                Text("VIEW HISTORY").tracking(1.4)
                Image(systemName: "arrow.right")
            }
            .font(.system(.caption, design: .monospaced).weight(.semibold))
            .foregroundStyle(Color.reloSecondaryText)
            .frame(maxWidth: .infinity, minHeight: 44)
            .overlay(alignment: .top) { Rectangle().fill(Color.primary.opacity(0.12)).frame(height: 0.5) }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityHint("Opens everything that has happened")
    }
}

// MARK: Today's log

private struct TodayLog: View {
    let rows: [HistoryRow]
    let openItem: (String) -> Void
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false

    var body: some View {
        VStack(spacing: 6) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                LogRow(row: row) { openItem(row.item.id) }
                    .opacity(shown ? 1 : 0)
                    .offset(y: shown || reduceMotion ? 0 : 10)
                    .animation(reduceMotion ? nil : .smooth(duration: 0.5).delay(Double(index) * 0.07), value: shown)
                    .transition(reduceMotion ? .opacity : .opacity.combined(with: .move(edge: .top)))
            }
        }
        .animation(reduceMotion ? nil : .smooth(duration: 0.4), value: rows.map(\.id))
        .onAppear { shown = true }
    }
}

private struct LogRow: View {
    let row: HistoryRow
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            HStack(spacing: 12) {
                glyph
                VStack(alignment: .leading, spacing: 3) {
                    Text(row.title).font(.subheadline.weight(.medium)).foregroundStyle(.primary).lineLimit(1)
                    Text(detail)
                        .font(.system(.caption2, design: .monospaced)).tracking(0.6)
                        .foregroundStyle(Color.reloSecondaryText).lineLimit(1)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text(row.at.formatted(date: .omitted, time: .shortened))
                    .font(.system(.caption2, design: .monospaced).monospacedDigit())
                    .foregroundStyle(Color.reloSecondaryText.opacity(0.8))
            }
            .padding(.horizontal, 12).padding(.vertical, 10).frame(minHeight: 52)
            .background(RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.primary.opacity(0.04)))
            .contentShape(Rectangle())
        }
        .buttonStyle(ReloPressStyle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens details")
    }

    private var signal: NowSignal { NowSignal.of(row.outcome) }

    private var symbol: String {
        switch row.outcome {
        case .done: "checkmark"
        case .stopped: "exclamationmark"
        case .expired, .ended, .replaced, .unanswered: "minus"
        case .answered: "checkmark.bubble.fill"
        default: "text.bubble.fill"
        }
    }

    private var glyph: some View {
        let tone = ReloHoloTheme.color(signal)
        return Image(systemName: symbol)
            .font(.system(size: 11, weight: .bold)).foregroundStyle(tone)
            .frame(width: 28, height: 28)
            .background(Circle().fill(tone.opacity(0.14)))
            .accessibilityHidden(true)
    }

    private var detail: String {
        var parts: [String] = []
        if let label = row.outcome.label { parts.append(label) } else { parts.append(row.source.name) }
        if let duration = row.duration { parts.append(Self.duration(duration)) }
        if let updates = row.updates, updates > 0 { parts.append("\(updates) updates") }
        return parts.joined(separator: " · ").uppercased()
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let value = Int(seconds.rounded())
        if value < 60 { return "\(max(value, 1))s" }
        if value < 3600 { return "\(value / 60)m" }
        return "\(value / 3600)h \(value % 3600 / 60)m"
    }
}

// MARK: Hourly strip

/// Flat and quiet: each hour is a thin stacked bar whose segments are the meaning colors, on a
/// faint track. The current hour gets a small tick; a one-line key names only what is present.
private struct ActivityStrip: View {
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
        Text(text).font(.system(size: 9, design: .monospaced).weight(.medium)).tracking(0.8).foregroundStyle(color)
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

private struct StandingBy: View {
    var body: some View {
        VStack(spacing: 10) {
            Text("STANDING BY").tracking(2.4)
                .font(.system(.footnote, design: .monospaced).weight(.semibold))
                .foregroundStyle(Color.reloSecondaryText)
            Text("When an agent starts work or sends a message, it shows up here, live.")
                .font(.footnote).foregroundStyle(Color.reloSecondaryText.opacity(0.85))
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 16)
        .accessibilityElement(children: .combine)
    }
}
