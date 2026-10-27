import { describe, expect, it } from "vitest"

import * as cli from "@relo/cli-e2ee"

import { ensureOwnerKeys, fromB64u, loadOwnerKeys, memoryStore, signPrekey } from "../src"

describe("OwnerKeys", () => {
  it("signs a prekey for the id the server assigned, the signature the server and the CLI verify", async () => {
    const keys = await ensureOwnerKeys(memoryStore(), "acct_1", { newRecipientId: () => "dev_pending" })
    const prekey = keys.prekeys[0]!
    for (const recipientId of [keys.recipientId, "dev_00000000-0000-4000-8000-000000000042"]) {
      const signature = await signPrekey(keys, prekey, recipientId)
      expect(
        cli.verifyPrekey({
          identityPublicKey: fromB64u(keys.identity.publicKey),
          prekey: { deviceId: recipientId, prekeyId: prekey.prekeyId, publicKey: prekey.publicKey, createdAt: prekey.createdAt, signature },
        })
      ).toBe(true)
    }
  })

  it("stores under owner:<account> unless told where, and keeps the id it chose", async () => {
    const store = memoryStore()
    const chosen = await ensureOwnerKeys(store, "acct_1", { newRecipientId: () => "dev_a" })
    expect(await loadOwnerKeys(store, "acct_1")).toBe(chosen)
    expect(await store.get("browser:acct_1")).toBeUndefined()
    // A second call never asks for another id.
    const again = await ensureOwnerKeys(store, "acct_1", { newRecipientId: () => "dev_b" })
    expect(again.recipientId).toBe("dev_a")
    expect(again.publishedRecipientId).toBeNull()

    await ensureOwnerKeys(store, "acct_1", { newRecipientId: () => "dev_c", stateKey: "custom" })
    expect((await store.get<{ recipientId: string }>("custom"))!.recipientId).toBe("dev_c")
  })
})
