import CryptoKit
import Foundation
import XCTest
@testable import ReloCore
@testable import ReloNotificationSupport

final class E2EENameTests: XCTestCase {
    private final class MemoryBook: ReloNameBook, @unchecked Sendable {
        private let lock = NSLock()
        private var stored: [String: String] = [:]
        func names() -> [String: String] { lock.withLock { stored } }
        func learn(_ names: [String: String], sender: String) { lock.withLock { stored.merge(ReloNames.accepted(names)) { _, new in new } } }
    }
    private final class RingStore: ReloKeyRingStore, @unchecked Sendable {
        private let lock = NSLock()
        private var state: ReloKeyRingState?
        func load() throws -> ReloKeyRingState? { lock.withLock { state } }
        func save(_ state: ReloKeyRingState) throws { lock.withLock { self.state = state } }
        func delete() throws { lock.withLock { state = nil } }
    }
    private final class TrustStore: ReloTrustedClientStore, @unchecked Sendable {
        private let lock = NSLock()
        private var clients: [ReloTrustedClient] = []
        func load() throws -> [ReloTrustedClient] { lock.withLock { clients } }
        func save(_ clients: [ReloTrustedClient]) throws { lock.withLock { self.clients = clients } }
    }

    private let project = "p-esslormyi6arblsa"
    private let topic = "t-aaaaaaaaaaaaaaa2"

    func testResolvesHandlesInTextAndInWholeJSONDocumentsOnly() throws {
        let names = [project: "relo", topic: "Release 0.12"]
        XCTAssertEqual(ReloNames.resolve("\(project) › \(topic)", names), "relo › Release 0.12")
        XCTAssertEqual(ReloNames.resolve("p-unknownhandle16 stays", names), "p-unknownhandle16 stays")
        let json = Data(#"{"context":{"project":"\#(project)","threadName":"\#(topic)"},"items":[{"name":"\#(project)"}],"count":3}"#.utf8)
        let resolved = try XCTUnwrap(JSONSerialization.jsonObject(with: ReloNames.resolve(json: json, names)) as? [String: Any])
        XCTAssertEqual((resolved["context"] as? [String: String])?["project"], "relo")
        XCTAssertEqual(((resolved["items"] as? [[String: String]])?.first)?["name"], "relo")
        XCTAssertEqual(resolved["count"] as? Int, 3)
        XCTAssertEqual(ReloNames.resolve(json: Data("not json".utf8), names), Data("not json".utf8))
        XCTAssertEqual(ReloNames.accepted(["bad": "x", project: "ok", topic: "two\nlines"]), [project: "ok"])
        XCTAssertEqual(ReloNames.resolve("c-cccccccccccccccc · a-aaaaaaaaaaaaaaaa",
                                         ["c-cccccccccccccccc": "Studio", "a-aaaaaaaaaaaaaaaa": "work"]), "Studio · work")
    }

    func testOpeningAnEnvelopeTeachesItsNames() throws {
        let ring = ReloKeyRing(store: RingStore(), factory: ReloSoftwareKeyFactory())
        let state = try ring.maintain()
        let trust = ReloTrustedClients(store: TrustStore())
        let mac = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        try trust.markVerified(ReloClientKey(clientId: "key_1", name: "Mac", keyId: ReloE2EE.keyID(publicKeyX963: mac.publicKeyX963),
                                             publicKey: ReloE2EE.base64URL(mac.publicKeyX963), changedAt: ""))
        let book = MemoryBook()
        let sealed = ReloSealedContent(ring: ring, trust: trust, nameBook: book)
        let envelope = try ReloE2EE.seal(kind: "notice", context: "ntf:n", sender: mac,
                                         recipients: [("dev_1", state.prekeys[0].id, state.prekeys[0].key.publicKey)],
                                         content: try JSONSerialization.data(withJSONObject: ["title": "x", "names": [project: "relo"]]))
        guard case .opened = sealed.open(envelope, deviceID: "dev_1") else { return XCTFail("opened") }
        XCTAssertEqual(book.names(), [project: "relo"])
        XCTAssertEqual(ReloNames.resolve(json: Data(#"{"p":"\#(project)"}"#.utf8), book.names()), Data(#"{"p":"relo"}"#.utf8))
    }

    func testNamesAreKeptPerSenderSoOneComputerCannotRelabelAnother() {
        var book = ReloNames.learning([project: "relo"], sender: "key-a", into: [:])
        book = ReloNames.learning([project: "bank-transfer", topic: "deploy"], sender: "key-b", into: book)
        XCTAssertEqual(book[project]?.name, "relo", "another computer cannot rename a handle")
        XCTAssertEqual(book[topic], ReloNames.Entry(name: "deploy", sender: "key-b"))
        book = ReloNames.learning([project: "relo-renamed"], sender: "key-a", into: book)
        XCTAssertEqual(book[project]?.name, "relo-renamed", "the computer that named it may rename it")
        XCTAssertEqual(ReloNames.learning(["not-a-handle": "x"], sender: "key-a", into: [:]), [:])
    }

    func testRowsStoredBeforeTheirNamesArrivedShowNamesOnceLearned() throws {
        let computer = "c-vrs7dnttsuaskvum"
        let stored = try JSONDecoder().decode(InboxContext.self, from: Data(
            #"{"project":"\#(project)","threadName":"\#(topic)","computer":"\#(computer)"}"#.utf8))
        ReloSealedCards.installNames { [:] }
        XCTAssertEqual(stored.project, project, "unknown handles stay handles")
        let book = [project: "relo", topic: "E2EE rollout", computer: "Work Mac"]
        ReloSealedCards.installNames { book }
        defer { ReloSealedCards.installNames { [:] } }
        XCTAssertEqual(stored.project, "relo")
        XCTAssertEqual(stored.threadName, "E2EE rollout")
        XCTAssertEqual(stored.originLabel, "Work Mac")
        // The stored form keeps the handle: names live only in this phone's Keychain.
        XCTAssertTrue(String(decoding: try JSONEncoder().encode(stored), as: UTF8.self).contains(project))
    }

    func testAnAgentSessionsSealedNamesTeachThePhoneItsNames() throws {
        let ring = ReloKeyRing(store: RingStore(), factory: ReloSoftwareKeyFactory())
        let state = try ring.maintain()
        let trust = ReloTrustedClients(store: TrustStore())
        let mac = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        try trust.markVerified(ReloClientKey(clientId: "key_1", name: "Mac", keyId: ReloE2EE.keyID(publicKeyX963: mac.publicKeyX963),
                                             publicKey: ReloE2EE.base64URL(mac.publicKeyX963), changedAt: ""))
        let book = MemoryBook()
        let sealed = ReloSealedContent(ring: ring, trust: trust, ledger: nil, nameBook: book)
        let envelope = try ReloE2EE.seal(kind: "names", context: "ses:abc", sender: mac,
                                         recipients: [("dev_1", state.prekeys[0].id, state.prekeys[0].key.publicKey)],
                                         content: try JSONSerialization.data(withJSONObject: ["names": [project: "relo"]]))
        XCTAssertTrue(book.names().isEmpty)
        // A session row reaches the phone in the Now summary; opening its names teaches the book.
        _ = sealed.opener(envelope, "ags_00000000-0000-4000-8000-000000000001")
        XCTAssertEqual(book.names(), [project: "relo"])
    }

    func testCardIdentityLabelsShowRealNames() {
        let presentation = LiveActivityPresentation(
            title: topic, status: "Working",
            identity: .init(project: .init(label: project, color: "#5ED8B7", icon: .active),
                            thread: .init(label: topic, color: "#5ED8B7", icon: .active), direct: false)
        )
        let resolved = presentation.resolvingNames([project: "relo", topic: "Release 0.12"])
        XCTAssertEqual(resolved.identity.project?.label, "relo")
        XCTAssertEqual(resolved.identity.thread?.label, "Release 0.12")
        XCTAssertEqual(resolved.title, "Release 0.12")
        XCTAssertEqual(presentation.resolvingNames([:]), presentation)
    }
}
