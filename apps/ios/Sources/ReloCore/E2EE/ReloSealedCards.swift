import Foundation

/// The text of an end-to-end sealed card or of a question folded into one (docs/END-TO-END-ENCRYPTION.md, E5).
public struct ReloSealedCardText: Codable, Equatable, Sendable {
    public var title: String?
    public var status: String?
    public var detail: String?
    public var steps: [String]?
    public var progressLabel: String?
    /// A sealed question's prompt.
    public var summary: String?

    public init(title: String? = nil, status: String? = nil, detail: String? = nil, steps: [String]? = nil,
                progressLabel: String? = nil, summary: String? = nil) {
        self.title = title
        self.status = status
        self.detail = detail
        self.steps = steps
        self.progressLabel = progressLabel
        self.summary = summary
    }
}

/// Opens sealed card text while a Live Activity's state is decoded, so every surface shows the real
/// text. The widget and the app install the opener at launch; without one, placeholders stay.
public enum ReloSealedCards {
    public static let titlePlaceholder = "Encrypted card"
    public static let statusPlaceholder = "Updating…"
    public static let questionTitlePlaceholder = "Encrypted question"
    public static let promptPlaceholder = "Open Relo on your iPhone to read this question."

    private final class Box: @unchecked Sendable {
        let lock = NSLock()
        var opener: (@Sendable (ReloEnvelope) -> Data?)?
        var names: (@Sendable () -> [String: String])?
    }

    private static let box = Box()

    public static func install(_ opener: @escaping @Sendable (ReloEnvelope) -> Data?) {
        box.lock.withLock { box.opener = opener }
    }

    /// The handle → name book for opaque project and topic names (E2.5).
    public static func installNames(_ names: @escaping @Sendable () -> [String: String]) {
        box.lock.withLock { box.names = names }
    }

    public static func knownNames() -> [String: String] {
        (box.lock.withLock { box.names })?() ?? [:]
    }

    public static func open(_ envelope: ReloEnvelope) -> ReloSealedCardText? {
        let opener = box.lock.withLock { box.opener }
        guard ["card", "question"].contains(envelope.kind), let data = opener?(envelope) else { return nil }
        return try? JSONDecoder().decode(ReloSealedCardText.self, from: data)
    }
}

public extension LiveActivityPresentation {
    /// Replaces the server's placeholders with the opened text. Words the server wrote itself
    /// ("Approved", "Expired") stay: only placeholders are replaced.
    func applying(_ text: ReloSealedCardText) -> LiveActivityPresentation {
        let placeholders = [ReloSealedCards.titlePlaceholder, ReloSealedCards.questionTitlePlaceholder]
        let openedTitle = text.title.flatMap { placeholders.contains($0) ? nil : $0 }
        let newTitle = placeholders.contains(title) ? (openedTitle ?? title) : title
        var newStatus = status
        if let real = text.status, status.contains(ReloSealedCards.statusPlaceholder) {
            newStatus = status.replacingOccurrences(of: ReloSealedCards.statusPlaceholder, with: real)
        }
        var newSubtitle = subtitle
        if subtitle == ReloSealedCards.promptPlaceholder, let prompt = text.summary {
            newSubtitle = prompt
        } else if subtitle == nil, let detail = text.detail {
            newSubtitle = detail
        }
        let newComponents = components.map { component -> Component in
            switch component {
            case let .steps(id, role, items):
                guard let labels = text.steps, labels.count == items.count else { return component }
                return .steps(id: id, colorRole: role, items: items.enumerated().map { index, item in
                    item.label == "Step \(index + 1)"
                        ? LiveActivityDisplayPresentation.Step(id: item.id, label: labels[index], state: item.state) : item
                })
            case let .progressBar(id, role, value, label):
                guard let real = text.progressLabel, label == nil || label?.isEmpty == true else { return component }
                return .progressBar(id: id, colorRole: role, value: value, label: real)
            case .image:
                return component
            }
        }
        return LiveActivityPresentation(header: header, title: newTitle, subtitle: newSubtitle, status: newStatus,
                                        components: newComponents, surfaces: surfaces, identity: identity, state: state,
                                        behavior: behavior, appearance: appearance, privacy: privacy)
    }
}

public extension LiveActivityPresentation {
    func replacingSubtitle(_ value: String) -> LiveActivityPresentation {
        LiveActivityPresentation(header: header, title: title, subtitle: value, status: status, components: components,
                                 surfaces: surfaces, identity: identity, state: state, behavior: behavior,
                                 appearance: appearance, privacy: privacy)
    }
}
