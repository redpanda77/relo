import { carriedTitle } from "@relo/owner-crypto"

export { carriedTitle }

/**
 * End-to-end encrypted content (docs/ENCRYPTION-PROTOCOL.md, ADR 0005). A Dashboard that is not a
 * linked browser holds no key: it only says that the item is encrypted and where to read it. A
 * linked browser opens what it can in lib/e2ee and teaches these helpers the names it learned.
 */

/** What the Dashboard shows in place of a sealed title, body, status or prompt. */
export const ENCRYPTED_TEXT = "End-to-end encrypted · open on iPhone to read"

/** The same, in a linked browser: what it could not open was sealed before it was linked. */
export const SEALED_BEFORE_LINK_TEXT = "Sealed before linking · open on iPhone to read"

/** The CLI's keyed handle for a name it sealed (packages/cli/src/crypto/opaque-names.mjs). */
const HANDLE_PATTERN = /^[ptwca]-[a-z2-7]{16}$/

const HANDLE_NAMES: Record<string, string> = {
  p: "Encrypted project",
  t: "Encrypted topic",
  w: "Encrypted task",
  c: "Encrypted computer",
  a: "Encrypted account",
}

/** Handle → name, learned from envelopes this browser opened (lib/e2ee/open-sealed.ts). */
const learnedNames = new Map<string, string>()

export function rememberNames(names: ReadonlyMap<string, string>) {
  for (const [handle, name] of names) learnedNames.set(handle, name)
}

/** Session id (`ags_…`) → the session's own name, from the `title` its opened names envelope carries. */
const learnedSessionTitles = new Map<string, string>()

export function rememberSessionTitle(sessionId: string, title: string) {
  learnedSessionTitles.set(sessionId, title)
}

/** The session's own name when this linked browser has opened it; never sent in the clear. */
export function sessionTitle(sessionId: string): string | null {
  return learnedSessionTitles.get(sessionId) ?? null
}

/** Tests only. */
export function forgetNames() {
  learnedNames.clear()
  learnedSessionTitles.clear()
}

/** True for an opaque handle such as "p-abcdefghijklmnop". */
export function isOpaqueHandle(value: string | null | undefined): boolean {
  return typeof value === "string" && HANDLE_PATTERN.test(value.trim())
}

/** "p-abcdefghijklmnop" -> its learned name, else "Encrypted project"; anything else unchanged. */
export function displayName(value: string): string {
  const trimmed = value.trim()
  if (!HANDLE_PATTERN.test(trimmed)) return value
  return learnedNames.get(trimmed) ?? HANDLE_NAMES[trimmed[0]!]!
}

/** displayName for optional names: null and empty stay null. */
export function displayNameOrNull(value: string | null | undefined): string | null {
  return value?.trim() ? displayName(value) : null
}
