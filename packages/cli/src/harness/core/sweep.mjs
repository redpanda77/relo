// The liveness sweep (observed state only): a harness that is killed or archived runs no SessionEnd hook, so a
// session record that is not `ended` but whose harness process is gone would stay "waiting" or "working" until
// the server's own timeouts. Each such session gets a synthetic `end` (reason "gone") through the same state
// machine and outbox as a real SessionEnd. It never touches the session's declared work file.
//
// Two steps with two cadences, so a harness that dies young is still known:
//  - resolve: the process a hook noted becomes the harness's own (pid and start time). Cheap, runs on every call, and
//    only for records without a harnessPid;
//  - check: is that process alive, plus garbage collection. Throttled to once per interval (a marker file shared by
//    every caller, so two callers never double the `ps` work).
// Callers: the outbox flusher (every flush) and the Relo MCP server (once a minute, through the composition root),
// so a quit session is found even when no hook fires anywhere. The MCP server also ends its harness's sessions the
// moment the harness exits (endSessionsOfProcess).
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { findHarnessProcess, processAlive } from "./liveness-probe.mjs";
import { processEvent } from "./process.mjs";

export const SWEEP_INTERVAL_MS = 60_000;
/**
 * Local state of a session ended longer ago than this is deleted. One day more than the server's SESSION_RETENTION_DAYS
 * (7, apps/server/src/agent-sessions.ts): a resumed session must never restart at seq 1 while the server still holds a
 * higher seq for it and would ignore the snapshots.
 */
export const ENDED_KEEP_MS = 8 * 24 * 60 * 60 * 1000;
const MAX_FILES = 500;
const MAX_BYTES = 64 * 1024;
/** Files removed per run, so cleaning up never holds the flusher. */
const MAX_DELETES = 200;
// Hook bookkeeping per session (core/bookkeeping.mjs): a role's marks and the status line's last reading.
const MARKER_FILE = /^(?:harness|context)-.+\.json$/u;

/** Every readable v1 record of the observed folder: [{ name, state, mtimeMs }], at most MAX_FILES. */
export async function readRecords(directory) {
  const names = (await readdir(directory)).filter((name) => name.endsWith(".json") && !name.startsWith(".")).slice(0, MAX_FILES);
  const records = [];
  for (const name of names) {
    try {
      const path = join(directory, name);
      const info = await stat(path);
      if (info.size > MAX_BYTES) continue;
      const state = JSON.parse(await readFile(path, "utf8"));
      if (state?.v === 1) records.push({ name, state, mtimeMs: info.mtimeMs });
    } catch { /* one unreadable record never stops the sweep */ }
  }
  return records;
}

const endEvent = (state, reason, pid) => ({ event: "end", harness: state.harness, session: state.session, subagent: false, reason,
  expectPid: pid, ...(typeof state.harnessCwd === "string" ? { cwd: state.harnessCwd } : {}) });

/** Deletes one session's local files (state, journals; never the .lock, which only its holder may remove). Returns how many were removed. */
async function removeSessionFiles(directory, name) {
  let removed = 0;
  const base = join(directory, name);
  for (const path of [base, `${base}.journal`, `${base}.journal.draining`, `${base}.journal.draining.next`]) {
    const existed = await stat(path).then(() => true, () => false);
    if (existed) { await rm(path, { force: true }); removed += 1; }
  }
  return removed;
}

/** Marker files untouched for ENDED_KEEP_MS go. `budget` bounds the deletions; returns how many were used. */
async function removeStaleMarkers({ directory, now, budget }) {
  let used = 0;
  try {
    const names = (await readdir(directory)).filter((name) => MARKER_FILE.test(name)).slice(0, MAX_FILES);
    for (const name of names) {
      if (used >= budget) break;
      try {
        const path = join(directory, name);
        if (now - (await stat(path)).mtimeMs > ENDED_KEEP_MS) { await rm(path, { force: true }); used += 1; }
      } catch { /* gone already */ }
    }
  } catch { /* no folder yet */ }
  return used;
}

/**
 * `adapterFor` resolves a harness id to its adapter (passed in: the core never imports an adapter). The ended sessions:
 * [{ session, harness }] swept this run. `startFlusher`: true when no flusher runs (the MCP server), so an end starts one.
 * Never throws.
 */
export async function sweepGoneSessions({ dependencies, adapterFor, intervalMs = SWEEP_INTERVAL_MS, startFlusher = false, records }) {
  const ended = [];
  try {
    const directory = dependencies.observedStateDirectory;
    const now = dependencies.now();
    const marker = join(directory, ".sweep");
    const last = Number(await readFile(marker, "utf8").catch(() => 0));
    const due = !(Number.isFinite(last) && now - last >= 0 && now - last < intervalMs);
    if (due) {
      await mkdir(directory, { recursive: true, mode: 0o700 });
      await writeFile(marker, String(now), { mode: 0o600 });
    }
    // Inside the flusher another one must not start; elsewhere (the MCP server) an end needs one.
    const run = startFlusher ? dependencies : { ...dependencies, spawnFlusher: async () => {} };
    const alive = dependencies.harnessProcess?.processAlive ?? processAlive;
    const find = dependencies.harnessProcess?.findHarnessProcess ?? findHarnessProcess;
    let deletes = 0;
    for (const { name, state, mtimeMs } of records ?? await readRecords(directory)) {
      try {
        if (state.phase === "ended") {
          const at = Date.parse(state.lastSeenAt);
          if (due && deletes < MAX_DELETES && now - (Number.isFinite(at) ? at : mtimeMs) > ENDED_KEEP_MS) deletes += await removeSessionFiles(directory, name);
          continue;
        }
        const adapter = adapterFor(state.harness);
        if (!adapter) continue;
        // Resolve: the process the hook noted becomes the harness's own (or none). A noted process already gone is
        // recorded as none, never as "gone": it may only have been the shell that ran the hook.
        if (state.harnessPid === undefined && Number.isInteger(state.harnessCandidate) && typeof adapter.harnessProcess === "function") {
          const found = await find({ match: adapter.harnessProcess, startPid: state.harnessCandidate });
          await processEvent({ adapter, input: {}, dependencies: run,
            event: { event: "harness", harness: state.harness, session: state.session, subagent: false,
              candidate: state.harnessCandidate, pid: found?.pid ?? null, start: found?.start ?? null } });
          continue;
        }
        if (!due || !Number.isInteger(state.harnessPid)) continue;
        if (await alive({ pid: state.harnessPid, start: state.harnessStart ?? undefined })) continue;
        await processEvent({ adapter, input: {}, dependencies: run, event: endEvent(state, "gone", state.harnessPid) });
        ended.push({ session: state.session, harness: state.harness });
      } catch { /* one unreadable record never stops the sweep */ }
    }
    if (due && deletes < MAX_DELETES && dependencies.hookStateDirectory) {
      await removeStaleMarkers({ directory: dependencies.hookStateDirectory, now, budget: MAX_DELETES - deletes });
    }
  } catch { /* a sweep never fails the flusher */ }
  return ended;
}

/**
 * The Relo MCP server's leave: its harness (process `pid`) exited, so every session that harness ran is over. Ends each
 * non-ended session whose harness process is `pid` (or whose noted process is, when not yet resolved), like a real
 * SessionEnd with reason "mcp", and starts the flusher (none runs here). The caller has already confirmed the process
 * is gone. [{ session, harness }]; never throws.
 */
export async function endSessionsOfProcess({ pid, dependencies, adapterFor }) {
  const ended = [];
  if (!Number.isInteger(pid) || pid <= 1) return ended;
  try {
    for (const { state } of await readRecords(dependencies.observedStateDirectory)) {
      try {
        if (state.phase === "ended") continue;
        const own = Number.isInteger(state.harnessPid) ? state.harnessPid : state.harnessPid === undefined ? state.harnessCandidate : undefined;
        if (own !== pid) continue;
        const adapter = adapterFor(state.harness);
        if (!adapter) continue;
        await processEvent({ adapter, input: {}, dependencies, event: endEvent(state, "mcp", pid) });
        ended.push({ session: state.session, harness: state.harness });
      } catch { /* one unreadable record never stops the leave */ }
    }
  } catch { /* nothing to end */ }
  return ended;
}

/**
 * The Relo MCP server's minute tick for the sessions its harness (process `pid`) runs: each one at a permission prompt
 * (phase `waiting`) queues one heartbeat snapshot, so the server can tell a prompt that waits from a session that is gone.
 * No other phase gets one (hooks heartbeat while working). Observed state only, through the same state machine and
 * outbox; starts the flusher (none runs here). [{ session, harness }] heartbeated; never throws.
 */
export async function heartbeatSessionsOfProcess({ pid, dependencies, adapterFor, records }) {
  const sent = [];
  if (!Number.isInteger(pid) || pid <= 1) return sent;
  try {
    for (const { state } of records ?? await readRecords(dependencies.observedStateDirectory)) {
      try {
        if (state.phase !== "waiting" || state.harnessPid !== pid) continue;
        const adapter = adapterFor(state.harness);
        if (!adapter) continue;
        const result = await processEvent({ adapter, input: {}, dependencies,
          event: { event: "heartbeat", harness: state.harness, session: state.session, subagent: false } });
        if (result.queued) sent.push({ session: state.session, harness: state.harness });
      } catch { /* one unreadable record never stops the tick */ }
    }
  } catch { /* nothing to heartbeat */ }
  return sent;
}
