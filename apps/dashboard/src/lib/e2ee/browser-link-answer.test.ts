import { describe, expect, it } from "vitest"

import * as cli from "@relo/cli-e2ee"
import { fromB64u } from "@relo/owner-crypto"

const target = {
  browserId: "brw_00000000-0000-4000-8000-0000000000cc",
  interactionId: "int_00000000-0000-4000-8000-000000000001",
  notificationId: "ntf_00000000-0000-4000-8000-000000000002",
}

describe("BrowserLink answers", () => {
  async function started(linked: boolean, envelopes: Record<string, unknown> = {}) {
    const { BrowserLink } = await import("./browser-link")
    const { memoryStore } = await import("./keys")
    const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } })
      if (url === "/api/dashboard/browser" && init?.method === "POST") {
        return json(200, { browserId: (JSON.parse(String(init.body)) as { browserId: string }).browserId, linked })
      }
      if (url.startsWith("/api/dashboard/sealed")) return json(200, { envelopes })
      if (url.startsWith("/api/dashboard/client-keys")) return json(200, { clients: [] })
      return json(200, { linked })
    }
    const link = new BrowserLink({ accountId: "acct_1", store: memoryStore(), fetcher: fetcher as typeof fetch, name: "Chrome on macOS" })
    await link.start()
    return link
  }

  it("a linked browser signs with its own id as the answering device; an unlinked one refuses", async () => {
    const link = await started(true)
    const state = link.getState()
    if (state.status !== "linked") throw new Error("expected a linked browser")
    const { browserId, signature } = await link.signAnswer({ interactionId: target.interactionId, notificationId: target.notificationId, action: "yes" })
    expect(browserId).toBe(state.browserId)
    const fields = { interactionId: target.interactionId, notificationId: target.notificationId, deviceId: browserId, value: "yes",
      respondedAt: signature.e2eeSignedAt }
    expect(cli.verifyBytes(fromB64u(state.identityKey, { length: 65 }), cli.answerSigningInput(fields),
      fromB64u(signature.e2eeSignature, { length: 64 }))).toBe(true)

    const unlinked = await started(false)
    await expect(unlinked.signAnswer({ interactionId: target.interactionId, notificationId: target.notificationId, action: "yes" }))
      .rejects.toThrow(/Link this browser/u)
    expect(await unlinked.openQuestion(target.notificationId)).toBeNull()
  })

  it("only a question envelope this browser opens is a question it can answer", async () => {
    const card = { v: "relo.e2e.v1", kind: "card" }
    expect(await (await started(true, { [target.notificationId]: card })).openQuestion(target.notificationId)).toBeNull()
    // A question envelope from a computer this browser does not trust does not open.
    const question = { v: "relo.e2e.v1", kind: "question", context: "ntf:q", sender: "k_AAAAAAAAAAAAAAAAAAAAAA", recipients: [] }
    expect(await (await started(true, { [target.notificationId]: question })).openQuestion(target.notificationId)).toBeNull()
  })
})
