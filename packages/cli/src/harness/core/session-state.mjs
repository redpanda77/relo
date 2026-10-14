// The per-session observed state file (EDGE.1): <observed dir>/<sessionKey prefix>.json, 0600 in 0700.
// Separate from the declared state file under sessions/ (agents write that one through relo commands;
// hooks only ever read it). Only the hook process writes this one.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Async hooks of one session run concurrently; a short lock keeps read-reduce-write whole.
const LOCK_WAIT_MS = 40;
const LOCK_STALE_MS = 2_000;
const MAX_BYTES = 64 * 1024;

export function observedStatePath(directory, session) {
  return join(directory, `${String(session).slice(0, 32)}.json`);
}

export async function readObservedState(directory, session) {
  try {
    const path = observedStatePath(directory, session);
    const info = await stat(path);
    if (!info.isFile() || info.size > MAX_BYTES) return undefined;
    const data = JSON.parse(await readFile(path, "utf8"));
    return data?.v === 1 && data.session === session ? data : undefined;
  } catch {
    return undefined;
  }
}

async function writeObservedState(directory, state) {
  const path = observedStatePath(directory, state.session);
  const temp = join(directory, `.${process.pid}-${randomBytes(4).toString("hex")}.tmp`);
  await writeFile(temp, JSON.stringify(state), { mode: 0o600 });
  await rename(temp, path);
}

async function lock(path) {
  const started = Date.now();
  for (;;) {
    try {
      const handle = await open(path, "wx", 0o600);
      await handle.close();
      return true;
    } catch (error) {
      if (error?.code !== "EEXIST") return false;
      const info = await stat(path).catch(() => undefined);
      if (info && Date.now() - info.mtimeMs > LOCK_STALE_MS) { await rm(path, { force: true }); continue; }
      // Fail open: a hook never waits long. Worst case one event is reduced on a slightly old state.
      if (Date.now() - started > LOCK_WAIT_MS) return false;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
}

/**
 * Read, change and write one session's state under its lock. `change(previous)` returns
 * { state, ...extra } (sync or async); `state` is written and the whole result returned.
 */
export async function updateObservedState(directory, session, change) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lockPath = `${observedStatePath(directory, session)}.lock`;
  const locked = await lock(lockPath);
  try {
    const previous = await readObservedState(directory, session);
    const outcome = await change(previous);
    if (outcome?.state) await writeObservedState(directory, outcome.state);
    return outcome;
  } finally {
    if (locked) await rm(lockPath, { force: true }).catch(() => {});
  }
}
