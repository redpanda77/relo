import Foundation
import ReloCore

extension CrossProcessResponseFile {
    public func enqueue(_ response: PendingNotificationResponse) throws -> PendingResponseEnqueueResult {
        try withLock(accountID: response.accountID, deviceID: response.deviceID) { fileURL in
            var ledger = try load(fileURL)
            let before = ledger
            prune(&ledger, now: .now)
            if ledger != before { try save(ledger, to: fileURL) }
            if let failure = ledger.notificationFailures.first(where: { $0.response.decisionKey == response.decisionKey }) {
                throw failure
            }
            if let existing = ledger.confirmations.first(where: { $0.decisionKey == response.decisionKey }) {
                return .alreadyConfirmed(existing)
            }
            if let existing = ledger.notificationConfirmations.first(where: { $0.decisionKey == response.decisionKey }) {
                return .alreadyNotificationConfirmed(existing)
            }
            if let index = ledger.pending.firstIndex(where: { $0.decisionKey == response.decisionKey }) {
                ledger.pending[index] = ledger.pending[index].bindingMetadata(from: response)
                let selected = ledger.pending[index]
                prune(&ledger, now: .now)
                try save(ledger, to: fileURL)
                if let failure = ledger.notificationFailures.first(where: { $0.response.decisionKey == response.decisionKey }) {
                    throw failure
                }
                return .alreadyPending(selected)
            }
            ledger.pending.append(response)
            try save(ledger, to: fileURL)
            return .enqueued
        }
    }

    public func pending(accountID: String, deviceID: String, now: Date) throws -> [PendingNotificationResponse] {
        try withLock(accountID: accountID, deviceID: deviceID) { fileURL in
            var ledger = try load(fileURL)
            let before = ledger
            prune(&ledger, now: now)
            if ledger != before { try save(ledger, to: fileURL) }
            return ledger.pending
        }
    }

    public func remove(id: String, accountID: String, deviceID: String) throws {
        try withLock(accountID: accountID, deviceID: deviceID) { fileURL in
            var ledger = try load(fileURL)
            ledger.pending.removeAll { $0.id == id }
            try save(ledger, to: fileURL)
        }
    }

    public func clear(accountID: String, deviceID: String) throws {
        try withLock(accountID: accountID, deviceID: deviceID) { fileURL in
            if FileManager.default.fileExists(atPath: fileURL.path) {
                try FileManager.default.removeItem(at: fileURL)
            }
        }
    }
}
