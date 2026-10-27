/**
 * The linked browser's keys (docs/ENCRYPTION-PROTOCOL.md, "Linked browsers") are `@relo/owner-crypto`'s
 * `OwnerKeys`. This module keeps the shape every Dashboard browser already stored in its IndexedDB
 * (`browserId`, `publishedBrowserId`, under `browser:<account>`), so a Dashboard that is rolled back,
 * or one that has not reloaded yet, reads the same record: the adapter below translates on every load
 * and save instead of migrating the stored record. Nothing here has its own crypto.
 */
import {
  ensureOwnerKeys,
  forgetOwnerKeys,
  loadOwnerKeys,
  saveOwnerKeys,
  signPrekey as signOwnerPrekey,
  type KeyValueStore,
  type OwnerKeys,
  type StoredPrekey,
} from "@relo/owner-crypto"

export {
  indexedDbStore,
  memoryStore,
  prekeyLookup,
  PREKEY_KEEP_RETIRED_MS,
  PREKEY_ROTATE_MS,
  type KeyValueStore,
  type StoredPrekey,
} from "@relo/owner-crypto"

/** The record as the Dashboard has always stored it. */
export type BrowserKeys = {
  /** `brw_<uuid>`, chosen by the browser; it signs its prekeys for this id. */
  browserId: string
  identity: OwnerKeys["identity"]
  /** Newest first; [0] is the current prekey. */
  prekeys: StoredPrekey[]
  /** The prekey id the server last accepted for this browserId. */
  publishedPrekeyId: string | null
  publishedBrowserId: string | null
}

export function newBrowserId() {
  return `brw_${crypto.randomUUID().toLowerCase()}`
}

const stateKey = (accountId: string) => `browser:${accountId}`

/** A stored record in either field naming becomes OwnerKeys. */
function toOwner(stored: BrowserKeys | OwnerKeys): OwnerKeys {
  if ("recipientId" in stored) return stored
  const { browserId, publishedBrowserId, ...rest } = stored
  return { ...rest, recipientId: browserId, publishedRecipientId: publishedBrowserId ?? null }
}

function toBrowser(keys: OwnerKeys): BrowserKeys {
  const { recipientId, publishedRecipientId, ...rest } = keys
  return { ...rest, browserId: recipientId, publishedBrowserId: publishedRecipientId }
}

/** Presents a store holding legacy records as one holding OwnerKeys; writes go back in the legacy shape. */
function legacyView(store: KeyValueStore): KeyValueStore {
  return {
    async get<T>(key: string) {
      const stored = await store.get<BrowserKeys | OwnerKeys>(key)
      return (stored ? toOwner(stored) : undefined) as T | undefined
    },
    set: (key, value) => store.set(key, toBrowser(value as OwnerKeys)),
    delete: (key) => store.delete(key),
  }
}

export async function loadBrowserKeys(store: KeyValueStore, accountId: string) {
  const keys = await loadOwnerKeys(legacyView(store), accountId, stateKey(accountId))
  return keys ? toBrowser(keys) : null
}

export async function saveBrowserKeys(store: KeyValueStore, accountId: string, keys: BrowserKeys) {
  await saveOwnerKeys(legacyView(store), accountId, toOwner(keys), stateKey(accountId))
}

/** Loads this account's browser keys, creating and rotating them as `ensureOwnerKeys` does. */
export async function ensureBrowserKeys(store: KeyValueStore, accountId: string, now = Date.now()): Promise<BrowserKeys> {
  return toBrowser(await ensureOwnerKeys(legacyView(store), accountId, { now, newRecipientId: newBrowserId, stateKey: stateKey(accountId) }))
}

/** The identity's signature over `prekey` for `browserId` (defaults to this browser's own id). */
export function signPrekey(keys: BrowserKeys, prekey: StoredPrekey, browserId = keys.browserId): Promise<string> {
  return signOwnerPrekey({ recipientId: browserId, identity: keys.identity }, prekey, browserId)
}

export const forgetBrowserKeys = forgetOwnerKeys
