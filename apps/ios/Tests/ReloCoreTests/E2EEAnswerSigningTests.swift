import CryptoKit
import Foundation
import XCTest
@testable import ReloCore
@testable import ReloTransport

final class E2EEAnswerSigningTests: XCTestCase {
    private func response(action: NotificationInteractionAction, value: [String: String] = [:], interactionID: String? = "int_1") -> PendingNotificationResponse {
        PendingNotificationResponse(accountID: "acc_1", deviceID: "dev_1", notificationID: "ntf_1", action: action, value: value,
                                    idempotencyKey: "ios:test", expiresAt: Date().addingTimeInterval(60), interactionID: interactionID)
    }

    func testSignsOnceOverExactlyWhatTheCLIVerifies() throws {
        let identity = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        let signed = ReloAnswerSigning.sign(response(action: .approve), signer: identity)
        let signedAt = try XCTUnwrap(signed.value[ReloAnswerSigning.signedAtField])
        XCTAssertEqual(signed.value[ReloAnswerSigning.keyIDField], ReloE2EE.keyID(publicKeyX963: identity.publicKeyX963))
        let message = ReloE2EE.answerSigningInput(interactionID: "int_1", notificationID: "ntf_1", deviceID: "dev_1", value: "approve", respondedAt: signedAt)
        let signature = try ReloE2EE.data(base64URL: try XCTUnwrap(signed.value[ReloAnswerSigning.signatureField]), length: 64, field: "sig")
        XCTAssertTrue(ReloE2EE.verify(signature: signature, message: message, publicKeyX963: identity.publicKeyX963))
        XCTAssertEqual(ReloAnswerSigning.sign(signed, signer: identity), signed, "a queued answer is never re-signed")
        XCTAssertEqual(signed.idempotencyKey, "ios:test")
        let plain = response(action: .approve)
        XCTAssertEqual(ReloAnswerSigning.sign(plain, signer: nil), plain)
        XCTAssertEqual(ReloAnswerSigning.sign(response(action: .approve, interactionID: nil), signer: identity).value, [:])
    }

    func testRepliesSignADigestThatMatchesTheCLI() {
        // The same digest packages/cli/src/answer-verify.mjs computes for "Ship it".
        XCTAssertEqual(ReloAnswerSigning.signedValue(action: .answer, value: ["response": "Ship it"]),
                       "answer:2c8d1fbaf0f6d4624aec53356e2fdec79a3dfe8ffb13d8ab9c2f82438fbe421f")
        XCTAssertEqual(ReloAnswerSigning.signedValue(action: .deny, value: [:]), "deny")
    }

    func testLiveActivityRequestCarriesTheSignature() throws {
        let identity = ReloSoftwareIdentity(privateKey: P256.Signing.PrivateKey())
        let base = PendingNotificationResponse.liveActivity(
            accountID: "acc_00000000-0000-4000-8000-000000000001", deviceID: "dev_00000000-0000-4000-8000-000000000001",
            notificationID: "ntf_00000000-0000-4000-8000-000000000001", activityID: "act_00000000-0000-4000-8000-000000000001",
            activityGeneration: 1, interactionID: "int_00000000-0000-4000-8000-000000000001", action: .approve,
            credential: String(repeating: "c", count: 43), expiresAt: Date().addingTimeInterval(60)
        )
        let request = try LiveActivityResponseRequestFactory.make(
            response: ReloAnswerSigning.sign(base, signer: identity), apiOrigin: URL(string: "https://relo.example")!
        )
        let body = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(request.httpBody)) as? [String: Any])
        let signature = try XCTUnwrap(body["signature"] as? [String: String])
        XCTAssertEqual(Set(signature.keys), [ReloAnswerSigning.keyIDField, ReloAnswerSigning.signedAtField, ReloAnswerSigning.signatureField])
        let unsigned = try LiveActivityResponseRequestFactory.make(response: base, apiOrigin: URL(string: "https://relo.example")!)
        let unsignedBody = try XCTUnwrap(JSONSerialization.jsonObject(with: try XCTUnwrap(unsigned.httpBody)) as? [String: Any])
        XCTAssertNil(unsignedBody["signature"])
    }
}
