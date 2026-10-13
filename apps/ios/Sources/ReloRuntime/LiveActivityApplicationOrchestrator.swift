import ReloCore
import Foundation

public enum LiveActivityApplicationOrchestrator {
    public static func apply(
        coordinator: LiveActivityCommandCoordinator,
        envelope: LiveActivityCommandEnvelope,
        expected: LiveActivitySystemSnapshot,
        priorActive: LiveActivitySystemSnapshot?,
        observed: LiveActivitySystemSnapshot?,
        isolation: isolated (any Actor)? = #isolation,
        mutation: () async throws -> Void
    ) async -> LiveActivityApplicationOutcome {
        do {
            if let journal = try await coordinator.applicationJournal(for: envelope) {
                switch LiveActivityApplicationJournalPolicy.reconcile(journal, observed: observed) {
                case .recordOrReuseReceipt:
                    try await coordinator.recordApplicationSuccess(for: envelope)
                    return .applied
                case .finishWithoutReceipt:
                    try await coordinator.discardApplicationJournal(for: envelope)
                    return .ignored
                case .indeterminate:
                    return .failed
                case .apply:
                    break
                }
            } else {
                try await coordinator.prepareApplication(
                    for: envelope,
                    expected: expected,
                    priorActive: priorActive
                )
            }

            try await coordinator.markApplicationInvocationStarted(for: envelope)
            try await mutation()
            try await coordinator.recordApplicationSuccess(for: envelope)
            return .applied
        } catch {
            return .failed
        }
    }
}
