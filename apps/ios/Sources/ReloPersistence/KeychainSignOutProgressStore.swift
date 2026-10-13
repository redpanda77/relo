import Foundation
import ReloCore

public struct KeychainSignOutProgressStore: SignOutProgressStore, Sendable {
    private let store: KeychainCodableStore<SignOutProgress>

    public init(service: String = "com.example.relo.notifications", account: String = "sign-out-progress") {
        store = KeychainCodableStore(
            service: service,
            account: account,
            schemaVersion: LocalStoreSchema.signOutProgress
        )
    }

    public func load() throws -> SignOutProgress? { try store.load() }
    public func save(_ progress: SignOutProgress) throws { try store.save(progress) }
    public func delete() throws { try store.delete() }
}
