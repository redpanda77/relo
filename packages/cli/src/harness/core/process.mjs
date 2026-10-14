// One observed hook invocation (EDGE.1, EDGE.6): canonical event → local state machine → (only when a
// snapshot is due) the outbox → a background flusher. It never awaits the network, never prints and
// never fails: the harness is not held up by Relo, online or not.
import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { enqueue, isFlushing, serverOrigin } from "../../outbox/index.mjs";
import { readHarnessCredential } from "./credential.mjs";
import { normalize } from "./events.mjs";
import { observedLabels } from "./labels.mjs";
import { observedEntry } from "./observed.mjs";
import { updateObservedState } from "./session-state.mjs";
import { markSent, reduce, snapshotDue } from "./state-machine.mjs";

async function debug(dependencies, message) {
  if (dependencies.env.RELO_DEBUG !== "1") return;
  try {
    await mkdir(dependencies.hookStateDirectory, { recursive: true, mode: 0o700 });
    await appendFile(join(dependencies.hookStateDirectory, "hook-debug.log"),
      `${new Date(dependencies.now()).toISOString()} ${String(message).slice(0, 300)}\n`, { mode: 0o600 });
  } catch { /* nothing more to do */ }
}

async function labelsFor(event, adapter, config, input, dependencies) {
  // Without the CLI config there is no way to know whether this computer seals: send no labels rather
  // than readable ones.
  if (!config) return { labels: {}, names: {} };
  const found = await observedLabels({ cwd: event.cwd, harnessEnv: adapter.harnessEnv?.(dependencies.env) ?? dependencies.env, config, dependencies });
  // The session's title, for adapters that can read one locally; it travels only inside the sealed names.
  let title;
  try { title = adapter.sessionTitle?.(input, { env: dependencies.env, home: dependencies.home }); } catch { title = undefined; }
  return title ? { ...found, title } : found;
}

/** The server a snapshot is queued for: the CLI config's API origin, else the harness credential's (local files only). */
export async function observedServer(config, dependencies) {
  return serverOrigin(config?.apiUrl) ?? serverOrigin((await readHarnessCredential(dependencies).catch(() => undefined))?.apiUrl);
}

/** Starts a detached flusher unless one already holds the outbox lock. Never throws. */
export async function startFlusher(dependencies) {
  try {
    if (await isFlushing({ directory: dependencies.outboxDirectory })) return false;
    dependencies.spawnFlusher?.();
    return true;
  } catch {
    return false;
  }
}

/**
 * Handles one hook event. Resolves with { queued, phase?, seq?, reason? }; never rejects.
 * `named` is the canonical event from the command line (the harness's own event name wins).
 */
export async function processHook({ adapter, named, input, dependencies }) {
  try {
    const event = normalize({ adapter, input, named });
    if (event.drop) return { queued: false, reason: event.drop };
    const now = dependencies.now();
    const outcome = await updateObservedState(dependencies.observedStateDirectory, event.session, async (previous) => {
      const state = reduce(previous, event, now);
      if (!snapshotDue(state, now)) return { state, queued: false };
      const next = markSent(state, now);
      try {
        const config = await Promise.resolve().then(() => dependencies.loadConfig(dependencies.configPath())).catch(() => undefined);
        const { labels, names, title } = await labelsFor(event, adapter, config, input, dependencies);
        // Not signed in: no server to queue it for. The local state is kept; nothing is queued.
        const server = await observedServer(config, dependencies);
        if (!server) return { state, queued: false, reason: "not_signed_in" };
        await enqueue({ directory: dependencies.outboxDirectory, lane: "observed", entry: { server, ...observedEntry(next, labels, names, title) }, now });
      } catch (error) {
        await debug(dependencies, `hook enqueue failed: ${error?.code ?? error?.name ?? "error"}: ${error?.message ?? ""}`);
        return { state, queued: false, reason: "enqueue_failed" };
      }
      return { state: next, queued: true };
    });
    if (outcome.queued) await startFlusher(dependencies);
    return { queued: outcome.queued, phase: outcome.state.phase, seq: outcome.state.seq, ...(outcome.reason ? { reason: outcome.reason } : {}) };
  } catch (error) {
    await debug(dependencies, `hook failed: ${error?.code ?? error?.name ?? "error"}: ${error?.message ?? ""}`);
    return { queued: false, reason: "error" };
  }
}
