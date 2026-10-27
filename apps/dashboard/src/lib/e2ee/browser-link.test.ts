import { describe, expect, it, vi } from "vitest"
import { safetyNumber } from "@relo/cli-e2ee"

import { BrowserLink, linkCode } from "./browser-link"
import { approveComputerSigningInput, b64u, keyId } from "@relo/owner-crypto"
import { memoryStore } from "./keys"
import { hasLockedItems } from "./open-sealed"

describe("BrowserLink.start", () => {
  it("retries after a failed start instead of staying broken until the page is reopened", async () => {
    let up = false
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      if (!up) throw new TypeError("network down")
      const url = String(input)
      if (url.endsWith("/api/dashboard/browser")) return Response.json({ browserId: link.browserIdForRevocation(), linked: true })
      return Response.json({ linked: true })
    })
    const link = new BrowserLink({ accountId: "acct_1", store: memoryStore(), fetcher: fetcher as unknown as typeof fetch, name: "Test" })
    await link.start()
    expect(link.getState().status).toBe("error")
    expect(link.isLinked()).toBe(false)
    up = true
    await link.start()
    expect(link.getState().status).toBe("linked")
  })
})

describe("hasLockedItems", () => {
  it("is true only while an item on the page is still sealed", () => {
    expect(hasLockedItems({ a: [{ b: { encrypted: true } }] })).toBe(true)
    expect(hasLockedItems({ a: [{ b: { encrypted: false, opened: true } }], c: "x" })).toBe(false)
    expect(hasLockedItems(null)).toBe(false)
  })
})

describe("computers are approved once, on any trusted device", () => {
  async function identity() {
    const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])
    const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
    return { publicKey: b64u(raw), raw, sign: async (message: Uint8Array) => b64u(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array(message)))) }
  }

  it("holds a later computer until an approver it pinned signs its key, and signs the ones it trusts", async () => {
    const phone = await identity()
    const rogue = await identity()
    const computers: Array<Record<string, unknown>> = []
    const posted: string[] = []
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/dashboard/browser")) return Response.json({ browserId: link.browserIdForRevocation(), linked: true })
      if (url.endsWith("/api/dashboard/client-keys")) return Response.json({ clients: computers })
      if (url.endsWith("/api/dashboard/approvers")) {
        return Response.json({ approvers: [{ id: "dev_phone", kind: "phone", name: "iPhone", identityKey: phone.publicKey, vouchedBy: null },
          { id: "dev_rogue", kind: "phone", name: "Rogue", identityKey: rogue.publicKey, vouchedBy: null }].slice(0, posted.length === 0 ? 1 : 2) })
      }
      if (url.includes("/api/dashboard/computers/") && init?.method === "POST") {
        posted.push(url.split("/")[4]!)
        return Response.json({ approved: true })
      }
      return Response.json({ linked: true })
    })
    const link = new BrowserLink({ accountId: "acct_1", store: memoryStore(), fetcher: fetcher as unknown as typeof fetch, name: "Test" })
    await link.start()
    const computer = async (clientId: string) => {
      const key = await identity()
      return { clientId, name: clientId, keyId: await keyId(key.raw), publicKey: key.publicKey, approvals: [] as unknown[] }
    }
    const studio = await computer("key_studio")
    computers.push(studio)
    expect((await link.trustedSenders()).has(studio.keyId)).toBe(true)
    await vi.waitFor(() => expect(posted).toEqual(["key_studio"]))

    // Signed in later: pending, also when an approver the browser never pinned (added by the server) signs it.
    const box = await computer("key_box")
    computers.push(box)
    expect((await link.trustedSenders()).has(box.keyId)).toBe(false)
    const sign = async (by: typeof phone, approverId: string) => {
      const signedAt = new Date().toISOString()
      return { approverId, signedAt, signature: await by.sign(approveComputerSigningInput({ clientId: box.clientId, identityKey: box.publicKey, approverId, signedAt })) }
    }
    box.approvals = [await sign(rogue, "dev_rogue")]
    expect((await link.trustedSenders()).has(box.keyId)).toBe(false)
    expect(await link.pendingComputers()).toEqual([{ clientId: "key_box", name: "key_box" }])
    // Approved on the phone: it opens here too.
    box.approvals = [await sign(phone, "dev_phone")]
    expect((await link.trustedSenders()).has(box.keyId)).toBe(true)
    expect(await link.pendingComputers()).toEqual([])
  })
})

describe("linkCode", () => {
  // Key bytes 0x04, 1, 2, …, 64: the vector the iPhone's tests pin too.
  const key = Uint8Array.from({ length: 65 }, (_, i) => (i === 0 ? 4 : i))

  it("is the first three groups of the fingerprint behind the CLI's safety number", async () => {
    const code = await linkCode(b64u(key))
    expect(code).toBe("76037 78271 31032")
    expect(safetyNumber(key, key).startsWith(code)).toBe(true)
  })
})

describe("BrowserLink.requestLink", () => {
  it("asks the phones once and names why it could not", async () => {
    const answers = [Response.json({ requested: true, phones: 2 }), Response.json({ error: "no_phone" }, { status: 409 })]
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.endsWith("/api/dashboard/browser")) return Response.json({ browserId: link.browserIdForRevocation(), linked: false })
      if (url.endsWith("/link-request") && init?.method === "POST") return answers.shift()!
      return Response.json({ linked: false })
    })
    const link = new BrowserLink({ accountId: "acct_1", store: memoryStore(), fetcher: fetcher as unknown as typeof fetch, name: "Test" })
    await link.start()
    expect(await link.requestLink()).toEqual({ ok: true, phones: 2 })
    expect(await link.requestLink()).toEqual({ ok: false, error: "no_phone" })
  })
})
