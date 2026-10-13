import Foundation

/// A request ID is immutable for one decision version. Replacements receive
/// new IDs; a delayed phone reply cannot transfer to the replacement.
public struct NotificationDecisionMetadata: Equatable, Sendable {
    public let accountID: String
    public let deviceID: String
    public let interactionID: String
    public let kind: InboxInteraction.Kind
    public let expiresAt: Date

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
        self.accountID = accountID; self.deviceID = deviceID; self.interactionID = interactionID
        self.kind = kind; self.expiresAt = expiresAt
    }
}

public struct NotificationDecisionAcknowledgement: Decodable, Equatable, Sendable {
    public let id: String
    public let state: String
    public let respondedAt: Date

    public init(id: String, state: String, respondedAt: Date) {
        self.id = id; self.state = state; self.respondedAt = respondedAt
    }

    public func validate(_ response: PendingNotificationResponse) throws {
        guard let expectedID = response.interactionID, id == expectedID, respondedAt <= response.expiresAt,
              state == NotificationResponsePolicy.canonicalState(for: response.action)
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
