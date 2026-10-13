import CryptoKit
import Foundation
import XCTest
// SwiftPM builds the shared activity sources as ReloActivityWire; Xcode compiles them into the app.
#if canImport(ReloActivityWire)
@testable import ReloActivityWire
#else
@testable import Relo
#endif
@testable import ReloCore
@testable import ReloNotificationSupport

final class E2EESealedCardTests: XCTestCase {
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

    private func placeholderCard(status: String = "Updating…", subtitle: String? = nil) -> LiveActivityPresentation {
        LiveActivityPresentation(title: "Encrypted card", subtitle: subtitle, status: status, components: [
            .steps(id: "steps", colorRole: .project, items: [
                .init(id: "s1", label: "Step 1", state: .complete), .init(id: "s2", label: "Step 2", state: .current),
            ]),
        ])
    }

    func testReplacesOnlyPlaceholdersAndKeepsTheServersOwnWords() {
        let text = ReloSealedCardText(title: "Deploy 0.12", status: "Shipping", detail: "to production", steps: ["Build", "Ship"])
        let opened = placeholderCard(status: "Approved · Updating…").applying(text)
        XCTAssertEqual(opened.title, "Deploy 0.12")
        XCTAssertEqual(opened.status, "Approved · Shipping")
        XCTAssertEqual(opened.subtitle, "to production")
        guard case let .steps(_, _, items) = opened.components[0] else { return XCTFail("steps") }
        XCTAssertEqual(items.map(\.label), ["Build", "Ship"])
        XCTAssertEqual(items.map(\.state), [.complete, .current])

        XCTAssertEqual(placeholderCard(status: "Expired").applying(text).status, "Expired", "server words stay")
        let question = placeholderCard(subtitle: ReloSealedCards.promptPlaceholder)
            .applying(ReloSealedCardText(title: "Encrypted card", summary: "Deploy now?"))
        XCTAssertEqual(question.subtitle, "Deploy now?")
        XCTAssertEqual(question.title, "Encrypted card", "a placeholder title in the sealed text never replaces")
        XCTAssertEqual(placeholderCard().applying(ReloSealedCardText(steps: ["Only one"])).components, placeholderCard().components)
    }

    func testDecodedContentStateShowsTheSealedTextFromAVerifiedComputer() throws {
        let ring = ReloKeyRing(store: RingStore(), factory: ReloSoftwareKeyFactory())
        let state = try ring.maintain()
        let trust = ReloTrustedClients(store: TrustStore())
        let mac = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        try trust.markVerified(ReloClientKey(clientId: "key_1", name: "Mac", keyId: ReloE2EE.keyID(publicKeyX963: mac.publicKeyX963),
                                             publicKey: ReloE2EE.base64URL(mac.publicKeyX963), changedAt: ""))
        ReloSealedCards.install(ReloSealedContent(ring: ring, trust: trust).cardOpener)
        defer { ReloSealedCards.install { _ in nil } }

        let envelope = try ReloE2EE.seal(kind: "card", context: "ntf:card", sender: mac,
                                         recipients: [("dev_1", state.prekeys[0].id, state.prekeys[0].key.publicKey)],
                                         content: try JSONSerialization.data(withJSONObject: ["title": "Deploy 0.12", "status": "Shipping", "steps": ["Build", "Ship"]]))
        let content = ReloActivityAttributes.ContentState(generation: 1, updatedAt: Date(timeIntervalSince1970: 1_800_000_000),
                                                          sequence: 3, interaction: nil, presentation: placeholderCard())
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(content)) as? [String: Any])
        json["sealed"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(envelope))
        let decoded = try JSONDecoder().decode(ReloActivityAttributes.ContentState.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(decoded.presentation.title, "Deploy 0.12")
        XCTAssertEqual(decoded.presentation.status, "Shipping")
        XCTAssertEqual(decoded.sealed, envelope)

        // From an unverified computer the placeholders stay.
        let stranger = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        json["sealed"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try ReloE2EE.seal(
            kind: "card", context: "ntf:fake", sender: stranger,
            recipients: [("dev_1", state.prekeys[0].id, state.prekeys[0].key.publicKey)],
            content: try JSONSerialization.data(withJSONObject: ["title": "Fake"]))))
        let forged = try JSONDecoder().decode(ReloActivityAttributes.ContentState.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(forged.presentation.title, "Encrypted card")
    }
}
