import ReloCore
import Foundation

@MainActor public final class ReceiptCoordinator {
    private struct Context {
        let session: SessionScope
        let receipt: ReceiptScope
        let store: any ScopedNotificationReceiptStoring
        let remote: any NotificationReceiptRemoteSource
    }
    private var context: Context?
    private var task: Task<Void, Never>?
    private var taskID: UUID?
    public private(set) var state = ReceiptRecoveryState()
    private let changed: @MainActor (ReceiptRecoveryState) -> Void
    public init(changed: @escaping @MainActor (ReceiptRecoveryState) -> Void = { _ in }) { self.changed = changed }
    deinit { task?.cancel() }

    public func activate(scope: SessionScope, store: any ScopedNotificationReceiptStoring,
                         remote: any NotificationReceiptRemoteSource) throws {
        let receipt = try ReceiptScope(serverOrigin: scope.storage.serverOrigin,
            accountId: scope.storage.accountID, deviceId: scope.storage.deviceID)
        stop()
        context = Context(session: scope, receipt: receipt, store: store, remote: remote)
        state.scope = scope; changed(state)
    }
    public func stop() { suspend(); context = nil; state = .init(); changed(state) }
    public func suspend() { task?.cancel(); task = nil; taskID = nil }
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
    private func owns(_ captured: Context) -> Bool { !Task.isCancelled && context?.session == captured.session }
    private func drain(_ captured: Context) async {
        let batch: NotificationReceiptBatch
        do { batch = try await captured.store.pending(scope: captured.receipt, limit: 25) }
        catch {
            if owns(captured) { state.issue = .storage; changed(state) }
            return
        }
        guard owns(captured) else { return }
        state.retiredUnscoped = batch.retiredUnscopedCount; state.issue = nil; changed(state)
        for record in batch.records.prefix(25) {
            guard owns(captured) else { return }
            guard record.scope == captured.receipt else { state.issue = .incompatible; changed(state); return }
            let outcome: NotificationReceiptOutcome
            do { outcome = try await captured.remote.submit(record) }
            catch {
                guard owns(captured) else { return }
                switch error as? NotificationReceiptRemoteError {
                case .unauthorized: state.issue = .unauthorized
                case .conflict: state.issue = .conflict
                case .incompatible, .scopeMismatch: state.issue = .incompatible
                default: state.issue = .offline
                }
                changed(state); return
            }
            guard owns(captured) else { return }
            do { try await captured.store.remove(records: [record]) }
            catch {
                if owns(captured) { state.issue = .storage; changed(state) }
                return
            }
            guard owns(captured) else { return }
            switch outcome {
            case .acknowledged: state.acknowledged += 1
            case .notFound: state.retiredNotFound += 1
            }
            changed(state)
        }
    }
}
