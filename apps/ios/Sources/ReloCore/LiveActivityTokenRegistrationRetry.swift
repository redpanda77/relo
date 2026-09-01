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
}

public enum LiveActivityTokenRegistrationRetrier {
    /// Four bounded waits produce at most five attempts inside ActivityKit's background runtime.
    public static let retryDelays: [Duration] = [
        .milliseconds(500),
        .seconds(1),
        .seconds(2),
        .seconds(4),
    ]

    public static func run(
        _ candidate: LiveActivityTokenRegistrationCandidate,
        retryDelays: [Duration] = retryDelays,
        attempt: @escaping @Sendable (LiveActivityTokenRegistrationCandidate) async -> LiveActivityTokenRegistrationAttempt,
        sleep: @escaping @Sendable (Duration) async -> Void = { delay in
            try? await Task.sleep(for: delay)
        }
    ) async -> LiveActivityTokenRegistrationOutcome {
        guard candidate.isValid else { return .invalid }
        return await run(retryDelays: retryDelays, attempt: { await attempt(candidate) }, sleep: sleep)
    }

    public static func run(
        retryDelays: [Duration] = retryDelays,
        attempt: @escaping @Sendable () async -> LiveActivityTokenRegistrationAttempt,
        sleep: @escaping @Sendable (Duration) async -> Void = { delay in
            try? await Task.sleep(for: delay)
        }
    ) async -> LiveActivityTokenRegistrationOutcome {
        for attemptIndex in 0...retryDelays.count {
            switch await attempt() {
            case .registered:
                return .registered
            case .terminal:
                return .terminal
            case .retryable:
                guard attemptIndex < retryDelays.count else { return .exhausted }
                await sleep(retryDelays[attemptIndex])
            }
        }
        return .exhausted
    }
}
