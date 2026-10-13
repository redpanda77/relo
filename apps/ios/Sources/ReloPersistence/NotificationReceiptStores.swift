import ReloCore
import Foundation
import ReloNotificationSupport

public struct FilePendingNotificationReceiptStore: PendingNotificationReceiptStoring, Sendable {
    private let file: NotificationReceiptFile

    public init(baseDirectory: URL, filename: String = "pending-notification-receipts.json", maximumStored: Int = 200) {
        file = NotificationReceiptFile(baseDirectory: baseDirectory, filename: filename, maximumStored: maximumStored)
    }
    @discardableResult public func add(notificationID: String) throws -> ReceiptAppendResult {
        try file.append(id: notificationID)
    }
    public func pending(limit: Int) throws -> [String] { try file.pending(limit: limit) }
    public func remove(notificationIDs: Set<String>) throws { try file.remove(ids: notificationIDs) }
}
