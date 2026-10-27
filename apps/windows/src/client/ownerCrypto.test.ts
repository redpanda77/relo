// The Windows adapter (owner-crypto behind owner-client's OwnerCrypto) against owner-client's fake server: sign in with a
// fake callback, register, publish keys signed for the server-assigned dev_ id, open text the CLI sealed to this PC's
// prekey, sign an answer. The CLI's own sealing and verification code is the other side (as in owner-crypto's tests).

import { createPublicKey, verify } from "node:crypto"
import * as cli from "@relo/cli-e2ee"
import { memoryStore, OwnerStore, type DeviceInfo, type FetchLike } from "@relo/owner-client"
import { approveComputerSigningInput, b64u, memoryStore as keyStore } from "@relo/owner-crypto"
import { afterEach, describe, expect, it, vi } from "vitest"
import { presentationOf, workingSessionsWithoutCards } from "../relo/presentation"
import { DEVICE, FakeServer, INTERACTION, NOTIFICATION, nowSummary, ORIGIN, questionDetail } from "../../../../packages/owner-client/src/test-support/fakeServer"
import { createOwnerCrypto, UNREGISTERED } from "./ownerCrypto"
import { notificationsByInteraction, questionSpecs, spokenWordsOf, trayStateOf, withSpoken } from "./view"

const CODE = "relo_signin_" + "A".repeat(43)
const info: DeviceInfo = { name: "PC", bundleIdentifier: "ai.relo.windows", appVersion: "0.1.0", appBuild: "1", osVersion: "Windows 11" }
const stores: OwnerStore[] = []
afterEach(() => stores.splice(0).forEach((store) => store.stop()))

type Computer = { clientId: string; name: string; keyId: string; publicKey: string; approvals: unknown[] }
const computerOf = (clientId: string, keys: { publicKey: Uint8Array }): Computer => ({
  clientId, name: clientId, keyId: cli.keyId(keys.publicKey), publicKey: cli.b64u(keys.publicKey), approvals: [],
})

async function phone() {
  const pair = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])
  const raw = new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey))
  return { raw, publicKey: b64u(raw), sign: async (message: Uint8Array) => b64u(new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new Uint8Array(message)))) }
}

function world() {
  const server = new FakeServer()
  const studio = cli.generateKeyPair()
  const computers: Computer[] = [computerOf("key_studio", studio)]
  const approvers: unknown[] = []
  const clock = { offset: 0 }
  const posted: Array<{ clientId: string; identityKey: string; signedAt: string; signature: string }> = []
  const now = () => Date.now() + clock.offset
  const fetch: FetchLike = async (input, init) => {
    const url = new URL(input)
    if (url.pathname === "/api/clients/keys" || url.pathname === "/api/devices/self/approvers") {
      const bearer = (init?.headers as Record<string, string> | undefined)?.Authorization
      if (bearer !== `Bearer ${server.deviceToken}`) return Response.json({ error: "unauthorized" }, { status: 401 })
      return Response.json(url.pathname === "/api/clients/keys" ? { clients: computers } : { approvers })
    }
    if (url.pathname === "/api/devices/self/computer-approvals" && init?.method === "POST") {
      posted.push(JSON.parse(String(init.body)))
      return Response.json({ approved: true })
    }
    return server.fetch(input, init)
  }
  const secrets = memoryStore()
  const keys = keyStore()
  const crypto = createOwnerCrypto({ keys, secrets, fetch, now })
  const store = new OwnerStore({ fetch, secrets, prefs: memoryStore(), crypto, device: info })
  stores.push(store)
  return { server, studio, computers, approvers, posted, clock, secrets, keys, crypto, store }
}
type World = ReturnType<typeof world>

async function signIn(w: World) {
  await w.store.start()
  expect(await w.store.setServerOrigin(ORIGIN)).toBe(true)
  const url = new URL((await w.store.beginSignIn())!)
  w.server.codeChallenge = url.searchParams.get("code_challenge")
  await w.store.completeSignIn(`relo://auth/callback?code=${CODE}&state=${url.searchParams.get("state")}`)
  await vi.waitFor(() => expect(w.server.count("PUT", "/api/devices/self/keys")).toBe(1))
  expect(w.store.getState().connection).toBe("live")
  return w.server.seen.find((s) => s.method === "PUT" && s.path === "/api/devices/self/keys")!.body as {
    identityKey: string
    prekey: { prekeyId: string; publicKey: string; createdAt: string; signature: string }
  }
}

/** apps/server/src/device-keys.ts `verifyPrekeySignature`, re-implemented with node:crypto. */
function serverAccepts(identityKey: string, deviceId: string, prekey: { prekeyId: string; publicKey: string; createdAt: string; signature: string }): boolean {
  const key = (publicKey: string) => {
    const bytes = Buffer.from(publicKey, "base64url")
    if (bytes.length !== 65 || bytes[0] !== 0x04) return undefined
    return createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: bytes.subarray(1, 33).toString("base64url"), y: bytes.subarray(33).toString("base64url") } })
  }
  const identity = key(identityKey)
  if (!identity || !key(prekey.publicKey)) return false
  const message = Buffer.from(["relo.e2e.v1 prekey", deviceId, prekey.prekeyId, prekey.publicKey, prekey.createdAt].join("\n"))
  return verify("sha256", message, { key: identity, dsaEncoding: "ieee-p1363" }, Buffer.from(prekey.signature, "base64url"))
}

function seal(w: World, published: { prekey: { prekeyId: string; publicKey: string } }, kind: string, content: unknown, sender = w.studio, context = "ctx:test") {
  return cli.sealEnvelope({
    kind, context, sender: { privateKey: sender.privateKey }, content,
    recipients: [{ deviceId: DEVICE, prekeyId: published.prekey.prekeyId, publicKey: cli.fromB64u(published.prekey.publicKey) }],
  })
}

/** A Now summary whose first card is sealed (the server's placeholders in the clear). */
function sealedNow(card: unknown, question: unknown = null, asking = false) {
  const summary = nowSummary({ question: asking })
  summary.needsYou[0].title = "Encrypted card"
  summary.needsYou[0].status = "Updating…"
  summary.needsYou[0].sealed = { card, question }
  return summary
}

describe("keys", () => {
  it("makes the identity before register and signs the prekey for the dev_ id after it", async () => {
    const w = world()
    await w.crypto.ensureKeys()
    const created = (await w.keys.get<{ recipientId: string }>("owner:this-pc"))!
    expect(created.recipientId).toBe(UNREGISTERED)

    const published = await signIn(w)
    expect(published.identityKey).toBe((await w.keys.get<{ identity: { publicKey: string } }>("owner:this-pc"))!.identity.publicKey)
    expect((await w.keys.get<{ recipientId: string }>("owner:this-pc"))!.recipientId).toBe(DEVICE)
    // What the server checks before it stores the keys.
    expect(serverAccepts(published.identityKey, DEVICE, published.prekey)).toBe(true)
    expect(serverAccepts(published.identityKey, "dev_00000000-0000-4000-8000-0000000000ff", published.prekey)).toBe(false)
    expect(serverAccepts(published.identityKey, UNREGISTERED, published.prekey)).toBe(false)
    // The strict body schema's shapes.
    expect(Buffer.from(published.identityKey, "base64url")).toHaveLength(65)
    expect(Buffer.from(published.prekey.publicKey, "base64url")).toHaveLength(65)
    expect(Buffer.from(published.prekey.signature, "base64url")).toHaveLength(64)
    expect(published.prekey.prekeyId).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(new Date(published.prekey.createdAt).toISOString()).toBe(published.prekey.createdAt)
    // The CLI's own verifier agrees.
    expect(cli.verifyPrekey({ identityPublicKey: cli.fromB64u(published.identityKey), prekey: { deviceId: DEVICE, ...published.prekey } })).toBe(true)
  })

  it("keeps one identity for one device id and starts a new one for another", async () => {
    const w = world()
    const first = await w.crypto.publishablePrekey(DEVICE, { rotate: false })
    const again = await w.crypto.publishablePrekey(DEVICE, { rotate: false })
    expect(again.identityKey).toBe(first.identityKey)
    expect(again.prekey.prekeyId).toBe(first.prekey.prekeyId)
    const other = "dev_00000000-0000-4000-8000-0000000000aa"
    const next = await w.crypto.publishablePrekey(other, { rotate: false })
    expect(next.identityKey).not.toBe(first.identityKey)
    expect(serverAccepts(next.identityKey, other, next.prekey)).toBe(true)
  })

  it("forgets everything on sign-out: nothing signs afterwards", async () => {
    const w = world()
    await signIn(w)
    const request = { interactionId: INTERACTION, notificationId: NOTIFICATION, deviceId: DEVICE, value: "approve", respondedAt: new Date().toISOString() }
    expect(await w.crypto.signAnswer(request)).not.toBeNull()
    await w.crypto.forget()
    expect(await w.crypto.signAnswer(request)).toBeNull()
    expect(await w.keys.get("owner:this-pc")).toBeUndefined()
  })
})

describe("opening what the computer sealed to this PC", () => {
  it("shows the real card in Now once the key is published, and nothing readable before", async () => {
    const w = world()
    const published = await signIn(w)
    w.server.nowBody = sealedNow(seal(w, published, "card", { title: "Cut release 0.18.116", status: "Running tests" }))
    w.store.refreshNow()
    await vi.waitFor(() => expect(w.store.getState().summary?.needsYou[0]?.title).toBe("Cut release 0.18.116"))
    expect(w.store.getState().summary?.needsYou[0]?.status).toBe("Running tests")
    const row = presentationOf(w.store.getState().summary).sections.flatMap((s) => s.rows)[0]!
    expect(row.unreadable).toBe(false)
  })

  it("leaves a card sealed by a computer this PC does not trust locked: the notch says to approve this PC", async () => {
    const w = world()
    const published = await signIn(w)
    const stranger = cli.generateKeyPair()
    w.server.nowBody = sealedNow(seal(w, published, "card", { title: "Not yours", status: "x" }, stranger))
    w.store.refreshNow()
    await vi.waitFor(() => expect(w.store.getState().summary?.needsYou[0]?.sealed).toBeDefined())
    expect(w.store.getState().summary?.needsYou[0]?.title).toBe("Encrypted card")
    const presentation = presentationOf(w.store.getState().summary)
    expect(presentation.hasUnreadable).toBe(true)
  })

  it("trusts computers present at first contact; a later one opens only after a pinned approver signs it", async () => {
    const w = world()
    const approver = await phone()
    w.approvers.push({ id: "dev_phone", kind: "phone", name: "iPhone", identityKey: approver.publicKey, vouchedBy: null })
    const published = await signIn(w)
    const tree = (card: unknown) => structuredClone(sealedNow(card))
    const opened = async (card: unknown) => ((await w.crypto.openTree(tree(card))) as ReturnType<typeof nowSummary>).needsYou[0].title

    expect(await opened(seal(w, published, "card", { title: "From the studio", status: "ok" }))).toBe("From the studio")

    const box = cli.generateKeyPair()
    const late = computerOf("key_box", box)
    w.computers.push(late)
    w.clock.offset += 61_000
    expect(await opened(seal(w, published, "card", { title: "From the box", status: "ok" }, box))).toBe("Encrypted card")
    expect(await w.crypto.pendingComputers()).toEqual(["key_box"])

    const signedAt = new Date().toISOString()
    late.approvals = [{ approverId: "dev_phone", signedAt, signature: await approver.sign(approveComputerSigningInput({ clientId: "key_box", identityKey: late.publicKey, approverId: "dev_phone", signedAt })) }]
    w.clock.offset += 61_000
    expect(await opened(seal(w, published, "card", { title: "From the box", status: "ok" }, box))).toBe("From the box")
    expect(await w.crypto.pendingComputers()).toEqual([])
  })
})

describe("computers waiting for approval", () => {
  const verifies = (publicKey: string, message: Uint8Array, signature: string) => {
    const raw = Buffer.from(publicKey, "base64url")
    const key = createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: raw.subarray(1, 33).toString("base64url"), y: raw.subarray(33).toString("base64url") } })
    return verify("sha256", message, { key, dsaEncoding: "ieee-p1363" }, Buffer.from(signature, "base64url"))
  }

  async function withLateComputer() {
    const w = world()
    const published = await signIn(w)
    expect(await w.crypto.syncApprovals()).toEqual([]) // first contact: the studio is trusted
    const box = cli.generateKeyPair()
    const late = computerOf("key_box", box)
    w.computers.push(late)
    w.clock.offset += 61_000
    return { w, published, box, late }
  }
  const titleFrom = async (w: World, published: Awaited<ReturnType<typeof signIn>>, box: ReturnType<typeof cli.generateKeyPair>) =>
    ((await w.crypto.openTree(structuredClone(sealedNow(seal(w, published, "card", { title: "From the box", status: "ok" }, box))))) as ReturnType<typeof nowSummary>).needsYou[0].title

  it("lists the computer that signed in later, and signs this PC's approval for the ones it trusts", async () => {
    const { w, published } = await withLateComputer()
    expect(await w.crypto.syncApprovals()).toEqual([{ id: "key_box", name: "key_box" }])
    const studio = w.posted.find((post) => post.clientId === "key_studio")!
    expect(studio).toBeTruthy()
    expect(verifies(published.identityKey, approveComputerSigningInput({ clientId: "key_studio", identityKey: studio.identityKey, approverId: DEVICE, signedAt: studio.signedAt }), studio.signature)).toBe(true)
    expect(w.posted.some((post) => post.clientId === "key_box")).toBe(false)
    await w.crypto.syncApprovals()
    expect(w.posted.filter((post) => post.clientId === "key_studio")).toHaveLength(1)
  })

  it("approving trusts it here, opens its cards, and sends a signed approval for the other devices", async () => {
    const { w, published, box, late } = await withLateComputer()
    await w.crypto.syncApprovals()
    expect(await titleFrom(w, published, box)).toBe("Encrypted card")

    expect(await w.crypto.approveComputer("key_box")).toBe(true)
    const post = w.posted.find((p) => p.clientId === "key_box")!
    expect(post.identityKey).toBe(late.publicKey)
    expect(verifies(published.identityKey, approveComputerSigningInput({ clientId: "key_box", identityKey: late.publicKey, approverId: DEVICE, signedAt: post.signedAt }), post.signature)).toBe(true)
    expect(await titleFrom(w, published, box)).toBe("From the box")
    expect(await w.crypto.syncApprovals()).toEqual([])
  })

  it("declining keeps it closed on this PC and keeps it from coming back as waiting", async () => {
    const { w, published, box } = await withLateComputer()
    await w.crypto.syncApprovals()
    await w.crypto.declineComputer("key_box")
    expect(await w.crypto.syncApprovals()).toEqual([])
    expect(await titleFrom(w, published, box)).toBe("Encrypted card")
    expect(w.posted.some((p) => p.clientId === "key_box")).toBe(false)
  })

  it("does nothing before this PC is registered", async () => {
    const w = world()
    expect(await w.crypto.syncApprovals()).toEqual([])
    expect(await w.crypto.approveComputer("key_box")).toBe(false)
  })
})

describe("questions", () => {
  it("opens the sealed question, then signs the answer bound to it so the computer accepts it", async () => {
    const w = world()
    const published = await signIn(w)
    const envelope = seal(w, published, "question", { title: "Deploy?", summary: "Deploy 0.18.116 to production?", body: "Deploy 0.18.116 to production?" }, w.studio, "ntf:q1")
    w.server.nowBody = sealedNow(seal(w, published, "card", { title: "Release", status: "Waiting" }), envelope, true)
    w.server.detail = questionDetail({ prompt: "Encrypted question" }, { alert: null, content: envelope })
    w.store.refreshNow()
    await vi.waitFor(() => expect(w.store.getState().questions[NOTIFICATION]?.prompt).toBe("Deploy 0.18.116 to production?"))

    // What the notch gets: kind, prompt and options by the question's id; answers map back to its notification.
    const state = w.store.getState()
    expect(questionSpecs(state)[INTERACTION]).toMatchObject({ kind: "choice", prompt: "Deploy 0.18.116 to production?" })
    expect(notificationsByInteraction(state.summary).get(INTERACTION)).toBe(NOTIFICATION)

    await w.store.answer(NOTIFICATION, "choose", { optionId: "yes" })
    expect(w.store.getState().answers[NOTIFICATION]).toEqual({ phase: "accepted" })
    const posted = w.server.seen.find((s) => s.method === "POST" && s.path === `/api/notifications/${NOTIFICATION}/interactions`)!.body.value as Record<string, string>
    expect(posted.optionId).toBe("yes")
    expect(posted.e2eeKeyId).toBe(cli.keyId(cli.fromB64u(published.identityKey)))
    const fields = { interactionId: INTERACTION, notificationId: NOTIFICATION, deviceId: DEVICE, value: "choose:yes", respondedAt: posted.e2eeSignedAt! }
    const identity = cli.fromB64u(published.identityKey)
    expect(cli.verifyBytes(identity, cli.answerSigningInput(fields), cli.fromB64u(posted.e2eeSignature!))).toBe(true)
    expect(posted.e2eeQuestion).toBe("ntf:q1")
    expect(cli.verifyBytes(identity, cli.questionAnswerSigningInput({ ...fields, question: "ntf:q1" }), cli.fromB64u(posted.e2eeQuestionSignature!))).toBe(true)
  })

  it("does not offer buttons for a question it could not read", async () => {
    const w = world()
    const published = await signIn(w)
    const stranger = cli.generateKeyPair()
    const envelope = seal(w, published, "question", { title: "x", summary: "Secret?" }, stranger, "ntf:q2")
    w.server.nowBody = sealedNow(null, envelope, true)
    w.server.detail = questionDetail({ prompt: "Encrypted question" }, { alert: null, content: envelope })
    w.store.refreshNow()
    await vi.waitFor(() => expect(w.store.getState().questions[NOTIFICATION]).toBeDefined())
    expect(questionSpecs(w.store.getState())).toEqual({})
  })
})

describe("tray", () => {
  it("says what the connection is and the server's counts", () => {
    const summary = nowSummary()
    const live = trayStateOf({ connection: "live", summary, serverOrigin: "https://relo.example.com", accountEmail: "ada@example.com" }, false)
    const presentation = presentationOf(summary)
    expect(live).toMatchObject({ status: "live", needsYou: presentation.needsYouCount, paused: false, hasOrigin: true, email: "ada@example.com", connecting: false })
    expect(live.running).toBe((presentation.sections.find((s) => s.kind === "running")?.rows.length ?? 0) + workingSessionsWithoutCards(presentation))
    expect(live.firstTitle).toBe(presentation.sections.find((s) => s.kind === "needsYou")?.rows[0]?.title ?? null)
    expect(trayStateOf({ connection: "signedOut", summary: null }, true)).toEqual({ status: "signedOut", needsYou: 0, running: 0, paused: true, hasOrigin: false, firstTitle: null, email: null, connecting: false })
    expect(trayStateOf({ connection: "offline", summary }, false).status).toBe("offline")
    expect(trayStateOf({ connection: "signingIn", summary: null }, false).status).toBe("signedOut")
    expect(trayStateOf({ connection: "connecting", summary: null }, false)).toMatchObject({ status: "starting", connecting: true })
    expect(trayStateOf({ connection: "starting", summary: null }, false)).toMatchObject({ status: "starting", connecting: false })
  })
})

describe("what a card says aloud (ADR 0015)", () => {
  // The CLI's own card text (seal-work.mjs workCardText) carries `name`, `voice` and `spoken`; the Now schema has no room for them.
  // @ts-expect-error the CLI is plain JS without declarations
  const cliCardText = async (work: unknown, options: unknown) => ((await import("../../../../packages/cli/src/crypto/seal-work.mjs")) as { workCardText(w: unknown, o: unknown): unknown }).workCardText(work, options)

  it("keeps the sealed gist, spoken name and voice level of each card beside the Now summary, and the rows carry them", async () => {
    const w = world()
    const published = await signIn(w)
    const text = await cliCardText({ goal: "Cut release 0.18.116", spokenName: "Release cut", voice: "full", status: "Done" }, { spoken: "Shipped and verified." })
    w.server.nowBody = sealedNow(seal(w, published, "card", text))
    w.store.refreshNow()
    await vi.waitFor(() => expect(w.store.getState().summary?.needsYou[0]?.title).toBe("Cut release 0.18.116"))
    const words = w.crypto.spokenWords()
    const id = w.store.getState().summary!.needsYou[0]!.id
    expect(words[id]).toEqual({ spoken: "Shipped and verified.", name: "Release cut", voice: "full" })
    const row = withSpoken(presentationOf(w.store.getState().summary), words).sections[0]!.rows[0]!
    expect(row).toMatchObject({ spoken: "Shipped and verified.", spokenName: "Release cut", spokenVoice: "full" })
  })

  it("a card without words has none, and a later card text without them drops the old ones", async () => {
    const w = world()
    const published = await signIn(w)
    w.server.nowBody = sealedNow(seal(w, published, "card", await cliCardText({ goal: "Plain", status: "Running" }, {})))
    w.store.refreshNow()
    await vi.waitFor(() => expect(w.store.getState().summary?.needsYou[0]?.title).toBe("Plain"))
    expect(w.crypto.spokenWords()).toEqual({})
    w.server.nowBody = sealedNow(seal(w, published, "card", await cliCardText({ goal: "Plain", spokenName: "Plain job", status: "Running" }, {})))
    w.store.refreshNow()
    await vi.waitFor(() => expect(Object.keys(w.crypto.spokenWords())).toHaveLength(1))
    w.server.nowBody = sealedNow(seal(w, published, "card", await cliCardText({ goal: "Plain", status: "Later" }, {})))
    w.store.refreshNow()
    await vi.waitFor(() => expect(w.crypto.spokenWords()).toEqual({}))
  })

  it("reads the words of an opened card text and ignores noise", () => {
    expect(spokenWordsOf({ title: "x", spoken: "  Done.  ", name: "", voice: "VERBOSE" })).toEqual({ spoken: "Done.", name: null, voice: "verbose" })
    expect(spokenWordsOf({ title: "x", voice: "loud" })).toBeNull()
    expect(spokenWordsOf(null)).toBeNull()
    const p = presentationOf(nowSummary())
    expect(withSpoken(p, {})).toBe(p)
  })
})
