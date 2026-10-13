import ReloCore
import Foundation

public actor AccountScopedCrossProcessResponseStore: AccountScopedPendingResponseStoring {
    private let file: CrossProcessResponseFile
    private var selectedAccountID: String?
    private var selectedDeviceID: String?

    public init(baseDirectory: URL) {
        self.file = CrossProcessResponseFile(baseDirectory: baseDirectory)
    }

    public func select(accountID: String, deviceID: String) {
        selectedAccountID = accountID
        selectedDeviceID = deviceID
    }

    public func enqueue(_ response: PendingNotificationResponse) throws -> PendingResponseEnqueueResult {
        try file.enqueue(response)
    }

    public func notificationFailures(now: Date) throws -> [NotificationResponseFailure] {
        let (accountID, deviceID) = try selectedIDs()
        return try file.notificationFailures(accountID: accountID, deviceID: deviceID, now: now)
    }

    public func rejectNotification(_ response: PendingNotificationResponse, reason: NotificationDecisionRejection, at: Date) throws {
        try file.rejectNotification(response, reason: reason, at: at)
    }

    public func pending(now: Date) throws -> [PendingNotificationResponse] {
        let (accountID, deviceID) = try selectedIDs()
        return try file.pending(accountID: accountID, deviceID: deviceID, now: now)
    }

    public func notificationConfirmations(now: Date) throws -> [NotificationResponseConfirmation] {
        let (accountID, deviceID) = try selectedIDs()
        return try file.notificationConfirmations(accountID: accountID, deviceID: deviceID, now: now)
    }

    public func confirmNotification(
        _ response: PendingNotificationResponse,
        confirmedAt: Date
    ) throws -> NotificationResponseConfirmation {
        try file.confirmNotification(response, confirmedAt: confirmedAt)
    }

    public func remove(id: String) throws {
        let (accountID, deviceID) = try selectedIDs()
        try file.remove(id: id, accountID: accountID, deviceID: deviceID)
    }

    public func clearSelectedAccount() throws {
        let (accountID, deviceID) = try selectedIDs()
        try file.clear(accountID: accountID, deviceID: deviceID)
    }

    private func selectedIDs() throws -> (String, String) {
        guard let selectedAccountID, let selectedDeviceID else {
            throw AccountScopedInboxCacheError.accountNotSelected
        }
        return (selectedAccountID, selectedDeviceID)
    }
}
