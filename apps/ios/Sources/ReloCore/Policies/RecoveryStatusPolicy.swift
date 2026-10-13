import Foundation

public enum RecoveryStatusPolicy {
    public static func current(_ state: CurrentRuntimeState?) -> OperationDiagnostic.Outcome {
        guard let state else { return .pending }
        if state.persistence == .unavailable { return .storageUnavailable }
        return switch state.connection {
        case .unauthorized: .unauthorized
        case .offline: .offline
        case .incompatible: .failed
        case .current: .confirmed
        case .inactive, .connecting: .pending
        }
    }
    public static func reads(_ state: PendingReadState) -> OperationDiagnostic.Outcome {
        switch state.issue {
        case .authorization: .unauthorized
        case .storage: .storageUnavailable
        case .offline: .offline
        case .full, .invalidResponse: .failed
        case nil: state.pendingIDs.isEmpty && !state.confirmedIDs.isEmpty ? .confirmed : .pending
        }
    }
    public static func receipts(_ state: ReceiptRecoveryState) -> OperationDiagnostic.Outcome {
        switch state.issue {
        case .unauthorized: .unauthorized
        case .storage: .storageUnavailable
        case .offline: .offline
        case .conflict, .incompatible: .failed
        case nil: state.acknowledged > 0 || state.retiredNotFound > 0 ? .confirmed : .pending
        }
    }
}
