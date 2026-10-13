import Foundation

public protocol AccountScopedLiveActivityLedgerStoring: Sendable {
    func select(accountID: String, deviceID: String) async throws
    func load() async throws -> LiveActivityCommandLedger
    func save(_ ledger: LiveActivityCommandLedger) async throws
    func clearSelectedAccount() async throws
}

public protocol AccountScopedPendingResponseStoring: Sendable {
    func notificationFailures(now: Date) async throws -> [NotificationResponseFailure]
    func rejectNotification(_ response: PendingNotificationResponse, reason: NotificationDecisionRejection, at: Date) async throws
    func select(accountID: String, deviceID: String) async throws
    func enqueue(_ response: PendingNotificationResponse) async throws -> PendingResponseEnqueueResult
    func pending(now: Date) async throws -> [PendingNotificationResponse]
    func notificationConfirmations(now: Date) async throws -> [NotificationResponseConfirmation]
    func confirmNotification(
        _ response: PendingNotificationResponse,
        confirmedAt: Date
    ) async throws -> NotificationResponseConfirmation
    func remove(id: String) async throws
    func clearSelectedAccount() async throws
}
