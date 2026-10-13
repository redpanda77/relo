import Foundation

public enum LiveActivityCommandOrderingPolicy {
    public static let maximumFutureSkew: TimeInterval = 300

    public static func evaluate(
        operation: LiveActivityCommand.Operation,
        incomingSequence: Int,
        incomingTimestamp: Date,
        expiresAt: Date?,
        observedSequence: Int,
        observedTimestamp: Date,
        now: Date
    ) -> LiveActivityCommandOrderingDecision {
        guard incomingSequence >= 0,
              incomingTimestamp.timeIntervalSince1970 >= 0,
              incomingTimestamp <= now.addingTimeInterval(maximumFutureSkew)
        else { return .conflict }
        if operation != .end, let expiresAt, expiresAt <= now { return .stale }
        if incomingSequence < observedSequence { return .stale }
        if incomingSequence == observedSequence { return .conflict }
        if incomingTimestamp < observedTimestamp { return .stale }
        return .apply
    }

    public static func permitsInitialStart(
        sequence: Int,
        timestamp: Date,
        expiresAt: Date?,
        now: Date
    ) -> Bool {
        guard sequence >= 0,
              timestamp.timeIntervalSince1970 >= 0,
              timestamp <= now.addingTimeInterval(maximumFutureSkew)
        else { return false }
        return expiresAt.map { $0 > now } ?? true
    }
}
