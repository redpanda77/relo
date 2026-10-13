import Foundation

/// One coalesced history repair per scope; cancelling never joins an obsolete transport.
@MainActor
public final class HistoryRepairCoordinator {
    private var scope: String?
    private var generation: UInt64 = 0
    private var task: Task<Bool, Never>?
    private var requestedAgain = false
    public init() {}
    deinit { task?.cancel() }

    public func stop() {
        generation &+= 1; scope = nil; task?.cancel(); task = nil; requestedAgain = false
    }

    public func repair(scope: String, operation: @escaping @MainActor () async -> Bool) async -> Bool {
        if self.scope != scope { stop(); self.scope = scope }
        if let task { requestedAgain = true; return await task.value }
        let captured = generation
        let work = Task { [weak self] in
            guard let self else { return false }
            defer { if self.generation == captured { self.task = nil } }
            var repaired = false
            repeat {
                self.requestedAgain = false
                let result = await operation()
                guard !Task.isCancelled, self.generation == captured else { return false }
                repaired = repaired || result
            } while self.requestedAgain
            return repaired
        }
        task = work
        return await work.value
    }
}
