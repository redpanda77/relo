// The calling agent session's human name, read by its harness's adapter (decision D5: sessions are named by
// the harness, never by the agent), through the same rule the hooks use (harness/core/labels.mjs resolveSessionTitle).
// Undefined for a harness whose names Relo cannot read. What the rule asks to remember (the Desktop file's path, or
// when none was found) lives in this session's declared state file (`titleCache`, local only) and is written
// with the work's next save (agent/work.mjs).
import { adapterFor } from "../harness/adapters/index.mjs";
import { resolveSessionTitle } from "../harness/core/labels.mjs";
import { readSessionFileSync } from "../work/session-store.mjs";

const latest = new WeakMap(); // dependencies → the cache this command resolved

export function sessionName(dependencies) {
  const caller = dependencies?.caller;
  if (caller?.type !== "agent_session") return undefined;
  try {
    const cached = latest.get(dependencies) ?? readSessionFileSync(dependencies, caller.sessionKey)?.titleCache ?? {};
    const { title, cache } = resolveSessionTitle(adapterFor(caller.harness), { session_id: caller.sessionId, cwd: dependencies.cwd },
      { env: dependencies.env, home: dependencies.home, now: (dependencies.now ?? Date.now)(), titlePath: cached.titlePath, titleMissAt: cached.titleMissAt, nameCache: cached.nameCache });
    latest.set(dependencies, cache ?? {});
    return title;
  } catch {
    return undefined;
  }
}

/** The title cache to keep in the session's file: this command's, else the file's own. */
export const titleCacheOf = (dependencies, file) => latest.get(dependencies) ?? file?.titleCache;
