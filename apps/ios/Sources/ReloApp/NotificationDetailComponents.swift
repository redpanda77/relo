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
                color = ReloStateStyle.needsYou.color
                switch interaction.kind {
                case .approval: (label, symbol) = ("Approval request", "checkmark.seal.fill")
                case .yesNo: (label, symbol) = ("Question", "arrow.triangle.branch")
                case .text: (label, symbol) = ("Reply requested", "text.bubble.fill")
                case .choice: (label, symbol) = ("Choice", "list.bullet.circle.fill")
                }
            case .approved, .yes, .replied:
                let answered = interaction.chosenLabel.map { "Chose \($0)" }
                    ?? (interaction.state == .replied ? "Replied" : interaction.state == .yes ? "Answered yes" : "Approved")
                (label, symbol, color) = (answered, "checkmark.circle.fill", ReloStateStyle.done.color)
            case .denied, .no:
                (label, symbol, color) = (interaction.state == .no ? "Answered no" : "Denied", "xmark.circle.fill", ReloStateStyle.failed.color)
            case .expired, .canceled:
                (label, symbol, color) = (interaction.state == .expired ? "Expired" : "Canceled", "clock.badge.xmark", ReloStateStyle.quiet.color)
            }
            return
        }
        switch item.kind {
        case .liveActivity:
            // An ended card says how it ended: finished, stopped, expired, or (from an older update) ended.
            switch InboxAttentionProjection.activityOutcome(item, now: .now) {
            case .completed: (label, symbol, color) = ("Completed", "checkmark.circle.fill", ReloStateStyle.done.color)
            case .stopped: (label, symbol, color) = ("Stopped", "exclamationmark.octagon.fill", ReloStateStyle.dropped.color)
            case .expired: (label, symbol, color) = ("Expired", "clock.badge.xmark", ReloStateStyle.quiet.color)
            case .ended: (label, symbol, color) = ("Ended", "stop.circle", ReloStateStyle.ended.color)
            case .running:
                (label, symbol, color) = stale ? ("Update overdue", "clock.badge.exclamationmark", Color.reloWarning)
                    : ("Live Activity", "waveform.path", ReloStateStyle.running.color)
            }
        case .response: (label, symbol, color) = ("Response", "arrowshape.turn.up.left.fill", ReloStateStyle.message.color)
        case .notification: (label, symbol, color) = ("Message", "bell.fill", ReloStateStyle.message.color)
        }
    }
}

/// How a tap destination reads: a web page by its site and page, a Shortcut by name, or an app by its scheme.
struct ReloDestinationLabel {
    let symbol: String
    let title: String
    let detail: String
    /// What VoiceOver says the tile does.
    let action: String

    init(url: URL) {
        let scheme = url.scheme?.lowercased() ?? ""
        if NotificationDestinationPolicy.isWebLink(url) {
            let host = (url.host() ?? url.absoluteString).replacingOccurrences(of: "www.", with: "", options: .anchored)
            let path = url.path(percentEncoded: false)
            let page = path.isEmpty || path == "/" ? nil : path
            (symbol, title, detail, action) = ("safari", host, page ?? "Opens in your browser", "Open link")
        } else if scheme == "shortcuts" {
            let name = URLComponents(url: url, resolvingAgainstBaseURL: false)?
                .queryItems?.first(where: { $0.name == "name" })?.value
            (symbol, title, detail, action) = ("square.stack.3d.up.fill", name ?? "Shortcuts", "Runs a Shortcut", "Run Shortcut")
        } else {
            (symbol, title, detail, action) = ("arrow.up.forward.app.fill", "\(scheme)://", "Opens in its app", "Open in app")
        }
    }
}

/// The link a message carries, as a tile: the destination's mark, where it goes and what it opens, and the
/// arrow that says it leaves Relo.
struct ReloLinkTile: View {
    let url: URL

    var body: some View {
        let link = ReloDestinationLabel(url: url)
        Link(destination: url) {
            HStack(spacing: 12) {
                Image(systemName: link.symbol)
                    .font(.system(size: 17, weight: .semibold))
                    .foregroundStyle(Color.reloInteractive)
                    .frame(width: 38, height: 38)
                    .background(RoundedRectangle(cornerRadius: 10, style: .continuous).fill(Color.reloInteractive.opacity(0.16)))
                    .overlay(RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .strokeBorder(Color.reloInteractive.opacity(0.28), lineWidth: 0.75))
                VStack(alignment: .leading, spacing: 2) {
                    Text(link.title).font(.subheadline.weight(.semibold)).foregroundStyle(.primary).lineLimit(1)
                    Text(link.detail).font(.caption).foregroundStyle(Color.reloSecondaryText)
                        .lineLimit(1).truncationMode(.middle)
                }
                Spacer(minLength: 8)
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 11, weight: .bold))
                    .foregroundStyle(Color.reloInteractive)
                    .frame(width: 26, height: 26)
                    .background(Circle().fill(Color.reloInteractive.opacity(0.14)))
            }
            .padding(10).frame(minHeight: 58)
            .background(RoundedRectangle(cornerRadius: ReloLayout.nestedRadius(), style: .continuous).fill(Color.white.opacity(0.05)))
            .overlay(RoundedRectangle(cornerRadius: ReloLayout.nestedRadius(), style: .continuous)
                .strokeBorder(Color.white.opacity(0.10), lineWidth: 0.75))
            .contentShape(RoundedRectangle(cornerRadius: ReloLayout.nestedRadius(), style: .continuous))
        }
        .buttonStyle(ReloPressStyle())
        .accessibilityLabel("\(link.action), \(link.title)")
        .contextMenu {
            Button { UIPasteboard.general.url = url } label: { Label("Copy link", systemImage: "doc.on.doc") }
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
