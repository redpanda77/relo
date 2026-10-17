/**
 * A linked browser's signed answer (docs/ENCRYPTION-PROTOCOL.md, "Answering from a linked
 * browser"). The browser's non-extractable identity key signs exactly the bytes the iPhone signs
 * (ReloAnswerSigning.swift, packages/cli/src/crypto/e2ee.mjs), with this browser's `brw_…` id as the
 * answering device. For a sealed question it also signs the context of the envelope it opened, so a
 * server cannot move the answer to another question. Computers verify it and decide whether a
 * browser's answer counts (never in strict mode).
 */
import { b64u, copy, fromB64u, utf8, type Bytes } from "./bytes"
import { E2EE_VERSION, keyId } from "./envelope"

export type AnswerAction = "approve" | "deny" | "yes" | "no" | "choose"

/** The fields the server stores with the answer and relays to the computer unchanged. */
export type AnswerSignature = {
  e2eeKeyId: string
  e2eeSignedAt: string
  e2eeSignature: string
  e2eeQuestion?: string
  e2eeQuestionSignature?: string
}

export type AnswerFields = {
  interactionId: string
  notificationId: string
  deviceId: string
  value: string
  respondedAt: string
}

/** What the signature covers: the action, or `choose:<optionId>` for a picked option. */
export function signedAnswerValue(action: AnswerAction, optionId?: string): string {
  return action === "choose" ? `choose:${optionId ?? ""}` : action
}

export function answerSigningInput({ interactionId, notificationId, deviceId, value, respondedAt }: AnswerFields): Bytes {
  return utf8([`${E2EE_VERSION} answer`, interactionId, notificationId, deviceId, value, respondedAt].join("\n"))
}

export function questionAnswerSigningInput(fields: AnswerFields & { question: string }): Bytes {
  const { interactionId, notificationId, deviceId, value, respondedAt, question } = fields
  return utf8([`${E2EE_VERSION} answer-to`, interactionId, notificationId, deviceId, value, respondedAt, question].join("\n"))
}

async function sign(privateKey: CryptoKey, message: Bytes): Promise<string> {
  // WebCrypto's ECDSA signature is raw r||s (64 bytes), the format CryptoKit and the CLI use.
  return b64u(copy(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, message)))
}

/**
 * Signs one answer with the browser's identity key. `question` is the context of the sealed
 * question envelope this browser opened and showed; pass it only after opening it.
 */
export async function signAnswer({
  identity,
  browserId,
  interactionId,
  notificationId,
  action,
  optionId,
  question,
  now = Date.now(),
}: {
  identity: { privateKey: CryptoKey; publicKey: string }
  browserId: string
  interactionId: string
  notificationId: string
  action: AnswerAction
  optionId?: string
  question?: string
  now?: number
}): Promise<AnswerSignature> {
  if ((action === "choose") !== Boolean(optionId)) throw new Error("A choice is answered with exactly one option.")
  const respondedAt = new Date(now).toISOString()
  const fields: AnswerFields = {
    interactionId,
    notificationId,
    deviceId: browserId,
    value: signedAnswerValue(action, optionId),
    respondedAt,
  }
  const signature: AnswerSignature = {
    e2eeKeyId: await keyId(fromB64u(identity.publicKey, { length: 65 })),
    e2eeSignedAt: respondedAt,
    e2eeSignature: await sign(identity.privateKey, answerSigningInput(fields)),
  }
  if (question) {
    signature.e2eeQuestion = question
    signature.e2eeQuestionSignature = await sign(identity.privateKey, questionAnswerSigningInput({ ...fields, question }))
  }
  return signature
}
