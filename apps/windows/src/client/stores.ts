// The owner client's storage on this PC.
//   - SecretStore: Windows Credential Manager through the secret_* commands (target `Relo/<name>`, small blobs).
//   - PrefsStore: localStorage (the chosen server, seen notices, the last look): not secret, possibly long.
//   - Keys: IndexedDB (relo-e2ee), as the Dashboard keeps its browser keys. WebCrypto keys are created non-extractable,
//     so their private halves live only inside the webview's key store and never reach JavaScript as bytes.

import { memoryStore, type PrefsStore, type SecretStore, type StringStore } from "@relo/owner-client"
import { inTauri, secretDelete, secretGet, secretSet } from "../bridge"

/** Credential Manager when running in the app; memory in a plain browser (dev), where nothing may be written to disk. */
export function createSecretStore(): SecretStore {
  if (!inTauri) return memoryStore()
  return {
    get: (key) => secretGet(key),
    set: (key, value) => secretSet(key, value),
    delete: (key) => secretDelete(key),
  }
}

/** localStorage with every access guarded: it can throw (blocked site data) and the app must still run. */
export function createPrefsStore(storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null = safeStorage()): PrefsStore {
  const fallback = memoryStore()
  const guarded = async <T>(use: (storage: Pick<Storage, "getItem" | "setItem" | "removeItem">) => T, otherwise: () => Promise<T>): Promise<T> => {
    if (!storage) return otherwise()
    try {
      return use(storage)
    } catch {
      return otherwise()
    }
  }
  const store: StringStore = {
    get: (key) => guarded((s) => s.getItem(key), () => fallback.get(key)),
    set: (key, value) => guarded((s) => s.setItem(key, value), () => fallback.set(key, value)),
    delete: (key) => guarded((s) => s.removeItem(key), () => fallback.delete(key)),
  }
  return store
}

function safeStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage
  } catch {
    return null
  }
}
