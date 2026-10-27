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
            let look = IslandLook(context: context)
            return DynamicIsland {
                // The Mac notch's layout: who and how long beside the camera, what it is doing below.
                DynamicIslandExpandedRegion(.leading) {
                    IslandSource(presentation: presentation, look: look)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    IslandStanding(context: context, look: look)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    PresentationCardView(
                        presentation: presentation, context: context, surface: .expanded
                    )
                }
            } compactLeading: {
                // Relo's disc in the state's colour, as on the Mac notch's left wing.
                Group {
                    if look.isPrivate {
                        Image(systemName: "lock.fill").foregroundStyle(.white)
                    } else {
                        IslandDisc(color: look.color, satellites: look.satellites)
                    }
                }
                .accessibilityLabel(accessibilitySummary(for: context).label)
            } compactTrailing: {
                IslandWing(look: look)
            } minimal: {
                if let count = look.needsYouCount {
                    IslandCount(count: count, size: 20)
                } else if look.isPrivate {
                    Image(systemName: "lock.fill").foregroundStyle(.white)
                        .accessibilityLabel("Relo private activity")
                } else {
                    IslandDisc(color: look.color, satellites: look.satellites, size: 20)
                        .accessibilityLabel(look.accessibilityText(title: presentation.title))
                }
            }
            .keylineTint(look.isPrivate ? Color.white.opacity(0.5) : look.color)
            .widgetURL(ReloDeepLink.activityURL(identity: context.attributes.identity))
        }
    }
}

/// A work card's plan on the Lock Screen: the shown steps plus the steps of a longer plan hidden around them.
struct LockScreenPlan: Equatable {
    let steps: [LiveActivityPlanDisplay.Step]
    let window: LiveActivityDisplayPresentation.StepWindow

    /// One segment per top-level step, hidden ones included; the current one filled to the server's fraction.
    var bar: PlanBar { PlanBar.make(steps: steps, before: window.before, after: window.after, progress: window.progress, fill: window.progress?.fill) }

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
            if segments.count <= CardProgressBar<EmptyView>.segmentLimit {
                CardProgressBar(shape: .segments(segments), color: palette.state,
                                track: palette.primaryText.opacity(0.12), currentTrack: palette.primaryText.opacity(0.2))
            } else {
                let whole = segments.reduce(0.0) { $0 + $1.fill }
                PresentationNeonBar(value: whole / Double(segments.count), palette: palette)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(plan.caption)
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
        .init(presentation: presentation, surface: surface, projectSlot: context.state.owner?.projectSlot)
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
        VStack(alignment: .leading, spacing: ReloLayout.cardGap) {
            // In the island the source and the time sit beside the camera (`IslandSource`, `IslandStanding`).
            if presentation.privacy != .private && surface == .lockScreen {
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

    /// The Lock Screen's header: the source on the leading edge, the time on the trailing edge.
    private var header: some View {
        HStack(alignment: .firstTextBaseline, spacing: ReloLayout.inlineGap) {
            PresentationSourceMark(presentation: presentation, palette: palette)
            if let chip = projection.chip {
                OwnerChipView(chip: chip, owner: context.state.owner)
            }
            Spacer(minLength: 0)
            PresentationTimeSlot(context: context, projection: projection, color: palette.secondaryText)
        }
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
                } else if let plan = lockScreenPlan {
                    // Work with a plan reads like its card in Relo: title, status, the plan's segments, one caption.
                    // The island opens on the same card, its title on one line under the camera.
                    if !dynamicTypeSize.isAccessibilitySize {
                        if surface == .lockScreen {
                            workCard(plan, titleLines: 2, statusLines: 2)
                            workCard(plan, titleLines: 2, statusLines: 1)
                        } else {
                            workCard(plan, titleLines: 1, statusLines: 2)
                        }
                        workCard(plan, titleLines: 1, statusLines: 1)
                    }
                    workCard(plan, titleLines: 1, statusLines: 0)
                    compactCard
                        .fixedSize(horizontal: false, vertical: true)
                    conciseFact.font(.caption).foregroundStyle(palette.secondaryText).lineLimit(1)
                } else if surface == .expanded, projection.components.isEmpty, !presentation.status.isEmpty {
                    // No plan yet: what it is doing now is the island's second line.
                    statusCard(statusLines: 2)
                    statusCard(statusLines: 1)
                    compactCard
                        .fixedSize(horizontal: false, vertical: true)
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
        VStack(alignment: .leading, spacing: ReloLayout.cardGap) {
            Text(presentation.title)
                .font(ReloLayout.cardTitle)
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

    /// The card's plan: its steps (with any hidden around the window) and the current step's own count.
    private var lockScreenPlan: LockScreenPlan? { LockScreenPlan.make(projection: projection, presentation: presentation) }

    /// Work without a plan: the title and what it is doing now.
    private func statusCard(statusLines: Int) -> some View {
        VStack(alignment: .leading, spacing: ReloLayout.cardGap) {
            Text(presentation.title)
                .font(ReloLayout.cardTitle)
                .foregroundStyle(palette.primaryText)
                .lineLimit(1)
                .accessibilityAddTraits(.isHeader)
            Text(presentation.status)
                .font(ReloLayout.cardMeta).foregroundStyle(palette.secondaryText)
                .lineLimit(statusLines)
                .fixedSize(horizontal: false, vertical: true)
        }
        .fixedSize(horizontal: false, vertical: true)
    }

    /// Work with a plan, as its card in Relo: title, status, the plan's segments across the card and the plan
    /// line under them. The bar is the app's (`CardProgressBar`).
    private func workCard(_ plan: LockScreenPlan, titleLines: Int, statusLines: Int) -> some View {
        VStack(alignment: .leading, spacing: ReloLayout.cardGap) {
            Text(presentation.title)
                .font(ReloLayout.cardTitle)
                .foregroundStyle(palette.primaryText)
                .lineLimit(titleLines)
                .fixedSize(horizontal: false, vertical: true)
                .accessibilityAddTraits(.isHeader)
            if statusLines > 0 && !presentation.status.isEmpty {
                Text(presentation.status)
                    .font(ReloLayout.cardMeta).foregroundStyle(palette.secondaryText)
                    .lineLimit(statusLines)
                    .fixedSize(horizontal: false, vertical: true)
            }
            // The one progress layout (every card, every surface): the bar across the card, the step line under it.
            PresentationPlanMeter(plan: plan, palette: palette)
                .padding(.top, 2)
            if let parts = plan.parts {
                PresentationPlanLine(parts: parts, color: palette.secondaryText, font: ReloLayout.cardMeta)
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
        VStack(alignment: .leading, spacing: ReloLayout.cardGap) {
            if showsTitle {
                Text(presentation.title)
                    .font(ReloLayout.cardTitle)
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
        VStack(alignment: .leading, spacing: ReloLayout.cardGap) {
            Text(presentation.title)
                .font(ReloLayout.cardTitle)
                .foregroundStyle(palette.primaryText)
                .lineLimit(surface == .lockScreen ? 2 : 1)
            conciseFact.font(.caption).foregroundStyle(palette.secondaryText).lineLimit(1)
        }
    }

    @ViewBuilder private var conciseFact: some View {
        switch projection.fact {
        case .percentage(let value, _):
            HStack(spacing: ReloLayout.cardGap) {
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
                // Progress belongs to the current step: "Step N of M · <step>" (2.15).
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
                .lineLimit(1)
                .minimumScaleFactor(0.7)
                .frame(maxWidth: 64, alignment: .trailing)
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

extension LockScreenPlan {
    /// A card's plan from its steps component (with any steps hidden around the window) and the current step's
    /// own count; nil without steps.
    static func make(projection: LiveActivitySurfaceProjection, presentation: LiveActivityPresentation) -> LockScreenPlan? {
        guard let step = projection.components.first(where: { if case .steps = $0 { true } else { false } }),
              case .steps(_, _, let items, let window) = step else { return nil }
        let count = projection.components.lazy.compactMap { component -> (Int, Int)? in
            if case .progressBar(_, _, _, let label) = component { LiveActivitySurfaceProjection.stepCount(label) } else { nil }
        }.first
        return LockScreenPlan(steps: LiveActivityPlanDisplay.steps(items, count: count), window: window,
                              standing: presentation.planStanding)
    }
}

/// The card's time: when an outcome landed or the work was last updated, the time left to answer, or how long
/// it has run. The system ticks the timers; nothing in the widget redraws them.
struct PresentationTimeSlot: View {
    let context: ActivityViewContext<ReloActivityAttributes>
    let projection: LiveActivitySurfaceProjection
    let color: Color

    private var presentation: LiveActivityPresentation { context.state.presentation }

    var body: some View {
        if let owner = context.state.owner, let timeSlot = OwnerTimeSlot(owner: owner) {
            timeSlot.font(.caption.monospacedDigit()).foregroundStyle(color)
                .lineLimit(1)
        } else if let deadline = questionDeadline {
            PresentationCountdown(deadline: deadline, palette: PresentationPalette(presentation: presentation))
        } else if let startedAt = elapsedStart {
            Text(timerInterval: startedAt...Date.distantFuture, countsDown: false)
                .font(.caption.monospacedDigit()).foregroundStyle(color)
                .multilineTextAlignment(.trailing)
                .frame(maxWidth: 72, alignment: .trailing)
                .accessibilityLabel("Running for")
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
}

// MARK: The island, as the Mac notch draws it

/// How the island reads a card: the state's colour and word (the app's one table, from the server's owner state),
/// the plan's segments, and the chip for a moment that asks for the owner. Display only: it decides nothing.
struct IslandLook {
    let style: ReloStateStyle
    let isPrivate: Bool
    let plan: LockScreenPlan?
    /// A sender's measured progress, for a card without a plan.
    let fraction: Double?
    /// The right wing's chip for a moment that asks for the owner: Answer, Missed, Your turn.
    let chip: String?
    /// The account's needs-you count, when any card needs the owner.
    let needsYouCount: Int?
    /// One satellite per live item across the account (the Mac notch's orbit), at least this card's own.
    let satellites: Int
    /// Live items besides this card: the right wing's +N.
    let more: Int

    var color: Color { isPrivate ? .white : style.color }
    /// The word beside the camera: the chip's, else the state's.
    var word: String { chip ?? style.label }

    init(context: ActivityViewContext<ReloActivityAttributes>) {
        let presentation = context.state.presentation
        let owner = context.state.owner
        let projection = LiveActivitySurfaceProjection.make(
            presentation: presentation, surface: .lockScreen,
            interaction: context.state.displayInteraction, isStale: context.isStale, owner: owner, now: .now)
        isPrivate = presentation.privacy == .private
        style = Self.style(presentation: presentation, projection: projection, owner: owner, isStale: context.isStale)
        plan = isPrivate ? nil : LockScreenPlan.make(projection: projection, presentation: presentation)
        fraction = isPrivate ? nil : projection.measuredProgress
        chip = if style == .missed { "Missed" }
            else if style == .needsYou || style == .permission { "Answer" }
            else if style == .yourTurn { "Your turn" }
            else { nil }
        needsYouCount = owner.flatMap { $0.needsYouCount > 0 ? $0.needsYouCount : nil }
        let live = owner?.live ?? 0
        satellites = min(max(live, 1), Self.maxSatellites)
        more = max(0, live - 1)
    }

    static let maxSatellites = 6

    /// The server's owner state when the card carries it; else what the card itself says.
    private static func style(
        presentation: LiveActivityPresentation, projection: LiveActivitySurfaceProjection,
        owner: LiveActivityOwner?, isStale: Bool
    ) -> ReloStateStyle {
        if owner?.isMissedQuestion == true { return .missed }
        if owner?.isPermission == true { return .permission }
        if let style = ReloStateStyle.make(state: owner?.ownerState, standing: nil) { return style }
        switch presentation.state.kind {
        case "completed": return .done
        case "failed": return .failed
        case "cancelled", "canceled", "expired", "superseded": return .ended
        case "needs_action": return .needsYou
        default: return projection.isDecision ? .needsYou : isStale ? .quiet : .running
        }
    }

    func accessibilityText(title: String) -> String {
        isPrivate ? "Relo private activity, \(word)" : "\(title), \(word)"
    }
}

/// Relo's disc, the Mac notch's left wing: an orbit, a core and one satellite per live item, spread evenly from the
/// top right, in the state's colour. Static: the island moves only when an update lands.
struct IslandDisc: View {
    let color: Color
    var satellites = 1
    var size: CGFloat = 22

    var body: some View {
        let dot = size * (satellites > 3 ? 0.19 : 0.23)
        let radius = size / 2 - 0.7
        ZStack {
            Circle().strokeBorder(color.opacity(0.5), lineWidth: 1.4)
            Circle().fill(color).padding(size * 0.27)
            ForEach(0..<max(satellites, 1), id: \.self) { index in
                let angle = (-45 + Double(index) * 360 / Double(max(satellites, 1))) * .pi / 180
                Circle().fill(color)
                    .frame(width: dot, height: dot)
                    .overlay { Circle().stroke(Color.black, lineWidth: 1.4) }
                    .offset(x: radius * cos(angle), y: radius * sin(angle))
            }
        }
        .frame(width: size, height: size)
    }
}

/// The right wing: a chip when the moment asks for the owner, else one segment per step (done filled, the
/// current one bright), else a sender's measured progress. Before it, the count of cards that need the owner.
/// When another app's activity shares the island the wing gets less room: it drops the "+N", then the chip's
/// word for its glyph, and never draws outside its own space (under the disc).
struct IslandWing: View {
    let look: IslandLook

    var body: some View {
        ViewThatFits(in: .horizontal) {
            wing(more: true, word: true)
            wing(more: false, word: true)
            wing(more: false, word: false)
        }
        .clipped()
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibilityText)
    }

    private func wing(more: Bool, word: Bool) -> some View {
        HStack(spacing: 4) {
            if look.chip == nil, let count = look.needsYouCount {
                IslandCount(count: count, size: 16)
            }
            if let chip = look.chip {
                Group {
                    if word {
                        Text(chip).font(.caption2.weight(.semibold)).lineLimit(1).fixedSize()
                            .padding(.horizontal, 7)
                    } else {
                        Image(systemName: glyph).font(.system(size: 10, weight: .bold)).frame(width: 20)
                    }
                }
                .foregroundStyle(look.color)
                .frame(height: 20)
                .background { Capsule().fill(look.color.opacity(0.2)) }
            } else if let segments = look.plan?.bar.segments, !segments.isEmpty {
                IslandSegments(segments: segments, color: look.color, failed: look.style == .failed)
            } else if let fraction = look.fraction {
                IslandBar(value: fraction, color: look.color)
            }
            if more, look.more > 0 {
                Text("+\(look.more)")
                    .font(.caption2.weight(.bold).monospacedDigit())
                    .foregroundStyle(Color.white.opacity(0.6))
                    .fixedSize()
            }
        }
        .fixedSize()
    }

    /// The chip's word as a glyph, for a wing too narrow for the word.
    private var glyph: String {
        switch look.chip {
        case "Missed": "exclamationmark"
        case "Your turn": "arrow.turn.down.left"
        default: "questionmark"
        }
    }

    private var accessibilityText: String {
        var standing = look.chip ?? look.plan?.caption ?? look.style.label
        if look.more > 0 { standing += ", \(look.more) more live" }
        guard look.chip == nil, let count = look.needsYouCount else { return standing }
        return "\(count) need you, \(standing)"
    }
}

/// The plan in the right wing: a small segment per step; a long plan becomes one bar.
struct IslandSegments: View {
    let segments: [PlanBar.Segment]
    let color: Color
    let failed: Bool

    private var width: CGFloat { segments.count <= 4 ? 7 : segments.count <= 6 ? 5 : 3 }

    var body: some View {
        if segments.count > 10 {
            IslandBar(value: segments.reduce(0.0) { $0 + $1.fill } / Double(segments.count), color: color)
        } else {
            HStack(spacing: 2.5) {
                ForEach(Array(segments.enumerated()), id: \.offset) { _, segment in
                    piece(segment.state).frame(width: width, height: 5)
                }
            }
        }
    }

    /// A failed plan dims what was done and lights the step it stopped on.
    @ViewBuilder private func piece(_ state: LiveActivityPlanDisplay.StepState) -> some View {
        let shape = RoundedRectangle(cornerRadius: 2)
        switch state {
        case .done: shape.fill(failed ? color.opacity(0.45) : color)
        case .current: shape.fill(color).overlay { shape.fill(Color.white.opacity(failed ? 0 : 0.5)) }
        case .open, .skipped: shape.fill(Color.white.opacity(0.18))
        }
    }
}

struct IslandBar: View {
    let value: Double
    let color: Color

    var body: some View {
        Capsule().fill(Color.white.opacity(0.18))
            .frame(width: 28, height: 5)
            .overlay(alignment: .leading) {
                Capsule().fill(color).frame(width: 28 * min(max(value, 0), 1))
            }
    }
}

/// The account's needs-you count: "1"…"9", "9+".
struct IslandCount: View {
    let count: Int
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle().fill(ReloStateStyle.needsYou.color)
            Text(count > 9 ? "9+" : "\(count)")
                .font(.system(size: size * 0.55, weight: .bold).monospacedDigit())
                .foregroundStyle(.black)
                .minimumScaleFactor(0.6)
        }
        .frame(width: size, height: size)
        .accessibilityLabel("\(count) need you")
    }
}

/// The open island's left of the camera: Relo's disc, the project and the session.
struct IslandSource: View {
    let presentation: LiveActivityPresentation
    let look: IslandLook

    var body: some View {
        HStack(spacing: 7) {
            if look.isPrivate {
                Image(systemName: "lock.fill").font(.caption).foregroundStyle(.white)
            } else {
                IslandDisc(color: look.color, satellites: look.satellites, size: 20)
            }
            VStack(alignment: .leading, spacing: 1) {
                Text(look.isPrivate ? "Relo" : presentation.identity.project?.label ?? presentation.header ?? "Relo")
                    .font(.caption.weight(.semibold)).foregroundStyle(.white)
                if !look.isPrivate, let thread = presentation.identity.thread?.label {
                    Text(thread).font(.caption2).foregroundStyle(Color.white.opacity(0.6))
                }
            }
            .lineLimit(1)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The open island's right of the camera: the state's word over its time.
struct IslandStanding: View {
    let context: ActivityViewContext<ReloActivityAttributes>
    let look: IslandLook

    var body: some View {
        VStack(alignment: .trailing, spacing: 1) {
            Text(look.word).font(.caption.weight(.semibold)).foregroundStyle(look.color)
                .lineLimit(1)
            PresentationTimeSlot(
                context: context,
                projection: .make(
                    presentation: context.state.presentation, surface: .expandedBottom,
                    interaction: context.state.displayInteraction, isStale: context.isStale,
                    owner: context.state.owner, now: .now),
                color: Color.white.opacity(0.72))
        }
        // The region's top edge sits on the island's curve: keep ascenders clear of it.
        .padding(.top, 3)
        .accessibilityElement(children: .combine)
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
        presentation: LiveActivityPresentation, surface: PresentationCardSurface = .expanded, projectSlot: Int? = nil
    ) {
        // The project's slot (every app's colour for it) wins over the presentation's own accent.
        let project = (ReloReadableColor(hex: presentation.color(for: .project))
            ?? .init(red: 0.37, green: 0.85, blue: 0.72)).readable(onLight: false)
        accent = projectSlot.flatMap { ReloProjectPalette.color(slot: $0, name: nil) }
            ?? Color(red: project.red, green: project.green, blue: project.blue)
        secondary = Color(neonHex: 0x8B7CFF)
        // Tone picks the ramp: running cyan>violet, done mint>teal, needs-you coral>magenta,
        // failed red>coral, stopped amber>coral, waiting amber>amber, neutral cyan>blue (red failed, as in the app).
        let ramp: (Color, Color) = switch presentation.state.tone {
        case "success": (Self.mint, Self.teal)
        case "attention": (Self.coral, Color(neonHex: 0xD65CF0))
        case "failure": (Color(neonHex: 0xF87171), Self.coral)
        case "stopped", "warning": (Self.amber, Self.coral)
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
        case .workingQuietly, .stale, .stoppedResponding, .noSignal:
            guard let declaredAt = owner.declaredAt else { return nil }
            kind = .updated(declaredAt)
        case .done, .failed:
            guard let finishedAt = owner.finishedAt ?? owner.declaredAt else { return nil }
            kind = .finished(finishedAt)
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
