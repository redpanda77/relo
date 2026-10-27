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
    /// The item carries a link: a small mark after the origin says so.
    var hasLink = false
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

/// The corner: the design's chip (C1). Height 20, a capsule of the state colour at 17% with a 0.75 border at 32%,
/// mono 10 semibold caps tracked .8. Its glyph says the state: a glowing dot (needs you blinks, running holds),
/// the return arrow (your turn), the moon (quiet), else the state's own symbol.
private struct CornerLabel: View {
    let corner: CardCorner
    let live: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        switch corner {
        case .none: EmptyView()
        case let .badge(style): chip(style.label, glyph: Glyph(style: style), color: style.color, sweep: live)
        case let .badgeTimer(style, since):
            chip(style.label, glyph: Glyph(style: style), color: style.color, sweep: live) {
                Text(" · ") + Text(timerInterval: since...Date.distantFuture, countsDown: false)
            }
        case let .timer(since):
            Text(timerInterval: since...Date.distantFuture, countsDown: false)
                .foregroundStyle(Color.reloSecondaryText).monospacedDigit()
        case let .countdown(deadline):
            // A live question: "● NEEDS YOU · 4:12", the system ticks the timer.
            chip(ReloStateStyle.needsYou.label, glyph: .blinkingDot, color: ReloStateStyle.needsYou.color, sweep: false) {
                Text(" · ") + Text(timerInterval: Date.now...deadline, countsDown: true)
            }
        case let .phase(words, symbol, color):
            chip(words, glyph: symbol.map(Glyph.symbol) ?? .none, color: color, sweep: false)
        }
    }

    enum Glyph {
        case none, blinkingDot, dot, symbol(String)

        init(style: ReloStateStyle) {
            switch style.symbol {
            case ReloStateStyle.needsYou.symbol: self = .blinkingDot
            case ReloStateStyle.running.symbol: self = .dot
            case ReloStateStyle.yourTurn.symbol: self = .symbol("arrow.uturn.left")
            case ReloStateStyle.quiet.symbol: self = .symbol("moon.fill")
            default: self = .symbol(style.symbol)
            }
        }
    }

    private func chip(_ words: String, glyph: Glyph, color: Color, sweep: Bool,
                      timer: () -> Text = { Text("") }) -> some View {
        HStack(spacing: 5) {
            switch glyph {
            case .none: EmptyView()
            case .blinkingDot: ChipDot(color: color, blinking: true)
            case .dot: ChipDot(color: color, blinking: false)
            case let .symbol(name):
                Image(systemName: name).font(.system(size: 9, weight: .bold))
                    .contentTransition(reduceMotion ? .identity : .symbolEffect(.replace.downUp))
            }
            (Text(words.uppercased()) + timer())
                .contentTransition(.interpolate)
        }
        .font(.system(size: 10, weight: .semibold, design: .monospaced))
        .tracking(0.8)
        .foregroundStyle(color)
        .padding(.horizontal, 8).frame(height: 20)
        .background(Capsule().fill(color.opacity(0.17)))
        .overlay { if sweep { ChipSweep() } }
        .clipShape(Capsule())
        .overlay(Capsule().strokeBorder(color.opacity(0.32), lineWidth: 0.75))
        .accessibilityElement(children: .combine)
    }
}

/// The chip's 6 pt dot with its glow; a question's blinks between 45% and full over 1.8 s.
private struct ChipDot: View {
    let color: Color
    let blinking: Bool
    @State private var bright = false
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        Circle().fill(color).frame(width: 6, height: 6)
            .shadow(color: color, radius: 3)
            .opacity(blinking && !reduceMotion ? (bright ? 1 : 0.45) : 1)
            .reloLoop(.easeInOut(duration: 0.9).repeatForever(autoreverses: true), flag: $bright, enabled: blinking)
    }
}

/// Running work's light across its chip: a band 40% wide, white at .55, added to the colours beneath, crossing
/// in 70% of 2.8 s and resting for the rest.
private struct ChipSweep: View {
    var body: some View {
        ReloMotionClock(framesPerSecond: 30, still: 0) { time in
            GeometryReader { proxy in
                let t = min(time.truncatingRemainder(dividingBy: 2.8) / (2.8 * 0.7), 1)
                let eased = t * t * (3 - 2 * t)
                let width = proxy.size.width * 0.4
                LinearGradient(colors: [.clear, .white.opacity(0.55), .clear], startPoint: .leading, endPoint: .trailing)
                    .frame(width: width)
                    .blendMode(.plusLighter)
                    .offset(x: -width + eased * proxy.size.width * 1.6)
            }
        }
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// A small link glyph: the item carries a link to open. Noticeable beside the origin, never the main thing.
struct ReloLinkMark: View {
    var body: some View {
        Image(systemName: "link")
            .font(.system(size: 9.5, weight: .bold))
            .foregroundStyle(Color.reloInteractive.opacity(0.85))
            .padding(.horizontal, 5).frame(height: 16)
            .background(Capsule().fill(Color.reloInteractive.opacity(0.14)))
            .fixedSize()
            .accessibilityLabel("Has a link")
    }
}

/// The origin: the harness's mark in an 18 pt tile, the project in violet, a chevron, the session's name.
/// It truncates the session first.
private struct OriginLine: View {
    let origin: ReloCardOrigin

    var body: some View {
        let showsSource = !origin.source.isEmpty && (origin.showsSource || origin.project == nil)
        HStack(alignment: .center, spacing: 6) {
            if showsSource { tile }
            if let project = origin.project {
                Text(project).foregroundStyle(origin.projectColor ?? ReloHoloTheme.sessionsViolet)
                    .fontWeight(.semibold).lineLimit(1)
            }
            if let name = origin.topic {
                if origin.project != nil { Text("›").foregroundStyle(Color.white.opacity(0.4)).accessibilityHidden(true) }
                Text(name).foregroundStyle(Color.white.opacity(0.6)).lineLimit(1).layoutPriority(-1)
            }
            if origin.hasLink { ReloLinkMark() }
        }
        .font(.system(size: 11.5, weight: .medium))
        .layoutPriority(-1)
        .accessibilityElement(children: .combine)
    }

    private var tile: some View {
        Group {
            if SourceLogo(sourceName: origin.source) != nil {
                SourceMark(name: origin.source, size: 11)
            } else {
                Image(systemName: origin.sourceSymbol ?? "hexagon").font(.system(size: 10, weight: .medium))
                    .foregroundStyle(Color(red: 0xC9 / 255, green: 0xCF / 255, blue: 0xDB / 255))
                    .accessibilityLabel(origin.source)
            }
        }
        .frame(width: 18, height: 18)
        .background(RoundedRectangle(cornerRadius: 5, style: .continuous).fill(Color.white.opacity(0.08)))
        .overlay(RoundedRectangle(cornerRadius: 5, style: .continuous).strokeBorder(Color.white.opacity(0.12), lineWidth: 0.5))
    }
}
