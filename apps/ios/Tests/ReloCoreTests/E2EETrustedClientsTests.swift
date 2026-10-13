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

    func testComputersAreTrustedOnFirstUseAndAChangedKeyIsTrustedAgainWithANotice() throws {
        let trust = ReloTrustedClients(store: MemoryStore())
        let mac = P256.Signing.PrivateKey()
        let entry = client(mac)
        XCTAssertEqual(try trust.trust(of: entry), .new)
        XCTAssertEqual(try trust.trustedSenders(), [:])

        XCTAssertTrue(try trust.autoTrust([entry]))
        XCTAssertFalse(try trust.autoTrust([entry]), "an unchanged key changes nothing")
        XCTAssertEqual(try trust.trust(of: entry), .auto)
        XCTAssertNil(try trust.notice(for: entry))
        XCTAssertEqual(try trust.trustedSenders(), [entry.keyId: mac.publicKey.x963Representation])

        // A reinstall on the computer: the new key is trusted, with a "security code changed" notice.
        let reinstalled = client(P256.Signing.PrivateKey())
        XCTAssertTrue(try trust.autoTrust([reinstalled]))
        XCTAssertEqual(try trust.trust(of: reinstalled), .auto)
        XCTAssertEqual(try trust.notice(for: reinstalled)?.previousKeyId, entry.keyId)
        XCTAssertEqual(try trust.notice(for: reinstalled)?.kind, "security_code_changed")
        XCTAssertNil(try trust.trustedSenders()[entry.keyId], "the old key no longer opens anything")

        try trust.markVerified(reinstalled)
        XCTAssertEqual(try trust.trust(of: reinstalled), .verified)
        try trust.forget(clientId: reinstalled.clientId)
        XCTAssertEqual(try trust.trust(of: reinstalled), .new)

        var forged = client(P256.Signing.PrivateKey(), id: "key_2")
        forged.keyId = entry.keyId
        XCTAssertFalse(try trust.autoTrust([forged]), "a key id that does not match its key is ignored")
    }

    func testASecondComputerIsTrustedWithANewComputerNoticeAndStaysListed() throws {
        let trust = ReloTrustedClients(store: MemoryStore())
        let first = client(P256.Signing.PrivateKey())
        XCTAssertTrue(try trust.autoTrust([first]))
        XCTAssertNil(try trust.notice(for: first), "the first computer is trusted silently")
        let second = client(P256.Signing.PrivateKey(), id: "key_2")
        XCTAssertTrue(try trust.autoTrust([first, second]))
        XCTAssertEqual(try trust.notice(for: second)?.kind, "new_computer")
        XCTAssertNil(try trust.notice(for: second)?.previousKeyId)
        // The server stops listing a computer: the phone still shows it, because it still opens its messages.
        XCTAssertFalse(try trust.autoTrust([first]))
        XCTAssertEqual(Set(try trust.all().map(\.clientId)), ["key_1", "key_2"])
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
