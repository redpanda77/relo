// THE session key, shared by an agent's relo commands (caller.mjs) and `relo hook` (harness/core/events.mjs):
// the id the agent's shell sees (CLAUDE_CODE_SESSION_ID) and the hook's stdin `session_id` give one key.
import { createHash } from "node:crypto";

/** A usable session id: a non-blank string of at most 500 characters, trimmed. */
export function sessionId(value) {
  const id = typeof value === "string" ? value.trim() : "";
  return id && id.length <= 500 ? id : undefined;
}

/** THE session key, for relo commands and `relo hook` alike: sha256 of "harness:id", base64url. */
export function sessionKey({ harness, id }) {
  return createHash("sha256").update(`${harness}:${id}`).digest("base64url");
}
