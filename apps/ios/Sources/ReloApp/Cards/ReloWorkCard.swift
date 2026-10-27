import ReloCore
import SwiftUI

/// The one work card for Now and History: header (where it runs · how it stands), content (title, status,
/// progress: the bar across the card and the step line under it), footer (computer and facts · the time).
struct ReloWorkCard<Extra: View>: View {
    var origin: ReloCardOrigin?
    var at: Date?
    var title: String
    var summary: String?
    /// Amber on a your-turn card (the card's glass is washed with it); none on running and quiet.
    var tint: Color? = nil
    /// A quiet card: the whole card at .78, no plan bar.
    var quiet = false
    var steps: NowItem.Steps? = nil
    var progress: Double? = nil
    /// The plan line ("Step 3 of 5 · Run the tests") shown beside the bar.
    var progressCaption: String? = nil
    var color: Color
    var shimmer = false
    var state: ReloStateStyle? = nil
    var facts: [String] = []
    /// Running work: the footer's time is a live timer (the system ticks it).
    var runningSince: Date? = nil
    var computer: String? = nil
    /// The computer's icon (ADR 0011); a laptop until the server names one.
    var computerIcon: ComputerIcon? = nil
    var surface: ReloCardPlacement = .card
    @ViewBuilder var extra: () -> Extra
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @ScaledMetric(relativeTo: .caption) private var footSize: CGFloat = 11

    /// What changes when the work moves on: a change to any of it settles the card on one spring, so a new
    /// status, step or badge never cuts the card's height or text.
    private struct Motion: Equatable {
        var title: String
        var summary: String?
        var steps: NowItem.Steps?
        var progress: Double?
        var caption: String?
        var state: ReloStateStyle?
        var running: Bool
    }

    var body: some View {
        ReloCard(tint: tint, rhythm: true, surface: surface) {
            // Header: where it runs, how it stands. Content: title, status, progress. Footer: the plan's step on
            // the left; the computer and the time on the right. Each part keeps its own space above it.
            CardHeader(origin: origin, corner: state.map { .badge($0) } ?? .none,
                       live: shimmer && state?.symbol == ReloStateStyle.running.symbol)
            CardTitle(title).cardGap(above: 9)
            if let summary, !summary.isEmpty { CardStatusLine(summary).cardGap(above: 4) }
            if !quiet, let spec = CardProgressSpec(steps: steps, fraction: progress, color: color, shimmer: shimmer) {
                CardProgress(spec: spec).cardGap(above: 12)
            }
            extra()
            footer.cardGap(above: 10)
        }
        .opacity(quiet && surface == .card ? 0.78 : 1)
        .animation(reduceMotion ? nil : .smooth(duration: 0.4),
                   value: Motion(title: title, summary: summary, steps: steps, progress: progress,
                                 caption: progressCaption, state: state, running: runningSince != nil))
    }

    private var footerInk: Color { Color.white.opacity(0.42) }

    @ViewBuilder private var footer: some View {
        let left = leftMeta
        if left != nil || rightMeta != nil {
            HStack(alignment: .center, spacing: ReloLayout.inlineGap) {
                if let left {
                    left.font(.system(size: footSize, weight: .medium)).foregroundColor(footerInk)
                        .lineLimit(1).frame(maxWidth: .infinity, alignment: .leading)
                } else {
                    Spacer(minLength: 0)
                }
                if let right = rightMeta {
                    right.lineLimit(1).fixedSize()
                }
            }
            .frame(minHeight: 20)
        }
    }

    /// The step line ("Step 3 of 3 · Deploy") and any facts, joined with " · ".
    private var leftMeta: Text? {
        var parts = [progressCaption].compactMap { $0 }.filter { !$0.isEmpty }.map { Text($0) }
        parts += facts.filter { !$0.isEmpty }.map { Text($0) }
        return Text.cardMeta(parts).map { $0.foregroundColor(footerInk) }
    }

    /// The computer's mark and name, then the time: a live timer in the state's colour while it runs, else the
    /// clock time, both in mono 10.5.
    private var rightMeta: Text? {
        let font = Font.system(size: footSize, weight: .medium)
        var line: Text?
        if let computer {
            let glyph = Text(Image(systemName: (computerIcon ?? .laptop).systemImageName)).font(.system(size: footSize + 2, weight: .light))
            line = glyph + Text("  " + computer).font(font)
        }
        let mono = Font.system(size: footSize - 0.5, design: .monospaced)
        var time: Text?
        if let runningSince {
            time = Text(timerInterval: runningSince...Date.distantFuture, countsDown: false).font(mono).monospacedDigit()
                .foregroundColor(color)
        } else if let at, !quiet {
            time = Text(at, style: .time).font(mono).foregroundColor(footerInk)
        }
        switch (line, time) {
        case let (line?, time?): return (line + Text(" · ").font(font) + time).foregroundColor(footerInk)
        case let (line?, nil): return line.foregroundColor(footerInk)
        case let (nil, time?): return time
        default: return nil
        }
    }
}

extension ReloWorkCard where Extra == EmptyView {
    init(origin: ReloCardOrigin?, at: Date?, title: String, summary: String?, tint: Color? = nil, quiet: Bool = false,
         steps: NowItem.Steps? = nil,
         progress: Double? = nil, progressCaption: String? = nil, color: Color, shimmer: Bool = false, state: ReloStateStyle? = nil,
         facts: [String] = [], runningSince: Date? = nil, computer: String? = nil,
         computerIcon: ComputerIcon? = nil, surface: ReloCardPlacement = .card) {
        self.init(origin: origin, at: at, title: title, summary: summary, tint: tint, quiet: quiet, steps: steps, progress: progress,
                  progressCaption: progressCaption, color: color,
                  shimmer: shimmer, state: state, facts: facts, runningSince: runningSince, computer: computer,
                  computerIcon: computerIcon, surface: surface, extra: { EmptyView() })
    }
}
