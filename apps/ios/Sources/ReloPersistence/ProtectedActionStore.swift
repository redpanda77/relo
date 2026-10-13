import ReloCore
import Foundation

public actor AccountScopedProtectedActionStore: AccountScopedLiveActivityLedgerStoring, AccountScopedPendingResponseStoring {
    private let baseDirectory: URL
    var selectedDirectory: URL?

    public init(baseDirectory: URL) {
        self.baseDirectory = baseDirectory
    }

    public func select(accountID: String, deviceID: String) throws {
        guard Self.safe(accountID), Self.safe(deviceID) else { throw AccountScopedInboxCacheError.invalidAccountId }
        selectedDirectory = baseDirectory
            .appendingPathComponent(accountID, isDirectory: true)
            .appendingPathComponent(deviceID, isDirectory: true)
    }

    public func clearSelectedAccount() throws {
        guard let selectedDirectory else { return }
        if FileManager.default.fileExists(atPath: selectedDirectory.path) {
            try FileManager.default.removeItem(at: selectedDirectory)
        }
    }

    func loadResponses() throws -> [PendingNotificationResponse] {
        try decode([PendingNotificationResponse].self, from: "pending-responses.json") ?? []
    }

    func loadNotificationConfirmations() throws -> [NotificationResponseConfirmation] {
        try decode([NotificationResponseConfirmation].self, from: "notification-response-confirmations.json") ?? []
    }

    func decode<Value: Codable>(_ type: Value.Type, from name: String) throws -> Value? {
        guard let selectedDirectory else { throw AccountScopedInboxCacheError.accountNotSelected }
        let url = selectedDirectory.appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { return nil }
        let data = try Data(contentsOf: url)
        let storage = try storageContract(for: name)
        return try VersionedStorageCodec.decode(
            type,
            from: data,
            schemaVersion: storage
        ).payload
    }

    func encode<Value: Codable>(_ value: Value, to name: String) throws {
        guard let selectedDirectory else { throw AccountScopedInboxCacheError.accountNotSelected }
        try FileManager.default.createDirectory(at: selectedDirectory, withIntermediateDirectories: true)
        let storage = try storageContract(for: name)
        try VersionedStorageCodec.encode(
            value,
            schemaVersion: storage
        ).write(
            to: selectedDirectory.appendingPathComponent(name),
            options: ReloProtectedFileWritingOptions.complete
        )
    }

    private func storageContract(
        for name: String
    ) throws -> Int {
        switch name {
        case "live-activity-ledger.json":
            LocalStoreSchema.liveActivityLedger
        case "pending-responses.json":
            LocalStoreSchema.pendingResponses
        case "notification-response-failures.json":
            1
        case "notification-response-confirmations.json":
            LocalStoreSchema.responseConfirmations
        default:
            throw ProtectedStoreContractError.unregisteredStore(name)
        }
    }

    private static func safe(_ value: String) -> Bool {
        let punctuation = CharacterSet(charactersIn: "_-")
        return !value.isEmpty && value.unicodeScalars.allSatisfy {
            CharacterSet.alphanumerics.contains($0) || punctuation.contains($0)
        }
    }
}

private enum ProtectedStoreContractError: Error {
    case unregisteredStore(String)
}
