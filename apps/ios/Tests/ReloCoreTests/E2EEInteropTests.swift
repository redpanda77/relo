import CryptoKit
import Foundation
import XCTest
@testable import ReloCore

/// relo.e2e.v1 interop: CryptoKit opens what the CLI sealed, and the CLI opens what CryptoKit
/// sealed (the `cryptokit` block, emitted with RELO_E2EE_EMIT and merged by
/// packages/cli/scripts/e2ee-vectors.mjs).
final class E2EEInteropTests: XCTestCase {
    private struct Key: Decodable { let privateKey: String; let publicKey: String; let keyId: String }
    private struct Keys: Decodable { let cliIdentity: Key; let deviceIdentity: Key; let prekey: Key; let otherDevicePrekey: Key }
    private struct HPKEVector: Decodable { let info, aad, plaintext, enc, ciphertext: String }
    private struct Prekey: Decodable { let deviceId, prekeyId, publicKey, createdAt, signature: String }
    private struct Answer: Decodable { let interactionId, notificationId, deviceId, value, respondedAt, signature: String }
    private struct NodeBlock: Decodable { let envelope: ReloEnvelope; let context: String; let prekey: Prekey; let answer: Answer }
    private struct Rejection: Decodable { let name: String; let envelope: ReloEnvelope; let error: String }
    private struct Fixture: Decodable {
        let version: String
        let keys: Keys
        let hpke: HPKEVector
        let node: NodeBlock
        let safetyNumber: String
        let rejections: [Rejection]
    }

    private let expectedContent: [String: String] = [
        "title": "Deploy finished",
        "summary": "All 848 tests passed",
        "body": "## Result\nEvery check passed. Ünïcödé and emoji ✅ survive sealing.",
        "project": "relo",
        "topic": "end-to-end encryption",
    ]

    private func fixture() throws -> Fixture {
        let url = try XCTUnwrap(Bundle.module.url(forResource: "e2ee-v1", withExtension: "json"))
        return try JSONDecoder().decode(Fixture.self, from: Data(contentsOf: url))
    }

    private func bytes(_ value: String) throws -> Data {
        try ReloE2EE.data(base64URL: value, field: "fixture")
    }

    private func prekey(_ fixture: Fixture) throws -> ReloSoftwarePrekey {
        ReloSoftwarePrekey(privateKey: try P256.KeyAgreement.PrivateKey(rawRepresentation: bytes(fixture.keys.prekey.privateKey)))
    }

    func testCryptoKitOpensNodeHPKEVector() throws {
        let fixture = try fixture()
        let opened = try prekey(fixture).openContentKey(
            encapsulatedKey: bytes(fixture.hpke.enc), ciphertext: bytes(fixture.hpke.ciphertext),
            info: bytes(fixture.hpke.info), aad: bytes(fixture.hpke.aad)
        )
        XCTAssertEqual(opened, try bytes(fixture.hpke.plaintext))
    }

    func testKeyIdentifiersAndSafetyNumberMatchTheCLI() throws {
        let fixture = try fixture()
        for key in [fixture.keys.cliIdentity, fixture.keys.deviceIdentity, fixture.keys.prekey] {
            XCTAssertEqual(ReloE2EE.keyID(publicKeyX963: try bytes(key.publicKey)), key.keyId)
        }
        let cli = try bytes(fixture.keys.cliIdentity.publicKey)
        let device = try bytes(fixture.keys.deviceIdentity.publicKey)
        XCTAssertEqual(ReloE2EE.safetyNumber(cli, device), fixture.safetyNumber)
        XCTAssertEqual(ReloE2EE.safetyNumber(device, cli), fixture.safetyNumber)
        XCTAssertEqual(fixture.safetyNumber.split(separator: " ").count, 12)
    }

    func testOpensNodeSealedEnvelopeOnlyForTrustedSenderAndRightDevice() throws {
        let fixture = try fixture()
        let trusted = [fixture.keys.cliIdentity.keyId: try bytes(fixture.keys.cliIdentity.publicKey)]
        let key = try prekey(fixture)
        let opened = try ReloE2EE.open(
            fixture.node.envelope, deviceID: "dev_phone", prekey: { $0 == "pk_1" ? key : nil },
            trustedSenders: trusted, expectedKind: "notice", expectedContext: fixture.node.context
        )
        XCTAssertEqual(try JSONDecoder().decode([String: String].self, from: opened), expectedContent)

        XCTAssertThrowsError(try ReloE2EE.open(fixture.node.envelope, deviceID: "dev_phone", prekey: { _ in key }, trustedSenders: [:])) {
            XCTAssertEqual($0 as? ReloE2EEError, .untrustedSender)
        }
        XCTAssertThrowsError(try ReloE2EE.open(fixture.node.envelope, deviceID: "dev_other", prekey: { _ in key }, trustedSenders: trusted)) {
            XCTAssertEqual($0 as? ReloE2EEError, .notARecipient)
        }
        XCTAssertThrowsError(try ReloE2EE.open(fixture.node.envelope, deviceID: "dev_phone", prekey: { _ in nil }, trustedSenders: trusted)) {
            XCTAssertEqual($0 as? ReloE2EEError, .prekeyUnavailable)
        }
        XCTAssertThrowsError(try ReloE2EE.open(
            fixture.node.envelope, deviceID: "dev_phone", prekey: { _ in key }, trustedSenders: trusted,
            expectedContext: "acct:acc_other/idem:vector-1"
        )) {
            XCTAssertEqual($0 as? ReloE2EEError, .unexpectedContext)
        }
        // A deleted (rotated-away) prekey cannot open: a different private key fails authentication.
        let rotated = ReloSoftwarePrekey(privateKey: P256.KeyAgreement.PrivateKey())
        XCTAssertThrowsError(try ReloE2EE.open(fixture.node.envelope, deviceID: "dev_phone", prekey: { _ in rotated }, trustedSenders: trusted)) {
            XCTAssertEqual($0 as? ReloE2EEError, .decryptionFailed)
        }
    }

    func testRejectsEveryTamperedEnvelope() throws {
        let fixture = try fixture()
        let trusted = [fixture.keys.cliIdentity.keyId: try bytes(fixture.keys.cliIdentity.publicKey)]
        let key = try prekey(fixture)
        for rejection in fixture.rejections {
            XCTAssertThrowsError(
                try ReloE2EE.open(rejection.envelope, deviceID: "dev_phone", prekey: { _ in key }, trustedSenders: trusted),
                rejection.name
            ) { XCTAssertEqual($0 as? ReloE2EEError, .invalidSignature, rejection.name) }
        }
    }

    func testVerifiesNodeSignedPrekeyAndAnswer() throws {
        let fixture = try fixture()
        let identity = try bytes(fixture.keys.deviceIdentity.publicKey)
        let prekey = fixture.node.prekey
        XCTAssertTrue(ReloE2EE.verify(
            signature: try bytes(prekey.signature),
            message: ReloE2EE.prekeySigningInput(deviceID: prekey.deviceId, prekeyID: prekey.prekeyId,
                                                 publicKeyX963: try bytes(prekey.publicKey), createdAt: prekey.createdAt),
            publicKeyX963: identity
        ))
        let answer = fixture.node.answer
        let input = ReloE2EE.answerSigningInput(interactionID: answer.interactionId, notificationID: answer.notificationId,
                                                deviceID: answer.deviceId, value: answer.value, respondedAt: answer.respondedAt)
        XCTAssertTrue(ReloE2EE.verify(signature: try bytes(answer.signature), message: input, publicKeyX963: identity))
        let forged = ReloE2EE.answerSigningInput(interactionID: answer.interactionId, notificationID: answer.notificationId,
                                                 deviceID: answer.deviceId, value: "denied", respondedAt: answer.respondedAt)
        XCTAssertFalse(ReloE2EE.verify(signature: try bytes(answer.signature), message: forged, publicKeyX963: identity))
    }

    func testSealedEnvelopeRoundTripsAndPadsToBuckets() throws {
        let identity = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        let prekey = P256.KeyAgreement.PrivateKey()
        let content = Data(#"{"text":"short"}"#.utf8)
        let envelope = try ReloE2EE.seal(
            kind: "reply", context: "acct:a/int:1", sender: identity,
            recipients: [("cli_1", "reply_1", prekey.publicKey.x963Representation)], content: content
        )
        XCTAssertEqual(try ReloE2EE.data(base64URL: envelope.ct, field: "ct").count, 256 + 16)
        let opened = try ReloE2EE.open(
            envelope, deviceID: "cli_1", prekey: { _ in ReloSoftwarePrekey(privateKey: prekey) },
            trustedSenders: [ReloE2EE.keyID(publicKeyX963: identity.publicKeyX963): identity.publicKeyX963]
        )
        XCTAssertEqual(opened, content)
    }

    /// Writes CryptoKit-sealed vectors for the CLI to open; runs only when RELO_E2EE_EMIT is set.
    func testEmitCryptoKitVectors() throws {
        guard let path = ProcessInfo.processInfo.environment["RELO_E2EE_EMIT"] else {
            throw XCTSkip("Set RELO_E2EE_EMIT=<path> to regenerate the CryptoKit vectors.")
        }
        let fixture = try fixture()
        let device = ReloSoftwareIdentity(privateKey: try P256.Signing.PrivateKey(rawRepresentation: bytes(fixture.keys.deviceIdentity.privateKey)))
        let content = try JSONSerialization.data(withJSONObject: expectedContent, options: [.sortedKeys])
        let envelope = try ReloE2EE.seal(
            kind: "reply", context: "acct:acc_test/int:vector-1", sender: device,
            recipients: [
                ("dev_phone", "pk_1", try bytes(fixture.keys.prekey.publicKey)),
                ("dev_ipad", "pk_9", try bytes(fixture.keys.otherDevicePrekey.publicKey)),
            ],
            content: content
        )
        var sender = try HPKE.Sender(
            recipientKey: P256.KeyAgreement.PublicKey(x963Representation: bytes(fixture.keys.prekey.publicKey)),
            ciphersuite: .P256_SHA256_AES_GCM_256, info: try bytes(fixture.hpke.info)
        )
        let hpkeCiphertext = try sender.seal(try bytes(fixture.hpke.plaintext), authenticating: try bytes(fixture.hpke.aad))
        let answerInput = ReloE2EE.answerSigningInput(interactionID: "int_2", notificationID: "ntf_2", deviceID: "dev_phone",
                                                      value: "denied", respondedAt: "2026-10-13T16:02:00.000Z")
        let output: [String: Any] = [
            "envelope": try JSONSerialization.jsonObject(with: JSONEncoder().encode(envelope)),
            "context": "acct:acc_test/int:vector-1",
            "hpke": ["enc": ReloE2EE.base64URL(sender.encapsulatedKey), "ciphertext": ReloE2EE.base64URL(hpkeCiphertext)],
            "answer": [
                "interactionId": "int_2", "notificationId": "ntf_2", "deviceId": "dev_phone", "value": "denied",
                "respondedAt": "2026-10-13T16:02:00.000Z", "signature": ReloE2EE.base64URL(try device.sign(answerInput)),
            ],
        ]
        try JSONSerialization.data(withJSONObject: output, options: [.prettyPrinted, .sortedKeys]).write(to: URL(fileURLWithPath: path))
    }
}
