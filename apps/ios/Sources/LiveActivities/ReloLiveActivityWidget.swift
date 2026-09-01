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
                .activityBackgroundTint(.black)
                .activitySystemActionForegroundColor(.white)
                .widgetURL(ReloDeepLink.activityURL(identity: context.attributes.identity))
                .accessibilityElement(children: .contain)
                .accessibilityLabel(accessibilitySummary(for: context).label)
                .accessibilityValue(accessibilitySummary(for: context).value)
                .accessibilityHint(accessibilitySummary(for: context).hint)
        } dynamicIsland: { context in
            let presentation = context.state.presentation
            let palette = PresentationPalette(presentation: presentation)
            return DynamicIsland {
                DynamicIslandExpandedRegion(.leading, priority: 1) {
                    PresentationSourceMark(presentation: presentation, palette: palette)
                }
                DynamicIslandExpandedRegion(.trailing) {
                    PresentationIslandStatusMark(presentation: presentation, palette: palette)
                    .dynamicIsland(verticalPlacement: .belowIfTooWide)
                }
                DynamicIslandExpandedRegion(.bottom) {
                    PresentationCardView(
                        presentation: presentation, context: context, surface: .expanded
                    )
                }
            } compactLeading: {
                Image(systemName: presentation.identity.project?.icon.systemImageName
                    ?? presentation.state.icon.systemImageName)
                    .foregroundStyle(palette.accent)
                    .accessibilityLabel(accessibilitySummary(for: context).label)
            } compactTrailing: {
                PresentationCompactSurface(
                    presentation: presentation, surface: .compactTrailing, palette: palette
                )
                    .accessibilityLabel(accessibilitySummary(for: context).value)
            } minimal: {
                PresentationCompactSurface(
                    presentation: presentation, surface: .minimal, palette: palette
                )
                    .accessibilityLabel(accessibilitySummary(for: context).label)
            }
            .keylineTint(palette.accent)
            .contentMargins(.horizontal, 14, for: .expanded)
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

    private var palette: PresentationPalette { .init(presentation: presentation) }
    private var componentSurface: LiveActivityPresentation.Surface {
        surface == .lockScreen ? .lockScreen : .expandedBottom
    }
    private var lockScreenComponents: [LiveActivityPresentation.Component] {
        presentation.components(for: .lockScreen)
    }
    private var lockScreenStepItems: [LiveActivityDisplayPresentation.Step]? {
        for component in lockScreenComponents {
            if case let .steps(_, _, items) = component { return items }
        }
        return nil
    }
    private var lockScreenHasMeasuredProgress: Bool {
        lockScreenComponents.contains { component in
            if case .progressBar = component { return true }
            return false
        }
    }
    private var lockScreenUsesCombinedProgress: Bool {
        lockScreenStepItems != nil && lockScreenHasMeasuredProgress
    }

    var body: some View {
        Group {
            if surface == .lockScreen {
                ZStack {
                    PresentationBackdrop(palette: palette)
                    lockScreenContent.padding(.horizontal, 14).padding(.vertical, 10)
                }
                .frame(maxWidth: .infinity)
            } else {
                content.padding(.top, 4).frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .modifier(PresentationThemeModifier(theme: presentation.appearance.theme))
    }

    private var lockScreenContent: some View {
        ViewThatFits(in: .vertical) {
            lockScreenLayout(
                spacing: 7, titleFont: .headline, detailFont: .caption,
                componentCompact: false
            )
            lockScreenLayout(
                spacing: 4, titleFont: .subheadline.weight(.semibold), detailFont: .caption2,
                componentCompact: true
            )
            lockScreenLayout(
                spacing: 2, titleFont: .caption.weight(.semibold), detailFont: .caption2,
                componentCompact: true
            )
        }
    }

    private func lockScreenLayout(
        spacing: CGFloat, titleFont: Font, detailFont: Font, componentCompact: Bool
    ) -> some View {
        VStack(alignment: .leading, spacing: spacing) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 8) {
                    PresentationSourceMark(
                        presentation: presentation, palette: palette, lineLimit: 1
                    )
                    .frame(maxWidth: .infinity, alignment: .leading)
                    if let stepItems = lockScreenStepItems {
                        PresentationPhaseMark(items: stepItems, palette: palette)
                    } else {
                        PresentationStatusMark(
                            presentation: presentation, palette: palette, lineLimit: 1
                        )
                        .multilineTextAlignment(.trailing)
                    }
                }
                VStack(alignment: .leading, spacing: 1) {
                    PresentationSourceMark(
                        presentation: presentation, palette: palette, lineLimit: 1
                    )
                    if let stepItems = lockScreenStepItems {
                        PresentationPhaseMark(items: stepItems, palette: palette)
                    } else {
                        PresentationStatusMark(
                            presentation: presentation, palette: palette, lineLimit: 1
                        )
                    }
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(presentation.title)
                    .font(titleFont)
                    .foregroundStyle(palette.primaryText)
                    .lineLimit(2)
                    .minimumScaleFactor(0.68)
                    .allowsTightening(true)
                    .layoutPriority(3)
                if lockScreenUsesCombinedProgress {
                    PresentationStatusMark(
                        presentation: presentation, palette: palette, lineLimit: 1
                    )
                }
            }
            PresentationComponentStack(
                presentation: presentation, surface: .lockScreen, palette: palette,
                accountID: context.attributes.accountID, compact: componentCompact
            )
            if let subtitle = presentation.subtitle {
                Text(subtitle)
                    .font(detailFont)
                    .foregroundStyle(palette.secondaryText)
                    .lineLimit(2)
                    .minimumScaleFactor(0.68)
                    .allowsTightening(true)
                    .layoutPriority(2)
            }
            PresentationBehaviorModule(
                activityID: context.attributes.eventID,
                activityGeneration: context.attributes.generation,
                behavior: presentation.behavior,
                interaction: context.state.displayInteraction,
                fallbackStatus: context.state.displayStatus,
                palette: palette
            )
        }
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 7) {
            if surface == .lockScreen {
                HStack(spacing: 8) {
                    PresentationSourceMark(presentation: presentation, palette: palette)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    PresentationStatusMark(presentation: presentation, palette: palette)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(presentation.title)
                    .font(surface == .lockScreen ? .headline : .subheadline.weight(.semibold))
                    .foregroundStyle(palette.primaryText)
                    .lineLimit(2)
                if let subtitle = presentation.subtitle {
                    Text(subtitle).font(.caption).foregroundStyle(palette.secondaryText)
                        .lineLimit(1)
                }
                if surface == .expanded && !hasStepComponent(on: componentSurface) {
                    Text(presentation.status)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(palette.state)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            PresentationComponentStack(
                presentation: presentation, surface: componentSurface, palette: palette,
                accountID: context.attributes.accountID, compact: true
            )
            PresentationBehaviorModule(
                activityID: context.attributes.eventID,
                activityGeneration: context.attributes.generation,
                behavior: presentation.behavior,
                interaction: context.state.displayInteraction,
                fallbackStatus: context.state.displayStatus,
                palette: palette
            )
        }
    }

    private func hasStepComponent(on surface: LiveActivityPresentation.Surface) -> Bool {
        presentation.components(for: surface).contains { component in
            if case .steps = component { return true }
            return false
        }
    }
}

private struct PresentationStepProgressPair {
    let stepID: String
    let stepRole: LiveActivityPresentation.IdentityRole
    let items: [LiveActivityDisplayPresentation.Step]
    let progressID: String
    let progressRole: LiveActivityPresentation.IdentityRole
    let value: Double
    let label: String?
}

struct PresentationComponentStack: View {
    let presentation: LiveActivityPresentation
    let surface: LiveActivityPresentation.Surface
    let palette: PresentationPalette
    let accountID: String?
    let compact: Bool

    private var components: [LiveActivityPresentation.Component] {
        presentation.components(for: surface)
    }

    private var pairedStepProgress: PresentationStepProgressPair? {
        var step: (id: String, role: LiveActivityPresentation.IdentityRole,
                   items: [LiveActivityDisplayPresentation.Step])?
        var progress: (id: String, role: LiveActivityPresentation.IdentityRole,
                       value: Double, label: String?)?
        for component in components {
            switch component {
            case let .steps(id, role, items): step = (id, role, items)
            case let .progressBar(id, role, value, label): progress = (id, role, value, label)
            case .image: continue
            }
        }
        guard let step, let progress else { return nil }
        return PresentationStepProgressPair(
            stepID: step.id, stepRole: step.role, items: step.items,
            progressID: progress.id, progressRole: progress.role,
            value: progress.value, label: progress.label
        )
    }

    private var standaloneComponents: [LiveActivityPresentation.Component] {
        guard let pair = pairedStepProgress else { return components }
        return components.filter { $0.id != pair.stepID && $0.id != pair.progressID }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 5) {
            if let pair = pairedStepProgress {
                PresentationStepProgressView(
                    presentation: presentation, pair: pair, palette: palette,
                    compact: compact
                )
            }
            ForEach(standaloneComponents) { component in
                PresentationComponentView(
                    presentation: presentation, component: component, palette: palette,
                    accountID: accountID, compact: compact
                )
            }
        }
    }
}

private struct PresentationStepProgressView: View {
    let presentation: LiveActivityPresentation
    let pair: PresentationStepProgressPair
    let palette: PresentationPalette
    let compact: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var stepColor: Color {
        Color.presentationHex(presentation.color(for: pair.stepRole)) ?? palette.secondary
    }
    private var progressColor: Color {
        Color.presentationHex(presentation.color(for: pair.progressRole)) ?? palette.accent
    }
    private var currentPhase: Int {
        if let index = pair.items.firstIndex(where: { $0.state == .current }) { return index + 1 }
        return pair.items.filter { $0.state == .complete }.count
    }
    private var phaseLabel: String {
        pair.label ?? "Phase \(currentPhase) of \(pair.items.count)"
    }
    private var percentageText: some View {
        Text(pair.value, format: .percent.precision(.fractionLength(0)))
            .font(.caption2.weight(.semibold).monospacedDigit())
            .foregroundStyle(progressColor)
    }
    private var segmentTrack: some View {
        HStack(spacing: 5) {
            ForEach(pair.items) { item in
                Capsule()
                    .fill(segmentColor(item.state))
                    .frame(height: compact ? 4 : 5)
            }
        }
        .frame(maxWidth: .infinity)
        .layoutPriority(1)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: compact ? 3 : 4) {
            if let label = pair.label {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(label)
                        .font(.caption2.weight(.medium))
                        .foregroundStyle(palette.secondaryText)
                        .lineLimit(1)
                        .minimumScaleFactor(0.72)
                        .allowsTightening(true)
                    Spacer(minLength: 0)
                    percentageText
                }
                segmentTrack
            } else {
                HStack(spacing: 8) {
                    segmentTrack
                    percentageText
                }
            }
            ProgressView(value: pair.value)
                .controlSize(.mini)
                .tint(progressColor)
                .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: pair.value)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(phaseLabel)
        .accessibilityValue("\(Int((pair.value * 100).rounded())) percent")
    }

    private func segmentColor(_ state: LiveActivityDisplayPresentation.Step.State) -> Color {
        switch state {
        case .complete: stepColor
        case .current: palette.secondary
        case .pending: palette.primaryText.opacity(0.16)
        }
    }
}

struct PresentationComponentView: View {
    let presentation: LiveActivityPresentation
    let component: LiveActivityPresentation.Component
    let palette: PresentationPalette
    let accountID: String?
    let compact: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private var componentColor: Color {
        Color.presentationHex(presentation.color(for: component.colorRole)) ?? palette.accent
    }

    var body: some View {
        switch component {
        case let .progressBar(_, _, value, label):
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if let label {
                        Text(label)
                            .font(.caption2)
                            .foregroundStyle(palette.secondaryText)
                            .lineLimit(1)
                            .minimumScaleFactor(0.68)
                            .allowsTightening(true)
                    }
                    Spacer(minLength: 0)
                    Text(value, format: .percent.precision(.fractionLength(0)))
                        .font(.caption2.weight(.semibold).monospacedDigit())
                        .foregroundStyle(componentColor)
                }
                ProgressView(value: value).tint(componentColor)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.24), value: value)
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label ?? "Progress")
            .accessibilityValue("\(Int((value * 100).rounded())) percent")
        case let .steps(_, _, items):
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 5) {
                    ForEach(items) { item in
                        Capsule().fill(stepColor(item.state, color: componentColor))
                            .frame(height: 5)
                    }
                }
                if let current = items.first(where: { $0.state == .current }) {
                    Label(current.label, systemImage: "circle.inset.filled")
                        .font((compact ? Font.caption2 : .caption).weight(.semibold))
                        .foregroundStyle(palette.primaryText)
                        .lineLimit(1)
                        .minimumScaleFactor(0.68)
                        .allowsTightening(true)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Steps")
            .accessibilityValue(items.map { "\($0.label), \($0.state.rawValue)" }.joined(separator: "; "))
        case let .image(_, _, asset):
            if let image = ImmutablePresentationAssetCache.image(for: asset, accountID: accountID) {
                Image(uiImage: image).resizable()
                    .aspectRatio(contentMode: asset.contentMode == .fill ? .fill : .fit)
                    .frame(maxWidth: .infinity, maxHeight: compact ? 36 : 56)
                    .clipShape(RoundedRectangle(cornerRadius: 10, style: .continuous))
                    .accessibilityLabel(asset.altText)
            } else {
                Label("Image available in Relo", systemImage: "photo.badge.exclamationmark")
                    .font(.caption).foregroundStyle(palette.secondaryText)
                    .accessibilityLabel(asset.altText)
            }
        }
    }

    private func stepColor(_ state: LiveActivityDisplayPresentation.Step.State, color: Color) -> Color {
        switch state {
        case .complete: color
        case .current: palette.secondary
        case .pending: palette.primaryText.opacity(0.16)
        }
    }
}

struct PresentationSourceMark: View {
    let presentation: LiveActivityPresentation
    let palette: PresentationPalette
    var lineLimit: Int? = 1

    private var identityText: String {
        let labels = [presentation.identity.project?.label, presentation.identity.thread?.label]
            .compactMap { $0 }
        return labels.isEmpty ? (presentation.header ?? "Relo") : labels.joined(separator: " · ")
    }

    private var identityIcon: String {
        presentation.identity.project?.icon.systemImageName
            ?? presentation.identity.thread?.icon.systemImageName
            ?? presentation.state.icon.systemImageName
    }

    var body: some View {
        Label(identityText, systemImage: identityIcon)
            .font(.caption.weight(.semibold))
            .foregroundStyle(palette.primaryText)
            .lineLimit(lineLimit)
            .minimumScaleFactor(0.68)
            .allowsTightening(true)
            .labelStyle(PresentationSourceLabelStyle(accent: palette.accent))
    }
}

struct PresentationStatusMark: View {
    let presentation: LiveActivityPresentation
    let palette: PresentationPalette
    var lineLimit: Int? = 1
    var body: some View {
        Text(presentation.status)
            .font(.caption.weight(.semibold))
            .lineLimit(lineLimit)
            .minimumScaleFactor(0.68)
            .allowsTightening(true)
            .foregroundStyle(palette.state)
    }
}

private struct PresentationPhaseMark: View {
    let items: [LiveActivityDisplayPresentation.Step]
    let palette: PresentationPalette

    private var currentPhase: Int {
        if let index = items.firstIndex(where: { $0.state == .current }) { return index + 1 }
        return items.filter { $0.state == .complete }.count
    }

    var body: some View {
        Text("Phase \(currentPhase)/\(items.count)")
            .font(.caption2.weight(.semibold).monospacedDigit())
            .foregroundStyle(palette.secondaryText)
            .lineLimit(1)
            .fixedSize(horizontal: true, vertical: false)
            .accessibilityLabel("Phase \(currentPhase) of \(items.count)")
    }
}

struct PresentationIslandStatusMark: View {
    let presentation: LiveActivityPresentation
    let palette: PresentationPalette
    private var compactText: String {
        for component in presentation.components(for: .expandedBottom) {
            if case let .steps(_, _, items) = component {
                let completed = items.filter { $0.state == .complete }.count
                let current = min(items.count, completed + (completed < items.count ? 1 : 0))
                return "Phase \(current)/\(items.count)"
            }
            if case let .progressBar(_, _, value, _) = component {
                return "\(Int((value * 100).rounded()))%"
            }
        }
        return String(presentation.status.prefix(12))
    }
    var body: some View {
        Text(compactText)
            .font(.caption.weight(.semibold)).monospacedDigit()
            .lineLimit(1).minimumScaleFactor(0.8).truncationMode(.tail)
            .foregroundStyle(palette.state)
            .accessibilityLabel(presentation.status)
    }
}

struct PresentationCompactSurface: View {
    let presentation: LiveActivityPresentation
    let surface: LiveActivityPresentation.Surface
    let palette: PresentationPalette
    var body: some View {
        if let component = presentation.components(for: surface).first {
            switch component {
            case let .progressBar(_, role, value, _):
                Text(value, format: .percent.precision(.fractionLength(0)))
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Color.presentationHex(presentation.color(for: role)) ?? palette.accent)
            case let .steps(_, role, items):
                Text("\(items.filter { $0.state == .complete }.count)/\(items.count)")
                    .font(.caption2.monospacedDigit())
                    .foregroundStyle(Color.presentationHex(presentation.color(for: role)) ?? palette.accent)
            case .image:
                Image(systemName: "photo.fill").foregroundStyle(palette.accent)
            }
        } else {
            Image(systemName: presentation.state.icon.systemImageName).foregroundStyle(palette.state)
        }
    }
}

struct PresentationThemeModifier: ViewModifier {
    let theme: LiveActivityDisplayPresentation.Theme
    @ViewBuilder func body(content: Content) -> some View {
        switch theme {
        case .system: content
        case .light: content.environment(\.colorScheme, .light)
        case .dark: content.environment(\.colorScheme, .dark)
        }
    }
}

struct PresentationBehaviorModule: View {
    let activityID: String
    let activityGeneration: Int
    let behavior: LiveActivityDisplayPresentation.Behavior
    let interaction: ReloActivityAttributes.Interaction?
    let fallbackStatus: String
    let palette: PresentationPalette

    var body: some View {
        switch behavior {
        case .informational, .progress:
            EmptyView()
        case let .approval(primary, secondary):
            decisionOptions(primary: primary, secondary: secondary, expectedKind: "approval")
        case let .yesNo(primary, secondary):
            decisionOptions(primary: primary, secondary: secondary, expectedKind: "yes_no")
        case .unsupportedTextReply:
            feedback(label: "Reply in the Relo app", symbol: "arrow.up.forward.app.fill")
                .accessibilityHint("Inline text entry is not supported in Live Activities")
        }
    }

    @ViewBuilder
    private func decisionOptions(primary: String, secondary: String, expectedKind: String) -> some View {
        if let interaction, interaction.kind == expectedKind {
            let response = LiveActivityResponseWidgetPresentation.make(
                interaction: interaction, primary: primary, secondary: secondary,
                fallbackStatus: fallbackStatus, now: .now
            )
            switch response.mode {
            case .actions:
                HStack(spacing: 8) {
                    decisionButton(label: primary, action: expectedKind == "yes_no" ? "yes" : "approve", interaction: interaction, emphasized: true)
                    decisionButton(label: secondary, action: expectedKind == "yes_no" ? "no" : "deny", interaction: interaction, emphasized: false)
                }
                .invalidatableContent()
            case .openTextReply, .sending, .queued, .rejected, .accepted, .terminal:
                feedback(label: response.label ?? "Response unavailable", symbol: response.symbol, showsProgress: response.showsProgress)
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
        Button(intent: ReloLiveActivityResponseIntent(
            activityID: activityID, activityGeneration: activityGeneration,
            notificationID: interaction.notificationID,
            interactionID: interaction.id, accountID: interaction.accountID,
            deviceID: interaction.targetDeviceID, action: action,
            credential: interaction.credential, expiresAt: interaction.expiresAt
        )) {
            Text(label)
                .font(.caption.weight(.bold))
                .foregroundStyle(emphasized ? Color(red: 0.03, green: 0.16, blue: 0.13) : palette.primaryText.opacity(0.78))
                .frame(maxWidth: .infinity)
                .padding(.vertical, 6)
                .background(emphasized ? palette.accent : Color.white.opacity(0.11), in: Capsule())
        }
        .buttonStyle(LiveActivityDecisionButtonStyle())
        .accessibilityLabel(label)
        .accessibilityHint("Sends this response to Relo")
    }

    private func feedback(label: String, symbol: String?, showsProgress: Bool = false) -> some View {
        HStack(spacing: 7) {
            if showsProgress { ProgressView().controlSize(.small) }
            else if let symbol { Image(systemName: symbol).contentTransition(.symbolEffect(.replace)) }
            Text(label)
                .lineLimit(1)
                .minimumScaleFactor(0.68)
                .allowsTightening(true)
        }
        .font(.caption.weight(.bold))
        .foregroundStyle(palette.primaryText)
        .frame(maxWidth: .infinity)
        .padding(.vertical, 6)
        .background(Color.white.opacity(0.11), in: Capsule())
        .transition(.opacity.combined(with: .scale(scale: 0.96)))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(label)
    }
}

struct LiveActivityDecisionButtonStyle: ButtonStyle {
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed ? 0.94 : 1)
            .opacity(configuration.isPressed ? 0.38 : 1)
            .overlay {
                if configuration.isPressed {
                    ProgressView().controlSize(.mini).tint(.white).transition(.opacity)
                }
            }
            .animation(.easeOut(duration: 0.12), value: configuration.isPressed)
    }
}

struct PresentationPalette: Sendable {
    let accent: Color
    let secondary: Color
    let state: Color
    let primaryText: Color
    let secondaryText: Color

    init(presentation: LiveActivityPresentation) {
        accent = Color.presentationHex(
            presentation.color(for: presentation.appearance.roles.cardIdentity)
        ) ?? .mint
        secondary = Color.presentationHex(
            presentation.color(for: presentation.appearance.roles.componentIdentity)
        ) ?? accent.opacity(0.58)
        state = Color.presentationHex(
            presentation.color(for: presentation.appearance.roles.statusEmphasis)
        ) ?? accent
        primaryText = presentation.appearance.theme == .light ? .black : .white
        secondaryText = primaryText.opacity(0.68)
    }
}

struct PresentationBackdrop: View {
    let palette: PresentationPalette

    var body: some View {
        ZStack {
            Color.black
            LinearGradient(
                colors: [palette.accent.opacity(0.34), palette.secondary.opacity(0.18), .black.opacity(0.94)],
                startPoint: .topLeading, endPoint: .bottomTrailing
            )
            RadialGradient(
                colors: [palette.secondary.opacity(0.28), .clear], center: .bottomTrailing,
                startRadius: 0, endRadius: 190
            )
        }
        .overlay {
            ContainerRelativeShape()
                .stroke(LinearGradient(
                    colors: [palette.accent.opacity(0.72), palette.secondary.opacity(0.18), .clear],
                    startPoint: .topLeading, endPoint: .bottomTrailing
                ), lineWidth: 1)
                .padding(1)
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

private extension Color {
    static func presentationHex(_ value: String) -> Color? {
        guard value.range(of: #"^#[0-9A-F]{6}$"#, options: .regularExpression) != nil,
              let rgb = UInt64(value.dropFirst(), radix: 16) else { return nil }
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
    let progress = context.state.progress
    return LiveActivityAccessibilitySummary(
        source: presentation.identity.project?.label ?? presentation.header ?? "Relo",
        headline: presentation.title,
        status: presentation.status, detail: presentation.subtitle, progress: progress,
        isPrivate: presentation.privacy == .private,
        isInteractive: presentation.permitsLiveActivityActions && context.state.displayInteraction != nil
    )
}
