/**
 * This Dashboard as a linked browser (docs/END-TO-END-ENCRYPTION.md, "Linked browsers"): keeps its
 * keys, registers them, learns whether a trusted phone linked it, trusts the account's computers on
 * first use, and fetches the envelopes sealed to it. Plaintext never leaves this module's callers.
 */
import { b64u, copy, fromB64u, type Bytes } from "./bytes"
import { approveDeviceSigningInput, keyId, openEnvelope } from "./envelope"
import {
  ensureBrowserKeys,
  indexedDbStore,
  newBrowserId,
  prekeyLookup,
  saveBrowserKeys,
  signPrekey,
  type BrowserKeys,
  type KeyValueStore,
} from "./keys"

export type BrowserLinkState =
  | { status: "unavailable" }
  | { status: "starting" }
  | { status: "unlinked"; browserId: string; identityKey: string }
  | { status: "linked"; browserId: string; identityKey: string; linkedBy: string | null }
  | { status: "error"; message: string }

type Fetcher = typeof fetch

export type TrustedClient = { keyId: string; publicKey: string; name: string }

const SEALED_IDS_PER_REQUEST = 100
const ROTATION_CHECK_MS = 3_600_000

/** "Chrome on macOS", from User-Agent Client Hints when available, else the user agent. */
export function browserName(nav: Pick<Navigator, "userAgent"> & { userAgentData?: { brands?: { brand: string }[]; platform?: string } } = navigator): string {
  const ua = nav.userAgent ?? ""
  const hinted = nav.userAgentData?.brands?.map((entry) => entry.brand).find((brand) => /chrome|edge|opera|brave|chromium/i.test(brand) && !/not/i.test(brand))
  const browser =
    hinted?.replace(/^Google /u, "").replace(/^Microsoft /u, "") ??
    (/Edg\//u.test(ua) ? "Edge" : /OPR\//u.test(ua) ? "Opera" : /Firefox\//u.test(ua) ? "Firefox" : /Chrome\//u.test(ua) ? "Chrome" : /Safari\//u.test(ua) ? "Safari" : "Browser")
  const platform =
    nav.userAgentData?.platform ||
    (/iPhone|iPad/u.test(ua) ? "iOS" : /Android/u.test(ua) ? "Android" : /Mac OS X|Macintosh/u.test(ua) ? "macOS" : /Windows/u.test(ua) ? "Windows" : /Linux/u.test(ua) ? "Linux" : "")
  return (platform ? `${browser} on ${platform}` : browser).slice(0, 80)
}

async function readJson(response: Response): Promise<Record<string, unknown> | null> {
  const payload = (await response.json().catch(() => null)) as unknown
  return payload && typeof payload === "object" ? (payload as Record<string, unknown>) : null
}

export class BrowserLink {
  private state: BrowserLinkState = { status: "starting" }
  private readonly listeners = new Set<() => void>()
  private keys: BrowserKeys | null = null

  /** This browser's id, for revoking it on sign-out. */
  browserIdForRevocation(): string | null {
    return this.keys?.browserId ?? null
  }
  private started: Promise<void> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private readonly store: KeyValueStore
  private readonly fetcher: Fetcher
  readonly accountId: string
  private readonly name: string
  private readonly now: () => number

  constructor({
    accountId,
    store,
    fetcher,
    name,
    now = Date.now,
  }: {
    accountId: string
    store: KeyValueStore
    fetcher?: Fetcher
    name?: string
    now?: () => number
  }) {
    this.accountId = accountId
    this.store = store
    this.fetcher = fetcher ?? ((input, init) => fetch(input, init))
    this.name = name ?? browserName()
    this.now = now
  }

  getState = (): BrowserLinkState => this.state

  subscribe = (listener: () => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private setState(next: BrowserLinkState) {
    this.state = next
    for (const listener of this.listeners) listener()
  }

  private linkState(linked: boolean, linkedBy: string | null = null): BrowserLinkState {
    const keys = this.keys!
    return linked
      ? { status: "linked", browserId: keys.browserId, identityKey: keys.identity.publicKey, linkedBy }
      : { status: "unlinked", browserId: keys.browserId, identityKey: keys.identity.publicKey }
  }

  /** Ensures keys and registers them; safe to call more than once. */
  start(): Promise<void> {
    this.started ??= this.refreshKeys().catch((cause: unknown) => {
      this.setState({ status: "error", message: cause instanceof Error ? cause.message : "Browser keys are unavailable." })
    })
    return this.started
  }

  /** Re-checks prekey rotation every hour while the tab stays open. */
  startRotationTimer() {
    this.timer ??= setInterval(() => void this.refreshKeys().catch(() => undefined), ROTATION_CHECK_MS)
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  /** Rotates the prekey when due and publishes it when the server does not have it yet. */
  async refreshKeys(): Promise<void> {
    this.keys = await ensureBrowserKeys(this.store, this.accountId, this.now())
    const current = this.keys.prekeys[0]!
    if (this.keys.publishedPrekeyId === current.prekeyId && this.keys.publishedBrowserId === this.keys.browserId) {
      if (this.state.status === "starting" || this.state.status === "error") await this.checkLinked()
      return
    }
    const linked = await this.register()
    this.setState(this.linkState(linked, this.state.status === "linked" ? this.state.linkedBy : null))
  }

  private async register(retry = true): Promise<boolean> {
    const keys = this.keys!
    const prekey = keys.prekeys[0]!
    const response = await this.fetcher("/api/dashboard/browser", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: this.name,
        browserId: keys.browserId,
        identityKey: keys.identity.publicKey,
        prekey: { prekeyId: prekey.prekeyId, publicKey: prekey.publicKey, createdAt: prekey.createdAt, signature: await signPrekey(keys, prekey) },
      }),
    })
    const payload = await readJson(response)
    if (response.status === 409 && payload?.error === "browser_id_taken" && retry) {
      this.keys = { ...keys, browserId: newBrowserId(), publishedPrekeyId: null, publishedBrowserId: null }
      await saveBrowserKeys(this.store, this.accountId, this.keys)
      return this.register(false)
    }
    if (!response.ok || payload?.browserId !== keys.browserId) {
      throw new Error(typeof payload?.error === "string" ? `Browser registration failed (${payload.error}).` : `Browser registration failed (${response.status}).`)
    }
    this.keys = { ...keys, publishedPrekeyId: prekey.prekeyId, publishedBrowserId: keys.browserId }
    await saveBrowserKeys(this.store, this.accountId, this.keys)
    return payload.linked === true
  }

  /** Asks the server whether a trusted phone has linked this browser yet. */
  async checkLinked(): Promise<boolean> {
    if (!this.keys) return false
    const response = await this.fetcher(`/api/dashboard/browser/${encodeURIComponent(this.keys.browserId)}`, {
      credentials: "same-origin",
      headers: { accept: "application/json" },
    })
    if (response.status === 404) {
      // The server forgot or revoked this browser: register again under a fresh id.
      this.keys = { ...this.keys, browserId: newBrowserId(), publishedPrekeyId: null, publishedBrowserId: null }
      await saveBrowserKeys(this.store, this.accountId, this.keys)
      const linked = await this.register()
      this.setState(this.linkState(linked))
      return linked
    }
    const payload = await readJson(response)
    if (!response.ok) throw new Error(`Browser status failed (${response.status}).`)
    const linked = payload?.linked === true
    this.setState(this.linkState(linked, typeof payload?.linkedBy === "string" ? payload.linkedBy : null))
    return linked
  }

  isLinked() {
    return this.state.status === "linked"
  }

  /**
   * Approves a new phone the way a trusted phone does (docs/END-TO-END-ENCRYPTION.md, "Approving
   * from a linked browser"): this browser's non-extractable identity key signs the phone's id and
   * identity key, with this browser's id as the approver. Only a linked browser signs.
   */
  async signApproval(target: { deviceId: string; identityKey: string }, now = this.now()) {
    await this.start()
    if (!this.keys || !this.isLinked()) throw new Error("Link this browser from your iPhone first.")
    const signedAt = new Date(now).toISOString()
    const message = approveDeviceSigningInput({ ...target, approverDeviceId: this.keys.browserId, signedAt })
    const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, this.keys.identity.privateKey, message)
    return { browserId: this.keys.browserId, identityKey: target.identityKey, signedAt, signature: b64u(copy(signature)) }
  }

  /** Content envelopes by id; a 403 means this browser is no longer linked. */
  async fetchEnvelopes(ids: string[]): Promise<Record<string, unknown>> {
    if (!this.keys || !this.isLinked() || ids.length === 0) return {}
    const envelopes: Record<string, unknown> = {}
    for (let index = 0; index < ids.length; index += SEALED_IDS_PER_REQUEST) {
      const query = new URLSearchParams()
      for (const id of ids.slice(index, index + SEALED_IDS_PER_REQUEST)) query.append("id", id)
      const response = await this.fetcher(`/api/dashboard/sealed?${query.toString()}`, {
        credentials: "same-origin",
        headers: { accept: "application/json", "x-relo-browser": this.keys.browserId },
      })
      if (response.status === 403) {
        this.setState(this.linkState(false))
        return {}
      }
      if (!response.ok) throw new Error(`Encrypted content could not be fetched (${response.status}).`)
      const payload = await readJson(response)
      if (payload?.envelopes && typeof payload.envelopes === "object") Object.assign(envelopes, payload.envelopes)
    }
    return envelopes
  }

  /**
   * The account's computers, trusted on first use and remembered. A changed key for the same
   * computer is accepted, with a note in the console.
   */
  async trustedSenders(): Promise<Map<string, Bytes>> {
    const storeKey = `clients:${this.accountId}`
    const remembered = (await this.store.get<Record<string, TrustedClient>>(storeKey)) ?? {}
    let next = { ...remembered }
    try {
      const response = await this.fetcher("/api/dashboard/client-keys", { credentials: "same-origin", headers: { accept: "application/json" } })
      const payload = response.ok ? await readJson(response) : null
      if (Array.isArray(payload?.clients)) {
        // Trust on first use: a computer stays trusted once seen; the list only adds or updates keys.
        next = { ...remembered }
        for (const client of payload.clients as Array<Record<string, unknown>>) {
          if (typeof client.clientId !== "string" || typeof client.keyId !== "string" || typeof client.publicKey !== "string") continue
          let publicKey: Bytes
          try {
            publicKey = fromB64u(client.publicKey, { length: 65 })
          } catch {
            continue
          }
          if ((await keyId(publicKey)) !== client.keyId) continue
          const name = typeof client.name === "string" ? client.name : client.clientId
          const known = remembered[client.clientId]
          if (known && known.publicKey !== client.publicKey) console.info(`Relo: the security code for ${name} changed; its new key is trusted.`)
          next[client.clientId] = { keyId: client.keyId, publicKey: client.publicKey, name }
        }
        await this.store.set(storeKey, next)
      }
    } catch {
      // Offline or an older server: the computers remembered earlier still open what they sealed.
    }
    return new Map(Object.values(next).map((client) => [client.keyId, fromB64u(client.publicKey, { length: 65 })]))
  }

  /** An opener for the sealed-content transform, or null while this browser is not linked. */
  async opener(): Promise<SealedOpener | null> {
    await this.start()
    if (!this.keys || !this.isLinked()) return null
    const keys = this.keys
    let senders: Promise<Map<string, Bytes>> | null = null
    return {
      fetchEnvelopes: (ids) => this.fetchEnvelopes(ids),
      open: async (envelope) => {
        senders ??= this.trustedSenders()
        try {
          return (await openEnvelope(envelope, { deviceId: keys.browserId, prekeyFor: prekeyLookup(keys), trustedSenders: await senders })).content
        } catch {
          return null
        }
      },
    }
  }
}

export type SealedOpener = {
  fetchEnvelopes(ids: string[]): Promise<Record<string, unknown>>
  /** The opened content, or null when this browser cannot open it. */
  open(envelope: unknown): Promise<unknown>
}

let current: BrowserLink | null = null

export function webCryptoAvailable() {
  return typeof indexedDB !== "undefined" && Boolean(globalThis.crypto?.subtle) && globalThis.isSecureContext !== false
}

/**
 * Signing out: this browser revokes its own server record (review L5), so it stops being a
 * recipient at once. Best effort; the keys are deleted afterwards either way.
 */
export async function revokeCurrentBrowser(fetcher: typeof fetch = fetch): Promise<void> {
  const browserId = current?.browserIdForRevocation()
  current?.stop()
  if (!browserId) return
  try {
    await fetcher(`/api/dashboard/browser/${encodeURIComponent(browserId)}`, { method: "DELETE", credentials: "same-origin" })
  } catch {
    // Offline: the record is revoked by the server's cleanup or when the phone unlinks it.
  }
}

/** The signed-in account's browser link, created once per page. */
export function browserLinkFor(accountId: string): BrowserLink | null {
  if (current && current.accountId === accountId) return current
  if (!webCryptoAvailable()) return null
  current?.stop()
  current = new BrowserLink({ accountId, store: indexedDbStore() })
  return current
}

export function currentBrowserLink() {
  return current
}

/** Tests only. */
export function setCurrentBrowserLink(link: BrowserLink | null) {
  current = link
}
