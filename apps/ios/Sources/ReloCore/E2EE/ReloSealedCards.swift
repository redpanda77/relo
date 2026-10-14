import Foundation

/// The text of an end-to-end sealed card or of a question folded into one (docs/END-TO-END-ENCRYPTION.md, E5).
///
/// Two shapes: v1 `{ title, status, steps: [label] }` (labels in plan order, matching the server's
/// "Step n" placeholders), and v2 `{ title, status, detail, phases: [{ id, title, steps: [{ id, label }] }] }`
/// (ADR 0007), whose labels are matched to the card's steps by id.
public struct ReloSealedCardText: Codable, Equatable, Sendable {
    public struct Phase: Codable, Equatable, Sendable {
        public struct Step: Codable, Equatable, Sendable {
            public var id: String
            public var label: String?

            public init(id: String, label: String? = nil) {
                self.id = id
                self.label = label
            }
        }

        public var id: String
        public var title: String?
        public var steps: [Step]?

        public init(id: String, title: String? = nil, steps: [Step]? = nil) {
            self.id = id
            self.title = title
            self.steps = steps
        }

        private enum CodingKeys: String, CodingKey { case id, title, steps }

        public init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            id = try values.decode(String.self, forKey: .id)
            title = try? values.decodeIfPresent(String.self, forKey: .title)
            let steps: [Step] = ReloWork.lenientArray(values, .steps)
            self.steps = values.contains(.steps) ? steps : nil
        }
    }

    public var title: String?
    public var status: String?
    public var detail: String?
    public var steps: [String]?
    public var phases: [Phase]?
    public var progressLabel: String?
    /// A sealed question's prompt.
    public var summary: String?

    public init(title: String? = nil, status: String? = nil, detail: String? = nil, steps: [String]? = nil,
                phases: [Phase]? = nil, progressLabel: String? = nil, summary: String? = nil) {
        self.title = title
        self.status = status
        self.detail = detail
        self.steps = steps
        self.phases = phases
        self.progressLabel = progressLabel
        self.summary = summary
    }

    private enum CodingKeys: String, CodingKey { case title, status, detail, steps, phases, progressLabel, summary }

    /// A field of an unexpected type is dropped, never the whole text: the rest still opens.
    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        title = try? values.decodeIfPresent(String.self, forKey: .title)
        status = try? values.decodeIfPresent(String.self, forKey: .status)
        detail = try? values.decodeIfPresent(String.self, forKey: .detail)
        steps = try? values.decodeIfPresent([String].self, forKey: .steps)
        let phases: [Phase] = ReloWork.lenientArray(values, .phases)
        self.phases = phases.isEmpty ? nil : phases
        progressLabel = try? values.decodeIfPresent(String.self, forKey: .progressLabel)
        summary = try? values.decodeIfPresent(String.self, forKey: .summary)
    }

    /// v2 labels by step id. Placeholder labels ("Step 3") are never real labels.
    public var labelsByStepID: [String: String] {
        var labels: [String: String] = [:]
        for step in (phases ?? []).flatMap({ $0.steps ?? [] }) {
            guard let label = ReloWork.text(step.label), !ReloSealedCards.isPlaceholderStep(label), labels[step.id] == nil
            else { continue }
            labels[step.id] = label
        }
        return labels
    }

    /// The v1 label for a server placeholder "Step n", by the number the placeholder carries.
    public func legacyLabel(forPlaceholder placeholder: String) -> String? {
        guard let labels = steps, let number = ReloSealedCards.placeholderStepNumber(placeholder),
              labels.indices.contains(number - 1) else { return nil }
        let label = ReloWork.text(labels[number - 1])
        return label.flatMap { ReloSealedCards.isPlaceholderStep($0) ? nil : $0 }
    }

    /// The real label for a card step: by id from v2 phases, else by the v1 placeholder's number.
    public func label(forStepID id: String, placeholder: String) -> String? {
        labelsByStepID[id] ?? legacyLabel(forPlaceholder: placeholder)
    }
}

/// The last real label this process saw for each step of a work, so an update whose text lacks a
/// label keeps showing it instead of falling back to "Step n". Scoped by work, kept in memory only.
public enum ReloStepLabelMemory {
    private final class Box: @unchecked Sendable {
        let lock = NSLock()
        var labels: [String: [String: String]] = [:]
        var order: [String] = []
    }

    private static let box = Box()
    private static let maximumScopes = 32

    public static func remember(_ labels: [String: String], scope: String) {
        guard !labels.isEmpty, !scope.isEmpty else { return }
        box.lock.withLock {
            box.labels[scope, default: [:]].merge(labels) { _, new in new }
            box.order.removeAll { $0 == scope }
            box.order.append(scope)
            while box.order.count > maximumScopes { box.labels[box.order.removeFirst()] = nil }
        }
    }

    public static func labels(scope: String) -> [String: String] {
        guard !scope.isEmpty else { return [:] }
        return box.lock.withLock { box.labels[scope] ?? [:] }
    }

    public static func reset() {
        box.lock.withLock { box.labels = [:]; box.order = [] }
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
        var lastFailure: String?
    }

    private static let box = Box()

    public static func install(_ opener: @escaping @Sendable (ReloEnvelope) -> Data?) {
        box.lock.withLock { box.opener = opener }
    }

    /// The handle → name book for opaque project and topic names (E2.5).
    public static func installNames(_ names: @escaping @Sendable () -> [String: String]) {
        box.lock.withLock { box.names = names }
    }

    /// Why the last open in this process failed (a `ReloSealedOpenRecord.Outcome` raw value).
    public static func noteFailure(_ outcome: String?) {
        box.lock.withLock { box.lastFailure = outcome }
    }

    /// One plain line for a card that stays encrypted, instead of a silent placeholder.
    public static func failureLine(sealed: Bool) -> String {
        guard sealed else { return "Not encrypted for this iPhone. Check Relo → Settings → Security." }
        switch box.lock.withLock({ box.opener == nil ? "no_opener" : box.lastFailure }) {
        case "not_for_this_phone": return "Encrypted for another device or an older key of this iPhone."
        case "computer_pending": return "From a computer waiting for your approval in Relo → Settings → Security."
        case "computer_declined": return "From a computer you declined."
        case "computer_unknown": return "From a computer this iPhone doesn't know yet. Open Relo to refresh."
        case "no_keys", "keys_unreadable", "trust_unreadable", "no_opener": return "Open Relo once to read encrypted cards here."
        default: return "Couldn't open this card. Open Relo to read it."
        }
    }

    /// The title of a row this phone cannot open (never "Encrypted card": it says nothing to the owner).
    public static let unreadableTitle = "Can't be read on this iPhone"

    /// The titles the server writes in place of sealed text.
    public static let titlePlaceholders: Set<String> = ["Encrypted card", "Encrypted notification", "Encrypted question"]

    /// A title fit to show: a server placeholder becomes the opened question's first line, else
    /// `unreadableTitle`. Any other title is returned unchanged.
    public static func readableTitle(_ title: String, prompt: String? = nil) -> String {
        guard titlePlaceholders.contains(title) else { return title }
        let placeholderLines: Set<String> = [promptPlaceholder, statusPlaceholder, "Private notification",
                                             "Open Relo on your iPhone to read this."]
        if let prompt, !placeholderLines.contains(prompt), !titlePlaceholders.contains(prompt),
           let line = prompt.split(whereSeparator: \.isNewline).first?.trimmingCharacters(in: .whitespaces), !line.isEmpty {
            return String(line.prefix(120))
        }
        return unreadableTitle
    }

    /// One short calm reason for a row this phone cannot open, from a `ReloSealedOpenRecord.Outcome`
    /// raw value ("not_sealed" when no envelope came for this phone at all).
    public static func unreadableReason(outcome: String?) -> String {
        switch outcome {
        case "not_for_this_phone": "Sealed for another device"
        case "not_sealed": "Not sealed for this iPhone"
        case "computer_pending": "From a computer waiting for your approval"
        case "computer_declined": "From a computer you declined"
        case "computer_unknown": "From a computer you haven't approved"
        case "no_keys", "keys_unreadable", "trust_unreadable": "This iPhone's keys aren't ready yet"
        default: "Its text couldn't be opened"
        }
    }

    /// The same reason as one sentence, for the body of a detail screen.
    public static func unreadableSentence(outcome: String?) -> String {
        switch outcome {
        case "not_for_this_phone": "This was sealed for another device, so this iPhone can't read it."
        case "not_sealed": "This wasn't sealed for this iPhone, so it can't be read here."
        case "computer_pending": "It comes from a computer waiting for your approval. Approve it in Settings → Security to read it."
        case "computer_declined": "It comes from a computer you declined, so this iPhone won't open it."
        case "computer_unknown": "It comes from a computer you haven't approved, so this iPhone won't open it."
        case "no_keys", "keys_unreadable", "trust_unreadable": "This iPhone's encryption keys aren't ready yet. Open Relo again in a moment."
        default: "Its text couldn't be opened on this iPhone."
        }
    }

    public static func isPlaceholderTitle(_ value: String) -> Bool {
        [titlePlaceholder, questionTitlePlaceholder].contains(value)
    }

    /// "Step 3" → 3: the server's stand-in for a sealed step label.
    public static func placeholderStepNumber(_ value: String) -> Int? {
        guard value.hasPrefix("Step "), let number = Int(value.dropFirst(5)), number > 0 else { return nil }
        return number
    }

    public static func isPlaceholderStep(_ value: String) -> Bool { placeholderStepNumber(value) != nil }

    /// "Phase 2": the server's stand-in for a sealed phase name.
    public static func isPlaceholderPhase(_ value: String) -> Bool {
        guard value.hasPrefix("Phase "), let number = Int(value.dropFirst(6)) else { return false }
        return number > 0
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
    /// `memoryScope` names the work (or plan) whose last known labels fill a step the text lacks.
    func applying(_ text: ReloSealedCardText, memoryScope: String? = nil) -> LiveActivityPresentation {
        let remembered = memoryScope.map(ReloStepLabelMemory.labels(scope:)) ?? [:]
        if let memoryScope { ReloStepLabelMemory.remember(text.labelsByStepID, scope: memoryScope) }
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
                // Each step on its own, by id (v2) or by its placeholder's number (v1); never all or nothing.
                return .steps(id: id, colorRole: role, items: items.map { item in
                    guard ReloSealedCards.isPlaceholderStep(item.label) else { return item }
                    guard let label = text.label(forStepID: item.id, placeholder: item.label) ?? remembered[item.id]
                    else { return item }
                    return LiveActivityDisplayPresentation.Step(id: item.id, label: label, state: item.state)
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
