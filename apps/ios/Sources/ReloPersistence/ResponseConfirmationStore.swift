import Foundation
import ReloCore

extension AccountScopedProtectedActionStore {
    public func notificationFailures(now: Date) throws -> [NotificationResponseFailure] {
        let all = try decode([NotificationResponseFailure].self, from: "notification-response-failures.json") ?? []
        let bounded = NotificationResponseFailure.bounded(all, now: now)
        if bounded != all { try encode(bounded, to: "notification-response-failures.json") }
        return bounded
    }

    public func rejectNotification(_ response: PendingNotificationResponse, reason: NotificationDecisionRejection, at: Date) throws {
        var failures = try notificationFailures(now: at)
        failures.removeAll { $0.response.decisionKey == response.decisionKey }
        failures.append(.init(response: response, reason: reason, recordedAt: at))
        // Write the terminal fence first so interruption cannot replay the action.
        try encode(NotificationResponseFailure.bounded(failures, now: at), to: "notification-response-failures.json")
        try remove(id: response.id)
    }

    public func notificationConfirmations(now: Date) throws -> [NotificationResponseConfirmation] {
        let all = try loadNotificationConfirmations()
        let active = all.filter { max($0.expiresAt, $0.confirmedAt.addingTimeInterval(86_400)) > now }
        if active != all { try encode(active, to: "notification-response-confirmations.json") }
        return active
    }

    public func confirmNotification(
        _ response: PendingNotificationResponse,
        confirmedAt: Date
    ) throws -> NotificationResponseConfirmation {
        var confirmations = try loadNotificationConfirmations()
        if let existing = confirmations.first(where: { $0.decisionKey == response.decisionKey }) {
            guard existing.exactlyMatches(response) else {
                throw LiveActivityResponseConfirmationError.responseMismatch
            }
            return existing
        }
        var responses = try loadResponses()
        guard let index = responses.firstIndex(where: { $0.id == response.id }), responses[index] == response else {
            throw LiveActivityResponseConfirmationError.missingPendingResponse
        }
        let confirmation = try NotificationResponseConfirmation(response: response, confirmedAt: confirmedAt)
        responses.remove(at: index)
        confirmations.append(confirmation)
        try encode(responses, to: "pending-responses.json")
        try encode(Array(confirmations.suffix(256)), to: "notification-response-confirmations.json")
        return confirmation
    }
}
