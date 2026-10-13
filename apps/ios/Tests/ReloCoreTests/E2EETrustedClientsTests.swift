import CryptoKit
import Foundation
import XCTest
@testable import ReloCore

final class E2EETrustedClientsTests: XCTestCase {
    private final class MemoryStore: ReloTrustedClientStore, @unchecked Sendable {
        private let lock = NSLock()
        private var clients: [ReloTrustedClient] = []
        func load() throws -> [ReloTrustedClient] { lock.withLock { clients } }
        func save(_ clients: [ReloTrustedClient]) throws { lock.withLock { self.clients = clients } }
    }

    private func client(_ key: P256.Signing.PrivateKey, id: String = "key_1") -> ReloClientKey {
        let publicKey = key.publicKey.x963Representation
        return ReloClientKey(clientId: id, name: "Work Mac", keyId: ReloE2EE.keyID(publicKeyX963: publicKey),
                             publicKey: ReloE2EE.base64URL(publicKey), changedAt: "2026-10-13T16:00:00.000Z")
    }

    func testOnlyVerifiedComputersAreTrustedSendersAndAChangedKeyIsNot() throws {
        let trust = ReloTrustedClients(store: MemoryStore())
        let mac = P256.Signing.PrivateKey()
        let entry = client(mac)
        XCTAssertEqual(try trust.trust(of: entry), .unverified)
        XCTAssertEqual(try trust.trustedSenders(), [:])

        try trust.markVerified(entry)
        XCTAssertEqual(try trust.trust(of: entry), .trusted)
        XCTAssertEqual(try trust.trustedSenders(), [entry.keyId: mac.publicKey.x963Representation])

        // The server presents a different key under the same computer id.
        let swapped = client(P256.Signing.PrivateKey())
        XCTAssertEqual(try trust.trust(of: swapped), .changed)
        XCTAssertNil(try trust.trustedSenders()[swapped.keyId])

        try trust.forget(clientId: entry.clientId)
        XCTAssertEqual(try trust.trust(of: entry), .unverified)
    }

    func testRefusesAKeyIdThatDoesNotMatchItsKeyAndMatchesTheCLISafetyNumber() throws {
        let trust = ReloTrustedClients(store: MemoryStore())
        var forged = client(P256.Signing.PrivateKey())
        forged.keyId = client(P256.Signing.PrivateKey()).keyId
        XCTAssertThrowsError(try trust.markVerified(forged))

        let url = try XCTUnwrap(Bundle.module.url(forResource: "e2ee-v1", withExtension: "json"))
        let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: url)) as? [String: Any]
        let keys = try XCTUnwrap(fixture?["keys"] as? [String: [String: String]])
        let cli = try XCTUnwrap(keys["cliIdentity"])
        let phone = try ReloE2EE.data(base64URL: try XCTUnwrap(keys["deviceIdentity"]?["publicKey"]), field: "phone")
        let entry = ReloClientKey(clientId: "key_1", name: "Mac", keyId: try XCTUnwrap(cli["keyId"]),
                                  publicKey: try XCTUnwrap(cli["publicKey"]), changedAt: "")
        XCTAssertEqual(try trust.safetyNumber(phoneIdentity: phone, client: entry), fixture?["safetyNumber"] as? String)
    }
}
