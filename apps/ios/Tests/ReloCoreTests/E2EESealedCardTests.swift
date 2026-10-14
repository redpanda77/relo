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
        // Each step on its own: a short list labels what it can, never all or nothing.
        guard case let .steps(_, _, partial) = placeholderCard().applying(ReloSealedCardText(steps: ["Only one"])).components[0]
        else { return XCTFail("steps") }
        XCTAssertEqual(partial.map(\.label), ["Only one", "Step 2"])
    }

    func testDecodedContentStateLabelsAWorksStepsByID() throws {
        let ring = ReloKeyRing(store: RingStore(), factory: ReloSoftwareKeyFactory())
        let state = try ring.maintain()
        let trust = ReloTrustedClients(store: TrustStore())
        let mac = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        try trust.markVerified(ReloClientKey(clientId: "key_1", name: "Mac", keyId: ReloE2EE.keyID(publicKeyX963: mac.publicKeyX963),
                                             publicKey: ReloE2EE.base64URL(mac.publicKeyX963), changedAt: ""))
        ReloSealedCards.install(ReloSealedContent(ring: ring, trust: trust).cardOpener)
        defer { ReloSealedCards.install { _ in nil } }

        let text: [String: Any] = ["title": "Ship 0.13", "status": "Testing", "phases": [
            ["id": "ph_plan", "title": "Plan", "steps": [["id": "st_scope", "label": "Scope"]]],
            ["id": "ph_build", "title": "Build", "steps": [["id": "st_code", "label": "Code"], ["id": "st_test", "label": "Test"]]],
        ]]
        let envelope = try ReloE2EE.seal(kind: "card", context: "ntf:work", sender: mac,
                                         recipients: [("dev_1", state.prekeys[0].id, state.prekeys[0].key.publicKey)],
                                         content: try JSONSerialization.data(withJSONObject: text))
        let card = LiveActivityPresentation(title: "Encrypted card", subtitle: nil, status: "Updating…", components: [
            .steps(id: "named_steps", colorRole: .thread, items: [
                .init(id: "st_scope", label: "Step 1", state: .complete), .init(id: "st_code", label: "Step 2", state: .complete),
                .init(id: "st_test", label: "Step 3", state: .current),
            ]),
        ])
        let content = ReloActivityAttributes.ContentState(generation: 1, updatedAt: Date(timeIntervalSince1970: 1_800_000_000),
                                                          sequence: 3, interaction: nil, presentation: card)
        var json = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(content)) as? [String: Any])
        json["sealed"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(envelope))
        json["work"] = ["id": "wrk_e2e", "version": 3, "phase": ["id": "ph_build", "index": 2, "count": 2],
                        "steps": ["st_code", "st_test"], "step": "st_test"]
        let decoded = try JSONDecoder().decode(ReloActivityAttributes.ContentState.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(decoded.work?.id, "wrk_e2e")
        guard case let .steps(_, _, items) = decoded.presentation.components[0] else { return XCTFail("steps") }
        XCTAssertEqual(items.map(\.label), ["Scope", "Code", "Test"], "every step labelled by id")

        // The app stores and ActivityKit decodes the state again: the same card.
        let reread = try JSONDecoder().decode(ReloActivityAttributes.ContentState.self, from: JSONEncoder().encode(decoded))
        XCTAssertEqual(reread.presentation, decoded.presentation)

        // Without works (today's server) the labels still open by id.
        json["work"] = nil
        let legacy = try JSONDecoder().decode(ReloActivityAttributes.ContentState.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(legacy.presentation, decoded.presentation)
        let command = try JSONDecoder().decode(LiveActivityCommand.self, from: JSONSerialization.data(withJSONObject: [
            "operation": "update", "activityId": "act_1", "generation": 1, "targetDeviceId": "dev_1",
            "work": ["id": "wrk_e2e"],
        ].merging(try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(card)) as? [String: Any])) { old, _ in old }))
        XCTAssertEqual(command.work?.id, "wrk_e2e")
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

        // The app applies the same command itself (Activity.request/update): it must open the text too,
        // and keep the envelope so the widget opens it again when it decodes the state.
        let applied = ReloActivityAttributes.ContentState(generation: 1, updatedAt: Date(timeIntervalSince1970: 1_800_000_000),
                                                          sequence: 3, interaction: nil, presentation: placeholderCard(), sealed: envelope)
        XCTAssertEqual(applied.presentation.title, "Deploy 0.12")
        XCTAssertEqual(applied.sealed, envelope)
        let reread = try JSONDecoder().decode(ReloActivityAttributes.ContentState.self, from: JSONEncoder().encode(applied))
        XCTAssertEqual(reread.presentation.status, "Shipping")
        // The server's command carries the envelope to the app.
        var command = try XCTUnwrap(JSONSerialization.jsonObject(with: JSONEncoder().encode(LiveActivityCommand(
            operation: .update, activityId: "act_1", generation: 1, targetDeviceId: "dev_1", style: "standard",
            sourceName: "Claude Code", headline: "Encrypted card", status: "Updating…"))) as? [String: Any])
        command["sealed"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(envelope))
        XCTAssertEqual(try JSONDecoder().decode(LiveActivityCommand.self, from: JSONSerialization.data(withJSONObject: command)).sealed, envelope)

        // From an unverified computer the placeholders stay.
        let stranger = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        json["sealed"] = try JSONSerialization.jsonObject(with: JSONEncoder().encode(try ReloE2EE.seal(
            kind: "card", context: "ntf:fake", sender: stranger,
            recipients: [("dev_1", state.prekeys[0].id, state.prekeys[0].key.publicKey)],
            content: try JSONSerialization.data(withJSONObject: ["title": "Fake"]))))
        let forged = try JSONDecoder().decode(ReloActivityAttributes.ContentState.self, from: JSONSerialization.data(withJSONObject: json))
        XCTAssertEqual(forged.presentation.title, "Encrypted card")
    }

    // The Live Activity widget has no Keychain (errSecNotAvailable): it opens cards from the mirror.

    func testWidgetMirrorKeepsOnlySoftwarePrekeysAndRoundTrips() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: directory) }
        let mirror = ReloWidgetKeyMirror(url: directory.appendingPathComponent("e2ee-widget-v1.json"))
        let state = try ReloKeyRing(store: RingStore(), factory: ReloSoftwareKeyFactory()).maintain()
        let enclave = ReloStoredPrekey(id: "pk_enclave", createdAt: "", retiredAt: nil,
                                       key: ReloStoredKey(kind: .secureEnclave, data: Data([1]), publicKey: Data([2])))
        let trusted = ReloTrustedClient(clientId: "key_1", name: "Mac", keyId: "k_1", publicKey: "p", verifiedAt: Date(timeIntervalSince1970: 0), level: "auto")
        mirror.refresh(ring: ReloKeyRingState(identity: state.identity, prekeys: state.prekeys + [enclave]),
                       trusted: [trusted], names: ["p-1": "relo"])
        let snapshot = try XCTUnwrap(mirror.load())
        XCTAssertEqual(snapshot.prekeys.map(\.id), state.prekeys.map(\.id), "Secure Enclave prekeys never leave the app")
        XCTAssertEqual(snapshot.trusted, [trusted])
        XCTAssertEqual(snapshot.names, ["p-1": "relo"])
        XCTAssertFalse(String(decoding: try Data(contentsOf: mirror.url), as: UTF8.self).contains(state.identity.data.base64EncodedString()),
                       "the identity key is never mirrored")
        XCTAssertEqual(try mirror.url.resourceValues(forKeys: [.isExcludedFromBackupKey]).isExcludedFromBackup, true)

        mirror.update { $0.trusted = [] }
        XCTAssertEqual(mirror.load()?.trusted, [])
        XCTAssertEqual(mirror.load()?.prekeys.map(\.id), state.prekeys.map(\.id))
    }

    func testWidgetOpensACardFromMirroredKeys() throws {
        let ring = ReloKeyRing(store: RingStore(), factory: ReloSoftwareKeyFactory())
        let state = try ring.maintain()
        let mac = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        let macKey = ReloClientKey(clientId: "key_1", name: "Mac", keyId: ReloE2EE.keyID(publicKeyX963: mac.publicKeyX963),
                                   publicKey: ReloE2EE.base64URL(mac.publicKeyX963), changedAt: "")
        let trustStore = TrustStore()
        try ReloTrustedClients(store: trustStore).markVerified(macKey)

        // What the widget sees: a ring with no identity, only the mirrored prekeys.
        let widgetRing = RingStore()
        try widgetRing.save(ReloKeyRingState(identity: ReloWidgetKeyMirror.noIdentity, prekeys: ReloWidgetKeyMirror.openable(state.prekeys)))
        let widget = ReloSealedContent(ring: ReloKeyRing(store: widgetRing, factory: ReloSoftwareKeyFactory()),
                                       trust: ReloTrustedClients(store: trustStore))
        let envelope = try ReloE2EE.seal(kind: "card", context: "ntf:mirror", sender: mac,
                                         recipients: [("dev_1", state.prekeys[0].id, state.prekeys[0].key.publicKey)],
                                         content: try JSONSerialization.data(withJSONObject: ["title": "Deploy 0.12"]))
        let attempt = widget.openCard(envelope)
        XCTAssertEqual(attempt.outcome, .opened)
        XCTAssertNotNil(attempt.data)
    }

    func testAnUnopenedCardSaysWhyInPlainWords() throws {
        let ring = ReloKeyRing(store: RingStore(), factory: ReloSoftwareKeyFactory())
        let state = try ring.maintain()
        let mac = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        let envelope = try ReloE2EE.seal(kind: "card", context: "ntf:why", sender: mac,
                                         recipients: [("dev_1", state.prekeys[0].id, state.prekeys[0].key.publicKey)],
                                         content: try JSONSerialization.data(withJSONObject: ["title": "Deploy"]))
        let trust = ReloTrustedClients(store: TrustStore())
        let content = ReloSealedContent(ring: ring, trust: trust)
        XCTAssertEqual(content.openCard(envelope).outcome, .computerUnknown)
        let oldMac = P256.Signing.PrivateKey().publicKey.x963Representation
        _ = try trust.autoTrust([ReloClientKey(clientId: "key_0", name: "Old Mac", keyId: ReloE2EE.keyID(publicKeyX963: oldMac),
                                               publicKey: ReloE2EE.base64URL(oldMac), changedAt: "")])
        let macKey = ReloClientKey(clientId: "key_1", name: "Mac", keyId: ReloE2EE.keyID(publicKeyX963: mac.publicKeyX963),
                                   publicKey: ReloE2EE.base64URL(mac.publicKeyX963), changedAt: "")
        _ = try trust.autoTrust([macKey])
        XCTAssertEqual(content.openCard(envelope).outcome, .computerPending)

        let elsewhere = try ReloE2EE.seal(kind: "card", context: "ntf:other", sender: mac,
                                          recipients: [("dev_2", "pk_other", P256.KeyAgreement.PrivateKey().publicKey.x963Representation)],
                                          content: Data("{}".utf8))
        XCTAssertEqual(content.openCard(elsewhere).outcome, .notForThisPhone)

        ReloSealedCards.install { _ in nil }
        ReloSealedCards.noteFailure("computer_pending")
        XCTAssertTrue(ReloSealedCards.failureLine(sealed: true).contains("waiting for your approval"))
        XCTAssertTrue(ReloSealedCards.failureLine(sealed: false).contains("Not encrypted for this iPhone"))
        ReloSealedCards.noteFailure(nil)
    }
}
