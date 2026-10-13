import CryptoKit
import Foundation
import XCTest
import ReloCore
@testable import ReloNotificationSupport

final class SecureEnclaveKeyFactoryTests: XCTestCase {
    private final class MemoryStore: ReloKeyRingStore, @unchecked Sendable {
        private let lock = NSLock()
        private var state: ReloKeyRingState?
        func load() throws -> ReloKeyRingState? { lock.withLock { state } }
        func save(_ state: ReloKeyRingState) throws { lock.withLock { self.state = state } }
        func delete() throws { lock.withLock { state = nil } }
    }

    private let start = Date(timeIntervalSince1970: 1_800_000_000)

    func testSecureEnclaveKeysOpenEnvelopesAndSignAnswers() throws {
        guard ReloSecureEnclaveKeyFactory.isAvailable else { throw XCTSkip("No Secure Enclave on this machine.") }
        let ring = ReloKeyRing(store: MemoryStore(), factory: ReloSecureEnclaveKeyFactory())
        let state = try ring.maintain(now: start)
        XCTAssertEqual(state.identity.kind, .secureEnclave)
        XCTAssertEqual(state.prekeys[0].key.usableWhileLocked, true)
        // The prekey lives in the shared Keychain so the widget and the notification extension can open
        // Live Activities and notifications; only the identity stays in the Secure Enclave.
        XCTAssertEqual(state.prekeys[0].key.kind, .software)
        let sender = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        let envelope = try ReloE2EE.seal(
            kind: "notice", context: "acct:a/idem:se", sender: sender,
            recipients: [("dev_1", state.prekeys[0].id, state.prekeys[0].key.publicKey)], content: Data(#"{"t":"enclave"}"#.utf8)
        )
        let opened = try ReloE2EE.open(envelope, deviceID: "dev_1", prekey: ring.prekeyOpener(state: state),
                                       trustedSenders: [ReloE2EE.keyID(publicKeyX963: sender.publicKeyX963): sender.publicKeyX963])
        XCTAssertEqual(opened, Data(#"{"t":"enclave"}"#.utf8))
        let answer = ReloE2EE.answerSigningInput(interactionID: "int_1", notificationID: "ntf_1", deviceID: "dev_1", value: "approved", respondedAt: "now")
        let signature = try ring.identitySigner(state: state).sign(answer)
        XCTAssertTrue(ReloE2EE.verify(signature: signature, message: answer, publicKeyX963: state.identity.publicKey))
    }
}
