import Foundation

/// Bounded independent recovery lanes. Current state and new decisions never join these tasks.
@MainActor
public final class ScopedMaintenanceCoordinator {
    public enum Lane: Hashable, Sendable { case commands, reads, receipts, notificationReceipts, health, nativeActivities, history }
    private struct Work { let id: UUID; let task: Task<Void, Never> }
    private var scope: String?
    private var generation: UInt64 = 0
    private var work: [Lane: Work] = [:]
    private var pending: [Lane: @MainActor () async -> Void] = [:]
    private var polling: Task<Void, Never>?
    private let sleep: @Sendable (Duration) async throws -> Void

    public init(sleep: @escaping @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }) {
        self.sleep = sleep
    }

    deinit { work.values.forEach { $0.task.cancel() }; polling?.cancel() }

    public func bind(scope: String?) {
        guard self.scope != scope else { return }
        stop(); self.scope = scope
    }

    public func stop() {
        generation &+= 1; scope = nil
        work.values.forEach { $0.task.cancel() }; polling?.cancel()
        work = [:]; pending = [:]; polling = nil
    }

    public func request(_ lane: Lane, operation: @escaping @MainActor () async -> Void) {
        guard scope != nil else { return }
        pending[lane] = operation
        guard work[lane] == nil else { return }
        let captured = generation, id = UUID()
        work[lane] = Work(id: id, task: Task { [weak self] in
            await self?.drain(lane, id: id, generation: captured)
        })
    }

    public func wait(for lane: Lane) async { await work[lane]?.task.value }

    public func startPolling(delay: @escaping @MainActor (Int) -> Duration,
                             tick: @escaping @MainActor () -> Void) {
        guard scope != nil, polling == nil else { return }
        let captured = generation
        polling = Task { [weak self, sleep] in
            var attempt = 0
            while !Task.isCancelled {
                do { try await sleep(delay(attempt)) } catch { return }
                guard let self, self.generation == captured, self.scope != nil, !Task.isCancelled else { return }
                tick(); attempt = min(attempt + 1, 5)
            }
        }
    }

    private func drain(_ lane: Lane, id: UUID, generation captured: UInt64) async {
        defer { if generation == captured, work[lane]?.id == id { work[lane] = nil } }
        while generation == captured, scope != nil, !Task.isCancelled,
              let operation = pending.removeValue(forKey: lane) {
            await operation()
        }
    }
}
