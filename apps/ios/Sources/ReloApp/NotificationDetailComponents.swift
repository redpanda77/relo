import ReloCore
import SwiftUI
import UIKit

/// What a message is and how it wants attention, in one place: label, symbol and state color.
struct ReloMessageKind {
    let label: String
    let symbol: String
    let color: Color

    init(item: InboxItem, stale: Bool) {
        if let interaction = item.interaction {
            switch interaction.state {
            case .pending:
                color = .reloSignalCoral
                switch interaction.kind {
                case .approval: (label, symbol) = ("Approval request", "checkmark.seal.fill")
                case .yesNo: (label, symbol) = ("Question", "arrow.triangle.branch")
                case .text: (label, symbol) = ("Reply requested", "text.bubble.fill")
                }
            case .approved, .yes, .replied:
                (label, symbol, color) = (interaction.state == .replied ? "Replied" : interaction.state == .yes ? "Answered yes" : "Approved",
                                          "checkmark.circle.fill", .reloDone)
            case .denied, .no:
                (label, symbol, color) = (interaction.state == .no ? "Answered no" : "Denied", "xmark.circle.fill", .reloErrorText)
            case .expired, .canceled:
                (label, symbol, color) = (interaction.state == .expired ? "Expired" : "Canceled", "clock.badge.xmark", .reloInfo)
            }
            return
        }
        switch item.kind {
        case .liveActivity:
            // An ended card says how it ended: finished, stopped, expired, or (from an older update) ended.
            switch InboxAttentionProjection.activityOutcome(item, now: .now) {
            case .completed: (label, symbol, color) = ("Completed", "checkmark.circle.fill", .reloDone)
            case .stopped: (label, symbol, color) = ("Stopped", "exclamationmark.octagon.fill", .reloWarning)
            case .expired: (label, symbol, color) = ("Expired", "clock.badge.xmark", .reloInfo)
            case .ended: (label, symbol, color) = ("Ended", "stop.circle", .reloInfo)
            case .running:
                (label, symbol, color) = stale ? ("Update overdue", "clock.badge.exclamationmark", .reloWarning)
                    : ("Live Activity", "waveform.path", .reloSignalIndigo)
            }
        case .response: (label, symbol, color) = ("Response", "arrowshape.turn.up.left.fill", .reloInfo)
        case .notification: (label, symbol, color) = ("Message", "bell.fill", .reloInfo)
        }
    }
}

/// How a tap destination reads: a web page by host, a Shortcut by name, or an app by its scheme.
struct ReloDestinationLabel {
    let symbol: String
    let title: String
    let detail: String

    init(url: URL) {
        let scheme = url.scheme?.lowercased() ?? ""
        if NotificationDestinationPolicy.isWebLink(url) {
            (symbol, title, detail) = ("link", "Open link", url.host() ?? url.absoluteString)
        } else if scheme == "shortcuts" {
            let name = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "name" })?.value
            (symbol, title, detail) = ("square.stack.3d.up.fill", "Run Shortcut", name ?? "Shortcuts")
        } else {
            (symbol, title, detail) = ("arrow.up.forward.app.fill", "Open in app", "\(scheme)://")
        }
    }
}

/// The message itself, set for reading. Markdown from the sender renders inline.
struct ReloMessageBody: View {
    let text: String
    let markdown: Bool
    var body: some View {
        Group {
            if markdown, let attributed = try? AttributedString(
                markdown: text, options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace)) {
                Text(attributed)
            } else {
                Text(text)
            }
        }
        .font(.body).lineSpacing(4)
        .tint(.reloInteractive)
        .textSelection(.enabled)
        .fixedSize(horizontal: false, vertical: true)
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

/// A titled glass section; the title sits outside the glass, like the grouped lists.
struct ReloDetailSection<Content: View>: View {
    let title: String
    @ViewBuilder let content: Content
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title).font(.subheadline.weight(.semibold)).foregroundStyle(Color.reloSecondaryText)
                .padding(.leading, 4)
                .accessibilityAddTraits(.isHeader)
            content
                .padding(ReloLayout.cardInset)
                .frame(maxWidth: .infinity, alignment: .leading)
                .reloCard()
        }
    }
}

/// Sent → Accepted by Apple → Received → Opened → Answered. The rail draws in once on appear.
struct ReloDeliveryTimelineView: View {
    let timeline: NotificationDeliveryTimeline
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var revealed = false

    var body: some View {
        VStack(alignment: .leading, spacing: 0) {
            ForEach(Array(timeline.steps.enumerated()), id: \.element.id) { index, step in
                HStack(alignment: .top, spacing: 14) {
                    VStack(spacing: 0) {
                        marker(step).padding(.top, 3)
                        if index < timeline.steps.count - 1 {
                            Rectangle()
                                .fill(rail(after: index))
                                .frame(width: 1.5)
                                .frame(maxHeight: .infinity)
                                .scaleEffect(x: 1, y: revealed ? 1 : 0, anchor: .top)
                                .animation(reduceMotion ? nil : .easeOut(duration: 0.35).delay(0.12 + Double(index) * 0.12),
                                           value: revealed)
                        }
                    }
                    .frame(width: 14)
                    VStack(alignment: .leading, spacing: 3) {
                        HStack(alignment: .firstTextBaseline) {
                            Text(step.title).font(.subheadline.weight(step.state == .waiting ? .regular : .medium))
                                .foregroundStyle(step.state == .waiting ? Color.reloSecondaryText : step.state == .failed ? Color.reloErrorText : .primary)
                            Spacer(minLength: 8)
                            if let date = step.date {
                                Text(date, format: .dateTime.hour().minute().second())
                                    .font(.caption.monospacedDigit()).foregroundStyle(Color.reloSecondaryText)
                            }
                        }
                        if let detail = step.detail {
                            Text(detail).font(.caption).foregroundStyle(Color.reloSecondaryText)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                    .padding(.bottom, index < timeline.steps.count - 1 ? 16 : 0)
                    .opacity(revealed || reduceMotion ? 1 : 0)
                    .animation(reduceMotion ? nil : .easeOut(duration: 0.3).delay(Double(index) * 0.12), value: revealed)
                }
                .accessibilityElement(children: .combine)
            }
        }
        .onAppear { revealed = true }
    }

    private func color(_ state: NotificationDeliveryTimeline.StepState) -> Color {
        switch state {
        case .complete: .reloDone
        case .waiting: .reloSignalIndigo
        case .failed: .reloErrorText
        }
    }

    private func rail(after index: Int) -> Color {
        timeline.steps[index + 1].state == .complete ? Color.reloDone.opacity(0.55) : Color.white.opacity(0.14)
    }

    @ViewBuilder private func marker(_ step: NotificationDeliveryTimeline.Step) -> some View {
        let tint = color(step.state)
        ZStack {
            if step.state == .waiting {
                Circle().strokeBorder(tint, lineWidth: 1.5)
                ReloWaitingPulse(color: tint)
            } else {
                Circle().fill(tint)
                    .shadow(color: tint.opacity(0.6), radius: 4)
                Image(systemName: step.state == .failed ? "xmark" : "checkmark")
                    .font(.system(size: 6.5, weight: .black)).foregroundStyle(Color.reloCanvas)
            }
        }
        .frame(width: 12, height: 12)
        .scaleEffect(revealed || reduceMotion ? 1 : 0.4)
        .animation(reduceMotion ? nil : .spring(response: 0.35, dampingFraction: 0.6), value: revealed)
        .accessibilityHidden(true)
    }
}

/// A slow ring around the step that is still in progress; static with Reduce Motion.
private struct ReloWaitingPulse: View {
    let color: Color
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var expanded = false
    var body: some View {
        Circle().stroke(color.opacity(expanded ? 0 : 0.6), lineWidth: 1)
            .scaleEffect(expanded ? 2.2 : 1)
            .onAppear {
                guard !reduceMotion else { return }
                withAnimation(.easeOut(duration: 1.6).repeatForever(autoreverses: false)) { expanded = true }
            }
    }
}

/// Every fact about the message. Hold a value to copy it.
struct ReloAboutRows: View {
    let rows: [(label: String, value: String, monospaced: Bool)]
    var body: some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.offset) { index, row in
                if index > 0 { Divider().overlay(Color.white.opacity(0.06)) }
                HStack(alignment: .firstTextBaseline, spacing: 16) {
                    Text(row.label).font(.subheadline).foregroundStyle(Color.reloSecondaryText)
                    Spacer(minLength: 12)
                    Text(row.value)
                        .font(row.monospaced ? .caption.monospaced() : .subheadline)
                        .foregroundStyle(.primary)
                        .multilineTextAlignment(.trailing)
                        .lineLimit(row.monospaced ? 1 : nil)
                        .truncationMode(.middle)
                        .fixedSize(horizontal: false, vertical: !row.monospaced)
                }
                .padding(.vertical, 10)
                .contentShape(Rectangle())
                .contextMenu {
                    Button { UIPasteboard.general.string = row.value } label: { Label("Copy \(row.label)", systemImage: "doc.on.doc") }
                }
                .accessibilityElement(children: .combine)
            }
        }
        .padding(.vertical, -10)
    }
}

/// One authored entrance: sections rise and sharpen into place in reading order.
private struct ReloEntrance: ViewModifier {
    let order: Int
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var shown = false
    func body(content: Content) -> some View {
        content
            .opacity(shown || reduceMotion ? 1 : 0)
            .offset(y: shown || reduceMotion ? 0 : 14)
            .blur(radius: shown || reduceMotion ? 0 : 6)
            .onAppear {
                guard !reduceMotion, !shown else { return }
                withAnimation(.spring(response: 0.5, dampingFraction: 0.86).delay(Double(order) * 0.06)) { shown = true }
            }
    }
}

extension View {
    func reloEntrance(_ order: Int) -> some View { modifier(ReloEntrance(order: order)) }
}
