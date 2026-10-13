import CryptoKit
import Foundation

/// Signs a phone's answer with its identity key so a CLI can tell a real approval from one a
/// compromised server invented (docs/END-TO-END-ENCRYPTION.md, E4.2). The signature rides inside the
/// answer value; it is made once, when the answer is queued, so every retry sends identical bytes.
public enum ReloAnswerSigning {
    public static let keyIDField = "e2eeKeyId"
    public static let signedAtField = "e2eeSignedAt"
    public static let signatureField = "e2eeSignature"
    public static let questionField = "e2eeQuestion"
    public static let questionSignatureField = "e2eeQuestionSignature"

    /// What the signature covers for an action: the action itself, the picked option, or a digest of a typed reply.
    public static func signedValue(action: NotificationInteractionAction, value: [String: String]) -> String {
        if action == .choose { return "choose:" + (value["optionId"] ?? "") }
        if action == .answer {
            let text = value["response"] ?? ""
            return "answer:" + SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        }
        return action.rawValue
    }

    /// The response with its signature added, or unchanged when there is no key or no interaction id.
    /// `question` is the context of the sealed question envelope this phone opened and showed; the
    /// CLI that asked requires a signature over it, so an approval cannot be moved to another question.
    public static func sign(
        _ response: PendingNotificationResponse,
        signer: (any ReloIdentitySigning)?,
        question: String? = nil,
        now: Date = Date()
    ) -> PendingNotificationResponse {
        guard let signer, let interactionID = response.interactionID, response.value[signatureField] == nil else { return response }
        let signedAt = ReloKeyRing.timestamp(now)
        let message = ReloE2EE.answerSigningInput(
            interactionID: interactionID, notificationID: response.notificationID, deviceID: response.deviceID,
            value: signedValue(action: response.action, value: response.value), respondedAt: signedAt
        )
        guard let signature = try? signer.sign(message) else { return response }
        var value = response.value
        value[keyIDField] = ReloE2EE.keyID(publicKeyX963: signer.publicKeyX963)
        value[signedAtField] = signedAt
        value[signatureField] = ReloE2EE.base64URL(signature)
        if let question {
            let bound = ReloE2EE.questionAnswerSigningInput(
                interactionID: interactionID, notificationID: response.notificationID, deviceID: response.deviceID,
                value: signedValue(action: response.action, value: response.value), respondedAt: signedAt, question: question
            )
            if let questionSignature = try? signer.sign(bound) {
                value[questionField] = question
                value[questionSignatureField] = ReloE2EE.base64URL(questionSignature)
            }
        }
        return PendingNotificationResponse(
            accountID: response.accountID, deviceID: response.deviceID, notificationID: response.notificationID,
            action: response.action, value: value, idempotencyKey: response.idempotencyKey, expiresAt: response.expiresAt,
            endpoint: response.endpoint, activityID: response.activityID, activityGeneration: response.activityGeneration,
            interactionID: response.interactionID, responseCredential: response.responseCredential,
            serverOrigin: response.serverOrigin
        )
    }
}

public extension ReloKeyRing {
    /// This phone's identity signer when keys exist; never creates or rotates keys.
    func existingIdentitySigner() -> (any ReloIdentitySigning)? {
        guard let state = try? store.load() else { return nil }
        return try? factory.signer(for: state.identity)
    }
}
