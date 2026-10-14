// Per-session state file (plan 04 §2.7): $XDG_STATE_HOME/relo/sessions/<sessionKey>.json, 0600 in 0700.
// Takes the caller, never a key: there is no API to open another session's file.
import { join } from "node:path";
import { readStateFile, stateRoot, sweep, writeStateFile } from "../work/state-file.mjs";

function sessionsDir(dependencies) {
  return join(stateRoot(dependencies?.env ?? process.env, dependencies?.home), "sessions");
}

function pathFor(caller, dependencies) {
  if (caller?.type !== "agent_session" || !caller.sessionKey) return undefined;
  return join(sessionsDir(dependencies), `${caller.sessionKey}.json`);
}

export async function readSession(caller, dependencies) {
  const path = pathFor(caller, dependencies);
  return path ? readStateFile(path) : undefined;
}

export async function writeSession(caller, dependencies, data) {
  const path = pathFor(caller, dependencies);
  if (!path) return false;
  try {
    await sweep(sessionsDir(dependencies));
    return await writeStateFile(path, { ...data, sessionKey: caller.sessionKey, harness: caller.harness });
  } catch {
    return false;
  }
}

/** Read-only: the last echo printed in this session (slice 3 SessionStart re-injection). */
export async function readSessionEcho(caller, dependencies) {
  return (await readSession(caller, dependencies))?.lastEcho;
}
