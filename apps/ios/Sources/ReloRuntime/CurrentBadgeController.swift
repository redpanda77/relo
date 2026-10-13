import Foundation

/// One writer prevents a slow previous update from overwriting the newest global count.
@MainActor
public final class CurrentBadgeController {
    private let write: @MainActor (Int) async -> Void
    private var desired: Int?
    private var applied: Int?
    private var task: Task<Void, Never>?
    public init(write: @escaping @MainActor (Int) async -> Void) { self.write = write }
    deinit { task?.cancel() }
    public func set(_ count: Int) {
        desired = max(0, count)
        guard task == nil, desired != applied else { return }
        task = Task { [weak self] in
            guard let self else { return }
            defer { self.task = nil }
            while !Task.isCancelled, let value = self.desired, value != self.applied {
                await self.write(value)
                self.applied = value
            }
        }
    }
    public func waitForUpdate() async { await task?.value }
}
