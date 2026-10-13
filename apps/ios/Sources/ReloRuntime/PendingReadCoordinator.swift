import ReloCore
import Foundation

/// Durable read intent is secondary maintenance; current state and decisions never await it.
@MainActor
public final class PendingReadCoordinator {
    private struct Context {
        let scope: SessionScope
        let store: any PendingReadStoring
        let remote: any ReadItemsRemoteSource
    }
    private var context: Context?
    private var task: Task<Void, Never>?
    private var taskID: UUID?
    public private(set) var state = PendingReadState()
    private let changed: @MainActor (PendingReadState) -> Void
    private let confirmed: @MainActor (InboxUnreadSummary) -> Void
    public init(changed: @escaping @MainActor (PendingReadState) -> Void = { _ in },
                confirmed: @escaping @MainActor (InboxUnreadSummary) -> Void = { _ in }) {
        self.changed = changed; self.confirmed = confirmed
    }
    deinit { task?.cancel() }

    public func activate(scope: SessionScope, store: any PendingReadStoring, remote: any ReadItemsRemoteSource) {
        stop(); context = Context(scope: scope, store: store, remote: remote)
    }
    public func stop() { suspend(); context = nil; state = .init(); changed(state) }
    public func suspend() { task?.cancel(); task = nil; taskID = nil }

    @discardableResult public func enqueue(_ ids: [String]) async -> Bool {
        guard let captured = context, !Task.isCancelled else { return false }
        do {
            try await captured.store.enqueue(ids)
            let pending = try await captured.store.pending(limit: 1_000)
            guard owns(captured) else { return false }
            state.pendingIDs = Set(pending); state.issue = nil; changed(state)
            return true
        } catch {
            guard owns(captured) else { return false }
            state.issue = error as? PendingReadError == .full ? .full : .storage; changed(state)
            return false
        }
    }

    public func reconcileHistory(_ items: [InboxItem]) {
        let stillUnread = Set(items.filter { $0.readAt == nil }.map(\.id))
        state.confirmedIDs.formIntersection(stillUnread); changed(state)
    }

    public func flush() async {
        if let task { await task.value; return }
        guard let captured = context, !Task.isCancelled else { return }
        let id = UUID()
        let work = Task<Void, Never> { [weak self] in
            guard let self else { return }
            await self.drain(captured)
        }
        task = work; taskID = id
        await withTaskCancellationHandler { await work.value } onCancel: { work.cancel() }
        if taskID == id { task = nil; taskID = nil }
    }

    private func owns(_ captured: Context) -> Bool { !Task.isCancelled && context?.scope == captured.scope }

    private func drain(_ captured: Context) async {
        do {
            for _ in 0..<4 {
                let pending = try await captured.store.pending(limit: 1_000)
                guard owns(captured) else { return }
                state.pendingIDs = Set(pending); changed(state)
                let batch = Array(pending.prefix(250))
                guard !batch.isEmpty else { state.issue = nil; changed(state); return }
                let response = try await captured.remote.markReadItems(batch)
                guard owns(captured) else { return }
                guard response.isValid(for: batch) else { state.issue = .invalidResponse; changed(state); return }
                let acknowledged = Set(response.results.map(\.notificationId))
                try await captured.store.remove(acknowledged)
                guard owns(captured) else { return }
                state.pendingIDs.subtract(acknowledged)
                state.confirmedIDs.formUnion(acknowledged)
                state.confirmedIDs = Set(state.confirmedIDs.sorted().prefix(1_000))
                state.issue = nil; changed(state); confirmed(response.unread)
                // Partial acknowledgements are retained for a later pass, never guessed away.
                if acknowledged.count < batch.count { return }
            }
        } catch {
            guard owns(captured) else { return }
            state.issue = error as? InboxRemoteError == .unauthorized ? .authorization
                : error is PendingReadError ? .storage : .offline
            changed(state)
        }
    }
}
