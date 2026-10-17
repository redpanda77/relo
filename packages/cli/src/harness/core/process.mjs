// One observed hook invocation (EDGE.1, EDGE.6): canonical event → local state machine → (only when a
// snapshot is due) the outbox → a background flusher. It never awaits the network, never prints and
// never fails: the harness is not held up by Relo, online or not.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { observedQueue, serverOrigin } from "../../outbox/index.mjs";
import { readHarnessCredential } from "./credential.mjs";
import { normalize } from "./events.mjs";
import { observedLabels, resolveSessionTitle } from "./labels.mjs";
import { observedEntry } from "./observed.mjs";
import { readObservedPhase, recordObservedEvent } from "./session-state.mjs";
import { markSent, reduce, snapshotDue } from "./state-machine.mjs";

const CONTEXT_READING_EVENTS = new Set(["stop", "tool_end"]);

async function debug(dependencies, message) {
  if (dependencies.env.RELO_DEBUG !== "1") return;
  try {
    await mkdir(dependencies.hookStateDirectory, { recursive: true, mode: 0o700 });
    await appendFile(join(dependencies.hookStateDirectory, "hook-debug.log"),
      `${new Date(dependencies.now()).toISOString()} ${String(message).slice(0, 300)}\n`, { mode: 0o600 });
  } catch { /* nothing more to do */ }
}

async function labelsFor(event, adapter, config, input, dependencies, titleCache) {
  // Without the CLI config there is no way to know whether this computer seals: send no labels rather
  // than readable ones.
  if (!config) return { labels: {}, names: {} };
  const found = await observedLabels({ cwd: event.cwd, harnessEnv: adapter.harnessEnv?.(dependencies.env) ?? dependencies.env, config, dependencies });
  // The session's title (the Desktop sidebar's under Claude Desktop), read locally; it travels only inside the sealed names.
  // `titleCache` (the Desktop file's path, or when none was found) is kept in the observed state, never sent.
  let resolved;
  try { resolved = resolveSessionTitle(adapter, input, { env: dependencies.env, home: dependencies.home, now: dependencies.now(), ...titleCache }); } catch { resolved = undefined; }
  return { ...found, ...(resolved?.title ? { title: resolved.title } : {}), titleCache: resolved?.cache ?? {} };
}

/** The server a snapshot is queued for: the CLI config's API origin, else the harness credential's (local files only). */
export async function observedServer(config, dependencies) {
  return serverOrigin(config?.apiUrl) ?? serverOrigin((await readHarnessCredential(dependencies).catch(() => undefined))?.apiUrl);
}

/** Starts a detached flusher unless one already holds the outbox lock. Never throws. */
async function startFlusher(dependencies) {
  try {
    if (await observedQueue.isFlushing({ directory: dependencies.outboxDirectory })) return false;
    await dependencies.spawnFlusher?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Notes, once per session run (the first event, and each fresh start), the process that ran this hook: the harness
 * itself, or the shell it ran the hook through. Only `process.ppid`, so the hook pays nothing; the outbox flusher's
 * liveness sweep (core/sweep.mjs) resolves it to the harness's own process off the hook path. Observed state only.
 */
function withHarnessProcess(state, previous, entries, adapter, dependencies) {
  if (typeof adapter.harnessProcess !== "function" || !state || state.phase === "ended") return state;
  const fresh = entries.some((entry) => entry.event.event === "start" && entry.event.source !== "compact");
  if (previous?.harnessCandidate !== undefined && !fresh) return state;
  const candidate = dependencies.parentPid ?? process.ppid;
  const cwd = [...entries].reverse().map((entry) => entry.event.cwd).find((value) => typeof value === "string");
  const { harnessPid: _pid, harnessStart: _start, ...rest } = state;
  return { ...rest, harnessCandidate: Number.isInteger(candidate) ? candidate : null, ...(cwd ? { harnessCwd: cwd } : {}) };
}

/**
 * Handles one hook event. Resolves with { queued, phase?, seq?, reason? }; never rejects.
 * `named` is the canonical event from the command line (the harness's own event name wins).
 */
export async function processHook({ adapter, named, input, dependencies }) {
  try {
    const event = normalize({ adapter, input, named });
    if (event.drop) return { queued: false, reason: event.drop };
    // The turn ended or a tool finished: the session's context size, where the harness can read it from its
    // transcript (the status line does not run in every host). A count only; the gate is the state machine's.
    if (CONTEXT_READING_EVENTS.has(event.event) && !event.subagent) {
      let tokens;
      try { tokens = adapter.contextTokens?.(input); } catch { tokens = undefined; }
      if (Number.isInteger(tokens)) event.contextTokens = tokens;
    }
    return await processEvent({ adapter, event, input, dependencies });
  } catch (error) {
    await debug(dependencies, `hook failed: ${error?.code ?? error?.name ?? "error"}: ${error?.message ?? ""}`);
    return { queued: false, reason: "error" };
  }
}

/**
 * The status line's reading of a session (context use, cost) as a canonical `context` event: folded into the
 * session's observed state and queued only when it moved enough (state-machine snapshotDue). A session the hooks
 * never saw has no state and queues nothing.
 */
export async function processContext({ adapter, session, contextPct, costUsd, cwd, input, dependencies }) {
  try {
    if (await readObservedPhase(dependencies.observedStateDirectory, session) === undefined) return { queued: false, reason: "no_session" };
    const event = { event: "context", harness: adapter.id, session, subagent: false, ...(contextPct === undefined ? {} : { contextPct }),
      ...(costUsd === undefined ? {} : { costUsd }), ...(cwd ? { cwd } : {}) };
    return await processEvent({ adapter, event, input, dependencies });
  } catch (error) {
    await debug(dependencies, `context failed: ${error?.code ?? error?.name ?? "error"}: ${error?.message ?? ""}`);
    return { queued: false, reason: "error" };
  }
}

export async function processEvent({ adapter, event, input, dependencies }) {
  const now = dependencies.now();
  // Every event journaled for this session (other hooks' included) is folded in order, then at most one
  // snapshot is queued for the result.
  const outcome = await recordObservedEvent(dependencies.observedStateDirectory, event.session, { event, now }, async (previous, entries) => {
    let state = entries.reduce((current, entry) => {
      // A synthetic end (the liveness sweep's "gone", the Relo MCP server's "mcp") applies only to the harness process
      // it saw die: a session resumed in a new process since then is not ended by it.
      if ((entry.event.reason === "gone" || entry.event.reason === "mcp") && entry.event.expectPid !== (current?.harnessPid ?? current?.harnessCandidate)) return current;
      // The sweep resolved the noted process to the harness's own (or to none): recorded only for the run it saw.
      if (entry.event.event === "harness") {
        return current && entry.event.candidate === current.harnessCandidate
          ? { ...current, harnessPid: entry.event.pid, harnessStart: entry.event.start } : current;
      }
      return reduce(current, entry.event, entry.now);
    }, previous);
    state = withHarnessProcess(state, previous, entries, adapter, dependencies);
    if (!snapshotDue(state, now)) return { state, queued: false };
    let next = markSent(state, now);
    // The heartbeat flag marks one snapshot only: no return path keeps it in the stored state.
    const { heartbeat: _lingering, ...unflagged } = state;
    try {
      const config = await Promise.resolve().then(() => dependencies.loadConfig(dependencies.configPath())).catch(() => undefined);
      const { labels, names, title, titleCache } = await labelsFor(event, adapter, config, input, dependencies, { titlePath: state.titlePath, titleMissAt: state.titleMissAt });
      const { titlePath: _path, titleMissAt: _miss, ...rest } = next;
      next = { ...rest, ...titleCache };
      // Not signed in: no server to queue it for. The local state is kept; nothing is queued.
      const server = await observedServer(config, dependencies);
      if (!server) return { state: unflagged, queued: false, reason: "not_signed_in" };
      await observedQueue.enqueue({ directory: dependencies.outboxDirectory, entry: { server, ...observedEntry(next, labels, names, title) }, now });
    } catch (error) {
      await debug(dependencies, `hook enqueue failed: ${error?.code ?? error?.name ?? "error"}: ${error?.message ?? ""}`);
      return { state: unflagged, queued: false, reason: "enqueue_failed" };
    }
    const { heartbeat: _heartbeat, ...stored } = next;
    return { state: stored, queued: true };
  });
  if (outcome.journaled) return { queued: false, reason: "journaled" };
  if (outcome.queued) await startFlusher(dependencies);
  return { queued: outcome.queued, phase: outcome.state?.phase, seq: outcome.state?.seq, ...(outcome.reason ? { reason: outcome.reason } : {}) };
}
