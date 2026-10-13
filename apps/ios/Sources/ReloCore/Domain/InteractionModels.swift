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
        selectedAction: NotificationInteractionAction? = nil
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
    }

    private enum CodingKeys: String, CodingKey {
        case id, notificationID, targetDeviceID, accountID, kind, state, credential
        case expiresAtUnixSeconds, responsePhase, selectedAction
    }

    public var expiresAt: Date {
        Date(timeIntervalSince1970: TimeInterval(expiresAtUnixSeconds))
    }

    public var isValidForPresentation: Bool {
        let kinds = Set(["approval", "yes_no", "text"])
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
    }

    public var description: String {
        let phaseDescription = responsePhase?.rawValue ?? "none"
        let actionDescription = selectedAction?.rawValue ?? "none"
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

public struct InboxInteraction: Codable, Equatable, Sendable {
    public enum Kind: String, Codable, Sendable {
        case approval
        case yesNo = "yes_no"
        case text
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

    public init(
        id: String,
        kind: Kind,
        prompt: String,
        state: State,
        expiresAt: Date,
        respondedAt: Date? = nil
    ) {
        self.id = id
        self.kind = kind
        self.prompt = prompt
        self.state = state
        self.expiresAt = expiresAt
        self.respondedAt = respondedAt
    }
}

public enum NotificationInteractionAction: String, Codable, Equatable, Sendable {
    case approve
    case deny
    case yes
    case no
    case answer
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
