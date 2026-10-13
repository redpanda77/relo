import ReloCore
import Foundation

public actor NotificationReceiptStorageAccess {
    private let store: any PendingNotificationReceiptStoring
    public init(store: any PendingNotificationReceiptStoring) { self.store = store }
    public func pending(limit: Int) throws -> [String] { try store.pending(limit: limit) }
    public func remove(notificationIDs: Set<String>) throws { try store.remove(notificationIDs: notificationIDs) }
}
