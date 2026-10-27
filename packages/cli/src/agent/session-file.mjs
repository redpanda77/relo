// Per-session state file (plan 04 §2.7): $XDG_STATE_HOME/relo/sessions/<sessionKey>.json, 0600 in 0700.
// Takes the caller, never a key: there is no API to open another session's file.
import { readSessionFile, sessionFile, sessionsDirectory } from "../work/session-store.mjs";
import { writeStateFile } from "../work/state-file.mjs";
import { sweepLocalState } from "../work/state-prune.mjs";

const ownKey = (caller) => (caller?.type === "agent_session" && caller.sessionKey ? caller.sessionKey : undefined);

export async function readSession(caller, dependencies) {
  const key = ownKey(caller);
  return key ? readSessionFile(dependencies, key) : undefined;
}

export async function writeSession(caller, dependencies, data) {
  const key = ownKey(caller);
  if (!key) return false;
  try {
    await sweepLocalState(dependencies, sessionsDirectory(dependencies));
    return await writeStateFile(sessionFile(dependencies, key), { ...data, sessionKey: caller.sessionKey, harness: caller.harness });
  } catch {
    return false;
  }
}
