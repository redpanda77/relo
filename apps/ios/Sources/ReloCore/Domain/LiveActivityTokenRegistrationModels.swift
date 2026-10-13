import Foundation

public struct LiveActivityTokenRegistrationCandidate: Equatable, Sendable {
    public let activityID: String
    public let generation: Int
    public let nativeActivityID: String
    public let token: String
    public let accountID: String

    public init(
        activityID: String,
        generation: Int,
        nativeActivityID: String,
        token: String,
        accountID: String
    ) {
        self.activityID = activityID
        self.generation = generation
        self.nativeActivityID = nativeActivityID
        self.token = token
        self.accountID = accountID
    }

    public var isValid: Bool {
        ReloIdentifier.isValid(activityID)
            && generation > 0
            && !nativeActivityID.isEmpty
            && !token.isEmpty
    }

    public var identity: LiveActivityIdentity {
        LiveActivityIdentity(activityID: activityID, generation: generation)
    }

    public func matches(accountID credentialAccountID: String?) -> Bool {
        accountID == credentialAccountID
    }
}

public enum LiveActivityTokenRegistrationAttempt: Equatable, Sendable {
    case registered
    case retryable
    case terminal
}

public enum LiveActivityTokenRegistrationOutcome: Equatable, Sendable {
    case registered
    case exhausted
    case terminal
    case invalid
    case cancelled
}
