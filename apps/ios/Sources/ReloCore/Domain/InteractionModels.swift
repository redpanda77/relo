import Foundation

public enum LiveActivityResponsePhase: String, Codable, Equatable, Hashable, Sendable {
    case sending
    case queued
    case accepted
    case rejected
}

public struct LiveActivityContentInteraction: Codable, Equatable, Hashable, Sendable,
    CustomStringConvertible, CustomDebugStringConvertible {
    public static let maximumUnixSeconds: Int64 = 9_007_199_254_740_991

    public let id: String
    public let notificationID: String
    public let targetDeviceID: String
    public let accountID: String
    public let kind: String
    public var state: String
    public let credential: String
    public let expiresAtUnixSeconds: Int64
    public var responsePhase: LiveActivityResponsePhase?
    public var selectedAction: NotificationInteractionAction?
    /// The option a `choose` response picked; nil for every other action.
    public var selectedOptionID: String?

    public init(
        id: String,
        notificationID: String,
        targetDeviceID: String,
        accountID: String,
        kind: String,
        state: String,
        credential: String,
        expiresAtUnixSeconds: Int64,
        responsePhase: LiveActivityResponsePhase? = nil,
        selectedAction: NotificationInteractionAction? = nil,
        selectedOptionID: String? = nil
    ) {
        self.id = id
        self.notificationID = notificationID
        self.targetDeviceID = targetDeviceID
        self.accountID = accountID
        self.kind = kind
        self.state = state
        self.credential = credential
        self.expiresAtUnixSeconds = expiresAtUnixSeconds
        self.responsePhase = responsePhase
        self.selectedAction = selectedAction
        self.selectedOptionID = selectedOptionID
    }

    private enum CodingKeys: String, CodingKey {
        case id, notificationID, targetDeviceID, accountID, kind, state, credential
        case expiresAtUnixSeconds, responsePhase, selectedAction, selectedOptionID
    }

    public var expiresAt: Date {
        Date(timeIntervalSince1970: TimeInterval(expiresAtUnixSeconds))
    }

    public var isValidForPresentation: Bool {
        let kinds = Set(["approval", "yes_no", "text", "choice"])
        let states = Set(["pending", "approved", "denied", "yes", "no", "replied", "expired", "canceled"])
        return ReloIdentifier.isValid(id)
            && ReloIdentifier.isValid(notificationID)
            && ReloIdentifier.isValid(targetDeviceID)
            && ReloIdentifier.isValid(accountID)
            && kinds.contains(kind)
            && states.contains(state)
            && (32...4_096).contains(credential.utf16.count)
            && (0...Self.maximumUnixSeconds).contains(expiresAtUnixSeconds)
            && LiveActivityResponsePolicy.isValid(
                phase: responsePhase,
                action: selectedAction,
                interactionKind: kind,
                interactionState: state
            )
            && (selectedAction == .choose
                ? selectedOptionID.map(InteractionOption.isValidID) == true
                : selectedOptionID == nil)
    }

    public var description: String {
        let phaseDescription = responsePhase?.rawValue ?? "none"
        let actionDescription = selectedAction.map { action in
            selectedOptionID.map { "\(action.rawValue)(\($0))" } ?? action.rawValue
        } ?? "none"
        return "LiveActivityContentInteraction(id: \(id), notificationID: \(notificationID), "
            + "targetDeviceID: \(targetDeviceID), accountID: \(accountID), kind: \(kind), "
            + "state: \(state), responsePhase: \(phaseDescription), "
            + "selectedAction: \(actionDescription), credential: <redacted>, "
            + "expiresAtUnixSeconds: \(expiresAtUnixSeconds))"
    }

    public var debugDescription: String { description }
}

public struct LiveActivityInteractionCommand: Codable, Equatable, Sendable {
    public let id: String
    public let notificationId: String
    public let kind: InboxInteraction.Kind
    public let state: InboxInteraction.State
    public let credential: String
    public let expiresAt: Date

    public init(
        id: String,
        notificationId: String,
        kind: InboxInteraction.Kind,
        state: InboxInteraction.State,
        credential: String,
        expiresAt: Date
    ) {
        self.id = id
        self.notificationId = notificationId
        self.kind = kind
        self.state = state
        self.credential = credential
        self.expiresAt = expiresAt
    }

    public var isValidForPresentation: Bool {
        ReloIdentifier.isValid(id)
            && ReloIdentifier.isValid(notificationId)
            && (32...4_096).contains(credential.utf16.count)
    }
}

/// One labeled answer of a choice question. A question offers 2–4.
public struct InteractionOption: Codable, Equatable, Hashable, Sendable, Identifiable {
    public static let allowedCount = 2...4
    public static let maximumLabelLength = 24

    public let id: String
    public let label: String

    public init(id: String, label: String) {
        self.id = id
        self.label = label
    }

    /// `^[a-z0-9][a-z0-9_-]{0,31}$`
    public static func isValidID(_ value: String) -> Bool {
        let scalars = Array(value.unicodeScalars)
        guard (1...32).contains(scalars.count), let first = scalars.first else { return false }
        func isLowerAlphanumeric(_ scalar: Unicode.Scalar) -> Bool {
            ("a"..."z").contains(scalar) || ("0"..."9").contains(scalar)
        }
        return isLowerAlphanumeric(first)
            && scalars.dropFirst().allSatisfy { isLowerAlphanumeric($0) || $0 == "_" || $0 == "-" }
    }

    /// One line of 1–24 characters.
    public static func isValidLabel(_ value: String) -> Bool {
        (1...maximumLabelLength).contains(value.count)
            && !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && value.unicodeScalars.allSatisfy { !CharacterSet.newlines.contains($0) }
    }

    /// 2–4 valid options with unique ids and labels unique ignoring case.
    public static func isValidList(_ options: [InteractionOption]) -> Bool {
        allowedCount.contains(options.count)
            && options.allSatisfy { isValidID($0.id) && isValidLabel($0.label) }
            && Set(options.map(\.id)).count == options.count
            && Set(options.map { $0.label.lowercased() }).count == options.count
    }
}

/// The interaction fields this build reads before trusting a whole interaction. A newer server
/// can add kinds or states; an item carrying one keeps everything else and loses only its
/// interaction (or, where an interaction is the item's reason to exist, the item is skipped).
struct InteractionCompatibilityProbe: Decodable {
    let kind: String?
    let type: String?
    let state: String?
}

extension KeyedDecodingContainer {
    func decodeSupportedInteraction<Value: Decodable>(
        _ type: Value.Type,
        forKey key: Key,
        isSupported: (InteractionCompatibilityProbe) -> Bool
    ) throws -> Value? {
        guard contains(key), try !decodeNil(forKey: key) else { return nil }
        guard isSupported(try decode(InteractionCompatibilityProbe.self, forKey: key)) else { return nil }
        return try decode(Value.self, forKey: key)
    }
}

public struct InboxInteraction: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case approval
        case yesNo = "yes_no"
        case text
        case choice
    }

    public enum State: String, Codable, Sendable {
        case pending
        case approved
        case denied
        case yes
        case no
        case replied
        case expired
        case canceled
    }

    public let id: String
    public let kind: Kind
    public let prompt: String
    public let state: State
    public let expiresAt: Date
    public let respondedAt: Date?
    /// A choice question's answers; nil for every other kind.
    public let options: [InteractionOption]?
    /// What an answered choice picked, as the server recorded it.
    public let response: ChoiceResponse?

    public struct ChoiceResponse: Codable, Equatable, Sendable {
        public let optionId: String?
        public let label: String?

        public init(optionId: String?, label: String?) {
            self.optionId = optionId
            self.label = label
        }
    }

    public init(
        id: String,
        kind: Kind,
        prompt: String,
        state: State,
        expiresAt: Date,
        respondedAt: Date? = nil,
        options: [InteractionOption]? = nil,
        response: ChoiceResponse? = nil
    ) {
        self.id = id
        self.kind = kind
        self.prompt = prompt
        self.state = state
        self.expiresAt = expiresAt
        self.respondedAt = respondedAt
        self.options = kind == .choice ? options : nil
        self.response = response
    }

    private enum CodingKeys: String, CodingKey {
        case id, kind, prompt, state, expiresAt, respondedAt, options, response
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        kind = try values.decode(Kind.self, forKey: .kind)
        prompt = try values.decode(String.self, forKey: .prompt)
        state = try values.decode(State.self, forKey: .state)
        expiresAt = try values.decode(Date.self, forKey: .expiresAt)
        respondedAt = try values.decodeIfPresent(Date.self, forKey: .respondedAt)
        if kind == .choice {
            let decoded = try values.decode([InteractionOption].self, forKey: .options)
            guard InteractionOption.isValidList(decoded) else {
                throw DecodingError.dataCorruptedError(
                    forKey: .options, in: values, debugDescription: "A choice needs 2–4 distinct options")
            }
            options = decoded
        } else {
            options = nil
        }
        // A response shape this build does not know never costs the interaction.
        response = (try? values.decodeIfPresent(ChoiceResponse.self, forKey: .response)) ?? nil
    }

    /// True when this build can read the kind and state a server sent.
    static func isSupported(_ probe: InteractionCompatibilityProbe) -> Bool {
        probe.kind.flatMap(Kind.init(rawValue:)) != nil && probe.state.flatMap(State.init(rawValue:)) != nil
    }

    public func option(id: String?) -> InteractionOption? {
        guard let id else { return nil }
        return options?.first { $0.id == id }
    }

    /// The label an answered choice shows: the server's label, else the matching option's.
    public var chosenLabel: String? {
        guard kind == .choice, state == .replied else { return nil }
        return response?.label ?? option(id: response?.optionId)?.label
    }
}

public enum NotificationInteractionAction: String, Codable, Equatable, Sendable {
    case approve
    case deny
    case yes
    case no
    case answer
    /// Picks one option of a choice question; the option travels as `value.optionId`.
    case choose
    case opened
    case received
}

public enum NotificationResponsePhase: String, Codable, Equatable, Hashable, Sendable {
    case sending
    case queued
    case accepted
    case rejected
}

public struct NotificationResponseFeedback: Equatable, Sendable {
    public let phase: NotificationResponsePhase
    public let action: NotificationInteractionAction
    public let canonicalState: String?
    public let message: String?

    public init(
        phase: NotificationResponsePhase,
        action: NotificationInteractionAction,
        canonicalState: String? = nil,
        message: String? = nil
    ) {
        self.phase = phase
        self.action = action
        self.canonicalState = canonicalState
        self.message = message
    }

    public var status: String {
        if let message { return message }
        let label = NotificationResponsePolicy.actionLabel(action)
        switch phase {
        case .sending: return "Sending \(label)…"
        case .queued: return "\(label.capitalized) queued securely"
        case .accepted:
            return (canonicalState ?? NotificationResponsePolicy.canonicalState(for: action) ?? label)
                .replacingOccurrences(of: "_", with: " ")
                .capitalized
        case .rejected: return "Response not recorded — retry"
        }
    }
}
