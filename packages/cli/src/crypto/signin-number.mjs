// The sign-in number (docs/ENCRYPTION-PROTOCOL.md, "Sign-in number"): two digits both the CLI and the approving
// device compute from the sign-in's user code and the identity key the computer started it with. A key the server
// swapped in gives another number, so the owner who picks the printed number approves that key and no other.
import { createHash } from "node:crypto";

/** "47"-style number for a user code (as printed, `ABCD-EFGH`) and an identity key (base64url, 65 bytes). */
export function signinNumber(userCode, identityKey) {
  const digest = createHash("sha256").update(`relo.e2e.v1 signin-number\n${userCode}\n${identityKey}`).digest();
  return String(digest.readUInt16BE(0) % 100).padStart(2, "0");
}
