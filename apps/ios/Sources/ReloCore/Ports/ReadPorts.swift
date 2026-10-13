import Foundation

public enum PendingReadError: Error, Equatable, Sendable { case full, invalidID, unavailable, corrupt, unsupportedVersion }

/// Instances are permanently bound to one origin/account/device. No mutable selection.
public protocol PendingReadStoring: Sendable {
    func enqueue(_ notificationIDs: [String]) async throws
    func pending(limit: Int) async throws -> [String]
    func remove(_ notificationIDs: Set<String>) async throws
}
