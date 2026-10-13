import CryptoKit
import Foundation
import XCTest
@testable import ReloNotificationSupport
@testable import ReloCore
@testable import Relo

/// The Lock Screen path against the real Keychain (P0, 14 October 2026): a prekey stored the way the
/// app stores it, in the shared access group, opens a sealed card while a Live Activity's state is
/// decoded, the way the widget does it, from separate store instances reading the same items (as
/// another process does). Before the fix the prekey was a Secure Enclave key only the app could use.
final class SealedLiveActivityKeychainTests: XCTestCase {
    private var service = ""
    private var group: String?

    override func setUp() {
        super.setUp()
        service = "relo.e2ee.test-\(UUID().uuidString)"
        group = ReloKeyRing.sharedAccessGroup(bundle: .main)
    }

    override func tearDown() {
        for account in [KeychainKeyRingStore.account, KeychainTrustedClientStore.account] {
            var query: [String: Any] = [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service,
                                        kSecAttrAccount as String: account]
            if let group { query[kSecAttrAccessGroup as String] = group }
            SecItemDelete(query as CFDictionary)
        }
        ReloSealedCards.install { _ in nil }
        super.tearDown()
    }

    func testASealedCardOpensFromTheSharedKeychainAsTheWidgetDecodesIt() throws {
        // The app: keys made the way the device factory makes prekeys, kept in the shared Keychain item.
        let appRing = ReloKeyRing(store: KeychainKeyRingStore(service: service, accessGroup: group), factory: ReloSoftwareKeyFactory())
        let state = try appRing.maintain()
        XCTAssertEqual(try ReloSecureEnclaveKeyFactory().makePrekey().kind, .software, "prekeys never live in the Secure Enclave")
        let mac = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        try ReloTrustedClients(store: KeychainTrustedClientStore(service: service, accessGroup: group)).markVerified(
            ReloClientKey(clientId: "key_1", name: "Studio Mac", keyId: ReloE2EE.keyID(publicKeyX963: mac.publicKeyX963),
                          publicKey: ReloE2EE.base64URL(mac.publicKeyX963), changedAt: ""))

        // The widget: new store instances over the same Keychain items, as a separate process sees them.
        let widget = ReloSealedContent(ring: ReloKeyRing(store: KeychainKeyRingStore(service: service, accessGroup: group),
                                                         factory: ReloSecureEnclaveKeyFactory()),
                                       trust: ReloTrustedClients(store: KeychainTrustedClientStore(service: service, accessGroup: group)))
        ReloSealedCards.install(widget.cardOpener)

        let envelope = try ReloE2EE.seal(kind: "card", context: "ntf:lock-screen", sender: mac,
                                         recipients: [("dev_1", state.prekeys[0].id, state.prekeys[0].key.publicKey)],
                                         content: try JSONSerialization.data(withJSONObject: [
                                            "title": "Release 0.16", "status": "Running the test suite", "steps": ["Build", "Test", "Ship"]]))
        let placeholders = ReloActivityAttributes.ContentState(
            generation: 1, updatedAt: Date(timeIntervalSince1970: 1_800_000_000), sequence: 1, interaction: nil,
            presentation: LiveActivityPresentation(title: "Encrypted card", subtitle: nil, status: "Updating…", components: [
                .steps(id: "steps", colorRole: .project, items: [
                    .init(id: "s1", label: "Step 1", state: .complete), .init(id: "s2", label: "Step 2", state: .current),
                    .init(id: "s3", label: "Step 3", state: .pending),
                ]),
            ]))
        // The push's content-state as the server sends it: placeholders plus this phone's envelope.
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(placeholders)) as? [String: Any])
        json["sealed"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(envelope))
        let decoded = try JSONDecoder().decode(ReloActivityAttributes.ContentState.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(decoded.presentation.title, "Release 0.16")
        XCTAssertEqual(decoded.presentation.status, "Running the test suite")
        guard case let .steps(_, _, items) = decoded.presentation.components[0] else { return XCTFail("steps") }
        XCTAssertEqual(items.map(\.label), ["Build", "Test", "Ship"])
    }
}
