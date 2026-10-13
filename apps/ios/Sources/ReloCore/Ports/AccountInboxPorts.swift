import Foundation

public enum InboxCacheRecovery: Equatable, Sendable { case corrupt, retiredSchema }

public enum AccountScopedInboxCacheError: Error, Equatable {
    case invalidAccountId
    case accountNotSelected
}

public protocol AccountScopedInboxCaching: InboxCache {
    func select(accountId: String) async throws
    func boundCache(for accountId: String) async throws -> any InboxCache
    func clearSelectedAccount() async throws
}
