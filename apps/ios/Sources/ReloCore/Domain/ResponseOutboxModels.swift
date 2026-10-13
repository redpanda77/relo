import Foundation

public enum PendingResponseEndpoint: String, Codable, Equatable, Sendable {
    case notification
    case liveActivity
}

public struct PendingNotificationResponse: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let accountID: String
    public let deviceID: String
    public let notificationID: String
    public let action: NotificationInteractionAction
    public let value: [String: String]
    public let idempotencyKey: String
    public let expiresAt: Date
    public let endpoint: PendingResponseEndpoint
    public let activityID: String?
    public let activityGeneration: Int?
    public let interactionID: String?
    public let responseCredential: String?
    public let serverOrigin: URL?

    public init(
        accountID: String,
        deviceID: String,
        notificationID: String,
        action: NotificationInteractionAction,
        value: [String: String],
        idempotencyKey: String,
        expiresAt: Date,
        endpoint: PendingResponseEndpoint = .notification,
        activityID: String? = nil,
        activityGeneration: Int? = nil,
        interactionID: String? = nil,
        responseCredential: String? = nil,
        serverOrigin: URL? = nil
    ) {
        self.id = idempotencyKey
        self.accountID = accountID
        self.deviceID = deviceID
        self.notificationID = notificationID
        self.action = action
        self.value = value
        self.idempotencyKey = idempotencyKey
        self.expiresAt = expiresAt
        self.endpoint = endpoint
        self.activityID = activityID
        self.activityGeneration = activityGeneration
        self.interactionID = interactionID
        self.responseCredential = responseCredential
        self.serverOrigin = serverOrigin
    }

    /// The option a `choose` response picks, carried in `value` as the server reads it.
    public var optionID: String? { action == .choose ? value["optionId"] : nil }

    /// A `choose` must name one well-formed option; every other action names none.
    public var hasValidOption: Bool {
        action == .choose ? optionID.map(InteractionOption.isValidID) == true : value["optionId"] == nil
    }

    public var decisionKey: String {
        switch endpoint {
        case .notification: "notification|\(notificationID)"
        case .liveActivity:
            "live-activity|\(activityID ?? "missing")|\(activityGeneration ?? 0)|\(interactionID ?? notificationID)"
        }
    }

    public static func liveActivity(
        accountID: String,
        deviceID: String,
        notificationID: String,
        activityID: String,
        activityGeneration: Int,
        interactionID: String,
        action: NotificationInteractionAction,
        optionID: String? = nil,
        credential: String,
        expiresAt: Date
    ) -> PendingNotificationResponse {
        let choice = action == .choose ? optionID : nil
        return PendingNotificationResponse(
            accountID: accountID,
            deviceID: deviceID,
            notificationID: notificationID,
            action: action,
            value: choice.map { ["optionId": $0] } ?? [:],
            idempotencyKey: "live-activity:\(activityID):\(activityGeneration):\(interactionID):\(action.rawValue)"
                + (choice.map { ":\($0)" } ?? ""),
            expiresAt: expiresAt,
            endpoint: .liveActivity,
            activityID: activityID,
            activityGeneration: activityGeneration,
            interactionID: interactionID,
            responseCredential: credential
        )
    }

    private enum CodingKeys: String, CodingKey {
        case id, accountID, deviceID, notificationID, action, value, idempotencyKey, expiresAt
        case endpoint, activityID, activityGeneration, interactionID, responseCredential, serverOrigin
        case expiresAtReferenceSeconds
    }

    public func encode(to encoder: Encoder) throws {
        var values = encoder.container(keyedBy: CodingKeys.self)
        try values.encode(id, forKey: .id)
        try values.encode(accountID, forKey: .accountID)
        try values.encode(deviceID, forKey: .deviceID)
        try values.encode(notificationID, forKey: .notificationID)
        try values.encode(action, forKey: .action)
        try values.encode(value, forKey: .value)
        try values.encode(idempotencyKey, forKey: .idempotencyKey)
        try values.encode(expiresAt, forKey: .expiresAt)
        // The shared legacy ISO8601 codec truncates fractional seconds.
        try values.encode(expiresAt.timeIntervalSinceReferenceDate, forKey: .expiresAtReferenceSeconds)
        try values.encode(endpoint, forKey: .endpoint)
        try values.encodeIfPresent(activityID, forKey: .activityID)
        try values.encodeIfPresent(activityGeneration, forKey: .activityGeneration)
        try values.encodeIfPresent(interactionID, forKey: .interactionID)
        try values.encodeIfPresent(responseCredential, forKey: .responseCredential)
        try values.encodeIfPresent(serverOrigin, forKey: .serverOrigin)
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        id = try values.decode(String.self, forKey: .id)
        accountID = try values.decode(String.self, forKey: .accountID)
        deviceID = try values.decode(String.self, forKey: .deviceID)
        notificationID = try values.decode(String.self, forKey: .notificationID)
        action = try values.decode(NotificationInteractionAction.self, forKey: .action)
        value = try values.decode([String: String].self, forKey: .value)
        idempotencyKey = try values.decode(String.self, forKey: .idempotencyKey)
        if let precise = try values.decodeIfPresent(Double.self, forKey: .expiresAtReferenceSeconds) {
            guard precise.isFinite else {
                throw DecodingError.dataCorruptedError(forKey: .expiresAtReferenceSeconds, in: values, debugDescription: "Invalid action deadline")
            }
            expiresAt = Date(timeIntervalSinceReferenceDate: precise)
        } else {
            expiresAt = try values.decode(Date.self, forKey: .expiresAt)
        }
        endpoint = try values.decodeIfPresent(PendingResponseEndpoint.self, forKey: .endpoint) ?? .notification
        activityID = try values.decodeIfPresent(String.self, forKey: .activityID)
        let decodedGeneration = try values.decodeIfPresent(Int.self, forKey: .activityGeneration)
        activityGeneration = endpoint == .liveActivity ? decodedGeneration ?? 1 : decodedGeneration
        if let activityGeneration, activityGeneration <= 0 {
            throw DecodingError.dataCorruptedError(
                forKey: .activityGeneration,
                in: values,
                debugDescription: "Live Activity generation must be positive"
            )
        }
        interactionID = try values.decodeIfPresent(String.self, forKey: .interactionID)
        responseCredential = try values.decodeIfPresent(String.self, forKey: .responseCredential)
        serverOrigin = try values.decodeIfPresent(URL.self, forKey: .serverOrigin)
    }
}

public enum PendingResponseEnqueueResult: Equatable, Sendable {
    case enqueued
    case alreadyPending(PendingNotificationResponse)
    case alreadyConfirmed(LiveActivityResponseConfirmation)
    case alreadyNotificationConfirmed(NotificationResponseConfirmation)
}

public enum PendingResponseFailureResolution: Equatable, Sendable {
    case discardedInvalidResponse
    case retry
}
