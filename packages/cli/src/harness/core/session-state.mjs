// The per-session observed state file (EDGE.1): <observed dir>/<sessionKey prefix>.json, 0600 in 0700.
// Separate from the declared state file under sessions/ (agents write that one through relo commands;
// hooks only ever read it). Only the hook process writes this one.
import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Async hooks of one session run concurrently. Each appends its event to the session's journal first; the
// one that gets the lock folds every journaled event into the state, in order, and writes it. A hook that
// cannot get the lock in time leaves its event in the journal for the next one: the state is never written
// without the lock, so no event is lost to a race.
const LOCK_WAIT_MS = 250;
const LOCK_STALE_MS = 2_000;
const MAX_BYTES = 64 * 1024;
const MAX_ENTRY_BYTES = 1_024;
const MAX_ROUNDS = 3;

function observedStatePath(directory, session) {
  return join(directory, `${String(session).slice(0, 32)}.json`);
}

async function readObservedState(directory, session) {
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
      // A hook never waits long: past this, its event stays journaled for the hook that holds the lock.
      if (Date.now() - started > LOCK_WAIT_MS) return false;
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  }
}

const journalPath = (directory, session) => `${observedStatePath(directory, session)}.journal`;

/** The session's observed phase right now (read only), or undefined when there is no state. */
export async function readObservedPhase(directory, session) {
  return (await readObservedState(directory, session))?.phase;
}

/** The events waiting in a journal file, oldest first; a line that does not parse is skipped. */
async function readEntries(path) {
  let text;
  try { text = await readFile(path, "utf8"); } catch { return []; }
  return text.split("\n").filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
}

/** Takes the journal for folding: what a crashed holder left in .draining first, then the new entries. */
async function takeEntries(directory, session) {
  const journal = journalPath(directory, session);
  const draining = `${journal}.draining`;
  const left = await readEntries(draining);
  try { await rename(journal, `${draining}.next`); } catch { return { entries: left, done: () => rm(draining, { force: true }) }; }
  const fresh = await readEntries(`${draining}.next`);
  await writeFile(draining, [...left, ...fresh].map((entry) => JSON.stringify(entry)).join("\n") + "\n", { mode: 0o600 });
  await rm(`${draining}.next`, { force: true });
  return { entries: [...left, ...fresh], done: () => rm(draining, { force: true }) };
}

/**
 * Records one hook event for a session. `entry` (JSON, at most 1 KiB) is appended to the session's journal;
 * whichever process holds the lock then calls `fold(previous, entries)` with every journaled entry in order
 * and writes the `state` it returns. Resolves with fold's result, or { journaled: true } when another hook
 * holds the lock and will fold this entry with its own.
 */
export async function recordObservedEvent(directory, session, entry, fold) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const line = JSON.stringify(entry);
  if (Buffer.byteLength(line) > MAX_ENTRY_BYTES) throw new Error("observed journal entry too large");
  await writeFile(journalPath(directory, session), `${line}\n`, { flag: "a", mode: 0o600 });
  const lockPath = `${observedStatePath(directory, session)}.lock`;
  if (!await lock(lockPath)) return { journaled: true };
  try {
    let outcome;
    let state = await readObservedState(directory, session);
    for (let round = 0; round < MAX_ROUNDS; round += 1) {
      const { entries, done } = await takeEntries(directory, session);
      if (entries.length === 0) break;
      outcome = await fold(state, entries);
      if (outcome?.state) { await writeObservedState(directory, outcome.state); state = outcome.state; }
      await done();
    }
    return outcome ?? { state };
  } finally {
    await rm(lockPath, { force: true }).catch(() => {});
  }
}
