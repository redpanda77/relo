import ReloCore
import SwiftUI

/// Where a card's work runs: the source (as its logo when known), the project and the session.
struct ReloCardOrigin: Equatable {
    var source: String
    var sourceSymbol: String? = nil
    var project: String? = nil
    var projectColor: Color? = nil
    var topic: String? = nil
    /// A filter that already pins the source hides it (unless nothing else would show).
    var showsSource = true
}

/// The header's trailing corner: how the work stands (a badge), or a question's countdown or send phase. The
/// time is the footer's, never the header's (the detail page's running timer is the one exception).
enum CardCorner: Equatable {
    case none
    /// "● Missed"
    case badge(ReloStateStyle)
    /// "● Running 3:12", the system ticks it.
    case badgeTimer(ReloStateStyle, since: Date)
    /// A page header's running timer (the detail page; cards carry their time in the footer).
    case timer(since: Date)
    /// "0:42" counting down to the answer deadline.
    case countdown(Date)
    /// Free words in a color ("Sending…").
    case phase(String, symbol: String?, color: Color)

    /// Nothing to show: no corner, or a countdown whose deadline has passed.
    fileprivate var isEmpty: Bool {
        switch self {
        case .none: true
        case let .countdown(deadline): deadline <= .now
        default: false
        }
    }

    var spoken: String? {
        switch self {
        case let .badge(style), let .badgeTimer(style, _): style.label
        case let .phase(words, _, _): words
        default: nil
        }
    }
}

/// The card's first line, and only one line: the origin `logo · project › session` leading (it gives way
/// first, the session name before the project), the corner trailing. At accessibility sizes the corner drops
/// under the origin instead of squeezing it.
struct CardHeader: View {
    var origin: ReloCardOrigin?
    var corner: CardCorner = .none
    /// The work is moving right now: the badge's symbol breathes (Running, Working).
    var live = false
    @Environment(\.dynamicTypeSize) private var typeSize
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if origin != nil || !corner.isEmpty {
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: ReloLayout.cardGap))
                : AnyLayout(HStackLayout(alignment: .center, spacing: ReloLayout.inlineGap))
            layout {
                if let origin { OriginLine(origin: origin) }
                if !corner.isEmpty {
                    if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                    CornerLabel(corner: corner, live: live)
                        .font(ReloLayout.cardMeta).lineLimit(1).fixedSize()
                        .transition(.opacity)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            // Waiting → Running, Sending → Sent: the symbol morphs, the words cross-fade and the color blends,
            // in place, never a cut.
            .animation(reduceMotion ? nil : .smooth(duration: 0.35), value: corner)
        }
    }
}

/// The corner, drawn as one symbol and its words so a change of state morphs the symbol (`.replace`) and
/// interpolates the words and color instead of swapping a flattened Text.
private struct CornerLabel: View {
    let corner: CardCorner
    let live: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.reloMotionPaused) private var paused

    var body: some View {
        switch corner {
        case .none: EmptyView()
        case let .badge(style): badge(style.label, symbol: style.symbol, color: style.color)
        case let .badgeTimer(style, since):
            HStack(alignment: .firstTextBaseline, spacing: 0) {
                badge(style.label, symbol: style.symbol, color: style.color)
                Text(" · ").foregroundStyle(Color.reloSecondaryText)
                timer(since)
            }
        case let .timer(since): timer(since)
        case let .countdown(deadline):
            (Text(Image(systemName: "timer")) + Text(" ")
                + Text(timerInterval: Date.now...deadline, countsDown: true).monospacedDigit())
                .foregroundStyle(Color.reloSecondaryText)
        case let .phase(words, symbol, color): badge(words, symbol: symbol, color: color)
        }
    }

    private func badge(_ words: String, symbol: String?, color: Color) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 4) {
            if let symbol {
                Image(systemName: symbol)
                    .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace.downUp))
                    .symbolEffect(.pulse, options: .repeating, isActive: live && !reduceMotion && !paused)
            }
            Text(words).contentTransition(.interpolate)
        }
        .foregroundStyle(color).fontWeight(.semibold)
    }

    private func timer(_ since: Date) -> some View {
        Text(timerInterval: since...Date.distantFuture, countsDown: false)
            .foregroundStyle(Color.reloSecondaryText).monospacedDigit()
    }
}

/// `logo · project › session`, truncating the session first.
private struct OriginLine: View {
    let origin: ReloCardOrigin

    var body: some View {
        let showsSource = !origin.source.isEmpty && (origin.showsSource || origin.project == nil)
        HStack(alignment: .center, spacing: 5) {
            if showsSource {
                SourceMark(name: origin.source, fallbackSymbol: origin.sourceSymbol, size: 14)
                    .foregroundStyle(Color.reloSecondaryText)
                    .lineLimit(1)
            }
            if let project = origin.project {
                if showsSource { separator("·") }
                Text(project).foregroundStyle(origin.projectColor ?? .primary).fontWeight(.semibold).lineLimit(1)
            }
            if let name = origin.topic {
                separator("›")
                Text(name).foregroundStyle(Color.reloSecondaryText).lineLimit(1).layoutPriority(-1)
            }
        }
        .font(ReloLayout.cardMeta.weight(.medium))
        .layoutPriority(-1)
        .accessibilityElement(children: .combine)
    }

    private func separator(_ mark: String) -> some View {
        Text(mark).foregroundStyle(Color.reloSecondaryText.opacity(0.6)).accessibilityHidden(true)
    }
}
