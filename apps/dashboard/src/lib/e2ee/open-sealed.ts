/**
 * The Dashboard's seat of the sealed-content transform (docs/ENCRYPTION-PROTOCOL.md, "Linked
 * browsers"). The transform itself is `@relo/owner-crypto`'s and holds no state; this binds it to
 * the names this Dashboard remembers (lib/encrypted.ts), so every call site keeps one import.
 */
import { openSealedTree as openTree, type SealedOpener } from "@relo/owner-crypto"

import { rememberNames, rememberSessionTitle } from "@/lib/encrypted"

export { hasLockedItems, type SealedOpener } from "@relo/owner-crypto"

export function openSealedTree<T>(tree: T, opener: SealedOpener) {
  return openTree(tree, opener, { rememberNames, rememberSessionTitle })
}
