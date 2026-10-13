import ReloCore
import Foundation

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
        sleep: @escaping @Sendable (Duration) async throws -> Void = { delay in
            try await Task.sleep(for: delay)
        }
    ) async -> LiveActivityTokenRegistrationOutcome {
        guard !Task.isCancelled else { return .cancelled }
        guard candidate.isValid else { return .invalid }
        return await run(retryDelays: retryDelays, attempt: { await attempt(candidate) }, sleep: sleep)
    }

    public static func run(
        retryDelays: [Duration] = retryDelays,
        attempt: @escaping @Sendable () async -> LiveActivityTokenRegistrationAttempt,
        sleep: @escaping @Sendable (Duration) async throws -> Void = { delay in
            try await Task.sleep(for: delay)
        }
    ) async -> LiveActivityTokenRegistrationOutcome {
        for attemptIndex in 0...retryDelays.count {
            guard !Task.isCancelled else { return .cancelled }
            let result = await attempt()
            guard !Task.isCancelled else { return .cancelled }
            switch result {
            case .registered:
                return .registered
            case .terminal:
                return .terminal
            case .retryable:
                guard attemptIndex < retryDelays.count else { return .exhausted }
                do { try await sleep(retryDelays[attemptIndex]) }
                catch is CancellationError { return .cancelled }
                catch { return Task.isCancelled ? .cancelled : .exhausted }
                guard !Task.isCancelled else { return .cancelled }
            }
        }
        return .exhausted
    }
}
