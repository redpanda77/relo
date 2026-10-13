import Foundation

/// A request ID is immutable for one decision version. Replacements receive
/// new IDs; a delayed phone reply cannot transfer to the replacement.
public struct NotificationDecisionMetadata: Equatable, Sendable {
    public let accountID: String
    public let deviceID: String
    public let interactionID: String
    public let kind: InboxInteraction.Kind
    public let expiresAt: Date
    /// A choice question's options (`relo.interactionOptions`); nil for every other kind.
    public let options: [InteractionOption]?

    public init?(relo: [String: Any]) {
        guard let accountID = relo["accountId"] as? String, ReloIdentifier.isValid(accountID),
              let deviceID = relo["deviceId"] as? String, ReloIdentifier.isValid(deviceID),
              let interactionID = relo["interactionId"] as? String, ReloIdentifier.isValid(interactionID),
              let kindValue = relo["interactionType"] as? String,
              let kind = InboxInteraction.Kind(rawValue: kindValue),
              let deadline = relo["interactionExpiresAt"] as? String
        else { return nil }
        let fractional = ISO8601DateFormatter()
        fractional.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        guard let expiresAt = fractional.date(from: deadline) ?? ISO8601DateFormatter().date(from: deadline)
        else { return nil }
        let options = kind == .choice ? Self.options(relo["interactionOptions"]) : nil
        guard kind != .choice || options != nil else { return nil }
        self.accountID = accountID; self.deviceID = deviceID; self.interactionID = interactionID
        self.kind = kind; self.expiresAt = expiresAt; self.options = options
    }

    /// `[{"id","label"}…]` from an APNs payload, only when it is a valid 2–4 option list.
    public static func options(_ value: Any?) -> [InteractionOption]? {
        guard let entries = value as? [[String: Any]] else { return nil }
        let options = entries.compactMap { entry -> InteractionOption? in
            guard let id = entry["id"] as? String, let label = entry["label"] as? String else { return nil }
            return InteractionOption(id: id, label: label)
        }
        guard options.count == entries.count, InteractionOption.isValidList(options) else { return nil }
        return options
    }
}

public struct NotificationDecisionAcknowledgement: Decodable, Equatable, Sendable {
    public let id: String
    public let state: String
    public let respondedAt: Date
    /// A choice's recorded answer, when the server echoes it.
    public let response: InboxInteraction.ChoiceResponse?

    public init(id: String, state: String, respondedAt: Date, response: InboxInteraction.ChoiceResponse? = nil) {
        self.id = id; self.state = state; self.respondedAt = respondedAt; self.response = response
    }

    private enum CodingKeys: String, CodingKey { case id, state, respondedAt, response }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        state = try values.decode(String.self, forKey: .state)
        respondedAt = try values.decode(Date.self, forKey: .respondedAt)
        response = (try? values.decodeIfPresent(InboxInteraction.ChoiceResponse.self, forKey: .response)) ?? nil
    }

    /// A choice must carry the option it picks; an echoed option must be that one.
    public func validate(_ response: PendingNotificationResponse) throws {
        guard let expectedID = response.interactionID, id == expectedID, respondedAt <= response.expiresAt,
              state == NotificationResponsePolicy.canonicalState(for: response.action),
              response.hasValidOption,
              self.response?.optionId.map({ $0 == response.optionID }) ?? true
        else { throw MobileAPIError.invalidResponse }
    }
}

public enum NotificationDecisionRejection: String, Codable, Sendable {
    case expired, superseded, answered, unavailable, versionMismatch
    public var message: String {
        switch self {
        case .expired: "Request expired — response not confirmed"
        case .superseded: "Request replaced — response not sent to the newer request"
        case .answered: "Request already answered"
        case .unavailable: "Request is no longer available"
        case .versionMismatch: "Request changed — response not sent"
        }
    }
}

/// Kept in protected storage for one day (at most 256 records). Retaining the
/// exact intent makes a late canonical acknowledgement distinguishable from a
/// new action after local expiry, without guessing that a timed-out send failed.
public struct NotificationResponseFailure: Codable, Equatable, Sendable, Error {
    public let response: PendingNotificationResponse
    public let reason: NotificationDecisionRejection
    public let recordedAt: Date

    public init(response: PendingNotificationResponse, reason: NotificationDecisionRejection, recordedAt: Date) {
        self.response = response; self.reason = reason; self.recordedAt = recordedAt
    }

    public static func bounded(_ values: [Self], now: Date) -> [Self] {
        Array(values.filter { $0.recordedAt.addingTimeInterval(86_400) > now }.suffix(256))
    }
}

public extension PendingNotificationResponse {
    /// Legacy queues did not record request identity. Fill it only from the
    /// same immutable event and scope, preserving the first saved choice/key.
    func bindingMetadata(from candidate: Self) -> Self {
        guard endpoint == .notification, candidate.endpoint == .notification,
              accountID == candidate.accountID, deviceID == candidate.deviceID,
              notificationID == candidate.notificationID,
              interactionID == nil, serverOrigin == nil,
              candidate.interactionID != nil, candidate.serverOrigin != nil else { return self }
        return Self(accountID: accountID, deviceID: deviceID, notificationID: notificationID,
            action: action, value: value, idempotencyKey: idempotencyKey,
            expiresAt: min(expiresAt, candidate.expiresAt), interactionID: candidate.interactionID,
            serverOrigin: candidate.serverOrigin)
    }
}

/// Per-question notification categories for choice questions. The server names the static
/// `RELO_CHOICE` category (no buttons); the Notification Service Extension registers
/// `RELO_CHOICE.<interactionId>` with one `RELO_OPTION.<optionId>` action per option and keeps
/// only the newest few beside the static categories.
public enum ChoiceNotificationCategoryPolicy {
    public static let staticCategoryIdentifier = "RELO_CHOICE"
    public static let categoryPrefix = "RELO_CHOICE."
    public static let actionPrefix = "RELO_OPTION."
    public static let retainedCategoryLimit = 20

    public struct Action: Equatable, Sendable {
        public let identifier: String
        public let title: String
    }

    public struct Category: Equatable, Sendable {
        public let identifier: String
        public let actions: [Action]
    }

    public static func category(interactionID: String, options: [InteractionOption]) -> Category? {
        guard ReloIdentifier.isValid(interactionID), InteractionOption.isValidList(options) else { return nil }
        return Category(
            identifier: categoryPrefix + interactionID,
            actions: options.map { Action(identifier: actionPrefix + $0.id, title: $0.label) })
    }

    public static func isPerQuestionCategory(_ identifier: String) -> Bool {
        identifier.hasPrefix(categoryPrefix) && identifier.count > categoryPrefix.count
    }

    /// The option a tapped `RELO_OPTION.<optionId>` action names; nil for any other action.
    public static func optionID(fromActionIdentifier identifier: String) -> String? {
        guard identifier.hasPrefix(actionPrefix) else { return nil }
        let id = String(identifier.dropFirst(actionPrefix.count))
        return InteractionOption.isValidID(id) ? id : nil
    }

    /// The per-question categories to keep after adding `newIdentifier`, oldest first and
    /// `newIdentifier` last. `recentOrder` is the order earlier registrations recorded (oldest
    /// first); registered categories it does not mention are treated as the oldest.
    public static func retainedIdentifiers(
        registered: [String],
        recentOrder: [String],
        adding newIdentifier: String,
        limit: Int = retainedCategoryLimit
    ) -> [String] {
        let registered = Set(registered.filter(isPerQuestionCategory)).subtracting([newIdentifier])
        var seen = Set<String>()
        let ordered = recentOrder.filter { registered.contains($0) && seen.insert($0).inserted }
        let unordered = registered.subtracting(ordered).sorted()
        return Array((unordered + ordered + [newIdentifier]).suffix(max(limit, 1)))
    }
}
