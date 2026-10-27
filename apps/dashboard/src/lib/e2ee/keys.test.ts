import { describe, expect, it } from "vitest"

import * as cli from "@relo/cli-e2ee"
import { fromB64u, PREKEY_ROTATE_MS } from "@relo/owner-crypto"

import { ensureBrowserKeys, loadBrowserKeys, memoryStore, newBrowserId, saveBrowserKeys, signPrekey } from "./keys"

/** A record exactly as the Dashboard stored it before @relo/owner-crypto: `browserId`, `publishedBrowserId`. */
async function legacyRecord(createdAt: string) {
  const identity = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])
  const prekey = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])
  const raw = async (key: CryptoKey) => cli.b64u(new Uint8Array(await crypto.subtle.exportKey("raw", key)))
  const publicKey = await raw(identity.publicKey)
  return {
    browserId: "brw_00000000-0000-4000-8000-0000000000aa",
    identity: { privateKey: identity.privateKey, publicKey, keyId: cli.keyId(fromB64u(publicKey)) },
    prekeys: [{ prekeyId: "pk_legacy", privateKey: prekey.privateKey, publicKey: await raw(prekey.publicKey), createdAt, retiredAt: null }],
    publishedPrekeyId: "pk_legacy",
    publishedBrowserId: "brw_00000000-0000-4000-8000-0000000000aa",
  }
}

describe("browser keys keep the record this Dashboard already stored", () => {
  it("reads a legacy record as it is: same id, identity and prekeys, nothing regenerated or rewritten", async () => {
    const createdAt = new Date().toISOString()
    const legacy = await legacyRecord(createdAt)
    const store = memoryStore()
    await store.set("browser:acct_1", legacy)

    const keys = await ensureBrowserKeys(store, "acct_1")
    expect(keys).toEqual(legacy)
    expect(keys.identity.privateKey).toBe(legacy.identity.privateKey)
    // Nothing changed, so nothing was saved: the stored object is the very one written before.
    expect(await store.get("browser:acct_1")).toBe(legacy)
    expect(await store.get("owner:acct_1")).toBeUndefined()
    expect(await loadBrowserKeys(store, "acct_1")).toEqual(legacy)
  })

  it("keeps writing the legacy shape when it rotates or registers, so an older Dashboard still reads it", async () => {
    const legacy = await legacyRecord("2026-10-13T00:00:00.000Z")
    const store = memoryStore()
    await store.set("browser:acct_1", legacy)

    const rotated = await ensureBrowserKeys(store, "acct_1", Date.parse("2026-10-13T00:00:00.000Z") + PREKEY_ROTATE_MS)
    expect(rotated.browserId).toBe(legacy.browserId)
    expect(rotated.prekeys).toHaveLength(2)
    const stored = (await store.get("browser:acct_1")) as Record<string, unknown>
    expect(stored).toMatchObject({ browserId: legacy.browserId, publishedBrowserId: legacy.publishedBrowserId, publishedPrekeyId: "pk_legacy" })
    expect(stored).not.toHaveProperty("recipientId")
    expect(stored).not.toHaveProperty("publishedRecipientId")

    await saveBrowserKeys(store, "acct_1", { ...rotated, browserId: newBrowserId(), publishedPrekeyId: null, publishedBrowserId: null })
    const renewed = (await store.get("browser:acct_1")) as Record<string, unknown>
    expect(renewed.browserId).not.toBe(legacy.browserId)
    expect(renewed).toMatchObject({ publishedBrowserId: null })
    expect(renewed).not.toHaveProperty("recipientId")
  })

  it("creates a new browser's keys in the legacy shape under browser:<account>", async () => {
    const store = memoryStore()
    const keys = await ensureBrowserKeys(store, "acct_9")
    expect(keys.browserId).toMatch(/^brw_[0-9a-f-]{36}$/u)
    expect(keys.publishedBrowserId).toBeNull()
    const stored = (await store.get("browser:acct_9")) as Record<string, unknown>
    expect(stored.browserId).toBe(keys.browserId)
    expect(stored).not.toHaveProperty("recipientId")
    expect(await store.get("owner:acct_9")).toBeUndefined()
  })

  it("signs a prekey for the browser id the server accepted, which the CLI verifies", async () => {
    const keys = await ensureBrowserKeys(memoryStore(), "acct_1")
    const prekey = keys.prekeys[0]!
    for (const browserId of [keys.browserId, "brw_00000000-0000-4000-8000-0000000000bb"]) {
      const signature = await signPrekey(keys, prekey, browserId)
      expect(
        cli.verifyPrekey({
          identityPublicKey: fromB64u(keys.identity.publicKey),
          prekey: { deviceId: browserId, prekeyId: prekey.prekeyId, publicKey: prekey.publicKey, createdAt: prekey.createdAt, signature },
        })
      ).toBe(true)
    }
  })
})
