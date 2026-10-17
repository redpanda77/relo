import ActivityKit
import AppIntents
import ReloCore
import SwiftUI
import UIKit
import WidgetKit

/// iOS 18+: the same activity, plus the `.small` family the Apple Watch Smart Stack renders.
/// Without it the watch falls back to the island's compact pair: two glyphs on a black tile.
@available(iOS 18.0, *)
struct ReloLiveActivityWatchWidget: Widget {
    var body: some WidgetConfiguration {
        ReloLiveActivityWidget().configuration.supplementalActivityFamilies([.small])
    }
}

struct ReloLiveActivityWidget: Widget {
    var body: some WidgetConfiguration { configuration }

    var configuration: some WidgetConfiguration {
        ActivityConfiguration(for: ReloActivityAttributes.self) { context in
            ReloActivityContentView(context: context)
            .activitySystemActionForegroundColor(.white)
            .widgetURL(ReloDeepLink.activityURL(identity: context.attributes.identity))
            .accessibilityElement(children: .contain)
            .accessibilityHint(accessibilitySummary(for: context).hint)
        } dynamicIsland: { context in
            let presentation = context.state.presentation
            let palette = PresentationPalette(presentation: presentation)
            return DynamicIsland {
                // The system insets each expanded region differently, so the header lives in
                // the bottom card with the content it labels: one column, one inset. The corner
                // regions carry only components a sender assigns to them explicitly.
                DynamicIslandExpandedRegion(.leading) {
                    if !presentation.components(for: .expandedLeading).isEmpty {
                        PresentationCompactSurface(
                            presentation: presentation, surface: .expandedLeading,
                            palette: palette, interaction: context.state.displayInteraction,
                            isStale: context.isStale)
                    }
                }
                DynamicIslandExpandedRegion(.bottom) {
                    PresentationCardView(
                        presentation: presentation, context: context, surface: .expanded
                    )
                }
            } compactLeading: {
                if let count = context.state.owner?.needsYouCountLabel {
                    Image(systemName: "exclamationmark.bubble.fill")
                        .foregroundStyle(OwnerChipStyle.needsYouOrange)
                        .accessibilityLabel("Relo, \(count) need you")
                } else if presentation.components(for: .compactLeading).isEmpty {
                    Image(
                        systemName: presentation.privacy == .private
                            ? "lock.fill"
                            : presentation.identity.project?.icon.systemImageName
                                ?? presentation.state.icon.systemImageName
                    )
                    .foregroundStyle(presentation.privacy == .private ? palette.primaryText : palette.accent)
                    .accessibilityLabel(accessibilitySummary(for: context).label)
                } else {
                    PresentationCompactSurface(
                        presentation: presentation, surface: .compactLeading,
                        palette: palette, interaction: context.state.displayInteraction,
                        isStale: context.isStale)
                }
            } compactTrailing: {
                PresentationCompactSurface(
                    presentation: presentation, surface: .compactTrailing, palette: palette,
                    interaction: context.state.displayInteraction, isStale: context.isStale,
                    owner: context.state.owner
                )
            } minimal: {
                PresentationCompactSurface(
                    presentation: presentation, surface: .minimal, palette: palette,
                    interaction: context.state.displayInteraction, isStale: context.isStale,
                    owner: context.state.owner
                )
            }
            .keylineTint(
                presentation.privacy == .private ? palette.primaryText.opacity(0.5) : palette.state
            )
            .widgetURL(ReloDeepLink.activityURL(identity: context.attributes.identity))
        }
    }
}

/// A work card's plan on the Lock Screen: the shown steps plus the steps of a longer plan hidden around them.
struct LockScreenPlan: Equatable {
    let steps: [LiveActivityPlanDisplay.Step]
    let window: LiveActivityDisplayPresentation.StepWindow

    /// One segment per top-level step, hidden ones included; the current one filled to the server's fraction.
    var bar: PlanBar { PlanBar.make(steps: steps, before: window.before, after: window.after, fill: window.progress?.fill) }

    var standing: PlanProgress.Standing = .moving

    /// The plan line (U2), as the app reads it: "2 of 10 · Run the migrations · 1/3".
    var caption: String {
        LiveActivityPlanDisplay.line(steps, window: window, standing: standing) ?? ""
    }

    var parts: PlanProgress.LineParts? { LiveActivityPlanDisplay.lineParts(steps, window: window, standing: standing) }
}

/// The plan line with its counts whole: only the step's label gives way to the width.
struct PresentationPlanLine: View {
    let parts: PlanProgress.LineParts
    let color: Color
    var font: Font = .caption.weight(.semibold)

    var body: some View {
        HStack(spacing: 4) {
            Text(parts.label == nil ? parts.lead : parts.lead + " ·").fixedSize()
            if let label = parts.label {
                Text(label).lineLimit(1).truncationMode(.tail)
                    .layoutPriority(-1)
            }
            if let trail = parts.trail { Text("· " + trail).fixedSize() }
        }
        .font(font).foregroundStyle(color)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(parts.text)
    }
}

/// One segment per step across the full width, as on the app's card; long plans become one bar.
struct PresentationPlanMeter: View {
    let plan: LockScreenPlan
    let palette: PresentationPalette

    var body: some View {
        let segments = plan.bar.segments
        Group {
            if segments.count <= 12 {
                HStack(spacing: 3) {
                    ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                        Capsule().fill(track(segment.state)).frame(height: 4).frame(maxWidth: .infinity)
                            .overlay(alignment: .leading) {
                                GeometryReader { proxy in
                                    Capsule().fill(palette.state).frame(width: proxy.size.width * segment.fill)
                                }
                            }
                            .clipShape(Capsule())
                    }
                }
            } else {
                let whole = segments.reduce(0.0) { $0 + $1.fill }
                PresentationNeonBar(value: whole / Double(segments.count), palette: palette)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(plan.caption)
    }

    private func track(_ state: LiveActivityPlanDisplay.StepState) -> Color {
        palette.primaryText.opacity(state == .current ? 0.2 : 0.12)
    }
}

enum PresentationCardSurface: String, Sendable {
    case lockScreen = "lock-screen"
    case expanded
}

struct PresentationCardView: View {
    let presentation: LiveActivityPresentation
    let context: ActivityViewContext<ReloActivityAttributes>
    let surface: PresentationCardSurface

    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    private var palette: PresentationPalette {
        // Lock Screen and Island share one dark, brand-tinted surface in every appearance.
        .init(presentation: presentation, surface: surface)
    }
    private var componentSurface: LiveActivityPresentation.Surface {
        surface == .lockScreen ? .lockScreen : .expandedBottom
    }
    private var projection: LiveActivitySurfaceProjection {
        .make(
            presentation: presentation, surface: componentSurface,
            interaction: context.state.displayInteraction, isStale: context.isStale,
            owner: context.state.owner, now: .now)
    }

    var body: some View {
        // Select within the surface budget, then report the selected content's height.
        // A flexible max-height frame here would inflate even the smallest fallback.
        VStack(alignment: .leading, spacing: 6) {
            if presentation.privacy != .private {
                header
            }
            fittedContent
        }
        .frame(maxWidth: .infinity, alignment: .topLeading)
        // Apple's Lock Screen guidance: one even margin that matches the card's corner radius.
        // In the island the system already clears the curve; a small inset keeps text off it.
        .padding(surface == .lockScreen ? 16 : 0)
        .padding(.horizontal, surface == .lockScreen ? 0 : 8)
        .padding(.bottom, surface == .lockScreen ? 0 : 6)
        .background {
            if surface == .lockScreen {
                PresentationBackdrop(palette: palette, isLuminanceReduced: isLuminanceReduced)
            }
        }
    }

    /// Source on the leading edge; in the island, the state glyph or fact on the trailing edge.
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            PresentationSourceMark(presentation: presentation, palette: palette)
            if let chip = projection.chip {
                OwnerChipView(chip: chip, owner: context.state.owner)
            }
            Spacer(minLength: 0)
            if let owner = context.state.owner, let timeSlot = OwnerTimeSlot(owner: owner) {
                timeSlot.font(.caption.monospacedDigit()).foregroundStyle(palette.secondaryText)
                    .lineLimit(1)
            } else if let deadline = questionDeadline {
                PresentationCountdown(deadline: deadline, palette: palette)
            } else {
                if let startedAt = elapsedStart {
                    // The system ticks this for free; nothing in the widget redraws it.
                    Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
                        .font(.caption.monospacedDigit()).foregroundStyle(palette.secondaryText)
                        .multilineTextAlignment(.trailing)
                        .frame(maxWidth: 72, alignment: .trailing)
                        .accessibilityLabel("Running for")
                }
                if surface == .expanded {
                    PresentationIslandStatusMark(
                    presentation: presentation, palette: palette,
                        interaction: context.state.displayInteraction, isStale: context.isStale)
                }
            }
        }
    }

    /// When the work began, only while it is still running; ended or stale cards show no timer.
    private var elapsedStart: Date? {
        guard presentation.state.kind == "active", !context.isStale else { return nil }
        if let state = context.state.owner?.ownerState, state != .moving, state != .needsYou { return nil }
        return context.state.startedAt
    }

    /// The answer deadline while a question can still be answered on the card.
    private var questionDeadline: Date? {
        guard projection.permitsInlineResponse, let interaction = context.state.displayInteraction else { return nil }
        return interaction.expiresAt
    }

    private var fittedContent: some View {
        LiveActivityFittingLayout(maximumHeight: surface == .lockScreen ? 110 : 84) {
            ViewThatFits(in: .vertical) {
                if presentation.privacy == .private {
                    privateCard
                } else if projection.isDecision {
                    // The answer buttons are never dropped: the text around them shrinks instead,
                    // and tapping the card opens the full question in Relo.
                    questionCard(showsTitle: true, questionLines: 2)
                    questionCard(showsTitle: true, questionLines: 1)
                    questionCard(showsTitle: false, questionLines: 2)
                    questionCard(showsTitle: false, questionLines: 1)
                    questionCard(showsTitle: false, questionLines: 0)
                } else if surface == .lockScreen, let plan = lockScreenPlan {
                    // Work with a plan reads like its card in Relo: title, status, the plan's segments, one caption.
                    if !dynamicTypeSize.isAccessibilitySize {
                        workCard(plan, titleLines: 2, statusLines: 2)
                        workCard(plan, titleLines: 2, statusLines: 1)
                        workCard(plan, titleLines: 1, statusLines: 1)
                    }
                    workCard(plan, titleLines: 1, statusLines: 0)
                    compactCard
                        .fixedSize(horizontal: false, vertical: true)
                    conciseFact.font(.caption).foregroundStyle(palette.secondaryText).lineLimit(1)
                } else {
                    if !dynamicTypeSize.isAccessibilitySize {
                        card(showComponents: true)
                            .fixedSize(horizontal: false, vertical: true)
                        card(showComponents: false)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    compactCard
                        .fixedSize(horizontal: false, vertical: true)
                    conciseFact.font(.caption).foregroundStyle(palette.secondaryText).lineLimit(1)
                }
            }
        }
    }

    private var privateCard: some View {
        Label("Private activity", systemImage: "lock.fill")
            .font(.caption).foregroundStyle(palette.primaryText)
    }

    private func card(showComponents: Bool) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(presentation.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.primaryText)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if let subtitle = presentation.subtitle {
                Text(subtitle).font(.caption).foregroundStyle(palette.secondaryText)
                    .fixedSize(horizontal: false, vertical: true)
            }
            if showComponents {
                PresentationComponentStack(
                    presentation: presentation, components: projection.components, palette: palette,
                    accountID: context.attributes.accountID
                )
            }
            if !(showComponents && componentsCarryFact) {
                // A rendered bar or step track already states progress; repeat it only when
                // the condensed variant drops the components.
                conciseFact
                    .font(.caption).foregroundStyle(palette.secondaryText)
                    .lineLimit(1)
            }
        }
    }

    /// The Lock Screen's plan: its steps (with any hidden around the window) and the current step's own count.
    private var lockScreenPlan: LockScreenPlan? {
        guard let step = projection.components.first(where: { if case .steps = $0 { true } else { false } }),
              case .steps(_, _, let items, let window) = step else { return nil }
        let count = projection.components.lazy.compactMap { component -> (Int, Int)? in
            if case .progressBar(_, _, _, let label) = component { LiveActivitySurfaceProjection.stepCount(label) } else { nil }
        }.first
        return LockScreenPlan(steps: LiveActivityPlanDisplay.steps(items, count: count), window: window,
                              standing: presentation.planStanding)
    }

    private func workCard(_ plan: LockScreenPlan, titleLines: Int, statusLines: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(presentation.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.primaryText)
                .lineLimit(titleLines)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if statusLines > 0, !presentation.status.isEmpty {
                Text(presentation.status)
                    .font(.caption).foregroundStyle(palette.secondaryText)
                    .lineLimit(statusLines)
                    .fixedSize(horizontal: false, vertical: true)
            }
            PresentationPlanMeter(plan: plan, palette: palette)
                .padding(.top, 2)
            if let parts = plan.parts {
                PresentationPlanLine(parts: parts, color: palette.secondaryText, font: .caption)
            }
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    private var componentsCarryFact: Bool {
        switch projection.fact {
        case .percentage, .stages: !projection.components.isEmpty
        case .symbol: false
        }
    }

    /// A question with its answer buttons. Every variant keeps the buttons.
    private func questionCard(showsTitle: Bool, questionLines: Int) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            if showsTitle {
                Text(presentation.title)
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(palette.primaryText)
                    .lineLimit(1)
                    .accessibilityAddTraits(.isHeader)
            }
            if questionLines > 0, let question = presentation.subtitle {
                Text(question)
                    .font(showsTitle ? .caption : .subheadline.weight(.semibold))
                    .foregroundStyle(showsTitle ? palette.secondaryText : palette.primaryText)
                    .lineLimit(questionLines)
            }
            PresentationBehaviorModule(
                activityID: context.attributes.eventID,
                activityGeneration: context.attributes.generation,
                behavior: presentation.behavior,
                interaction: context.state.displayInteraction,
                fallbackStatus: projection.status, palette: palette,
                permitsSubmission: projection.permitsInlineResponse
            )
            .padding(.horizontal, 4)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Work that does not fit in full: the title and one line of status.
    private var compactCard: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(presentation.title)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(palette.primaryText)
                .lineLimit(surface == .lockScreen ? 2 : 1)
            conciseFact.font(.caption).foregroundStyle(palette.secondaryText).lineLimit(1)
        }
    }

    @ViewBuilder private var conciseFact: some View {
        switch projection.fact {
        case .percentage(let value, let role):
            HStack(spacing: 6) {
                Text(value, format: .percent.precision(.fractionLength(0)))
                    .fontWeight(.semibold).monospacedDigit()
                    .foregroundStyle(palette.state)
                Text(projection.status)
            }
            .accessibilityElement(children: .combine)
        case .stages(let completed, let total):
            Text("\(completed) of \(total)")
        case .symbol(let symbol, let label):
            Label(label, systemImage: symbol)
        }
    }

    private var statusSymbol: String {
        if case .symbol(let symbol, _) = projection.fact { return symbol }
        return presentation.state.icon.systemImageName
    }
}

struct PresentationComponentStack: View {
    let presentation: LiveActivityPresentation
    let components: [LiveActivityPresentation.Component]
    let palette: PresentationPalette
    let accountID: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if let step = components.first(where: { if case .steps = $0 { true } else { false } }),
                case .steps(_, _, let items, let window) = step,
                components.contains(where: { if case .progressBar = $0 { true } else { false } })
            {
                // Progress belongs to the current step: "Step 2 · 1 to go · <step> · n of m" (2.15).
                let count = components.lazy.compactMap { component -> (Int, Int)? in
                    if case .progressBar(_, _, _, let label) = component { LiveActivitySurfaceProjection.stepCount(label) } else { nil }
                }.first
                if let parts = LiveActivityPlanDisplay.lineParts(LiveActivityPlanDisplay.steps(items, count: count), window: window,
                                                                 standing: presentation.planStanding) {
                    PresentationPlanLine(parts: parts, color: palette.primaryText)
                }
            }
            ForEach(components) { component in
                if case .steps = component,
                    components.contains(where: { if case .progressBar = $0 { true } else { false } })
                {
                    EmptyView()
                } else {
                    PresentationComponentView(
                        presentation: presentation, component: component, palette: palette,
                        accountID: accountID,
                        showsValue: !components.contains(where: { if case .steps = $0 { true } else { false } })
                    )
                }
            }
        }
    }
}

struct PresentationComponentView: View {
    let presentation: LiveActivityPresentation
    let component: LiveActivityPresentation.Component
    let palette: PresentationPalette
    let accountID: String?
    /// False when steps carry the count: the bar's label and percent would be a second number.
    var showsValue = true
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var componentColor: Color {
        palette.state
    }

    var body: some View {
        switch component {
        case .progressBar(_, _, let value, let label) where presentation.appearance.drawsProgressAsRing:
            HStack(spacing: 10) {
                PresentationProgressRing(value: value, color: componentColor, track: palette.primaryText)
                    .frame(width: 40, height: 40)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: value)
                if let label {
                    Text(label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.secondaryText)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label ?? "Progress")
            .accessibilityValue("\(Int((value * 100).rounded())) percent")
        case .progressBar(_, _, let value, let label):
            VStack(alignment: .leading, spacing: 3) {
                if showsValue {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        if let label {
                            Text(label)
                                .font(.caption2)
                                .foregroundStyle(palette.secondaryText)
                                .lineLimit(1)
                                .allowsTightening(true)
                        }
                        Spacer(minLength: 0)
                        Text(value, format: .percent.precision(.fractionLength(0)))
                            .font(.caption2.weight(.semibold).monospacedDigit())
                            .foregroundStyle(componentColor)
                    }
                }
                PresentationNeonBar(value: value, palette: palette)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: value)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label ?? "Progress")
            .accessibilityValue("\(Int((value * 100).rounded())) percent")
        case .steps(_, _, let items, let window):
            // No plan-wide ratio bar here: plans grow (2.15). The Lock Screen work card draws the plan's segments.
            if let parts = LiveActivityPlanDisplay.lineParts(LiveActivityPlanDisplay.steps(items), window: window,
                                                             standing: presentation.planStanding) {
                PresentationPlanLine(parts: parts, color: palette.primaryText)
            }
        case .image(_, _, let asset):
            ZStack {
                palette.primaryText.opacity(0.08)
                if let image = ImmutablePresentationAssetCache.image(for: asset, accountID: accountID) {
                    Image(uiImage: image).resizable()
                        .aspectRatio(contentMode: asset.contentMode == .fill ? .fill : .fit)
                } else {
                    Image(systemName: "photo.badge.exclamationmark")
                        .foregroundStyle(palette.secondaryText)
                }
            }
            .frame(height: 36)
            .frame(maxWidth: .infinity)
            .clipShape(RoundedRectangle(cornerRadius: 8, style: .continuous))
            .accessibilityLabel(asset.altText)
        }
    }

    /// One gradient runs across the whole row and shows through the finished and current steps,
    /// so the color flows continuously instead of restarting in every segment. The step in
    /// progress is a touch brighter; pending steps are faint glass.
    private func stepRow(_ items: [LiveActivityDisplayPresentation.Step]) -> some View {
        func segments(_ fill: @escaping (LiveActivityDisplayPresentation.Step.State) -> Color) -> some View {
            HStack(spacing: 5) {
                ForEach(items) { item in Capsule().fill(fill(item.state)).frame(height: 5) }
            }
        }
        return segments { _ in Color.white.opacity(0.13) }
            .overlay {
                Rectangle().fill(palette.rampGradient)
                    .mask(segments { $0 == .pending ? .clear : .black })
            }
            .overlay {
                Rectangle().fill(Color.white.opacity(0.28))
                    .mask(segments { $0 == .current ? .black : .clear })
            }
            .frame(height: 5)
    }
}

/// A thin determinate bar filled with the neon ramp over faint glass.
struct PresentationNeonBar: View {
    let value: Double
    let palette: PresentationPalette

    var body: some View {
        Capsule().fill(Color.white.opacity(0.13)).frame(height: 5)
            .overlay(alignment: .leading) {
                GeometryReader { proxy in
                    Capsule().fill(palette.rampGradient)
                        .frame(width: max(5, proxy.size.width * min(max(value, 0), 1)))
                }
            }
    }
}

struct PresentationSourceMark: View {
    let presentation: LiveActivityPresentation
    let palette: PresentationPalette
    var lineLimit: Int? = 1

    private var identityText: String {
        presentation.privacy == .private
            ? "Relo" : presentation.identity.project?.label ?? presentation.header ?? "Relo"
    }

    private var identityIcon: String {
        presentation.privacy == .private
            ? "lock.fill"
            : presentation.identity.project?.icon.systemImageName
                ?? presentation.identity.thread?.icon.systemImageName
                ?? presentation.state.icon.systemImageName
    }

    var body: some View {
        Label(identityText, systemImage: identityIcon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(palette.primaryText)
            .lineLimit(lineLimit)
            .allowsTightening(true)
            .labelStyle(
                PresentationSourceLabelStyle(
                    accent: presentation.privacy == .private ? palette.primaryText : palette.accent)
            )
            .accessibilityLabel(accessibleIdentity)
    }

    private var accessibleIdentity: String {
        guard presentation.privacy != .private else { return "Relo private activity" }
        let labels = [presentation.identity.project?.label, presentation.identity.thread?.label]
            .compactMap { $0 }
        return labels.isEmpty ? identityText : labels.joined(separator: ", ")
    }
}

struct PresentationIslandStatusMark: View {
    let presentation: LiveActivityPresentation
    let palette: PresentationPalette
    let interaction: ReloActivityAttributes.Interaction?
    let isStale: Bool
    /// The bottom card already states measured progress beside its bar or step track.
    private var bottomCarriesProgress: Bool {
        let bottom = LiveActivitySurfaceProjection.make(
            presentation: presentation, surface: .expandedBottom,
            interaction: interaction, isStale: isStale, now: .now)
        switch bottom.fact {
        case .percentage, .stages: return !bottom.components.isEmpty
        case .symbol: return false
        }
    }

    var body: some View {
        if bottomCarriesProgress && presentation.privacy != .private {
            // Never repeat the bottom card's number; show the state glyph instead.
            Image(systemName: presentation.state.icon.systemImageName)
                .font(.caption.weight(.semibold))
                .foregroundStyle(palette.state)
                .accessibilityLabel(presentation.status)
        } else {
            PresentationCompactSurface(
                presentation: presentation, surface: .expandedTrailing,
                palette: palette, interaction: interaction, isStale: isStale)
        }
    }
}

/// Time left to answer, counted down by the system without further pushes.
struct PresentationCountdown: View {
    let deadline: Date
    let palette: PresentationPalette

    var body: some View {
        HStack(spacing: 4) {
            Image(systemName: "timer")
            Text(timerInterval: Date.now...max(deadline, Date.now), countsDown: true)
                .monospacedDigit()
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 44, alignment: .trailing)
        }
        .font(.caption.weight(.semibold))
        .foregroundStyle(palette.state)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Time left to answer")
    }
}

/// A determinate gauge with the percent centered: the `ring` activity style.
struct PresentationProgressRing: View {
    let value: Double
    let color: Color
    let track: Color

    var body: some View {
        ZStack {
            Circle().stroke(track.opacity(0.15), lineWidth: 4)
            Circle().trim(from: 0, to: min(max(value, 0), 1))
                .stroke(color, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                .rotationEffect(.degrees(-90))
            Text(value, format: .percent.precision(.fractionLength(0)))
                .font(.system(size: 11, weight: .bold).monospacedDigit())
                .foregroundStyle(track)
                .minimumScaleFactor(0.7)
        }
        .padding(2)
    }
}

struct PresentationCompactSurface: View {
    let presentation: LiveActivityPresentation
    let surface: LiveActivityPresentation.Surface
    let palette: PresentationPalette
    var interaction: ReloActivityAttributes.Interaction? = nil
    var isStale = false
    /// The server's owner state: its needs-you count wins compact trailing and minimal (spec 6.2).
    var owner: LiveActivityOwner? = nil

    private var projection: LiveActivitySurfaceProjection {
        .make(
            presentation: presentation, surface: surface,
            interaction: interaction, isStale: isStale, owner: owner, now: .now)
    }
    private var needsYouCount: Int? {
        guard surface == .compactTrailing || surface == .minimal else { return nil }
        return projection.needsYouCount
    }
    private var factColor: Color {
        if presentation.privacy == .private { return palette.primaryText }
        if case .percentage(_, let role) = projection.fact {
            return palette.state
        }
        return palette.state
    }

    var body: some View {
        Group {
            if let count = needsYouCount {
                if surface == .minimal {
                    ZStack {
                        Circle().fill(OwnerChipStyle.needsYouOrange)
                        Text(count > 9 ? "9+" : "\(count)")
                            .font(.system(size: 11, weight: .bold).monospacedDigit())
                            .foregroundStyle(.black)
                            .minimumScaleFactor(0.6)
                    }
                    .frame(width: 20, height: 20)
                } else {
                    Text(count > 9 ? "9+" : "\(count)")
                        .foregroundStyle(OwnerChipStyle.needsYouOrange)
                }
            } else if surface == .minimal {
                minimalFact
            } else {
                ViewThatFits(in: .horizontal) {
                    fullFact.fixedSize(horizontal: true, vertical: false)
                    Image(systemName: fallbackSymbol).foregroundStyle(factColor)
                }
            }
        }
        .font(.caption2.weight(.semibold).monospacedDigit())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    @ViewBuilder private var fullFact: some View {
        switch projection.fact {
        case .symbol(let symbol, _):
            Image(systemName: symbol).foregroundStyle(factColor)
        case .percentage(let value, _):
            Text(value, format: .percent.precision(.fractionLength(0)))
                .foregroundStyle(factColor).frame(width: 36)
        case .stages(let completed, let total):
            Text("\(completed)/\(total)").foregroundStyle(factColor).frame(width: 30)
        }
    }

    @ViewBuilder private var minimalFact: some View {
        switch projection.fact {
        case .symbol(let symbol, _):
            Image(systemName: symbol).foregroundStyle(factColor)
        case .percentage(let value, _):
            ring(value)
        case .stages(let completed, let total):
            ring(Double(completed) / Double(max(total, 1)))
        }
    }

    private func ring(_ value: Double) -> some View {
        ZStack {
            Circle().stroke(palette.primaryText.opacity(0.22), lineWidth: 2)
            Circle().trim(from: 0, to: value).stroke(
                factColor, style: StrokeStyle(lineWidth: 2, lineCap: .round)
            )
            .rotationEffect(.degrees(-90))
        }
        .frame(width: 20, height: 20)
    }

    private var fallbackSymbol: String {
        if case .symbol(let symbol, _) = projection.fact { return symbol }
        return presentation.state.icon.systemImageName
    }
    private var accessibilityText: String {
        let needsYou = needsYouCount.map { "\($0) need you" }
        if presentation.privacy == .private {
            return needsYou.map { "Relo private activity, \($0)" } ?? "Relo private activity. Open Relo to view"
        }
        let fact: String
        if let needsYou {
            return surface == .minimal
                ? "\(presentation.identity.project?.label ?? presentation.header ?? "Relo"), \(presentation.title), \(needsYou)"
                : needsYou
        }
        switch projection.fact {
        case .symbol(_, let label): fact = label
        case .percentage(let value, _): fact = "\(Int((value * 100).rounded())) percent"
        case .stages(let completed, let total): fact = "\(completed) of \(total)"
        }
        return surface == .minimal
            ? "\(presentation.identity.project?.label ?? presentation.header ?? "Relo"), \(presentation.title), \(fact)"
            : fact
    }
}

struct PresentationBehaviorModule: View {
    let activityID: String
    let activityGeneration: Int
    let behavior: LiveActivityDisplayPresentation.Behavior
    let interaction: ReloActivityAttributes.Interaction?
    let fallbackStatus: String
    let palette: PresentationPalette
    let permitsSubmission: Bool
    /// 44 on the phone; the watch tile has room for about 30.
    var controlHeight: CGFloat = 44
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        switch behavior {
        case .informational, .progress:
            EmptyView()
        case .approval(let primary, let secondary):
            decisionOptions(primary: primary, secondary: secondary, expectedKind: "approval")
        case .yesNo(let primary, let secondary):
            decisionOptions(primary: primary, secondary: secondary, expectedKind: "yes_no")
        case .choice(let options):
            choiceOptions(options)
        case .unsupportedTextReply:
            decisionOptions(primary: "Reply", secondary: "Reply", expectedKind: "text")
                .accessibilityHint("Inline text entry is not supported in Live Activities")
        }
    }

    @ViewBuilder
    private func decisionOptions(primary: String, secondary: String, expectedKind: String)
        -> some View
    {
        if let interaction, interaction.kind == expectedKind {
            let response = LiveActivityResponseWidgetPresentation.make(
                interaction: interaction, primary: primary, secondary: secondary,
                fallbackStatus: fallbackStatus, now: .now
            )
            switch response.mode {
            case .actions:
                if permitsSubmission {
                    HStack(spacing: 8) {
                        decisionButton(
                            label: secondary, action: expectedKind == "yes_no" ? "no" : "deny",
                            interaction: interaction, emphasized: false)
                        decisionButton(
                            label: primary, action: expectedKind == "yes_no" ? "yes" : "approve",
                            interaction: interaction, emphasized: true)
                    }
                    .invalidatableContent()
                } else {
                    feedback(label: fallbackStatus, symbol: "info.circle.fill")
                }
            case .openTextReply:
                feedback(label: "Reply needed", symbol: "text.bubble")
            case .rejected:
                feedback(label: "Response not recorded", symbol: "exclamationmark.triangle.fill")
            case .sending, .queued, .accepted, .terminal:
                feedback(
                    label: response.label ?? "Response unavailable", symbol: response.symbol,
                    showsProgress: response.showsProgress)
            case .placeholder:
                feedback(label: fallbackStatus, symbol: "info.circle.fill")
            }
        } else {
            feedback(label: "Response unavailable", symbol: "exclamationmark.triangle.fill")
        }
    }

    /// 2 options: one row exactly like approval. 3–4: one row of compact buttons whose labels
    /// may wrap to two lines, at the same 44 pt height, so the card's height budget holds.
    @ViewBuilder
    private func choiceOptions(_ options: [InteractionOption]) -> some View {
        if let interaction, interaction.kind == "choice" {
            let response = LiveActivityResponseWidgetPresentation.make(
                interaction: interaction, primary: "", secondary: "", options: options,
                fallbackStatus: fallbackStatus, now: .now
            )
            switch response.mode {
            case .actions:
                if permitsSubmission {
                    let compact = options.count > 2
                    HStack(spacing: compact ? 6 : 8) {
                        ForEach(options) { option in
                            decisionButton(
                                label: option.label, action: NotificationInteractionAction.choose.rawValue,
                                optionID: option.id, interaction: interaction, emphasized: false,
                                compact: compact)
                        }
                    }
                    .invalidatableContent()
                } else {
                    feedback(label: fallbackStatus, symbol: "info.circle.fill")
                }
            case .rejected:
                feedback(label: "Response not recorded", symbol: "exclamationmark.triangle.fill")
            case .sending, .queued, .accepted, .terminal:
                feedback(
                    label: response.label ?? "Response unavailable", symbol: response.symbol,
                    showsProgress: response.showsProgress)
            case .openTextReply, .placeholder:
                feedback(label: fallbackStatus, symbol: "info.circle.fill")
            }
        } else {
            feedback(label: "Response unavailable", symbol: "exclamationmark.triangle.fill")
        }
    }

    private func decisionButton(
        label: String, action: String, optionID: String = "",
        interaction: ReloActivityAttributes.Interaction, emphasized: Bool, compact: Bool = false
    ) -> some View {
        Button(
            intent: ReloLiveActivityResponseIntent(
                activityID: activityID, activityGeneration: activityGeneration,
                notificationID: interaction.notificationID,
                interactionID: interaction.id, accountID: interaction.accountID,
                deviceID: interaction.targetDeviceID, action: action, optionID: optionID,
                credential: interaction.credential, expiresAt: interaction.expiresAt
            )
        ) {
            Text(label)
                .font(compact ? .caption2.weight(.bold) : .caption.weight(.bold))
                .multilineTextAlignment(.center)
                .lineLimit(compact ? 2 : nil)
                .minimumScaleFactor(compact ? 0.8 : 1)
                .padding(.horizontal, compact ? 4 : 0)
                .fixedSize(horizontal: false, vertical: !compact)
                .foregroundStyle(emphasized ? PresentationBackdrop.base : palette.primaryText)
                .frame(maxWidth: .infinity, minHeight: controlHeight)
                .background(
                    emphasized
                        ? AnyShapeStyle(palette.rampGradient)
                        : AnyShapeStyle(palette.primaryText.opacity(0.11)),
                    in: Capsule())
        }
        .buttonStyle(LiveActivityDecisionButtonStyle())
        .accessibilityLabel(label)
        .accessibilityHint("Sends this response to Relo")
    }

    private func feedback(label: String, symbol: String?, showsProgress: Bool = false) -> some View {
        HStack(spacing: 7) {
            if showsProgress {
                ProgressView().controlSize(.small)
            } else if let symbol {
                Image(systemName: symbol).contentTransition(
                    reduceMotion ? .identity : .symbolEffect(.replace))
            }
            Text(label)
                .fixedSize(horizontal: false, vertical: true)
        }
        .font(.caption.weight(.bold))
        .foregroundStyle(palette.primaryText)
        .frame(maxWidth: .infinity, minHeight: controlHeight, alignment: .leading)
        .transition(.opacity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

struct LiveActivityDecisionButtonStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.98 : 1)
            .opacity(configuration.isPressed ? 0.8 : 1)
            .animation(reduceMotion ? nil : .easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct PresentationPalette: Sendable {
    /// The curated neon ramp. Structure (bars, steps, rings, glow) uses only these; the project
    /// identity colour is a small accent on the source mark and never a fill or wash.
    let cyan = Color(neonHex: 0x5CE1FF)
    let violet = Color(neonHex: 0x8B7CFF)
    let magenta = Color(neonHex: 0xD65CF0)
    static let mint = Color(neonHex: 0x34D399)
    static let coral = Color(neonHex: 0xFF6B57)
    static let amber = Color(neonHex: 0xFBBF24)

    static let teal = Color(neonHex: 0x2DD4BF)
    static let blue = Color(neonHex: 0x4D8DFF)

    let accent: Color
    let secondary: Color
    /// Lead colour of the state ramp: glyphs, rings, percentages and the progress fill start.
    let state: Color
    /// Far end of the state ramp: bar/segment fill end, glow and the backdrop's lit corner.
    let rampEnd: Color
    let primaryText = Color.white
    let secondaryText = Color.white.opacity(0.72)
    let canvas = Color(neonHex: 0x0B0E1A)

    var rampGradient: LinearGradient {
        LinearGradient(colors: [state, rampEnd], startPoint: .leading, endPoint: .trailing)
    }

    init(
        presentation: LiveActivityPresentation, surface: PresentationCardSurface = .expanded
    ) {
        let project = (ReloReadableColor(hex: presentation.color(for: .project))
            ?? .init(red: 0.37, green: 0.85, blue: 0.72)).readable(onLight: false)
        accent = Color(red: project.red, green: project.green, blue: project.blue)
        secondary = Color(neonHex: 0x8B7CFF)
        // Tone picks the ramp: running cyan>violet, done mint>teal, needs-you coral>magenta,
        // failed/stopped amber>coral, waiting amber>amber, neutral cyan>blue.
        let ramp: (Color, Color) = switch presentation.state.tone {
        case "success": (Self.mint, Self.teal)
        case "attention": (Self.coral, Color(neonHex: 0xD65CF0))
        case "failure", "stopped", "warning": (Self.amber, Self.coral)
        case "waiting": (Self.amber, Color(neonHex: 0xF59E0B))
        case "live": (Color(neonHex: 0x5CE1FF), Color(neonHex: 0x8B7CFF))
        default: (Color(neonHex: 0x5CE1FF), Self.blue)
        }
        state = ramp.0
        rampEnd = ramp.1
    }
}

/// The Lock Screen surface: near-black glass that rises diagonally into the state colour.
/// Dark holds the first ~60%; the lit corner reaches ~42% of the ramp end. No drawn border:
/// the system rounds and clips the card, and a square stroke would be cut at the corners.
/// Always On dims to plain black.
struct PresentationBackdrop: View {
    static let base = Color(neonHex: 0x05060B)
    let palette: PresentationPalette
    var isLuminanceReduced = false

    var body: some View {
        if isLuminanceReduced {
            Color.black
        } else {
            ZStack {
                Self.base
                LinearGradient(
                    stops: [
                        .init(color: .clear, location: 0),
                        .init(color: .clear, location: 0.58),
                        .init(color: palette.state.opacity(0.20), location: 0.82),
                        .init(color: palette.rampEnd.opacity(0.42), location: 1),
                    ],
                    startPoint: .topLeading, endPoint: .bottomTrailing)
                RadialGradient(
                    colors: [palette.state.opacity(0.10), .clear],
                    center: .topLeading, startRadius: 0, endRadius: 90)
            }
        }
    }
}

struct PresentationSourceLabelStyle: LabelStyle {
    let accent: Color
    func makeBody(configuration: Configuration) -> some View {
        HStack(spacing: 6) {
            configuration.icon.foregroundStyle(accent)
            configuration.title
        }
    }
}

extension Color {
    fileprivate init(neonHex rgb: UInt32) {
        self.init(
            red: Double((rgb >> 16) & 0xff) / 255, green: Double((rgb >> 8) & 0xff) / 255,
            blue: Double(rgb & 0xff) / 255)
    }
}

private func accessibilitySummary(
    for context: ActivityViewContext<ReloActivityAttributes>
) -> LiveActivityAccessibilitySummary {
    let presentation = context.state.presentation
    let projection = LiveActivitySurfaceProjection.make(
        presentation: presentation, surface: .lockScreen,
        interaction: context.state.displayInteraction, isStale: context.isStale,
        owner: context.state.owner, now: .now)
    let source = [presentation.identity.project?.label, presentation.identity.thread?.label]
        .compactMap { $0 }
    return LiveActivityAccessibilitySummary(
        source: source.isEmpty ? presentation.header ?? "Relo" : source.joined(separator: ", "),
        headline: presentation.title,
        status: projection.status, detail: presentation.subtitle, progress: projection.measuredProgress,
        isPrivate: presentation.privacy == .private,
        isInteractive: projection.permitsInlineResponse
    )
}

/// Owner-state chip colors (text always carries the meaning; color only reinforces it).
enum OwnerChipStyle {
    static let needsYouOrange = Color(red: 1.0, green: 0.58, blue: 0.0)
    static let attentionYellow = Color(red: 1.0, green: 0.84, blue: 0.04)
    static let runningCyan = Color(red: 0.2, green: 0.85, blue: 0.95)
    static let doneMint = Color(red: 0.39, green: 0.9, blue: 0.75)
    static let failedRed = Color(red: 1.0, green: 0.27, blue: 0.23)

    static func color(_ chip: OwnerChip) -> Color {
        switch chip {
        case .needsYou, .missed: needsYouOrange
        case .yourTurn: attentionYellow
        case .working: runningCyan.opacity(0.7)
        case .quiet: Color.white.opacity(0.6)
        case .done: doneMint
        case .failed: failedRed
        }
    }
}

/// The header chip: "NEEDS YOU", "MISSED", "YOUR TURN", "WORKING", "QUIET", "DONE", "FAILED".
struct OwnerChipView: View {
    let chip: OwnerChip
    let owner: LiveActivityOwner?

    var body: some View {
        Text(chip.label)
            .font(.caption2.weight(.bold))
            .tracking(0.4)
            .lineLimit(1)
            .fixedSize()
            .foregroundStyle(OwnerChipStyle.color(chip))
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(Capsule().fill(OwnerChipStyle.color(chip).opacity(0.16)))
            .accessibilityLabel(accessibilityText)
    }

    private var accessibilityText: String {
        guard chip == .quiet || chip == .working, let declaredAt = owner?.declaredAt else { return chip.accessibilityLabel }
        let relative = RelativeDateTimeFormatter().localizedString(for: declaredAt, relativeTo: .now)
        return "\(chip.accessibilityLabel), updated \(relative)"
    }
}

/// The header's time slot by owner state: "updated <relative>" for quiet work, "finished <time>"
/// for outcomes, nothing for your turn. Renders server instants; never decides a state.
struct OwnerTimeSlot: View {
    private enum Kind { case updated(Date), finished(Date), none }
    private let kind: Kind

    init?(owner: LiveActivityOwner) {
        switch owner.ownerState {
        case .workingQuietly, .stale, .stoppedResponding, .noSignal: kind = .updated(owner.declaredAt)
        case .done, .failed: kind = .finished(owner.finishedAt ?? owner.declaredAt)
        case .waitingOnYou: kind = .none
        case .needsYou where owner.needsYouReason == .permission: kind = .none
        default: return nil
        }
    }

    var body: some View {
        switch kind {
        case .updated(let date): Text("updated \(date, style: .relative) ago")
        case .finished(let date): Text("finished \(date, style: .time)")
        case .none: EmptyView()
        }
    }
}
