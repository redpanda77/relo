import Foundation
import ReloCore

extension CrossProcessResponseFile {
    public func confirmations(
        accountID: String,
        deviceID: String,
        now: Date
    ) throws -> [LiveActivityResponseConfirmation] {
        try withLock(accountID: accountID, deviceID: deviceID) { fileURL in
            var ledger = try load(fileURL)
            let before = ledger
            prune(&ledger, now: now)
            if ledger != before { try save(ledger, to: fileURL) }
            return ledger.confirmations
        }
    }

    public func notificationConfirmations(
        accountID: String,
        deviceID: String,
        now: Date
    ) throws -> [NotificationResponseConfirmation] {
        try withLock(accountID: accountID, deviceID: deviceID) { fileURL in
            var ledger = try load(fileURL)
            let before = ledger
            prune(&ledger, now: now)
            if ledger != before { try save(ledger, to: fileURL) }
            return ledger.notificationConfirmations
        }
    }

    public func notificationFailures(accountID: String, deviceID: String, now: Date) throws -> [NotificationResponseFailure] {
        try withLock(accountID: accountID, deviceID: deviceID) { fileURL in
            var ledger = try load(fileURL)
            let before = ledger
            prune(&ledger, now: now)
            if ledger != before { try save(ledger, to: fileURL) }
            return ledger.notificationFailures
        }
    }

    public func rejectNotification(_ response: PendingNotificationResponse, reason: NotificationDecisionRejection, at: Date) throws {
        try withLock(accountID: response.accountID, deviceID: response.deviceID) { fileURL in
            var ledger = try load(fileURL)
            guard !ledger.notificationConfirmations.contains(where: { $0.decisionKey == response.decisionKey }) else { return }
            if let stored = ledger.pending.first(where: { $0.id == response.id }), !sameProtectedDecision(stored, response) {
                throw LiveActivityResponseConfirmationError.responseMismatch
            }
            ledger.pending.removeAll { $0.id == response.id }
            ledger.notificationFailures.removeAll { $0.response.decisionKey == response.decisionKey }
            ledger.notificationFailures.append(.init(response: response, reason: reason, recordedAt: at))
            prune(&ledger, now: at)
            try save(ledger, to: fileURL)
        }
    }

    @discardableResult

    public func confirmNotification(
        _ response: PendingNotificationResponse,
        confirmedAt: Date
    ) throws -> NotificationResponseConfirmation {
        try withLock(accountID: response.accountID, deviceID: response.deviceID) { fileURL in
            var ledger = try load(fileURL)
            if let existing = ledger.notificationConfirmations.first(where: { $0.decisionKey == response.decisionKey }) {
                guard existing.exactlyMatches(response) else {
                    throw LiveActivityResponseConfirmationError.responseMismatch
                }
                return existing
            }
            let stored = ledger.pending.first(where: { $0.id == response.id })
                ?? ledger.notificationFailures.first(where: { $0.response.id == response.id && $0.reason == .expired })?.response
            guard let stored else {
                throw LiveActivityResponseConfirmationError.missingPendingResponse
            }
            guard sameProtectedDecision(stored, response) else {
                throw LiveActivityResponseConfirmationError.responseMismatch
            }
            let confirmation = try NotificationResponseConfirmation(response: response, confirmedAt: confirmedAt)
            ledger.pending.removeAll { $0.id == response.id }
            ledger.notificationFailures.removeAll { $0.response.id == response.id }
            ledger.notificationConfirmations.removeAll { $0.decisionKey == confirmation.decisionKey }
            ledger.notificationConfirmations.append(confirmation)
            ledger.notificationConfirmations = Array(ledger.notificationConfirmations.suffix(Self.maximumConfirmations))
            prune(&ledger, now: confirmedAt)
            try save(ledger, to: fileURL)
            return confirmation
        }
    }

    @discardableResult

    public func confirm(
        _ response: PendingNotificationResponse,
        canonicalState: String,
        confirmedAt: Date
    ) throws -> LiveActivityResponseConfirmation {
        try withLock(accountID: response.accountID, deviceID: response.deviceID) { fileURL in
            var ledger = try load(fileURL)
            prune(&ledger, now: confirmedAt)
            if let existing = ledger.confirmations.first(where: { $0.decisionKey == response.decisionKey }) {
                guard existing.exactlyMatches(response), existing.canonicalState == canonicalState else {
                    throw LiveActivityResponseConfirmationError.responseMismatch
                }
                return existing
            }
            guard let pendingIndex = ledger.pending.firstIndex(where: { $0.id == response.id }) else {
                throw LiveActivityResponseConfirmationError.missingPendingResponse
            }
            guard sameProtectedDecision(ledger.pending[pendingIndex], response) else {
                throw LiveActivityResponseConfirmationError.responseMismatch
            }
            let confirmation = try LiveActivityResponseConfirmation(
                response: response,
                canonicalState: canonicalState,
                confirmedAt: confirmedAt
            )
            ledger.pending.remove(at: pendingIndex)
            ledger.confirmations.removeAll { $0.decisionKey == confirmation.decisionKey }
            ledger.confirmations.append(confirmation)
            ledger.confirmations = Array(ledger.confirmations.suffix(Self.maximumConfirmations))
            try save(ledger, to: fileURL)
            return confirmation
        }
    }
}
