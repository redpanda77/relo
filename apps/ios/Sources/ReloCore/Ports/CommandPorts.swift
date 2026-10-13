import Foundation

public protocol PendingNotificationReceiptStoring: Sendable {
    func pending(limit: Int) throws -> [String]
    func remove(notificationIDs: Set<String>) throws
}
