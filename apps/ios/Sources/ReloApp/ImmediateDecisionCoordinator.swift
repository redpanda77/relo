import Foundation

/// Joins attempts for one exact durable decision without serializing unrelated
/// decisions behind network waits. Persistence precedes entry to this owner.
@MainActor
final class ImmediateDecisionCoordinator {
    struct Key: Hashable {
        let scope: String
        let decision: String
    }

    private var submissions: [Key: Task<Bool, Never>] = [:]

    func submit(key: Key, operation: @escaping @MainActor () async -> Bool) async -> Bool {
        if let existing = submissions[key] { return await existing.value }
        let task = Task { @MainActor in await BoundedDecisionAttempt.run(operation: operation) }
        submissions[key] = task
        defer { submissions[key] = nil }
        return await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            task.cancel()
        }
    }
}
