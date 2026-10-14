import ActivityKit
import Foundation
import ReloCore

struct ReloActivityAttributes: Codable {
    enum Style: String, Codable, CaseIterable, Hashable {
        case standard
        case ring
        case hero
        case terminal
        case steps
        case approval
        case shell
        case verdict
        case signal
    }

    enum Privacy: String, Codable, Hashable {
        case standard
        case `private`
    }

    struct ContentState: Codable, Hashable {
        var generation: Int
        var updatedAt: Date
        var sequence: Int
        var expiresAt: Date?
        var staleAt: Date?
        var interaction: Interaction?
        var presentation: LiveActivityPresentation
        /// When the work began, for the elapsed timer; absent in older payloads.
        var startedAt: Date?
        /// This phone's sealed card or question text (E5), opened while decoding.
        var sealed: ReloEnvelope?
        /// The work this card shows (ADR 0007): its id scopes the last known step labels; absent before works.
        var work: ReloWork?

        init(
            generation: Int,
            updatedAt: Date,
            sequence: Int,
            expiresAt: Date? = nil,
            staleAt: Date? = nil,
            interaction: Interaction?,
            presentation: LiveActivityPresentation,
            startedAt: Date? = nil,
            sealed: ReloEnvelope? = nil,
            work: ReloWork? = nil
        ) {
            precondition(generation > 0, "Live Activity generation must be positive")
            self.generation = generation
            self.updatedAt = updatedAt
            self.sequence = sequence
            self.expiresAt = expiresAt
            self.staleAt = staleAt
            // The app applies the same command a push carries: open its sealed text the same way, so
            // a card the app starts or updates never falls back to the server's placeholders.
            let opened = Self.opening(presentation, sealed: sealed, work: work)
            self.interaction = opened.permitsLiveActivityActions ? interaction : nil
            self.presentation = opened
            self.startedAt = startedAt
            self.sealed = sealed
            self.work = work
        }

        /// The presentation with this phone's sealed text applied (step labels by id) and handles named.
        static func opening(_ presentation: LiveActivityPresentation, sealed: ReloEnvelope?,
                            work: ReloWork? = nil) -> LiveActivityPresentation {
            let text = sealed.flatMap(ReloSealedCards.open)
            let scope = work?.id ?? text?.phases.map { $0.map(\.id).joined(separator: "|") }
            var opened = text.map { presentation.applying($0, memoryScope: scope) } ?? presentation
            // A card that stays encrypted says why, in one plain line, instead of showing raw handles.
            if text == nil, presentation.title == ReloSealedCards.titlePlaceholder {
                opened = opened.replacingSubtitle(ReloSealedCards.failureLine(sealed: sealed != nil))
            }
            // A sealed question shows only the prompt this phone opened, never text the server wrote.
            if sealed?.kind == "question" {
                opened = opened.replacingSubtitle(text?.summary ?? ReloSealedCards.promptPlaceholder)
            }
            // Opaque project and topic handles show their real names (E2.5).
            return opened.resolvingNames(ReloSealedCards.knownNames())
        }

        private enum CodingKeys: String, CodingKey {
            case generation, updatedAt, sequence, expiresAt, staleAt, interaction, startedAt, sealed, work
        }

        init(from decoder: Decoder) throws {
            let values = try decoder.container(keyedBy: CodingKeys.self)
            generation = try values.decode(Int.self, forKey: .generation)
            guard generation > 0 else {
                throw DecodingError.dataCorruptedError(
                    forKey: .generation,
                    in: values,
                    debugDescription: "Live Activity generation must be a positive integer"
                )
            }
            let decodedPresentation = try LiveActivityPresentation(from: decoder)
            sealed = try? values.decodeIfPresent(ReloEnvelope.self, forKey: .sealed)
            work = (try? values.decodeIfPresent(ReloWork.self, forKey: .work)).flatMap { $0.isEmpty ? nil : $0 }
            // Opened on this phone: every surface shows the real text instead of the placeholders.
            presentation = Self.opening(decodedPresentation, sealed: sealed, work: work)
            updatedAt = try Self.decodeDate(.updatedAt, from: values)
            sequence = try values.decodeIfPresent(Int.self, forKey: .sequence) ?? 0
            expiresAt = try Self.decodeDateIfPresent(.expiresAt, from: values)
            staleAt = try Self.decodeDateIfPresent(.staleAt, from: values)
            startedAt = try Self.decodeDateIfPresent(.startedAt, from: values)
            let decoded = try values.decodeIfPresent(Interaction.self, forKey: .interaction)
            interaction = presentation.permitsLiveActivityActions
                && decoded?.isValidForPresentation == true ? decoded : nil
        }

        func encode(to encoder: Encoder) throws {
            try presentation.encode(to: encoder)
            var values = encoder.container(keyedBy: CodingKeys.self)
            try values.encode(generation, forKey: .generation)
            try values.encode(updatedAt, forKey: .updatedAt)
            try values.encode(sequence, forKey: .sequence)
            try values.encodeIfPresent(expiresAt, forKey: .expiresAt)
            try values.encodeIfPresent(staleAt, forKey: .staleAt)
            try values.encodeIfPresent(startedAt, forKey: .startedAt)
            try values.encodeIfPresent(interaction, forKey: .interaction)
            try values.encodeIfPresent(sealed, forKey: .sealed)
            try values.encodeIfPresent(work, forKey: .work)
        }

        private static func decodeDateIfPresent(
            _ key: CodingKeys,
            from values: KeyedDecodingContainer<CodingKeys>
        ) throws -> Date? {
            guard values.contains(key), try !values.decodeNil(forKey: key) else { return nil }
            return try decodeDate(key, from: values)
        }

        private static func decodeDate(
            _ key: CodingKeys,
            from values: KeyedDecodingContainer<CodingKeys>
        ) throws -> Date {
            if let seconds = try? values.decode(Double.self, forKey: key) {
                return ActivityKitTimestamp.date(fromUnixSeconds: seconds)
            }
            if
                let string = try? values.decode(String.self, forKey: key),
                let date = ActivityKitTimestamp.date(fromISO8601: string)
            {
                return date
            }
            return try values.decode(Date.self, forKey: key)
        }

        var headline: String { presentation.title }
        var detail: String? { presentation.subtitle }
        var status: String { presentation.status }
        var progress: Double? {
            for component in presentation.components {
                switch component {
                case let .progressBar(_, _, value, _): return value
                case let .steps(_, _, items):
                    return Double(items.filter { $0.state == .complete }.count) / Double(items.count)
                case .image: continue
                }
            }
            return nil
        }
        var style: Style {
            switch presentation.behavior {
            case .approval, .choice: .approval
            case .yesNo: .verdict
            case .informational, .progress, .unsupportedTextReply:
                presentation.components.contains { if case .steps = $0 { true } else { false } }
                    ? .steps : .standard
            }
        }
        var symbol: LiveActivitySymbol {
            LiveActivitySymbol(rawValue: presentation.state.icon.displaySymbol.rawValue) ?? .terminal
        }
        var privacy: Privacy { presentation.privacy == .private ? .private : .standard }
        var accentColor: String { presentation.color(for: presentation.appearance.roles.cardIdentity) }
        var primaryLabel: String? {
            switch presentation.behavior {
            case let .approval(primary, _), let .yesNo(primary, _): primary
            case .informational, .progress, .choice, .unsupportedTextReply: nil
            }
        }
        var secondaryLabel: String? {
            switch presentation.behavior {
            case let .approval(_, secondary), let .yesNo(_, secondary): secondary
            case .informational, .progress, .choice, .unsupportedTextReply: nil
            }
        }
        var displayStatus: String { status }
        var displayInteraction: Interaction? { interaction }
    }

    typealias Interaction = LiveActivityContentInteraction

    var eventID: String
    var generation: Int
    var sourceName: String
    var style: Style
    var accountID: String

    init(
        eventID: String,
        generation: Int,
        sourceName: String,
        style: Style,
        accountID: String
    ) {
        precondition(generation > 0, "Live Activity generation must be positive")
        self.eventID = eventID
        self.generation = generation
        self.sourceName = sourceName
        self.style = style
        self.accountID = accountID
    }

    var identity: LiveActivityIdentity {
        LiveActivityIdentity(activityID: eventID, generation: generation)
    }

    private enum CodingKeys: String, CodingKey {
        case eventID, generation, sourceName, style, accountID
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        eventID = try values.decode(String.self, forKey: .eventID)
        generation = try values.decode(Int.self, forKey: .generation)
        guard generation > 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .generation,
                in: values,
                debugDescription: "Live Activity generation must be a positive integer"
            )
        }
        sourceName = try values.decode(String.self, forKey: .sourceName)
        style = try values.decode(Style.self, forKey: .style)
        accountID = try values.decode(String.self, forKey: .accountID)
    }

    func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(eventID, forKey: .eventID)
        try values.encode(generation, forKey: .generation)
        try values.encode(sourceName, forKey: .sourceName)
        try values.encode(style, forKey: .style)
        try values.encode(accountID, forKey: .accountID)
    }
}

#if os(iOS)
extension ReloActivityAttributes: ActivityAttributes {}
#endif
