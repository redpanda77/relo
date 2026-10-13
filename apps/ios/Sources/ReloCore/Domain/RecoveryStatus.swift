import Foundation

public enum RecoveryStatus: String, Codable, Sendable {
    case pending, pausedForAuth, pausedForStorage, retrying, confirmed, notSentExpired, notSentReplaced, failed

    public init(outcome: OperationDiagnostic.Outcome) {
        self = switch outcome {
        case .confirmed: .confirmed
        case .expired: .notSentExpired
        case .superseded, .coalesced: .notSentReplaced
        case .unauthorized: .pausedForAuth
        case .storageUnavailable: .pausedForStorage
        case .offline, .providerBackoff: .retrying
        case .pending, .awaitingToken, .cancelled: .pending
        case .failed: .failed
        }
    }
}

public struct RecoveryQueueStatus: Equatable, Sendable, Identifiable {
    public var id: OperationDiagnostic.Operation { operation }
    public let operation: OperationDiagnostic.Operation
    public let status: RecoveryStatus
    /// Nil means the queue has not been read; never display it as an empty queue.
    public let depth: Int?
    public let lastConfirmedAt: Date?
    public init(operation: OperationDiagnostic.Operation, status: RecoveryStatus, depth: Int?, lastConfirmedAt: Date?) {
        self.operation = operation; self.status = status; self.depth = depth.map { max(0, $0) }
        self.lastConfirmedAt = lastConfirmedAt
    }
}
