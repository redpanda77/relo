// Unidentified callers (no session id): a handle `wrk_<8hex>.<token>` stands in for the session (plan 04 §2.3, C3).
import { randomBytes } from "node:crypto";
import { sessionKey } from "../caller.mjs";

export function mintHandleToken() {
  return randomBytes(16).toString("base64url");
}

export function handleIdentity(token, caller) {
  const harness = String(caller?.agent ?? "unknown").toLowerCase().replace(/\s+/gu, "-");
  return { sessionKey: sessionKey({ harness: "handle", id: token }), harness: `handle.${harness}` };
}

export function parseHandle(value) {
  const match = /^(wrk_[0-9a-f]{8})\.([A-Za-z0-9_-]{22})$/u.exec(String(value ?? "").trim());
  return match ? { prefix: match[1], token: match[2] } : undefined;
}

export const printHandle = (workId, token) => `${String(workId).slice(0, 12)}.${token}`;
