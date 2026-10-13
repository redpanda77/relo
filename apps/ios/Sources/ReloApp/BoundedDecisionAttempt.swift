import Foundation

/// The delegate must finish even when an adapter ignores cancellation. A
/// structured task group would wait for that adapter after the deadline.
/// This owner resumes once, cancels both tasks, and fences late completion.
@MainActor
final class BoundedDecisionAttempt {
    private var continuation: CheckedContinuation<Bool, Never>?
    private var operation: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?

    static func run(
        waitForDeadline: @escaping @Sendable () async throws -> Void = { try await Task.sleep(for: .seconds(5)) },
        operation: @escaping @MainActor () async -> Bool
    ) async -> Bool {
        let owner = BoundedDecisionAttempt()
        return await withTaskCancellationHandler {
            guard !Task.isCancelled else { return false }
            return await withCheckedContinuation { continuation in
                owner.continuation = continuation
                owner.operation = Task { @MainActor in owner.finish(await operation()) }
                owner.watchdog = Task { @MainActor in
                    do { try await waitForDeadline() } catch { return }
                    owner.finish(false)
                }
            }
        } onCancel: {
            Task { @MainActor in owner.finish(false) }
        }
    }

    private func finish(_ result: Bool) {
        guard let continuation else { return }
        self.continuation = nil
        operation?.cancel(); watchdog?.cancel()
        operation = nil; watchdog = nil
        continuation.resume(returning: result)
    }
}

@MainActor
final class BackgroundNotificationActionCoordinator {
    static let shared = BackgroundNotificationActionCoordinator()
    private var handler: ((NotificationActionRequest) async -> Void)?
    private let waitForDeadline: @Sendable () async throws -> Void

    init(waitForDeadline: @escaping @Sendable () async throws -> Void = { try await Task.sleep(for: .seconds(5)) }) {
        self.waitForDeadline = waitForDeadline
    }

    func install(model: AppModel) {
        handler = { [weak model] request in await model?.respondToNotificationAction(request) }
    }

    func handle(_ request: NotificationActionRequest) async {
        guard let handler else { return }
        _ = await BoundedDecisionAttempt.run(waitForDeadline: waitForDeadline) {
            await handler(request)
            return true
        }
    }
}
