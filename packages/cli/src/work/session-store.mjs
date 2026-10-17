// The per-session declared state files (plan 04 §2.7): <state>/sessions/<sessionKey>.json, 0600 in 0700.
// The one place their path is built. Agents reach them through agent/session-file.mjs (by caller, never a
// key); hooks only read them (harness/core/roles.mjs), never write.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readStateFile, stateRoot } from "./state-file.mjs";

/** The injected sessions folder, else the state root's (callers that build no dependencies). */
export function sessionsDirectory(dependencies) {
  return dependencies?.sessionsDirectory ?? join(stateRoot(dependencies?.env ?? process.env, dependencies?.home), "sessions");
}

export function sessionFile(dependencies, sessionKey) {
  return join(sessionsDirectory(dependencies), `${sessionKey}.json`);
}

/** Read-only: a session's declared state, or undefined. */
export function readSessionFile(dependencies, sessionKey) {
  return readStateFile(sessionFile(dependencies, sessionKey));
}

/** Read-only and synchronous (for the session's name, resolved inside sync code): the declared state, or undefined. */
export function readSessionFileSync(dependencies, sessionKey) {
  try {
    const path = sessionFile(dependencies, sessionKey);
    if (statSync(path).size > 1 << 20) return undefined;
    const data = JSON.parse(readFileSync(path, "utf8"));
    return data?.v === 1 ? data : undefined;
  } catch {
    return undefined;
  }
}
