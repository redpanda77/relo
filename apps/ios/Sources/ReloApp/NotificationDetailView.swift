import Combine
import ReloCore
import SwiftUI
import UIKit

struct NotificationDetailView: View {
    @Bindable var model: AppModel
    let item: InboxItem
    @Environment(\.accessibilityReduceTransparency) private var reduceTransparency
    @State private var confirmsWithdrawal = false
    private var currentItem: InboxItem {
        guard let detail = model.selectedNotificationDetail, detail.item.id == item.id else { return item }
        return detail.item
    }
    private var presentation: LiveActivityDisplayPresentation { InboxPresentationProjection.presentation(for: currentItem) }
    private var pending: Bool {
        guard let draft = model.currentDecision(notificationID: item.id) else { return false }
        return model.decisionAvailability(draft.identity).permitsSubmission
            && !model.responseIsQueued(for: item.id) && !model.responseIsAccepted(for: item.id)
    }
    private var stale: Bool { InboxAttentionProjection.isStale(currentItem, now: model.attentionDate) }
    private var messageText: String? { currentItem.content?.body ?? presentation.subtitle }
    /// What the header does not already say; empty means no About section.
    private var aboutRows: [(label: String, value: String, monospaced: Bool)] {
        let context = InboxHierarchyProjection.context(for: currentItem)
        var rows: [(label: String, value: String, monospaced: Bool)] = []
        if let task = context?.taskTitle, !task.isEmpty { rows.append(("Task", task, false)) }
        if let computer = context?.computer, !computer.isEmpty { rows.append(("Computer", computer, false)) }
        if let interaction = currentItem.interaction, interaction.state == .pending {
            rows.append(("Respond by", interaction.expiresAt.formatted(date: .omitted, time: .shortened), false))
        }
        return rows
    }

    private var asksNow: Bool { currentItem.interaction?.state == .pending }

    private var statusLine: String? { currentItem.kind == .liveActivity ? (stale ? "Update overdue" : presentation.status) : nil }

    private var measuredProgress: Double? {
        if let value = currentItem.activitySummary?.progress { return value }
        if case let .progressBar(value, _) = presentation.visual { return value }
        return nil
    }

    @ViewBuilder private var progressSection: some View {
        if currentItem.kind == .liveActivity {
            VStack(alignment: .leading, spacing: 16) {
                ReloMissionTimeline(item: currentItem, steps: presentation.timelineSteps(for: currentItem), progress: measuredProgress,
                                    status: presentation.status, now: model.attentionDate)
                ReloActivityVisual(item: currentItem, accountID: model.credential?.accountId, mediaOnly: true)
            }
            .reloEntrance(1)
        }
    }

    @ViewBuilder private var messageSection: some View {
        let kind = ReloMessageKind(item: currentItem, stale: stale)
        if messageText != nil || currentItem.validatedDestinationURL != nil || currentItem.validatedSourceImageURL != nil {
            VStack(alignment: .leading, spacing: 14) {
                if let messageText {
                    ReloMessageBody(text: messageText, markdown: currentItem.content?.format == .markdown)
                }
                if let imageURL = currentItem.validatedSourceImageURL {
                    ReloRemoteImage(url: imageURL, accountID: model.credential?.accountId, altText: "Image from \(currentItem.sourceName)")
                        .clipShape(RoundedRectangle(cornerRadius: 14, style: .continuous))
                }
                if let url = currentItem.validatedDestinationURL {
                    Link(destination: url) {
                        HStack(spacing: 10) {
                            let link = ReloDestinationLabel(url: url)
                            Image(systemName: link.symbol).font(.subheadline.weight(.semibold))
                            VStack(alignment: .leading, spacing: 1) {
                                Text(link.title).font(.subheadline.weight(.semibold))
                                Text(link.detail).font(.caption)
                                    .foregroundStyle(Color.reloSecondaryText).lineLimit(1)
                            }
                            Spacer(minLength: 0)
                            Image(systemName: "arrow.up.right").font(.caption.weight(.bold))
                        }
                        .foregroundStyle(Color.reloInteractive)
                        .padding(12).frame(minHeight: 44)
                        .background { RoundedRectangle(cornerRadius: 14, style: .continuous).fill(Color.reloInteractive.opacity(0.10)) }
                    }
                }
            }
            .padding(ReloLayout.cardInset + 2)
            .frame(maxWidth: .infinity, alignment: .leading)
            .reloCard(tint: kind.color)
            .reloEntrance(1)
        }
    }

    var body: some View {
        let kind = ReloMessageKind(item: currentItem, stale: stale)
        ScrollView {
            VStack(alignment: .leading, spacing: 24) {
                ReloIdentityHeader(item: currentItem, title: presentation.title, kind: kind,
                                   status: statusLine, now: model.attentionDate)
                    .reloEntrance(0)
                // A question leads with the question; the work it belongs to follows.
                if asksNow {
                    messageSection
                    progressSection
                } else {
                    progressSection
                    messageSection
                }
                if currentItem.interaction != nil && !pending {
                    ResponseControls(model: model, item: currentItem).reloEntrance(2)
                }
                if currentItem.kind != .liveActivity {
                    ReloDetailSection(title: "Delivery") {
                        ReloDeliveryTimelineView(timeline: .make(currentItem))
                    }
                    .reloEntrance(3)
                }
                if !aboutRows.isEmpty {
                    ReloDetailSection(title: "About") {
                        ReloAboutRows(rows: aboutRows)
                    }
                    .reloEntrance(4)
                }
            }
            .padding(.horizontal, ReloLayout.screenInset)
            .padding(.top, 8).padding(.bottom, 32)
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .background(alignment: .top) {
            // A soft wash of the message's state color behind the header; static, never motion.
            EllipticalGradient(colors: [kind.color.opacity(0.22), .clear], center: .top,
                               startRadiusFraction: 0, endRadiusFraction: 0.75)
                .frame(height: 420).ignoresSafeArea().allowsHitTesting(false).accessibilityHidden(true)
        }
        .reloScreenBackground()
        .safeAreaInset(edge: .bottom) {
            if pending {
                ResponseControls(model: model, item: currentItem)
                    .padding(.horizontal, ReloLayout.screenInset).padding(.top, 12).padding(.bottom, 8)
                    .background {
                        if reduceTransparency { Color.reloSurface.ignoresSafeArea() } else {
                            Rectangle().fill(.ultraThinMaterial).ignoresSafeArea()
                                .overlay(alignment: .top) { Rectangle().fill(Color.white.opacity(0.10)).frame(height: 0.5) }
                        }
                    }
            }
        }
        .navigationTitle(currentItem.kind == .liveActivity ? "Activity" : "Message")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if model.canWithdraw(currentItem) {
                ToolbarItem(placement: .topBarTrailing) {
                    Menu {
                        Button("Remove notification", role: .destructive) { confirmsWithdrawal = true }
                    } label: { Image(systemName: "ellipsis.circle") }.accessibilityLabel("More actions")
                }
            }
        }
        .confirmationDialog("Remove this notification?", isPresented: $confirmsWithdrawal, titleVisibility: .visible) {
            Button("Remove notification", role: .destructive) { Task { await model.withdrawNotification(currentItem.id) } }
        } message: { Text("It will disappear from Now. You can still find it in History.") }
    }
}

struct ActivityPresentationPalette {
    let accent: Color
    let secondary: Color
    let primaryText: Color
    let secondaryText: Color
    let canvas: Color
    let surface: Color

    init(item: InboxItem) {
        self.init(presentation: InboxPresentationProjection.presentation(for: item))
    }

    init(
        presentation: LiveActivityDisplayPresentation,
        hostColorScheme: ColorScheme = .dark,
        usesSystemSurfaces: Bool = false
    ) {
        // The host owns reading surfaces, even when sender appearance disagrees.
        accent = .reloInteractive
        secondary = .secondary
        primaryText = .primary
        secondaryText = .reloSecondaryText
        canvas = .reloCanvas
        surface = .reloSurface
    }
}

enum ActivityPresentationVisualSurface {
    case detail
    case row
}

struct ActivityPresentationVisual: View {
    let presentation: LiveActivityDisplayPresentation
    let palette: ActivityPresentationPalette
    let accountID: String?
    let surface: ActivityPresentationVisualSurface
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    @ViewBuilder
    var body: some View {
        switch presentation.visual {
        case .none:
            EmptyView()
        case let .progressBar(value, label):
            VStack(alignment: .leading, spacing: 7) {
                progressHeading(value: value, label: label)
                ProgressView(value: value)
                    .tint(palette.accent)
            }
            .animation(reduceMotion ? nil : .snappy(duration: 0.28), value: value)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(label ?? "Progress")
            .accessibilityValue("\(Int((value * 100).rounded())) percent")
        case let .steps(items):
            VStack(alignment: .leading, spacing: surface == .detail ? 9 : 6) {
                HStack(spacing: 6) {
                    ForEach(items) { item in
                        Capsule()
                            .fill(item.state == .pending ? palette.primaryText.opacity(0.14)
                                : item.state == .current ? palette.accent.opacity(0.42) : palette.accent)
                            .frame(height: surface == .detail ? 8 : 5)
                    }
                }
                if surface == .detail, let active = items.first(where: { $0.state == .current }) {
                    Text(active.label)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(palette.secondaryText)
                }
            }
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("Progress")
            .accessibilityValue(stepsAccessibilityValue(items))
        case let .image(reference):
            ReloImmutableImage(reference: reference, accountID: accountID, row: surface == .row)
        }
    }

    private func progressHeading(value: Double, label: String?) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label ?? "Progress")
                .font(surface == .detail ? .caption.weight(.semibold) : .caption2.weight(.semibold))
                .foregroundStyle(palette.secondaryText)
                .lineLimit(1)
            Spacer(minLength: 8)
            Text(value, format: .percent.precision(.fractionLength(0)))
                .font(surface == .detail ? .title3.weight(.bold) : .caption.weight(.bold))
                .monospacedDigit()
                .foregroundStyle(palette.primaryText)
                .contentTransition(.numericText(value: value))
        }
    }

    private func stepsAccessibilityValue(_ items: [LiveActivityDisplayPresentation.Step]) -> String {
        guard !items.isEmpty else { return "No steps" }
        let completed = items.filter { $0.state == .complete }.count
        return "\(completed) of \(items.count) complete"
    }
}

@MainActor
enum NotificationResponseHaptics {
    static func decisionStarted() {
        let generator = UIImpactFeedbackGenerator(style: .medium)
        generator.prepare()
        generator.impactOccurred(intensity: 0.82)
    }

    static func responseFinished(_ phase: NotificationResponsePhase) {
        let generator = UINotificationFeedbackGenerator()
        generator.prepare()
        switch phase {
        case .accepted: generator.notificationOccurred(.success)
        case .queued: generator.notificationOccurred(.warning)
        case .rejected: generator.notificationOccurred(.error)
        case .sending: break
        }
    }
}

private extension InboxInteraction.State {
    var displayName: String {
        switch self {
        case .pending: "Pending"
        case .approved: "Approved"
        case .denied: "Denied"
        case .yes: "Yes"
        case .no: "No"
        case .replied: "Replied"
        case .expired: "Expired"
        case .canceled: "Canceled"
        }
    }
}

extension InboxItem.Kind {
    var displayName: String {
        switch self {
        case .notification: "Notification"
        case .liveActivity: "Live Activity"
        case .response: "Response"
        }
    }
}
