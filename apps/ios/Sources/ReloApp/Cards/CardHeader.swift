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

    fileprivate var text: Text? {
        func badge(_ style: ReloStateStyle) -> Text {
            (Text(Image(systemName: style.symbol)) + Text(" ") + Text(style.label))
                .foregroundColor(style.color).fontWeight(.semibold)
        }
        func gap() -> Text { Text(" · ").foregroundColor(Color.reloSecondaryText) }
        func timer(_ since: Date) -> Text {
            Text(timerInterval: since...Date.distantFuture, countsDown: false)
                .foregroundColor(Color.reloSecondaryText).monospacedDigit()
        }
        switch self {
        case .none: return nil
        case let .badge(style): return badge(style)
        case let .badgeTimer(style, since): return badge(style) + gap() + timer(since)
        case let .timer(since): return timer(since)
        case let .countdown(deadline):
            guard deadline > .now else { return nil }
            return (Text(Image(systemName: "timer")) + Text(" ")
                + Text(timerInterval: Date.now...deadline, countsDown: true).monospacedDigit())
                .foregroundColor(Color.reloSecondaryText)
        case let .phase(words, symbol, color):
            return ((symbol.map { Text(Image(systemName: $0)) + Text(" ") } ?? Text("")) + Text(words))
                .foregroundColor(color).fontWeight(.semibold)
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
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        if origin != nil || corner.text != nil {
            let layout = typeSize.isAccessibilitySize
                ? AnyLayout(VStackLayout(alignment: .leading, spacing: ReloLayout.cardGap))
                : AnyLayout(HStackLayout(alignment: .center, spacing: ReloLayout.inlineGap))
            layout {
                if let origin { OriginLine(origin: origin) }
                if let text = corner.text {
                    if !typeSize.isAccessibilitySize { Spacer(minLength: 0) }
                    text.font(ReloLayout.cardMeta).lineLimit(1).fixedSize()
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
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
