import Foundation
import ReloCore
import Security

/// The browsers this phone linked and keeps re-signing, in the same shared Keychain group as the key
/// ring. Readable after first unlock; never synced or backed up (`ThisDeviceOnly`).
public struct KeychainLinkedBrowserStore: ReloLinkedBrowserStore {
    public static let account = "e2ee-linked-browsers-v1"
    private let service: String
    private let accessGroup: String?

    public init(service: String = "relo.e2ee", accessGroup: String?) {
        self.service = service
        self.accessGroup = accessGroup
    }

    public func load() throws -> [ReloLocalLinkedBrowser] {
        var query = baseQuery
        query[kSecReturnData as String] = true
        query[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(query as CFDictionary, &result)
        if status == errSecItemNotFound { return [] }
        guard status == errSecSuccess else { throw CredentialStoreError.keychain(status) }
        guard let data = result as? Data else { throw CredentialStoreError.invalidData }
        let decoder = JSONDecoder()
        decoder.dateDecodingStrategy = .iso8601
        return try decoder.decode([ReloLocalLinkedBrowser].self, from: data)
    }

    public func save(_ browsers: [ReloLocalLinkedBrowser]) throws {
        let encoder = JSONEncoder()
        encoder.dateEncodingStrategy = .iso8601
        let attributes: [String: Any] = [
            kSecValueData as String: try encoder.encode(browsers),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        let status = SecItemUpdate(baseQuery as CFDictionary, attributes as CFDictionary)
        if status == errSecItemNotFound {
            var insertion = baseQuery
            attributes.forEach { insertion[$0.key] = $0.value }
            let added = SecItemAdd(insertion as CFDictionary, nil)
            guard added == errSecSuccess else { throw CredentialStoreError.keychain(added) }
        } else if status != errSecSuccess {
            throw CredentialStoreError.keychain(status)
        }
    }

    private var baseQuery: [String: Any] {
        var query: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: service,
            kSecAttrAccount as String: Self.account,
        ]
        if let accessGroup { query[kSecAttrAccessGroup as String] = accessGroup }
        #if os(macOS)
        // The data-protection keychain, as on iOS: access belongs to the app's ID, so macOS never asks the owner to
        // allow an app per item (the file-based login keychain did, again whenever the signing changed).
        if ReloDataProtectionKeychain.available { query[kSecUseDataProtectionKeychain as String] = true }
        #endif
        return query
    }
}

public extension ReloLinkedBrowsers {
    static func live(bundle: Bundle = .main) -> ReloLinkedBrowsers {
        ReloLinkedBrowsers(store: KeychainLinkedBrowserStore(accessGroup: ReloKeyRing.sharedAccessGroup(bundle: bundle)))
    }
}
