import ReloCore
import Foundation

public actor InMemoryProtectedActionStore: AccountScopedLiveActivityLedgerStoring, AccountScopedPendingResponseStoring {
    private var ledger = LiveActivityCommandLedger()
    private var responses: [PendingNotificationResponse] = []
    private var notificationResponseConfirmations: [NotificationResponseConfirmation] = []
    private var failures: [NotificationResponseFailure] = []

    public init() {}
    public func select(accountID: String, deviceID: String) {}
    public func load() -> LiveActivityCommandLedger { ledger }
    public func save(_ ledger: LiveActivityCommandLedger) { self.ledger = ledger }
    public func enqueue(_ response: PendingNotificationResponse) throws -> PendingResponseEnqueueResult {
        if let failure = failures.first(where: { $0.response.decisionKey == response.decisionKey }) { throw failure }
        if let existing = notificationResponseConfirmations.first(where: { $0.decisionKey == response.decisionKey }) {
            return .alreadyNotificationConfirmed(existing)
        }
        if let index = responses.firstIndex(where: { $0.decisionKey == response.decisionKey }) {
            responses[index] = responses[index].bindingMetadata(from: response)
            return .alreadyPending(responses[index])
        }
        responses.append(response)
        return .enqueued
    }
    public func pending(now: Date) -> [PendingNotificationResponse] {
        for response in responses where response.endpoint == .notification && response.expiresAt <= now {
            failures.removeAll { $0.response.decisionKey == response.decisionKey }
            failures.append(.init(response: response, reason: .expired, recordedAt: now))
        }
        responses.removeAll { $0.expiresAt <= now }
        return responses
    }
    public func notificationFailures(now: Date) -> [NotificationResponseFailure] {
        failures = NotificationResponseFailure.bounded(failures, now: now)
        return failures
    }
    public func rejectNotification(_ response: PendingNotificationResponse, reason: NotificationDecisionRejection, at: Date) {
        responses.removeAll { $0.id == response.id }
        failures.removeAll { $0.response.decisionKey == response.decisionKey }
        failures.append(.init(response: response, reason: reason, recordedAt: at))
        failures = NotificationResponseFailure.bounded(failures, now: at)
    }
    public func notificationConfirmations(now: Date) -> [NotificationResponseConfirmation] {
        notificationResponseConfirmations.removeAll {
            max($0.expiresAt, $0.confirmedAt.addingTimeInterval(86_400)) <= now
        }
        return notificationResponseConfirmations
    }
    public func confirmNotification(
        _ response: PendingNotificationResponse,
        confirmedAt: Date
    ) throws -> NotificationResponseConfirmation {
        if let existing = notificationResponseConfirmations.first(where: { $0.decisionKey == response.decisionKey }) {
            guard existing.exactlyMatches(response) else {
                throw LiveActivityResponseConfirmationError.responseMismatch
            }
            return existing
        }
        guard let index = responses.firstIndex(where: { $0 == response }) else {
            throw LiveActivityResponseConfirmationError.missingPendingResponse
        }
        let confirmation = try NotificationResponseConfirmation(response: response, confirmedAt: confirmedAt)
        responses.remove(at: index)
        notificationResponseConfirmations.append(confirmation)
        return confirmation
    }
    public func remove(id: String) { responses.removeAll { $0.id == id } }
    public func clearSelectedAccount() {
        ledger = LiveActivityCommandLedger()
        responses = []
        notificationResponseConfirmations = []
        failures = []
    }
}
