import Foundation

/// Diagnostics accept only an allowlist of values. Never add content or error text.
public struct OperationDiagnostic: Codable, Equatable, Sendable, Identifiable {
    public enum Operation: String, Codable, Sendable, CaseIterable {
        case currentSync, responseSubmission, readReplay, receiptUpload, tokenRegistration
    }
    public enum Phase: String, Codable, Sendable { case started, persisted, requested, completed }
    public enum Outcome: String, Codable, Sendable {
        case pending, confirmed, expired, superseded, coalesced, awaitingToken, providerBackoff
        case offline, unauthorized, storageUnavailable, cancelled, failed
    }
    public enum Priority: String, Codable, Sendable { case immediate, current, maintenance }
    public let id: UUID
    public let correlationID: UUID
    public let operation: Operation
    public let phase: Phase
    public let timestamp: Date
    public let durationMilliseconds: Double?
    public let attempt: Int
    public let outcome: Outcome
    public let priority: Priority
    public let queueDepth: Int

    public init(operation: Operation, phase: Phase, correlationID: UUID = UUID(), timestamp: Date = .now,
                durationMilliseconds: Double? = nil, attempt: Int = 1, outcome: Outcome,
                priority: Priority, queueDepth: Int = 0, id: UUID = UUID()) {
        self.id = id; self.correlationID = correlationID; self.operation = operation; self.phase = phase
        self.timestamp = timestamp
        self.durationMilliseconds = durationMilliseconds.flatMap { $0.isFinite ? max(0, min($0, 86_400_000)) : nil }
        self.attempt = max(0, min(attempt, 1_000_000)); self.outcome = outcome; self.priority = priority
        self.queueDepth = max(0, min(queueDepth, 1_000_000))
    }

    /// This exact allowlisted string is the only payload passed to OSLog.
    public var redactedDescription: String {
        "\(operation.rawValue) \(phase.rawValue) \(outcome.rawValue) correlation=\(correlationID.uuidString) priority=\(priority.rawValue) attempt=\(attempt) depth=\(queueDepth) duration_ms=\(durationMilliseconds ?? 0)"
    }

    public static func outcome(for error: any Error) -> Outcome {
        if error is CancellationError { return .cancelled }
        if let error = error as? MobileAPIError {
            switch error {
            case .reauthenticationRequired, .forbidden, .invalidCredentials, .accountDisabled: return .unauthorized
            case .unavailable, .serverUnreachable: return .offline
            case .rateLimited: return .providerBackoff
            case .decisionRejected(let reason): return reason == .expired ? .expired : reason == .superseded || reason == .versionMismatch ? .superseded : .failed
            default: return .failed
            }
        }
        if let error = error as? URLError {
            switch error.code {
            case .cancelled: return .cancelled
            case .notConnectedToInternet, .networkConnectionLost, .timedOut, .cannotConnectToHost: return .offline
            default: return .failed
            }
        }
        return .failed
    }
}
