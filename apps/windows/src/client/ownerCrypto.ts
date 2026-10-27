// @relo/owner-crypto behind @relo/owner-client's OwnerCrypto interface: this PC as an end-to-end recipient.
//
// Keys and the id ordering. A recipient signs its prekeys for the id the server knows it by, and for this app that is
// the device id the server assigns at registration (`dev_...`), which exists only after sign-in. So:
//   1. `ensureKeys()` (before register, and again before every publish) creates the ECDSA identity key and the first
//      ECDH prekey under the placeholder recipient id "unregistered". Both are non-extractable WebCrypto keys kept as
//      CryptoKey objects in IndexedDB; no private byte ever reaches JavaScript.
//   2. After register the store calls `publishablePrekey(deviceId, ...)`: the record is re-labelled with the dev_ id
//      and the prekey is signed for exactly that id, which is what the server verifies (apps/server/src/device-keys.ts
//      verifyPrekeySignature).
//   3. If a different dev_ id ever shows up (signed out and in again, another account), the old identity is dropped and
//      a new one made: a new device registration is a new, unlinked recipient (like the iPhone's sign-out).
// Opening: the Now/inbox JSON arrives with this device's envelopes inline (`sealed`); they are opened here with the
// prekeys still held, after checking the sender against the computers this PC trusts (trust.ts).

import type { AnswerSignature, AnswerSignatureRequest, FetchLike, OwnerCrypto, PublishablePrekey, SecretStore } from "@relo/owner-client"
import {
  answerSigningInput,
  approveComputerSigningInput,
  b64u,
  copy,
  ensureOwnerKeys,
  loadOwnerKeys,
  openEnvelope,
  openSealedTree,
  prekeyLookup,
  questionAnswerSigningInput,
  saveOwnerKeys,
  signPrekey,
  type Bytes,
  type KeyValueStore,
  type OwnerKeys,
  type SealedOpener,
} from "@relo/owner-crypto"
import type { SpokenWordsById } from "../relo/presentation"
import { Trust, type ComputerRow } from "./trust"
import { spokenWordsOf } from "./view"

/** The recipient id of a key set that has not been registered yet. */
export const UNREGISTERED = "unregistered"
const SCOPE = "this-pc"
const STATE_KEY = "owner:this-pc"
/** Where @relo/owner-client keeps the device credential (its KEY.device); the adapter reads the bearer from there. */
export const DEVICE_SECRET = "relo.owner.device"

interface StoredDevice { deviceId: string; accountId: string; accessToken: string; origin: string }

export interface OwnerCryptoDeps {
  keys: KeyValueStore
  secrets: SecretStore
  fetch: FetchLike
  now?: () => number
}

export interface PcOwnerCrypto extends OwnerCrypto {
  /** What the cards opened so far say aloud (ADR 0015), by card id: the Now item's strict schema has no room for it. */
  spokenWords(): SpokenWordsById
  /** Sign-out: forget the keys and what was pinned. */
  forget(): Promise<void>
  /** Computers whose text this PC is holding back until an approver signs them. */
  pendingComputers(): Promise<string[]>
  /** Reads the account's computers now: the ones waiting for the owner (Mac `waitingComputers`). Also signs this PC's approval of every computer it already trusts, so they open on the other devices. */
  syncApprovals(): Promise<WaitingComputer[]>
  /** The owner approved a waiting computer here: trusted on this PC, and this PC's signed approval sent for the other devices. False when it could not be done. */
  approveComputer(clientId: string): Promise<boolean>
  /** Declined here: it stays listed and its cards stay closed on this PC. */
  declineComputer(clientId: string): Promise<void>
}

export interface WaitingComputer {
  id: string
  name: string
}

type Node = Record<string, unknown>
const isNode = (value: unknown): value is Node => typeof value === "object" && value !== null && !Array.isArray(value)
const text = (value: unknown) => (typeof value === "string" && value.trim() ? value : undefined)
const TITLE_PLACEHOLDERS = new Set(["Encrypted card", "Encrypted notification", "Encrypted question", "Encrypted notice"])
const isNowItem = (value: Node) => typeof value.id === "string" && value.id.startsWith("act_") && isNode(value.owner) && "title" in value

export function createOwnerCrypto(deps: OwnerCryptoDeps): PcOwnerCrypto {
  const now = deps.now ?? Date.now
  let queue: Promise<unknown> = Promise.resolve()
  /** Key changes happen one at a time: a publish and an open must not both rotate. */
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work, work)
    queue = run.catch(() => undefined)
    return run
  }
  const ensure = () => ensureOwnerKeys(deps.keys, SCOPE, { stateKey: STATE_KEY, newRecipientId: () => UNREGISTERED, now: now() })

  const credential = async (): Promise<StoredDevice | null> => {
    try {
      const raw = await deps.secrets.get(DEVICE_SECRET)
      const device = raw ? (JSON.parse(raw) as Partial<StoredDevice>) : null
      return device && device.deviceId && device.accountId && device.accessToken && device.origin ? (device as StoredDevice) : null
    } catch {
      return null
    }
  }

  let trust: { account: string; value: Trust } | null = null
  const trustFor = (device: StoredDevice, keys: OwnerKeys): Trust => {
    if (trust?.account === device.accountId) return trust.value
    const value = new Trust({
      store: deps.keys,
      scope: device.accountId,
      now,
      self: () => ({ id: device.deviceId, identityKey: keys.identity.publicKey }),
      getJson: async (path) => {
        try {
          const response = await deps.fetch(new URL(path, device.origin).toString(), {
            headers: { Accept: "application/json", Authorization: `Bearer ${device.accessToken}` },
            cache: "no-store",
          })
          if (!response.ok) return null
          const body = (await response.json()) as unknown
          return isNode(body) ? body : null
        } catch {
          return null
        }
      },
    })
    trust = { account: device.accountId, value }
    return value
  }

  /** The keys, once registered; null before. Never creates or rotates. */
  const registered = async (): Promise<{ keys: OwnerKeys; device: StoredDevice } | null> => {
    const [keys, device] = await Promise.all([loadOwnerKeys(deps.keys, SCOPE, STATE_KEY), credential()])
    if (!keys || !device || keys.recipientId !== device.deviceId) return null
    return { keys, device }
  }

  async function opener(keys: OwnerKeys, device: StoredDevice): Promise<{ open(envelope: unknown): Promise<{ content: unknown; kind: string } | null> }> {
    const senders = await trustFor(device, keys).trustedSenders()
    const prekeyFor = prekeyLookup(keys)
    return {
      async open(envelope) {
        try {
          const opened = await openEnvelope(envelope, { deviceId: keys.recipientId, prekeyFor, trustedSenders: senders })
          return { content: opened.content, kind: opened.kind }
        } catch {
          return null
        }
      },
    }
  }

  /** The envelopes a Now summary carries inline, keyed by the row ids `openSealedTree` looks for. */
  function harvest(tree: unknown) {
    const envelopes: Record<string, unknown> = {}
    const sessions = new Set<string>()
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk)
      if (!isNode(value)) return
      if (isNowItem(value)) {
        const sealed = isNode(value.sealed) ? value.sealed : null
        if (sealed?.card) envelopes[value.id as string] = sealed.card
        if (sealed?.question && typeof value.notificationId === "string") envelopes[value.notificationId] = sealed.question
        if (value.sessionNames && typeof value.sessionId === "string" && value.sessionId.startsWith("ags_")) {
          envelopes[value.sessionId] ??= value.sessionNames
          sessions.add(value.sessionId)
        }
      }
      if (typeof value.id === "string" && value.id.startsWith("ags_") && value.sealedNames) envelopes[value.id] = value.sealedNames
      for (const child of Object.values(value)) walk(child)
    }
    walk(tree)
    return { envelopes, sessions: [...sessions] }
  }

  /** An inbox item or detail with `sealed: { alert, content }`: this PC's envelope replaces the server's placeholders. */
  async function openInline(tree: unknown, open: (envelope: unknown) => Promise<{ content: unknown; kind: string } | null>): Promise<void> {
    const nodes: Node[] = []
    const walk = (value: unknown): void => {
      if (Array.isArray(value)) return value.forEach(walk)
      if (!isNode(value)) return
      if (isNode(value.sealed) && isNode(value.sealed.content)) nodes.push(value)
      for (const child of Object.values(value)) walk(child)
    }
    walk(tree)
    for (const node of nodes) {
      const sealed = node.sealed as Node
      const opened = (await open(sealed.content)) ?? (isNode(sealed.alert) ? await open(sealed.alert) : null)
      if (!opened || !isNode(opened.content)) continue
      const content = opened.content
      if (typeof node.title === "string" && TITLE_PLACEHOLDERS.has(node.title)) {
        const title = text(content.title)
        if (title && !TITLE_PLACEHOLDERS.has(title)) node.title = title.slice(0, 200)
      }
      const body = text(content.body)
      const summary = text(content.summary) ?? text(content.status) ?? text(content.detail) ?? body?.slice(0, 240)
      if ("summary" in node && summary) node.summary = summary.slice(0, 240)
      if ("detail" in node && (body ?? text(content.detail))) node.detail = body ?? text(content.detail)
      // A sealed question shows its real prompt once opened (iOS InboxSealedNotice, E4.1).
      if (opened.kind === "question" && isNode(node.interaction)) {
        const prompt = text(content.summary) ?? body
        if (prompt) node.interaction.prompt = prompt
      }
    }
  }

  const spoken = new Map<string, SpokenWordsById[string]>()
  const signedApprovals = new Set<string>()
  /** Signs and sends this PC's approval of the computer's current key (POST /api/devices/self/computer-approvals). */
  async function sendApproval(ready: { keys: OwnerKeys; device: StoredDevice }, row: ComputerRow): Promise<boolean> {
    const marker = `${row.clientId}|${row.publicKey}`
    if (signedApprovals.has(marker)) return true
    const signedAt = new Date(now()).toISOString()
    const message = approveComputerSigningInput({ clientId: row.clientId, identityKey: row.publicKey, approverId: ready.device.deviceId, signedAt })
    try {
      const signature = b64u(copy(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, ready.keys.identity.privateKey, message)))
      const response = await deps.fetch(new URL("/api/devices/self/computer-approvals", ready.device.origin).toString(), {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: `Bearer ${ready.device.accessToken}` },
        body: JSON.stringify({ clientId: row.clientId, identityKey: row.publicKey, signedAt, signature }),
        cache: "no-store",
      })
      // Refused (a key that changed meanwhile, an approver the server does not allow) is not retried until the next launch.
      if (response.ok || (response.status >= 400 && response.status < 500)) signedApprovals.add(marker)
      return response.ok
    } catch {
      return false
    }
  }

  return {
    async syncApprovals() {
      const ready = await registered()
      if (!ready) return []
      const rows = await trustFor(ready.device, ready.keys).computers()
      for (const row of rows) if (row.level === "auto" && !row.signedByThisPc) await sendApproval(ready, row)
      return rows.filter((row) => row.level === "pending").map((row) => ({ id: row.clientId, name: row.name }))
    },

    async approveComputer(clientId) {
      const ready = await registered()
      if (!ready) return false
      const trust = trustFor(ready.device, ready.keys)
      const row = (await trust.computers()).find((candidate) => candidate.clientId === clientId)
      if (!row) return false
      await trust.decide(clientId, "auto")
      signedApprovals.delete(`${row.clientId}|${row.publicKey}`)
      return sendApproval(ready, row)
    },

    async declineComputer(clientId) {
      const ready = await registered()
      if (ready) await trustFor(ready.device, ready.keys).decide(clientId, "declined")
    },

    spokenWords() {
      return Object.fromEntries(spoken)
    },

    async ensureKeys() {
      await exclusive(ensure)
    },

    async publishablePrekey(deviceId, options): Promise<PublishablePrekey> {
      void options // ensureOwnerKeys rotates by age (10 h), which is when the store asks for a rotation.
      return exclusive(async () => {
        let keys = await ensure()
        if (keys.recipientId !== deviceId) {
          if (keys.recipientId !== UNREGISTERED) {
            await deps.keys.delete(STATE_KEY)
            keys = await ensure()
          }
          keys = { ...keys, recipientId: deviceId, publishedPrekeyId: null, publishedRecipientId: null }
          await saveOwnerKeys(deps.keys, SCOPE, keys, STATE_KEY)
        }
        const prekey = keys.prekeys[0]!
        return {
          identityKey: keys.identity.publicKey,
          prekey: { prekeyId: prekey.prekeyId, publicKey: prekey.publicKey, createdAt: prekey.createdAt, signature: await signPrekey(keys, prekey, deviceId) },
        }
      })
    },

    async openTree(tree) {
      const ready = await registered()
      if (!ready) return tree
      const { open } = await opener(ready.keys, ready.device)
      const work = structuredClone(tree)
      const { envelopes, sessions } = harvest(work)
      if (isNode(work) && sessions.length) work.namesFrom = sessions
      const sealedOpener: SealedOpener = {
        fetchEnvelopes: async (ids) => Object.fromEntries(ids.filter((id) => id in envelopes).map((id) => [id, envelopes[id]])),
        open: async (envelope) => {
          const content = (await open(envelope))?.content ?? null
          // A card's own envelope (act_...): keep what it says aloud; a later opening without words drops them.
          const id = Object.keys(envelopes).find((key) => key.startsWith("act_") && envelopes[key] === envelope)
          if (id) {
            const words = spokenWordsOf(content)
            if (words) spoken.set(id, words)
            else if (content !== null) spoken.delete(id)
          }
          return content
        },
      }
      const result = await openSealedTree(work, sealedOpener)
      const opened = result.tree
      if (isNode(opened)) delete opened.namesFrom
      await openInline(opened, open)
      return opened
    },

    async signAnswer(request: AnswerSignatureRequest): Promise<AnswerSignature | null> {
      const keys = await loadOwnerKeys(deps.keys, SCOPE, STATE_KEY)
      if (!keys || keys.recipientId === UNREGISTERED) return null
      const fields = {
        interactionId: request.interactionId,
        notificationId: request.notificationId,
        deviceId: request.deviceId,
        value: request.value,
        respondedAt: request.respondedAt,
      }
      const sign = async (message: Bytes) => b64u(copy(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.identity.privateKey, message)))
      return {
        keyId: keys.identity.keyId,
        signature: await sign(answerSigningInput(fields)),
        ...(request.question ? { questionSignature: await sign(questionAnswerSigningInput({ ...fields, question: request.question })) } : {}),
      }
    },

    async forget() {
      await exclusive(async () => {
        const device = await credential()
        await deps.keys.delete(STATE_KEY)
        if (device) for (const key of new Trust({ store: deps.keys, scope: device.accountId, now, getJson: async () => null, self: () => null }).storageKeys) await deps.keys.delete(key)
        trust = null
        spoken.clear()
      })
    },

    async pendingComputers() {
      const ready = await registered()
      return ready ? trustFor(ready.device, ready.keys).pending() : []
    },
  }
}
