import ReloNotificationSupport
import ReloCore
import Foundation

public actor FileScopedNotificationReceiptStore: ScopedNotificationReceiptStoring {
    private let file: NotificationReceiptFile
    public init(baseDirectory: URL) { file = NotificationReceiptFile(baseDirectory: baseDirectory) }
    public func pending(scope: ReceiptScope, limit: Int) throws -> NotificationReceiptBatch { try file.pending(scope: scope, limit: limit) }
    public func remove(records: Set<NotificationReceiptRecord>) throws { try file.remove(records: records) }
    public func retire(scope: ReceiptScope) throws { try file.retire(scope: scope) }
}
