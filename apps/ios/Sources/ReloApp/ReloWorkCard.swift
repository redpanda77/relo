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

/// How the work stands: "Your turn", "Done", "Running", in its color.
struct ReloCardState: Equatable {
    var label: String
    var color: Color
    var symbol: String? = nil
}

/// The one work card for Now and History. Each line carries one kind of fact: where it runs (source,
/// project, session), the title, the status in its own words, the plan, then how it stands, when and on
/// which computer ("Your turn · 0 of 10 · Reproduce the issue · 12:01 AM · MacBook Pro"). The state sits
/// under the bar, never beside the title: titles can be long.
struct ReloWorkCard<Extra: View>: View {
    var origin: ReloCardOrigin?
    var at: Date?
    var title: String
    var summary: String?
    var steps: NowItem.Steps? = nil
    var progress: Double? = nil
    var color: Color
    var shimmer = false
    var state: ReloCardState? = nil
    var facts: [String] = []
    /// Running work: a live timer joins the facts (the system ticks it).
    var runningSince: Date? = nil
    var computer: String? = nil
    /// The computer's icon (ADR 0011); a laptop until the server names one.
    var computerIcon: ComputerIcon? = nil
    @ViewBuilder var extra: () -> Extra

    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if origin != nil { originRow }
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary)
                .lineLimit(typeSize.isAccessibilitySize ? nil : 3)
                .fixedSize(horizontal: false, vertical: true)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let summary, !summary.isEmpty {
                Text(summary).font(.footnote).foregroundStyle(Color.reloSecondaryText)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)
            }
            extra()
            meter
            if state != nil || !facts.isEmpty || runningSince != nil || at != nil || computer != nil {
                standing.font(.caption).fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder private var meter: some View {
        if let steps, steps.total > 0 {
            if steps.total <= 12 {
                LiveStepsBar(steps: steps, color: color, shimmer: shimmer).padding(.vertical, 3)
            } else {
                LiveProgressBar(value: Double(steps.done) / Double(steps.total), color: color, shimmer: shimmer,
                                showsValue: false).padding(.vertical, 3)
            }
        } else if let progress, progress.isFinite {
            LiveProgressBar(value: progress, color: color, shimmer: shimmer, showsValue: false).padding(.vertical, 3)
        }
    }

    /// "Your turn · 0 of 10 · Reproduce the issue · 2 updates", the state in its color; one wrapping line.
    private var standing: Text {
        var text = Text("")
        var first = true
        func join(_ part: Text) {
            text = first ? part : text + Text(" · ").foregroundColor(Color.reloSecondaryText) + part
            first = false
        }
        if let state {
            let symbol = state.symbol.map { Text(Image(systemName: $0)) + Text(" ") } ?? Text("")
            join((symbol + Text(state.label)).foregroundColor(state.color).fontWeight(.semibold))
        }
        for fact in facts { join(Text(fact).foregroundColor(Color.reloSecondaryText)) }
        if let runningSince {
            join((Text("running ") + Text(timerInterval: runningSince...Date.distantFuture, countsDown: false))
                .foregroundColor(Color.reloSecondaryText).monospacedDigit())
        } else if let at {
            join(Text(at, style: .time).foregroundColor(Color.reloSecondaryText).monospacedDigit())
        }
        // Where it ran closes the line, after when.
        if let computer {
            join(ComputerMark.text(icon: computerIcon, name: computer).foregroundColor(Color.reloSecondaryText))
        }
        return text
    }

    /// Where it runs: source · project › session, the logo centered on the line; a long session name
    /// truncates. The computer closes the bottom line, after the time.
    private var originRow: some View {
        ViewThatFits(in: .horizontal) {
            originParts(topic: true).fixedSize()
            originParts(topic: true).lineLimit(1).truncationMode(.tail)
        }
        .font(.caption.weight(.medium))
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }

    private func originParts(topic: Bool) -> some View {
        let origin = origin ?? ReloCardOrigin(source: "", showsSource: false)
        let showsSource = !origin.source.isEmpty && (origin.showsSource || origin.project == nil)
        return HStack(alignment: .center, spacing: 5) {
            if showsSource {
                SourceMark(name: origin.source, fallbackSymbol: origin.sourceSymbol, size: 14)
                    .foregroundStyle(Color.reloSecondaryText)
            }
            if let project = origin.project {
                if showsSource { separator("·") }
                Text(project).foregroundStyle(origin.projectColor ?? .primary).fontWeight(.semibold)
            }
            if topic, let name = origin.topic {
                separator("›")
                Text(name).foregroundStyle(Color.reloSecondaryText).layoutPriority(-1)
            }
        }
    }

    private func separator(_ mark: String) -> some View {
        Text(mark).foregroundStyle(Color.reloSecondaryText.opacity(0.6)).accessibilityHidden(true)
    }
}

extension ReloWorkCard where Extra == EmptyView {
    init(origin: ReloCardOrigin?, at: Date?, title: String, summary: String?, steps: NowItem.Steps? = nil,
         progress: Double? = nil, color: Color, shimmer: Bool = false, state: ReloCardState? = nil,
         facts: [String] = [], runningSince: Date? = nil, computer: String? = nil,
         computerIcon: ComputerIcon? = nil) {
        self.init(origin: origin, at: at, title: title, summary: summary, steps: steps, progress: progress, color: color,
                  shimmer: shimmer, state: state, facts: facts, runningSince: runningSince, computer: computer,
                  computerIcon: computerIcon, extra: { EmptyView() })
    }
}

struct ReloCardInlineLabelStyle: LabelStyle {
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 3) { configuration.icon.imageScale(.small); configuration.title }
    }
}

/// The sweep of light used on live meters. It is a mask, not an overlay: it is drawn only
/// inside the shape it decorates (the filled part of a bar), so it never shows as a band over
/// the track or the label. It moves by sliding the gradient's start and end points.
struct LiveSweep: View {
    let active: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        if active && !reduceMotion {
            // The shared clock: paused off screen, in Low Power Mode and when the device is hot.
            ReloMotionClock(framesPerSecond: 24, still: 0) { time in
                let cycle = 2.8
                // Travels from just before the left edge to just past the right, then rests.
                let phase = min(time.truncatingRemainder(dividingBy: cycle) / (cycle * 0.7), 1) * 1.6 - 0.3
                LinearGradient(stops: [.init(color: .clear, location: 0),
                                       .init(color: .white.opacity(0.55), location: 0.5),
                                       .init(color: .clear, location: 1)],
                               startPoint: UnitPoint(x: phase - 0.18, y: 0.5),
                               endPoint: UnitPoint(x: phase + 0.18, y: 0.5))
                    .blendMode(.plusLighter)
            }
            .allowsHitTesting(false)
            .accessibilityHidden(true)
        }
    }
}

/// A flat bar for work that reports a fraction instead of steps; the sweep lives in the fill.
struct LiveProgressBar: View {
    let value: Double
    let color: Color
    let shimmer: Bool
    var showsValue = true

    private var fraction: Double { value.isFinite ? min(max(value, 0), 1) : 0 }

    var body: some View {
        HStack(spacing: 10) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.white.opacity(0.1))
                    Capsule().fill(color)
                        .overlay { LiveSweep(active: shimmer) }
                        .clipShape(Capsule())
                        .frame(width: max(4, proxy.size.width * fraction))
                        .animation(.smooth(duration: 0.6), value: fraction)
                }
            }
            .frame(height: 4)
            if showsValue {
                Text(fraction, format: .percent.precision(.fractionLength(0)))
                    .font(.caption.weight(.medium).monospacedDigit()).foregroundStyle(Color.reloSecondaryText)
            }
        }
        .accessibilityElement(children: .ignore).accessibilityLabel("Progress")
        .accessibilityValue(fraction.formatted(.percent.precision(.fractionLength(0))))
    }
}

/// The plan as segments, one per TOP-LEVEL step (the server's counts, never the step tree): finished ones in
/// the meaning color with the sweep running through them only (masked by their shapes), the current one filled
/// to the server's fraction of that step (its substeps, or its own progress), pending ones faint track.
struct LiveStepsBar: View {
    let steps: NowItem.Steps
    let color: Color
    let shimmer: Bool

    private var segments: [PlanBar.Segment] { steps.bar.segments }
    private var current: Int { min(steps.currentIndex ?? steps.done + 1, max(steps.total, 1)) }

    private func row(_ paint: @escaping (PlanBar.Segment) -> some View) -> some View {
        HStack(spacing: 3) {
            ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                paint(segment).frame(height: 4).frame(maxWidth: .infinity)
            }
        }
    }

    var body: some View {
        row { segment in
            Capsule().fill(Color.white.opacity(segment.state == .current ? 0.18 : 0.1))
                .overlay(alignment: .leading) {
                    GeometryReader { proxy in
                        Capsule().fill(color).frame(width: proxy.size.width * segment.fill)
                    }
                }
                .clipShape(Capsule())
        }
        .overlay {
            LiveSweep(active: shimmer)
                .mask(row { segment in Capsule().fill(segment.fill >= 1 ? Color.black : Color.clear) })
        }
        .frame(height: 4)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(current) of \(steps.total)\(steps.current.map { ": \($0)" } ?? "")")
    }
}
