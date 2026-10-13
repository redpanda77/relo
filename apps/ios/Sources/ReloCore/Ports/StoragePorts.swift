import Foundation

public enum InboxStorageError: Error, Equatable, Sendable {
    case unavailable
    case corrupt
    case unsupportedSchema(Int)
}

/// Synchronous operations run inside the owning cache actor. Replacement must be atomic.
public protocol InboxStorageIO: Sendable {
    func read(url: URL) throws -> Data
    func replace(data: Data, at url: URL) throws
    func remove(url: URL) throws
}
