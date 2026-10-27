import { readFileSync } from "node:fs"
import { describe, expect, it } from "vitest"

import * as cli from "@relo/cli-e2ee"

import {
  approveDeviceSigningInput,
  b64u,
  ensureOwnerKeys,
  fromB64u,
  keyId,
  memoryStore,
  openEnvelope,
  PREKEY_KEEP_RETIRED_MS,
  PREKEY_ROTATE_MS,
  prekeyLookup,
  signPrekey,
  type Bytes,
  type RecipientPrekey,
} from "../src"

const fixtureText = readFileSync(new URL("../../contracts/fixtures/e2ee-v1.json", import.meta.url), "utf8")
const newRecipientId = () => `dev_${crypto.randomUUID()}`

type Fixture = {
  keys: Record<string, { privateKey: string; publicKey: string; keyId: string }>
  node: { envelope: unknown; content: unknown }
  cryptokit: { envelope: { recipients: Array<{ device: string; prekey: string }> } }
  rejections: Array<{ name: string; envelope: unknown; error: string }>
}
const fixture = JSON.parse(fixtureText) as Fixture

/** Imports a fixture's raw P-256 scalar as a non-extractable ECDH key, as a browser would hold it. */
async function fixturePrekey(name: string): Promise<RecipientPrekey> {
  const { privateKey, publicKey } = fixture.keys[name]!
  const point = fromB64u(publicKey)
  const key = await crypto.subtle.importKey(
    "jwk",
    { kty: "EC", crv: "P-256", d: privateKey, x: b64u(point.subarray(1, 33)), y: b64u(point.subarray(33)) },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"]
  )
  return { privateKey: key, publicKey: point }
}

function senders(...names: string[]) {
  return new Map<string, Bytes>(names.map((name) => [fixture.keys[name]!.keyId, fromB64u(fixture.keys[name]!.publicKey)]))
}

describe("relo.e2e.v1 open side on WebCrypto", () => {
  it("computes key ids like the CLI", async () => {
    for (const key of Object.values(fixture.keys)) expect(await keyId(fromB64u(key.publicKey))).toBe(key.keyId)
  })

  it("opens the CLI fixture envelope", async () => {
    const prekey = await fixturePrekey("prekey")
    const opened = await openEnvelope(fixture.node.envelope, {
      deviceId: "dev_phone",
      prekeyFor: (id) => (id === "pk_1" ? prekey : null),
      trustedSenders: senders("cliIdentity"),
    })
    expect(opened.content).toEqual(fixture.node.content)
    expect(opened.kind).toBe("notice")
  })

  it("opens the CryptoKit fixture envelope", async () => {
    const entry = fixture.cryptokit.envelope.recipients.find((recipient) => recipient.device === "dev_phone")!
    const prekey = await fixturePrekey(entry.prekey === "pk_1" ? "prekey" : "otherDevicePrekey")
    const opened = await openEnvelope(fixture.cryptokit.envelope, {
      deviceId: "dev_phone",
      prekeyFor: () => prekey,
      trustedSenders: senders("deviceIdentity", "cliIdentity"),
    })
    expect(opened.content).toBeTruthy()
  })

  it("rejects every tampered fixture", async () => {
    const prekey = await fixturePrekey("prekey")
    for (const rejection of fixture.rejections) {
      await expect(
        openEnvelope(rejection.envelope, { deviceId: "dev_phone", prekeyFor: () => prekey, trustedSenders: senders("cliIdentity") }),
        rejection.name
      ).rejects.toMatchObject({ code: expect.any(String) })
    }
  })

  it("refuses an untrusted sender and a wrong device", async () => {
    const prekey = await fixturePrekey("prekey")
    await expect(
      openEnvelope(fixture.node.envelope, { deviceId: "dev_phone", prekeyFor: () => prekey, trustedSenders: new Map() })
    ).rejects.toMatchObject({ code: "untrusted_sender" })
    await expect(
      openEnvelope(fixture.node.envelope, { deviceId: "brw_other", prekeyFor: () => prekey, trustedSenders: senders("cliIdentity") })
    ).rejects.toMatchObject({ code: "not_a_recipient" })
  })

  it("opens what the CLI seals to a browser-generated prekey, and the CLI verifies its prekey signature", async () => {
    const store = memoryStore()
    const keys = await ensureOwnerKeys(store, "acct_1", { newRecipientId: () => "dev_server_assigned_1" })
    const prekey = keys.prekeys[0]!
    expect(prekey.privateKey.extractable).toBe(false)
    expect(keys.identity.privateKey.extractable).toBe(false)
    expect(keys.recipientId).toBe("dev_server_assigned_1")
    expect(keys.identity.keyId).toBe(cli.keyId(fromB64u(keys.identity.publicKey)))

    const signature = await signPrekey(keys, prekey)
    expect(
      cli.verifyPrekey({
        identityPublicKey: fromB64u(keys.identity.publicKey),
        prekey: { deviceId: keys.recipientId, prekeyId: prekey.prekeyId, publicKey: prekey.publicKey, createdAt: prekey.createdAt, signature },
      })
    ).toBe(true)

    const computer = cli.generateKeyPair()
    const phone = cli.generateKeyPair()
    const content = { title: "Deploy finished", summary: "848 tests passed", body: "Ünïcödé ✅", names: { "p-abcdefghijklmnop": "relo" } }
    const envelope = cli.sealEnvelope({
      kind: "card",
      context: "ntf:abc",
      sender: { privateKey: computer.privateKey },
      recipients: [
        { deviceId: "dev_phone", prekeyId: "pk_phone", publicKey: phone.publicKey },
        { deviceId: keys.recipientId, prekeyId: prekey.prekeyId, publicKey: fromB64u(prekey.publicKey) },
      ],
      content,
    })
    const trusted = new Map([[cli.keyId(computer.publicKey), computer.publicKey as Bytes]])
    const opened = await openEnvelope(envelope, { deviceId: keys.recipientId, prekeyFor: prekeyLookup(keys), trustedSenders: trusted })
    expect(opened.content).toEqual(content)

    const tampered = { ...envelope, recipients: envelope.recipients.map((r) => ({ ...r, key: r.key!.replace(/^./u, (c) => (c === "A" ? "B" : "A")) })) }
    await expect(openEnvelope(tampered, { deviceId: keys.recipientId, prekeyFor: prekeyLookup(keys), trustedSenders: trusted })).rejects.toBeTruthy()
  })

  it("rotates the prekey every 10 hours and deletes retired private prekeys after 12 hours", async () => {
    const store = memoryStore()
    const start = Date.parse("2026-10-13T00:00:00Z")
    const first = await ensureOwnerKeys(store, "acct_1", { newRecipientId, now: start })
    expect((await ensureOwnerKeys(store, "acct_1", { newRecipientId, now: start + 1000 })).prekeys).toHaveLength(1)
    const rotated = await ensureOwnerKeys(store, "acct_1", { newRecipientId, now: start + PREKEY_ROTATE_MS })
    expect(rotated.prekeys).toHaveLength(2)
    expect(rotated.prekeys[1]!.prekeyId).toBe(first.prekeys[0]!.prekeyId)
    expect(rotated.identity.publicKey).toBe(first.identity.publicKey)
    const later = await ensureOwnerKeys(store, "acct_1", { newRecipientId, now: start + PREKEY_ROTATE_MS + PREKEY_KEEP_RETIRED_MS + 1 })
    expect(later.prekeys.map((prekey) => prekey.prekeyId)).not.toContain(first.prekeys[0]!.prekeyId)
    expect(prekeyLookup(later)(first.prekeys[0]!.prekeyId)).toBeNull()
    // Another account on the same browser gets its own keys.
    expect((await ensureOwnerKeys(store, "acct_2", { newRecipientId })).identity.publicKey).not.toBe(first.identity.publicKey)
  })
})

describe("approving a device from a linked browser", () => {
  it("signs exactly the bytes the CLI (and the iPhone) sign, with the browser as the approver", () => {
    const input = { deviceId: "dev_00000000-0000-4000-8000-000000000001", identityKey: "B".repeat(87),
      approverDeviceId: "brw_00000000-0000-4000-8000-000000000002", signedAt: "2026-10-14T08:00:00.000Z" }
    expect(Array.from(approveDeviceSigningInput(input))).toEqual(Array.from(cli.approveDeviceSigningInput(input)))
  })
})
