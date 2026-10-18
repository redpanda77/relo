import ReloCore
import SwiftUI

/// The one work card for Now and History, built from the card components: a header (where it runs, how it
/// stands and its timer), the title, the status in its own words, and a footer (the plan line and the
/// computer, the time trailing). The plan's bar runs along the card's bottom edge and costs no row.
struct ReloWorkCard<Extra: View>: View {
    var origin: ReloCardOrigin?
    var at: Date?
    var title: String
    var summary: String?
    var steps: NowItem.Steps? = nil
    var progress: Double? = nil
    var color: Color
    var shimmer = false
    var state: ReloStateStyle? = nil
    var facts: [String] = []
    /// Running work: a live timer joins the badge (the system ticks it).
    var runningSince: Date? = nil
    var computer: String? = nil
    /// The computer's icon (ADR 0011); a laptop until the server names one.
    var computerIcon: ComputerIcon? = nil
    var surface: ReloCardPlacement = .card
    @ViewBuilder var extra: () -> Extra

    var body: some View {
        let meta = Text.cardMeta(metaParts)
        // A footer that would hold only the time gives it to the header instead: no row for one short field.
        let timeInFooter = meta != nil && runningSince == nil && at != nil
        ReloCard(tint: nil, progress: CardProgressSpec(steps: steps, fraction: progress, color: color, shimmer: shimmer),
                 surface: surface) {
            CardHeader(origin: origin, corner: corner(timeInHeader: !timeInFooter))
            CardTitle(title)
            if let summary, !summary.isEmpty { CardStatusLine(summary) }
            extra()
            CardFooter(meta: meta, trailing: timeInFooter ? at.map { Text($0, style: .time).monospacedDigit() } : nil)
        }
    }

    private func corner(timeInHeader: Bool) -> CardCorner {
        let showsTime = timeInHeader && runningSince == nil
        if let state {
            if let runningSince { return .badgeTimer(state, since: runningSince) }
            if showsTime, let at { return .badgeAt(state, at) }
            return .badge(state)
        }
        if let runningSince { return .timer(since: runningSince) }
        if showsTime, let at { return .time(at) }
        return .none
    }

    private var metaParts: [Text] {
        var parts = facts.filter { !$0.isEmpty }.map { Text($0) }
        if let computer { parts.append(ComputerMark.text(icon: computerIcon, name: computer)) }
        return parts
    }
}

extension ReloWorkCard where Extra == EmptyView {
    init(origin: ReloCardOrigin?, at: Date?, title: String, summary: String?, steps: NowItem.Steps? = nil,
         progress: Double? = nil, color: Color, shimmer: Bool = false, state: ReloStateStyle? = nil,
         facts: [String] = [], runningSince: Date? = nil, computer: String? = nil,
         computerIcon: ComputerIcon? = nil, surface: ReloCardPlacement = .card) {
        self.init(origin: origin, at: at, title: title, summary: summary, steps: steps, progress: progress, color: color,
                  shimmer: shimmer, state: state, facts: facts, runningSince: runningSince, computer: computer,
                  computerIcon: computerIcon, surface: surface, extra: { EmptyView() })
    }
}
