import Foundation
import ReloCore

extension AccountScopedProtectedActionStore {
    public func enqueue(_ response: PendingNotificationResponse) throws -> PendingResponseEnqueueResult {
        if let failure = try notificationFailures(now: .now).first(where: { $0.response.decisionKey == response.decisionKey }) { throw failure }
        if response.endpoint == .notification,
           let existing = try loadNotificationConfirmations().first(where: { $0.decisionKey == response.decisionKey }) {
            return .alreadyNotificationConfirmed(existing)
        }
        var responses = try loadResponses()
        if let index = responses.firstIndex(where: { $0.decisionKey == response.decisionKey }) {
            responses[index] = responses[index].bindingMetadata(from: response)
            try encode(responses, to: "pending-responses.json")
            return .alreadyPending(responses[index])
        }
        responses.append(response)
        try encode(responses, to: "pending-responses.json")
        return .enqueued
    }

    public func pending(now: Date) throws -> [PendingNotificationResponse] {
        let all = try loadResponses()
        for response in all where response.endpoint == .notification && response.expiresAt <= now {
            try rejectNotification(response, reason: .expired, at: now)
        }
        let rejectedIDs = Set(try notificationFailures(now: now).map { $0.response.id })
        let active = all.filter { $0.expiresAt > now && !rejectedIDs.contains($0.id) }
        if active != all { try encode(active, to: "pending-responses.json") }
        return active
    }

    public func remove(id: String) throws {
        let remaining = try loadResponses().filter { $0.id != id }
        try encode(remaining, to: "pending-responses.json")
    }
}
