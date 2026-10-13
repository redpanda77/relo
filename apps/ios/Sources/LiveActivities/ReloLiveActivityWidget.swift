import ActivityKit
import AppIntents
import ReloCore
import SwiftUI
import UIKit
import WidgetKit

struct ReloLiveActivityWidget: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: ReloActivityAttributes.self) { context in
            PresentationCardView(
                presentation: context.state.presentation, context: context, surface: .lockScreen
            )
            .activityBackgroundTint(PresentationBackdrop.base)
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
                if presentation.components(for: .compactLeading).isEmpty {
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
                    interaction: context.state.displayInteraction, isStale: context.isStale
                )
            } minimal: {
                PresentationCompactSurface(
                    presentation: presentation, surface: .minimal, palette: palette,
                    interaction: context.state.displayInteraction, isStale: context.isStale
                )
            }
            .keylineTint(
                presentation.privacy == .private ? palette.primaryText.opacity(0.5) : palette.cyan
            )
            .widgetURL(ReloDeepLink.activityURL(identity: context.attributes.identity))
        }
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
        .init(presentation: presentation, surface: surface, hostColorScheme: .dark)
    }
    private var componentSurface: LiveActivityPresentation.Surface {
        surface == .lockScreen ? .lockScreen : .expandedBottom
    }
    private var projection: LiveActivitySurfaceProjection {
        .make(
            presentation: presentation, surface: componentSurface,
            interaction: context.state.displayInteraction, isStale: context.isStale, now: .now)
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
            Spacer(minLength: 0)
            if let deadline = questionDeadline {
                PresentationCountdown(deadline: deadline, palette: palette)
            } else if surface == .expanded {
                PresentationIslandStatusMark(
                    presentation: presentation, palette: palette,
                    interaction: context.state.displayInteraction, isStale: context.isStale)
            }
        }
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
                    .foregroundStyle(palette.cyan)
                Text(projection.status)
            }
            .accessibilityElement(children: .combine)
        case .stages(let completed, let total):
            Text("\(completed) of \(total) stages complete")
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
                case .steps(_, _, let items) = step,
                components.contains(where: { if case .progressBar = $0 { true } else { false } })
            {
                let phase = LiveActivitySurfaceProjection.Phase(items: items)
                Text(phase.label).font(.caption).foregroundStyle(palette.secondaryText)
                    .lineLimit(1)
                    .accessibilityLabel(
                        phase.current.map { "Phase \($0) of \(phase.total), \(phase.label)" } ?? phase.label)
            }
            ForEach(components) { component in
                if case .steps = component,
                    components.contains(where: { if case .progressBar = $0 { true } else { false } })
                {
                    EmptyView()
                } else {
                    PresentationComponentView(
                        presentation: presentation, component: component, palette: palette,
                        accountID: accountID
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var componentColor: Color {
        palette.cyan
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
                PresentationNeonBar(value: value, palette: palette)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: value)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label ?? "Progress")
            .accessibilityValue("\(Int((value * 100).rounded())) percent")
        case .steps(_, _, let items):
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    ForEach(items) { item in
                        stepSegment(item.state)
                    }
                }
                let phase = LiveActivitySurfaceProjection.Phase(items: items)
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(phase.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.primaryText)
                        .lineLimit(1)
                        .allowsTightening(true)
                    Spacer(minLength: 0)
                    if let current = phase.current {
                        Text("\(current) of \(phase.total)")
                            .font(.caption.monospacedDigit())
                            .foregroundStyle(palette.secondaryText)
                    }
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Steps")
            .accessibilityValue(items.map { "\($0.label), \($0.state.rawValue)" }.joined(separator: "; "))
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

    /// Completed work is the cyan to violet ramp, the step in progress is the brightest
    /// segment (static: Live Activities cannot loop animation), pending steps are faint glass.
    @ViewBuilder
    private func stepSegment(_ state: LiveActivityDisplayPresentation.Step.State) -> some View {
        switch state {
        case .complete:
            Capsule().fill(palette.rampGradient).frame(height: 5)
        case .current:
            Capsule()
                .fill(LinearGradient(colors: [palette.violet, palette.magenta], startPoint: .leading, endPoint: .trailing))
                .frame(height: 5)
                .shadow(color: palette.magenta.opacity(0.75), radius: 4)
        case .pending:
            Capsule().fill(Color.white.opacity(0.15)).frame(height: 5)
        }
    }
}

/// A thin determinate bar filled with the neon ramp over faint glass.
struct PresentationNeonBar: View {
    let value: Double
    let palette: PresentationPalette

    var body: some View {
        Capsule().fill(Color.white.opacity(0.15)).frame(height: 5)
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

    private var projection: LiveActivitySurfaceProjection {
        .make(
            presentation: presentation, surface: surface,
            interaction: interaction, isStale: isStale, now: .now)
    }
    private var factColor: Color {
        if presentation.privacy == .private { return palette.primaryText }
        if case .percentage(_, let role) = projection.fact {
            return palette.cyan
        }
        return palette.state
    }

    var body: some View {
        Group {
            if surface == .minimal {
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
        if presentation.privacy == .private { return "Relo private activity. Open Relo to view" }
        let fact: String
        switch projection.fact {
        case .symbol(_, let label): fact = label
        case .percentage(let value, _): fact = "\(Int((value * 100).rounded())) percent"
        case .stages(let completed, let total): fact = "\(completed) of \(total) stages complete"
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
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        switch behavior {
        case .informational, .progress:
            EmptyView()
        case .approval(let primary, let secondary):
            decisionOptions(primary: primary, secondary: secondary, expectedKind: "approval")
        case .yesNo(let primary, let secondary):
            decisionOptions(primary: primary, secondary: secondary, expectedKind: "yes_no")
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

    private func decisionButton(
        label: String, action: String, interaction: ReloActivityAttributes.Interaction, emphasized: Bool
    ) -> some View {
        Button(
            intent: ReloLiveActivityResponseIntent(
                activityID: activityID, activityGeneration: activityGeneration,
                notificationID: interaction.notificationID,
                interactionID: interaction.id, accountID: interaction.accountID,
                deviceID: interaction.targetDeviceID, action: action,
                credential: interaction.credential, expiresAt: interaction.expiresAt
            )
        ) {
            Text(label)
                .font(.caption.weight(.bold))
                .fixedSize(horizontal: false, vertical: true)
                .foregroundStyle(emphasized ? Color.white : palette.primaryText)
                .frame(maxWidth: .infinity, minHeight: 44)
                .background(
                    emphasized
                        ? AnyShapeStyle(LinearGradient(
                            colors: [Color(neonHex: 0x4F5BEA), Color(neonHex: 0x9A45DD)],
                            startPoint: .leading, endPoint: .trailing))
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
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
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

    let accent: Color
    let secondary: Color
    let state: Color
    let primaryText = Color.white
    let secondaryText = Color.white.opacity(0.72)
    let canvas = Color(neonHex: 0x0B0E1A)
    /// Live Activities are always dark glass so the neon reads, even on a light Lock Screen.
    let isLight = false

    var rampGradient: LinearGradient {
        LinearGradient(colors: [cyan, violet], startPoint: .leading, endPoint: .trailing)
    }

    init(
        presentation: LiveActivityPresentation, surface: PresentationCardSurface = .expanded,
        hostColorScheme: ColorScheme = .dark
    ) {
        let project = (ReloReadableColor(hex: presentation.color(for: .project))
            ?? .init(red: 0.37, green: 0.85, blue: 0.72)).readable(onLight: false)
        accent = Color(red: project.red, green: project.green, blue: project.blue)
        secondary = Color(neonHex: 0x8B7CFF)
        state = switch presentation.state.tone {
        case "success": Self.mint
        case "failure", "attention": Self.coral
        case "waiting", "stopped", "warning": Self.amber
        default: Color(neonHex: 0x5CE1FF)
        }
    }
    func identityColor(_ hex: String) -> Color { cyan }
}

/// The Lock Screen surface: deep near-black glass with a faint cyan and violet edge glow.
/// Always On dims to plain black so the glow never burns in.
struct PresentationBackdrop: View {
    static let base = Color(neonHex: 0x0B0E1A)
    let palette: PresentationPalette
    var isLuminanceReduced = false

    var body: some View {
        if isLuminanceReduced {
            Color.black
        } else {
            ZStack {
                Self.base
                RadialGradient(
                    colors: [palette.cyan.opacity(0.10), .clear],
                    center: .topLeading, startRadius: 0, endRadius: 200)
                RadialGradient(
                    colors: [palette.violet.opacity(0.12), .clear],
                    center: .bottomTrailing, startRadius: 0, endRadius: 220)
                Rectangle().strokeBorder(
                    LinearGradient(
                        colors: [palette.cyan.opacity(0.22), palette.violet.opacity(0.10), palette.magenta.opacity(0.18)],
                        startPoint: .topLeading, endPoint: .bottomTrailing),
                    lineWidth: 1)
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
    fileprivate static func presentationHex(_ value: String) -> Color? {
        guard value.range(of: #"^#[0-9A-F]{6}$"#, options: .regularExpression) != nil,
            let rgb = UInt64(value.dropFirst(), radix: 16)
        else { return nil }
        return Color(
            red: Double((rgb >> 16) & 0xff) / 255,
            green: Double((rgb >> 8) & 0xff) / 255,
            blue: Double(rgb & 0xff) / 255
        )
    }
}

private func accessibilitySummary(
    for context: ActivityViewContext<ReloActivityAttributes>
) -> LiveActivityAccessibilitySummary {
    let presentation = context.state.presentation
    let projection = LiveActivitySurfaceProjection.make(
        presentation: presentation, surface: .lockScreen,
        interaction: context.state.displayInteraction, isStale: context.isStale, now: .now)
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
