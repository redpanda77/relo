import Foundation
import ReloCore

/// The code the wizard showed and its bind half (docs/ENCRYPTION-PROTOCOL.md, "Key binding"), in the Keychain for the
/// code's 30 minutes so the key check still runs after the app was backgrounded or relaunched. One code at a time.
public struct KeychainComputerInviteStore: ComputerInviteStoring, Sendable {
    private let store: KeychainCodableStore<ReloPendingComputerInvite>

    public init(service: String = "com.example.relo.notifications", account: String = "computer-invite") {
        store = KeychainCodableStore(service: service, account: account, schemaVersion: LocalStoreSchema.computerInvite)
    }

    public func load() throws -> ReloPendingComputerInvite? { try store.load() }
    public func save(_ invite: ReloPendingComputerInvite) throws { try store.save(invite) }
    public func delete() throws { try store.delete() }
}
