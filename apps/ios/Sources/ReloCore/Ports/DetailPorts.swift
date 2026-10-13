import Foundation

public protocol NotificationDetailCaching: Sendable {
    func load(notificationID: String) async throws -> InboxItem?
    func save(_ item: InboxItem) async throws
    func clear() async throws
}

/// Exact-scope full content, separate from history. Most recently opened first.
/// Serialized envelope size (including metadata) is the 4 MiB limit.
