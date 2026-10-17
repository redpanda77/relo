/**
 * The linked browser's own keys (docs/ENCRYPTION-PROTOCOL.md, "Linked browsers"): an ECDSA P-256
 * identity and rotating ECDH P-256 prekeys, all created non-extractable by WebCrypto and kept as
 * CryptoKey objects in IndexedDB. Private halves never leave WebCrypto.
 */
import { b64u, copy, fromB64u, type Bytes } from "./bytes"
import { keyId, prekeySigningInput, type RecipientPrekey } from "./envelope"

export const PREKEY_ROTATE_MS = 10 * 3_600_000
/** retention (10 h) + 2 h: a retired private prekey is deleted after this. */
export const PREKEY_KEEP_RETIRED_MS = 12 * 3_600_000

/** Where browser keys live; CryptoKey values must survive structured cloning. */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
}

export function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>()
  return {
    async get<T>(key: string) {
      return values.get(key) as T | undefined
    },
    async set(key, value) {
      values.set(key, value)
    },
    async delete(key) {
      values.delete(key)
    },
  }
}

export function indexedDbStore(name = "relo-e2ee", storeName = "kv"): KeyValueStore {
  let opened: Promise<IDBDatabase> | null = null
  const database = () => {
    opened ??= new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(name, 1)
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains(storeName)) request.result.createObjectStore(storeName)
      }
      request.onsuccess = () => {
        // Sign-out deletes the database: close this connection so the deletion is never blocked.
        request.result.onversionchange = () => {
          request.result.close()
          opened = null
        }
        resolve(request.result)
      }
      request.onerror = () => reject(request.error ?? new Error("IndexedDB is unavailable."))
    })
    return opened
  }
  const run = async <T>(mode: IDBTransactionMode, action: (store: IDBObjectStore) => IDBRequest) => {
    const db = await database()
    return new Promise<T>((resolve, reject) => {
      const transaction = db.transaction(storeName, mode)
      const request = action(transaction.objectStore(storeName))
      transaction.oncomplete = () => resolve(request.result as T)
      transaction.onerror = () => reject(transaction.error ?? new Error("IndexedDB request failed."))
      transaction.onabort = () => reject(transaction.error ?? new Error("IndexedDB request aborted."))
    })
  }
  return {
    get: <T>(key: string) => run<T | undefined>("readonly", (store) => store.get(key)),
    set: async (key, value) => {
      await run("readwrite", (store) => store.put(value, key))
    },
    delete: async (key) => {
      await run("readwrite", (store) => store.delete(key))
    },
  }
}

export type StoredPrekey = {
  prekeyId: string
  privateKey: CryptoKey
  publicKey: string
  createdAt: string
  retiredAt: string | null
}

export type BrowserKeys = {
  /** `brw_<uuid>`, chosen by the browser; it signs its prekeys for this id. */
  browserId: string
  identity: { privateKey: CryptoKey; publicKey: string; keyId: string }
  /** Newest first; [0] is the current prekey. */
  prekeys: StoredPrekey[]
  /** The prekey id the server last accepted for this browserId. */
  publishedPrekeyId: string | null
  publishedBrowserId: string | null
}

export function newBrowserId() {
  return `brw_${crypto.randomUUID().toLowerCase()}`
}

function newPrekeyId() {
  return `pk_${b64u(crypto.getRandomValues(new Uint8Array(12)))}`
}

async function exportRaw(key: CryptoKey): Promise<string> {
  return b64u(copy(await crypto.subtle.exportKey("raw", key)))
}

async function createPrekey(now: number): Promise<StoredPrekey> {
  const pair = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, false, ["deriveBits"])
  return {
    prekeyId: newPrekeyId(),
    privateKey: pair.privateKey,
    publicKey: await exportRaw(pair.publicKey),
    createdAt: new Date(now).toISOString(),
    retiredAt: null,
  }
}

const stateKey = (accountId: string) => `browser:${accountId}`

export async function loadBrowserKeys(store: KeyValueStore, accountId: string) {
  return (await store.get<BrowserKeys>(stateKey(accountId))) ?? null
}

export async function saveBrowserKeys(store: KeyValueStore, accountId: string, keys: BrowserKeys) {
  await store.set(stateKey(accountId), keys)
}

/**
 * Loads this account's browser keys, creating them on first use, rotating the prekey every 10 h and
 * deleting private prekeys retired more than 12 h ago. Saves only when something changed.
 */
export async function ensureBrowserKeys(store: KeyValueStore, accountId: string, now = Date.now()): Promise<BrowserKeys> {
  let keys = await loadBrowserKeys(store, accountId)
  let changed = false
  if (!keys) {
    const identity = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"])
    const publicKey = await exportRaw(identity.publicKey)
    keys = {
      browserId: newBrowserId(),
      identity: { privateKey: identity.privateKey, publicKey, keyId: await keyId(fromB64u(publicKey)) },
      prekeys: [await createPrekey(now)],
      publishedPrekeyId: null,
      publishedBrowserId: null,
    }
    changed = true
  }
  const current = keys.prekeys[0]
  if (!current || now - Date.parse(current.createdAt) >= PREKEY_ROTATE_MS) {
    const retiredAt = new Date(now).toISOString()
    keys = {
      ...keys,
      prekeys: [await createPrekey(now), ...keys.prekeys.map((prekey) => ({ ...prekey, retiredAt: prekey.retiredAt ?? retiredAt }))],
    }
    changed = true
  }
  const kept = keys.prekeys.filter(
    (prekey, index) => index === 0 || !prekey.retiredAt || now - Date.parse(prekey.retiredAt) <= PREKEY_KEEP_RETIRED_MS
  )
  if (kept.length !== keys.prekeys.length) {
    keys = { ...keys, prekeys: kept }
    changed = true
  }
  if (changed) await saveBrowserKeys(store, accountId, keys)
  return keys
}

/** The identity's signature over the current prekey for `browserId` (raw r||s, base64url). */
export async function signPrekey(keys: BrowserKeys, prekey: StoredPrekey, browserId = keys.browserId): Promise<string> {
  const message = prekeySigningInput({
    deviceId: browserId,
    prekeyId: prekey.prekeyId,
    publicKey: fromB64u(prekey.publicKey, { length: 65 }),
    createdAt: prekey.createdAt,
  })
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, keys.identity.privateKey, message)
  return b64u(copy(signature))
}

/** Opening side: the private prekey for an id this browser still holds. */
export function prekeyLookup(keys: BrowserKeys): (prekeyId: string) => RecipientPrekey | null {
  const byId = new Map<string, RecipientPrekey>(
    keys.prekeys.map((prekey) => [prekey.prekeyId, { privateKey: prekey.privateKey, publicKey: fromB64u(prekey.publicKey, { length: 65 }) as Bytes }])
  )
  return (prekeyId) => byId.get(prekeyId) ?? null
}

/**
 * Signing out ends this browser's link: its keys are deleted, so nothing it could read stays
 * readable here and the next sign-in starts a new, unlinked browser (like the iPhone's sign-out).
 */
export function forgetBrowserKeys(name = "relo-e2ee"): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name)
      request.onsuccess = request.onerror = request.onblocked = () => resolve()
    } catch {
      resolve()
    }
  })
}
