import ReloCore
import SwiftUI

struct ReloContextLabel: View {
    let item: InboxItem
    var compact = false
    var showsProject = true

    var body: some View {
        let source = InboxSourceProjection.source(for: item)
        let project = InboxHierarchyProjection.project(for: item)
        let topic = InboxSourceProjection.topic(for: item)
        let context = InboxHierarchyProjection.context(for: item)
        VStack(alignment: .leading, spacing: compact ? 3 : 6) {
            if compact {
                Label(source.name, systemImage: source.systemImageName)
                    .font(.caption.weight(.semibold)).foregroundStyle(Color.reloInteractive)
                    .accessibilityLabel("Source: \(source.name)")
                if showsProject {
                    Label(project.isDirect ? "No project" : project.name, systemImage: "folder")
                        .accessibilityLabel("Project: \(project.isDirect ? "Not supplied" : project.name)")
                }
                Label(topic?.name ?? "No topic", systemImage: "bubble.left")
                    .accessibilityLabel("Topic: \(topic?.name ?? "Not supplied")")
            } else {
                LabeledContent("Source", value: source.name)
                LabeledContent("Project", value: project.isDirect ? "Not supplied" : project.name)
                LabeledContent("Topic", value: topic?.name ?? "Not supplied")
                if let computer = context?.computer, !computer.isEmpty {
                    LabeledContent("Computer", value: computer)
                }
            }
        }
        .font(compact ? .caption : .subheadline)
        .foregroundStyle(Color.reloSecondaryText)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// `Source › Project › Topic` on one line. Missing parts are omitted, never invented.
struct ReloContextLine: View {
    let item: InboxItem
    var body: some View {
        let source = InboxSourceProjection.source(for: item)
        let project = InboxHierarchyProjection.project(for: item)
        let topic = InboxSourceProjection.topic(for: item)
        let parts = [source.name, project.isDirect ? nil : project.name, topic?.name].compactMap { $0 }
        Text(parts.joined(separator: " › "))
            .font(.subheadline).foregroundStyle(Color.reloSecondaryText)
            .lineLimit(1).truncationMode(.middle)
            .accessibilityLabel(parts.joined(separator: ", "))
    }
}

struct ReloEventRow: View {
    let item: InboxItem
    let accountID: String?
    var showsPreview = false
    var showsContext = true
    var stale = false
    var responseStatus: String?
    @Environment(\.dynamicTypeSize) private var typeSize
    private var signalColor: Color {
        if stale { return .reloWarning }
        if item.kind == .liveActivity {
            return InboxAttentionProjection.activityIsFinished(item, now: .now) ? .reloInfo : .reloSignalIndigo
        }
        if item.interaction != nil { return .reloSignalCoral }
        return .reloInfo
    }
    var body: some View {
        let presentation = InboxPresentationProjection.presentation(for: item)
        HStack(alignment: .top, spacing: 12) {
            ReloSignalGlyph(symbol: presentation.symbol.systemImageName, color: signalColor, size: 32)
            VStack(alignment: .leading, spacing: 3) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(presentation.title).font(.headline).foregroundStyle(.primary)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                        .fixedSize(horizontal: false, vertical: true)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(item.activitySummary?.updatedAt ?? item.createdAt, style: .time)
                        .font(.caption.monospacedDigit()).foregroundStyle(Color.reloSecondaryText)
                }
                if showsContext { ReloContextLine(item: item) }
                if !showsPreview, let detail = presentation.subtitle, detail != presentation.title {
                    Text(detail).font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                        .lineLimit(typeSize.isAccessibilitySize ? nil : 1)
                }
                // A plain message has no state worth a line; everything else says where it stands.
                if responseStatus != nil || stale || item.interaction != nil || item.kind != .notification || item.result != nil {
                    HStack(spacing: 6) {
                        Circle().fill(signalColor).frame(width: 6, height: 6).accessibilityHidden(true)
                        Text(responseStatus ?? (stale ? "Update overdue" : presentation.status))
                    }
                    .font(.caption.weight(.medium)).foregroundStyle(Color.reloSecondaryText)
                    .padding(.top, 2)
                }
                if showsPreview {
                    ReloActivityVisual(item: item, accountID: accountID, row: true)
                }
            }
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
        .contentShape(Rectangle())
        .accessibilityElement(children: .combine)
        .accessibilityHint("Opens details")
    }
}

/// A state-tinted symbol in a soft circle; the color says what kind of attention it wants.
struct ReloSignalGlyph: View {
    let symbol: String
    let color: Color
    var size: CGFloat = 32
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.44, weight: .semibold))
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(color)
            .frame(width: size, height: size)
            .background {
                Circle().fill(color.opacity(0.14))
                    .overlay { Circle().strokeBorder(color.opacity(0.22), lineWidth: 0.5) }
            }
            .accessibilityHidden(true)
    }
}

struct ReloChevron: View {
    var body: some View {
        Image(systemName: "chevron.right").font(.caption.weight(.semibold))
            .foregroundStyle(.tertiary).accessibilityHidden(true)
    }
}

/// A measured value on a thin track. The fill carries the running color into the done color.
struct ReloProgressTrack: View {
    let value: Double
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var fraction: Double { value.isFinite ? min(max(value, 0), 1) : 0 }
    var body: some View {
        HStack(spacing: 10) {
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule().fill(Color.primary.opacity(0.09))
                    Capsule()
                        .fill(LinearGradient(colors: [.reloIndigo, .reloMagenta],
                                             startPoint: .leading, endPoint: .trailing))
                        .frame(width: max(6, proxy.size.width * fraction))
                        .shadow(color: .reloSignalIndigo.opacity(0.45), radius: 6, x: 0, y: 2)
                }
            }
            .frame(height: 6)
            .animation(reduceMotion ? nil : .smooth(duration: 0.5), value: fraction)
            Text(fraction, format: .percent.precision(.fractionLength(0)))
                .font(.caption.weight(.semibold).monospacedDigit()).foregroundStyle(.primary)
                .contentTransition(.numericText(value: fraction))
        }
        .accessibilityElement(children: .ignore).accessibilityLabel("Progress")
        .accessibilityValue(fraction.formatted(.percent.precision(.fractionLength(0))))
    }
}

/// Cards press in slightly, like a physical surface; Reduce Motion keeps only the dimming.
struct ReloPressStyle: ButtonStyle {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .scaleEffect(configuration.isPressed && !reduceMotion ? 0.975 : 1)
            .opacity(configuration.isPressed ? 0.88 : 1)
            .animation(.spring(response: 0.28, dampingFraction: 0.72), value: configuration.isPressed)
    }
}

/// The one caps label: monospaced, one weight, one tracking. Section kickers, codes and small status words.
struct ReloMonoLabel: View {
    let text: String
    var color: Color = .reloSecondaryText
    init(_ text: String, color: Color = .reloSecondaryText) { self.text = text; self.color = color }
    var body: some View {
        Text(text.uppercased())
            .font(.system(.caption2, design: .monospaced).weight(.semibold))
            .tracking(ReloLayout.labelTracking)
            .foregroundStyle(color)
    }
}

struct ReloEmptyState: View {
    let title: String
    let detail: String
    var symbol = "tray"
    var body: some View {
        ContentUnavailableView {
            Label(title, systemImage: symbol)
        } description: { Text(detail) }
        .padding(.vertical, 20)
    }
}

/// The Settings idiom: a filled, gradient tile with a white symbol, then the title.
struct ReloSettingLabel: View {
    let title: String
    let symbol: String
    var color: Color = .reloActionFill
    @Environment(\.dynamicTypeSize) private var typeSize
    var body: some View {
        // The fixed-size tile can't grow with the text; at accessibility sizes the words need its width.
        if typeSize.isAccessibilitySize {
            Text(title).fixedSize(horizontal: false, vertical: true).frame(minHeight: 32)
        } else {
            tiled
        }
    }
    private var tiled: some View {
        Label {
            Text(title).fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: symbol)
                .font(.system(size: 14, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 29, height: 29)
                .background(color.gradient, in: RoundedRectangle(cornerRadius: 7, style: .continuous))
                .accessibilityHidden(true)
        }
        .frame(minHeight: 32)
    }
}

/// The mark communicates the request kind before its title is read.
struct ReloRequestGlyph: View {
    let item: InboxItem
    var size: CGFloat = 56

    private var color: Color {
        item.interaction?.kind == .approval ? .reloSignalCoral : .reloInteractive
    }
    private var symbol: String {
        switch item.interaction?.kind {
        case .approval: "checkmark.seal.fill"
        case .yesNo: "arrow.triangle.branch"
        case .text: "text.bubble.fill"
        case .choice: "list.bullet.circle.fill"
        default: "bell.badge.fill"
        }
    }
    var body: some View {
        Image(systemName: symbol)
            .font(.system(size: size * 0.46, weight: .semibold))
            .symbolRenderingMode(.hierarchical)
            .foregroundStyle(color)
            .frame(width: size, height: size)
            .background(color.opacity(0.13).gradient,
                        in: RoundedRectangle(cornerRadius: size * 0.28, style: .continuous))
            .accessibilityHidden(true)
    }
}

struct ReloRequestWidget: View {
    let item: InboxItem
    var showsProject = true
    var responseStatus: String?
    @Environment(\.dynamicTypeSize) private var typeSize

    var body: some View {
        Group {
            if !typeSize.isAccessibilitySize {
                HStack(alignment: .center, spacing: 12) {
                    ReloRequestGlyph(item: item, size: 40)
                    summary
                    ReloChevron()
                }
            } else {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        ReloRequestGlyph(item: item, size: 40)
                        Spacer()
                        ReloChevron()
                    }
                    summary
                }
            }
        }
        .padding(ReloLayout.cardInset)
        .frame(maxWidth: .infinity, minHeight: 100, alignment: .leading)
        .reloCard().contentShape(RoundedRectangle(cornerRadius: ReloLayout.cardRadius, style: .continuous))
        .accessibilityElement(children: .combine).accessibilityHint("Opens request")
    }

    private var summary: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(item.title).font(.headline).foregroundStyle(.primary)
                .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                .fixedSize(horizontal: false, vertical: true)
            ReloContextLabel(item: item, compact: true, showsProject: showsProject)
            Text(responseStatus ?? InboxPresentationProjection.presentation(for: item).status)
                .font(.caption).foregroundStyle(Color.reloSecondaryText)
        }.frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A measured value, never an invented completion estimate.
struct ReloProgressRing: View {
    let value: Double
    @ScaledMetric(relativeTo: .title2) private var diameter: CGFloat = 96
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    private var fraction: Double { value.isFinite ? min(max(value, 0), 1) : 0 }

    var body: some View {
        ZStack {
            Circle().stroke(Color.reloSignalIndigo.opacity(0.15), lineWidth: 8)
            Circle().trim(from: 0, to: fraction)
                .stroke(AngularGradient(colors: [.reloSignalIndigo, .reloInteractive], center: .center),
                        style: StrokeStyle(lineWidth: 8, lineCap: .round))
                .rotationEffect(.degrees(-90))
                .animation(reduceMotion ? nil : .easeOut(duration: 0.25), value: fraction)
            Text(fraction, format: .percent.precision(.fractionLength(0)))
                .font(.system(.title2, design: .rounded, weight: .bold)).monospacedDigit()
                .foregroundStyle(.primary)
        }
        .frame(width: diameter, height: diameter).padding(4)
        .accessibilityElement(children: .ignore).accessibilityLabel("Progress")
        .accessibilityValue(fraction.formatted(.percent.precision(.fractionLength(0))))
    }
}

struct ReloProjectLabel: View {
    let project: InboxProjectIdentity
    var body: some View {
        Label(project.isDirect ? "No project" : project.name, systemImage: project.systemImageName)
            .font(.subheadline.weight(.semibold)).foregroundStyle(color)
            .fixedSize(horizontal: false, vertical: true)
    }
    private var color: Color {
        guard let slot = project.paletteSlot else { return .reloSecondaryText }
        switch slot % 3 {
        case 0: return .reloInteractive
        case 1: return .reloSignalIndigo
        default: return .reloSignalCoral
        }
    }
}

struct ReloActivityWidget: View {
    let item: InboxItem
    let stale: Bool
    var revealsDetails = true
    var showsContext = true
    var showsProject = true
    @Environment(\.dynamicTypeSize) private var typeSize
    private var presentation: LiveActivityDisplayPresentation { InboxPresentationProjection.presentation(for: item) }
    private var progress: Double? {
        if case let .progressBar(value, _) = presentation.visual, value.isFinite { return value }
        return nil
    }
    var body: some View {
        let layout = typeSize.isAccessibilitySize
            ? AnyLayout(VStackLayout(alignment: .leading, spacing: 16))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 16))
        layout {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label(stale ? "Update overdue" : presentation.status, systemImage: stale ? "clock.badge.exclamationmark" : "waveform.path")
                        .font(.caption.weight(.semibold)).foregroundStyle(Color.reloSignalIndigo)
                    Spacer(minLength: 0)
                    if revealsDetails {
                        ReloChevron()
                    }
                }
                Text(presentation.title).font(.title3.weight(.semibold)).foregroundStyle(.primary)
                    .lineLimit(typeSize.isAccessibilitySize ? nil : 2)
                    .fixedSize(horizontal: false, vertical: true)
                if showsContext { ReloContextLabel(item: item, compact: true, showsProject: showsProject) }
            }.frame(maxWidth: .infinity, alignment: .leading)
            if let progress { ReloProgressRing(value: progress) }
            else {
                Image(systemName: presentation.symbol.systemImageName)
                    .font(.largeTitle).foregroundStyle(Color.reloSignalIndigo)
                    .frame(width: 72, height: 72)
                    .background(Color.reloSignalIndigo.opacity(0.12), in: Circle())
                    .accessibilityHidden(true)
            }
        }
        .padding(ReloLayout.cardInset).frame(maxWidth: .infinity, alignment: .leading).reloCard()
        .contentShape(RoundedRectangle(cornerRadius: ReloLayout.cardRadius, style: .continuous))
        .accessibilityElement(children: .combine)
    }
}

/// A filter chip. Selected chips fill with the action color; menu chips carry a chevron.
struct ReloFilterPill: View {
    let title: String
    var symbol: String?
    let selected: Bool
    var menu = false
    let action: () -> Void

    var body: some View {
        if menu { label } else { Button(action: action) { label }.buttonStyle(.plain) }
    }

    private var label: some View {
        HStack(spacing: 6) {
            if let symbol { Image(systemName: symbol).font(.caption.weight(.semibold)) }
            Text(title).font(.subheadline.weight(.semibold)).lineLimit(1)
            if menu { Image(systemName: "chevron.down").font(.caption2.weight(.bold)).opacity(0.7) }
        }
        .foregroundStyle(selected ? Color.reloCanvas : Color.primary)
        .padding(.horizontal, 14).frame(minHeight: 34)
        .background {
            Capsule().fill(selected ? AnyShapeStyle(Color.reloInteractive) : AnyShapeStyle(Color.white.opacity(0.07)))
        }
        .overlay { Capsule().strokeBorder(Color.white.opacity(selected ? 0 : 0.12), lineWidth: 0.75) }
        .contentShape(Capsule())
        .accessibilityAddTraits(selected ? [.isButton, .isSelected] : .isButton)
    }
}
