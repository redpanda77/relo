// The pending handoff of a project on this computer (the working layer, plan 12 §5.1b): what a session left
// for the next one in the same project. <state>/handoffs/<project>.json, 0600 in 0700, one file per project
// (a newer handoff replaces it). It holds readable text (goal, round title, the note) and never leaves this
// computer: the server keeps only the handle's hash. Dependency-light on purpose: a hook reads it at session
// start (harness/core/handoff-offer.mjs); only the work verbs write it.
import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { repositoryRoot } from "../shared/repo.mjs";
import { readStateFile, stateRoot, sweep, writeStateFile } from "./state-file.mjs";

const hash = (value, length) => createHash("sha256").update(String(value)).digest("hex").slice(0, length);

/** The injected handoffs folder, else the state root's. */
export function handoffsDirectory(dependencies) {
  return dependencies?.handoffsDirectory ?? join(stateRoot(dependencies?.env ?? process.env, dependencies?.home), "handoffs");
}

/** A project is its repository root (or the folder itself outside one), hashed: the path never names a file. */
export const projectKey = (cwd) => hash(repositoryRoot(cwd ?? process.cwd()), 24);
/** The session that handed off, as an opaque hash of its session key. */
export const sessionHash = (sessionKeyValue) => hash(sessionKeyValue, 16);

export const handoffFile = (dependencies, cwd) => join(handoffsDirectory(dependencies), `${projectKey(cwd)}.json`);

/** The pending handoff for this project, or undefined when none or expired. `now`: epoch ms. */
export async function readPendingHandoff(dependencies, cwd, now = Date.now()) {
  const data = await readStateFile(handoffFile(dependencies, cwd));
  if (!data || typeof data.handle !== "string" || !data.handle) return undefined;
  const expires = Date.parse(data.expiresAt);
  return Number.isFinite(expires) && expires > now ? data : undefined;
}

export async function writePendingHandoff(dependencies, cwd, data) {
  try {
    await sweep(handoffsDirectory(dependencies));
    await writeStateFile(handoffFile(dependencies, cwd), data);
    return true;
  } catch {
    return false;
  }
}

/** Removes the pending handoff when it holds this handle (taken over, or refused as gone). */
export async function clearPendingHandoff(dependencies, cwd, handle) {
  try {
    const data = await readStateFile(handoffFile(dependencies, cwd));
    if (data && data.handle === handle) await rm(handoffFile(dependencies, cwd), { force: true });
  } catch { /* best effort: it expires on its own */ }
}
