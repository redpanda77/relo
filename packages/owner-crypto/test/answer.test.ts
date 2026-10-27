import { describe, expect, it } from "vitest"

import * as cli from "@relo/cli-e2ee"

import { answerSigningInput, b64u, copy, fromB64u, fromUtf8, questionAnswerSigningInput, signAnswer, signedAnswerValue } from "../src"

/** A browser identity as keys.ts makes it: a non-extractable ECDSA P-256 private key. */
async function browserIdentity() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])
  const publicKey = b64u(copy(await crypto.subtle.exportKey("raw", pair.publicKey)))
  return { privateKey: pair.privateKey, publicKey }
}

const target = {
  browserId: "brw_00000000-0000-4000-8000-0000000000cc",
  interactionId: "int_00000000-0000-4000-8000-000000000001",
  notificationId: "ntf_00000000-0000-4000-8000-000000000002",
}

describe("a linked browser's signed answer", () => {
  it("signs exactly the bytes the iPhone and the CLI use, with the browser as the answering device", () => {
    const fields = { interactionId: "int_1", notificationId: "ntf_1", deviceId: "brw_1", value: "approve", respondedAt: "2026-10-15T10:00:00.000Z" }
    expect(fromUtf8(answerSigningInput(fields))).toBe("relo.e2e.v1 answer\nint_1\nntf_1\nbrw_1\napprove\n2026-10-15T10:00:00.000Z")
    expect(fromUtf8(answerSigningInput(fields))).toBe(fromUtf8(cli.answerSigningInput(fields)))
    expect(fromUtf8(questionAnswerSigningInput({ ...fields, question: "ntf:q" }))).toBe(
      fromUtf8(cli.questionAnswerSigningInput({ ...fields, question: "ntf:q" }))
    )
    expect(signedAnswerValue("choose", "ship")).toBe("choose:ship")
    expect(signedAnswerValue("deny")).toBe("deny")
  })

  it("produces a signature the CLI verifies, bound to the opened question when one is given", async () => {
    const identity = await browserIdentity()
    const now = Date.parse("2026-10-15T10:00:00.000Z")
    const signed = await signAnswer({ identity, ...target, action: "choose", optionId: "ship", question: "ntf:question-1", now })
    const publicKey = fromB64u(identity.publicKey, { length: 65 })
    expect(signed.e2eeKeyId).toBe(cli.keyId(publicKey))
    expect(signed.e2eeSignedAt).toBe("2026-10-15T10:00:00.000Z")
    const fields = { interactionId: target.interactionId, notificationId: target.notificationId, deviceId: target.browserId,
      value: "choose:ship", respondedAt: signed.e2eeSignedAt }
    expect(cli.verifyBytes(publicKey, cli.answerSigningInput(fields), fromB64u(signed.e2eeSignature, { length: 64 }))).toBe(true)
    expect(signed.e2eeQuestion).toBe("ntf:question-1")
    expect(cli.verifyBytes(publicKey, cli.questionAnswerSigningInput({ ...fields, question: "ntf:question-1" }),
      fromB64u(signed.e2eeQuestionSignature!, { length: 64 }))).toBe(true)
    // Not valid for any other value or question.
    expect(cli.verifyBytes(publicKey, cli.answerSigningInput({ ...fields, value: "choose:wait" }), fromB64u(signed.e2eeSignature, { length: 64 }))).toBe(false)
  })

  it("an unsealed question carries no binding, and a choice needs exactly one option", async () => {
    const identity = await browserIdentity()
    const signed = await signAnswer({ identity, ...target, action: "approve" })
    expect(signed.e2eeQuestion).toBeUndefined()
    expect(signed.e2eeQuestionSignature).toBeUndefined()
    await expect(signAnswer({ identity, ...target, action: "choose" })).rejects.toThrow(/exactly one option/u)
    await expect(signAnswer({ identity, ...target, action: "approve", optionId: "ship" })).rejects.toThrow(/exactly one option/u)
  })
})
