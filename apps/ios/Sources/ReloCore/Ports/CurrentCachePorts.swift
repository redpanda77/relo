import Foundation

public protocol CurrentStateCaching: Sendable {
    func load() async throws -> CurrentCacheSnapshot
    func save(_ snapshot: CurrentCacheSnapshot) async throws
}

/// Bound once to immutable authority; no mutable global account or credentials are read here.
public enum CurrentCacheCapacityError: Error { case limitReached }
