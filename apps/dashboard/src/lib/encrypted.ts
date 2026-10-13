/**
 * End-to-end encrypted content (docs/END-TO-END-ENCRYPTION.md, ADR 0005). The Dashboard holds no
 * key by design: it never opens sealed text, it only says that the item is encrypted and where to
 * read it. These helpers are display-only.
 */

/** What the Dashboard shows in place of a sealed title, body, status or prompt. */
export const ENCRYPTED_TEXT = "End-to-end encrypted · open on iPhone to read"

/** The CLI's keyed handle for a name it sealed (packages/cli/src/opaque-names.mjs). */
const HANDLE_PATTERN = /^[ptwca]-[a-z2-7]{16}$/

const HANDLE_NAMES: Record<string, string> = {
  p: "Encrypted project",
  t: "Encrypted topic",
  w: "Encrypted task",
  c: "Encrypted computer",
  a: "Encrypted account",
}

/** True for an opaque handle such as "p-abcdefghijklmnop". */
export function isOpaqueHandle(value: string | null | undefined): boolean {
  return typeof value === "string" && HANDLE_PATTERN.test(value.trim())
}

/** "p-abcdefghijklmnop" -> "Encrypted project"; anything else unchanged. */
export function displayName(value: string): string {
  const trimmed = value.trim()
  return HANDLE_PATTERN.test(trimmed) ? HANDLE_NAMES[trimmed[0]!]! : value
}

/** displayName for optional names: null and empty stay null. */
export function displayNameOrNull(value: string | null | undefined): string | null {
  return value?.trim() ? displayName(value) : null
}
