import Foundation

public struct NotificationResponseConfirmation: Codable, Equatable, Sendable {
    public let accountID: String
    public let deviceID: String
    public let notificationID: String
    public let action: NotificationInteractionAction
    public let idempotencyKey: String
    public let canonicalState: String
    public let confirmedAt: Date
    public let expiresAt: Date

    public var decisionKey: String { "notification|\(notificationID)" }

    public init(response: PendingNotificationResponse, confirmedAt: Date) throws {
        guard
            response.endpoint == .notification,
            let canonicalState = NotificationResponsePolicy.canonicalState(for: response.action)
        else { throw LiveActivityResponseConfirmationError.invalidConfirmation }
        accountID = response.accountID
        deviceID = response.deviceID
        notificationID = response.notificationID
        action = response.action
        idempotencyKey = response.idempotencyKey
        self.canonicalState = canonicalState
        self.confirmedAt = confirmedAt
        expiresAt = response.expiresAt
    }

    public func exactlyMatches(_ response: PendingNotificationResponse) -> Bool {
        response.endpoint == .notification
            && response.accountID == accountID
            && response.deviceID == deviceID
            && response.notificationID == notificationID
            && response.action == action
            && response.idempotencyKey == idempotencyKey
    }
}

public struct LiveActivityResponseConfirmation: Codable, Equatable, Sendable {
    public let accountID: String
    public let deviceID: String
    public let notificationID: String
    public let activityID: String
    public let activityGeneration: Int
    public let interactionID: String
    public let action: NotificationInteractionAction
    /// The option a confirmed `choose` picked; absent for every other action and in older records.
    public let optionID: String?
    public let idempotencyKey: String
    public let canonicalState: String
    public let confirmedAt: Date
    public let expiresAt: Date

    public var decisionKey: String { "live-activity|\(activityID)|\(activityGeneration)|\(interactionID)" }

    public init(
        response: PendingNotificationResponse,
        canonicalState: String,
        confirmedAt: Date
    ) throws {
        guard
            response.endpoint == .liveActivity,
            let activityID = response.activityID,
            let activityGeneration = response.activityGeneration,
            let interactionID = response.interactionID,
            ReloIdentifier.isValid(activityID),
            activityGeneration > 0,
            ReloIdentifier.isValid(interactionID),
            LiveActivityResponsePolicy.isCanonicalResponse(canonicalState, for: response.action)
        else { throw LiveActivityResponseConfirmationError.invalidConfirmation }
        self.accountID = response.accountID
        self.deviceID = response.deviceID
        self.notificationID = response.notificationID
        self.activityID = activityID
        self.activityGeneration = activityGeneration
        self.interactionID = interactionID
        self.action = response.action
        self.optionID = response.optionID
        self.idempotencyKey = response.idempotencyKey
        self.canonicalState = canonicalState
        self.confirmedAt = confirmedAt
        self.expiresAt = response.expiresAt
    }

    private enum CodingKeys: String, CodingKey {
        case accountID, deviceID, notificationID, activityID, activityGeneration, interactionID
        case action, optionID, idempotencyKey, canonicalState, confirmedAt, expiresAt
    }

    public init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        accountID = try values.decode(String.self, forKey: .accountID)
        deviceID = try values.decode(String.self, forKey: .deviceID)
        notificationID = try values.decode(String.self, forKey: .notificationID)
        activityID = try values.decode(String.self, forKey: .activityID)
        activityGeneration = try values.decodeIfPresent(Int.self, forKey: .activityGeneration) ?? 1
        guard activityGeneration > 0 else {
            throw DecodingError.dataCorruptedError(
                forKey: .activityGeneration,
                in: values,
                debugDescription: "Live Activity generation must be positive"
            )
        }
        interactionID = try values.decode(String.self, forKey: .interactionID)
        action = try values.decode(NotificationInteractionAction.self, forKey: .action)
        optionID = try values.decodeIfPresent(String.self, forKey: .optionID)
        idempotencyKey = try values.decode(String.self, forKey: .idempotencyKey)
        canonicalState = try values.decode(String.self, forKey: .canonicalState)
        confirmedAt = try values.decode(Date.self, forKey: .confirmedAt)
        expiresAt = try values.decode(Date.self, forKey: .expiresAt)
    }

    public func exactlyMatches(_ response: PendingNotificationResponse) -> Bool {
        response.accountID == accountID
            && response.deviceID == deviceID
            && response.notificationID == notificationID
            && response.activityID == activityID
            && response.activityGeneration == activityGeneration
            && response.interactionID == interactionID
            && response.action == action
            && response.idempotencyKey == idempotencyKey
    }

    public func response(using credential: String) -> PendingNotificationResponse {
        PendingNotificationResponse(
            accountID: accountID,
            deviceID: deviceID,
            notificationID: notificationID,
            action: action,
            value: optionID.map { ["optionId": $0] } ?? [:],
            idempotencyKey: idempotencyKey,
            expiresAt: expiresAt,
            endpoint: .liveActivity,
            activityID: activityID,
            activityGeneration: activityGeneration,
            interactionID: interactionID,
            responseCredential: credential
        )
    }
}

public enum LiveActivityResponseConfirmationError: Error, Equatable, Sendable {
    case invalidConfirmation
    case missingPendingResponse
    case responseMismatch
}

public struct LiveActivityResponseServerResult: Codable, Equatable, Sendable {
    public let state: String

    public static func decode(
        _ data: Data,
        expectedAction: NotificationInteractionAction
    ) throws -> Self {
        let result = try JSONDecoder().decode(Self.self, from: data)
        guard LiveActivityResponsePolicy.isCanonicalResponse(result.state, for: expectedAction) else {
            throw LiveActivityResponseConfirmationError.invalidConfirmation
        }
        return result
    }
}
