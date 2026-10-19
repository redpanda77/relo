import ReloCore
import SwiftUI

/// The one work card for Now and History: header (where it runs · how it stands), content (title, status,
/// progress: the bar across the card and the step line under it), footer (computer and facts · the time).
struct ReloWorkCard<Extra: View>: View {
    var origin: ReloCardOrigin?
    var at: Date?
    var title: String
    var summary: String?
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

    var body: some View {
        ReloCard(tint: nil, surface: surface) {
            // Header: where it runs, how it stands. Content: title, status, progress. Footer: computer and
            // facts, the time. Each field has one place.
            CardHeader(origin: origin, corner: state.map { .badge($0) } ?? .none)
            CardTitle(title)
            if let summary, !summary.isEmpty { CardStatusLine(summary) }
            if let spec = CardProgressSpec(steps: steps, fraction: progress, color: color, shimmer: shimmer) {
                CardProgressRow(caption: progressCaption, spec: spec)
            }
            extra()
            CardFooter(meta: Text.cardMeta(metaParts), trailing: trailing)
        }
    }

    /// The footer's trailing time: the live timer while it runs, else the clock time.
    private var trailing: Text? {
        if let runningSince {
            return Text("running ") + Text(timerInterval: runningSince...Date.distantFuture, countsDown: false).monospacedDigit()
        }
        return at.map { Text($0, style: .time).monospacedDigit() }
    }

    private var metaParts: [Text] {
        var parts = facts.filter { !$0.isEmpty }.map { Text($0) }
        if let computer { parts.append(ComputerMark.text(icon: computerIcon, name: computer)) }
        return parts
    }
}

extension ReloWorkCard where Extra == EmptyView {
    init(origin: ReloCardOrigin?, at: Date?, title: String, summary: String?, steps: NowItem.Steps? = nil,
         progress: Double? = nil, progressCaption: String? = nil, color: Color, shimmer: Bool = false, state: ReloStateStyle? = nil,
         facts: [String] = [], runningSince: Date? = nil, computer: String? = nil,
         computerIcon: ComputerIcon? = nil, surface: ReloCardPlacement = .card) {
        self.init(origin: origin, at: at, title: title, summary: summary, steps: steps, progress: progress,
                  progressCaption: progressCaption, color: color,
                  shimmer: shimmer, state: state, facts: facts, runningSince: runningSince, computer: computer,
                  computerIcon: computerIcon, surface: surface, extra: { EmptyView() })
    }
}
