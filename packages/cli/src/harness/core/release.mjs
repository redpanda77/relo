// The release role (SessionEnd): when the session ends with `/clear` and holds an open work, the work is
// handed off at once (note "after /clear") so the cleared session's start (source clear) offers it and the card
// goes on instead of hanging. The hook writes nothing itself: it runs the session's own `relo work handoff`
// through `runRelo` (like harness/core/approve.mjs), so the handoff is a declared act of the session. It waits a
// little less than the hook's own ceiling and never longer; any other reason is a no-op.
import { T_HISTORY_MS } from "../../work/state-file.mjs";

export const CLEAR_NOTE = "after /clear";
/** The hook's ceiling is 2 s (levels.mjs); the wait stays under it. */
const WAIT_MS = 1_500;

const delivered = (work) => {
  const rounds = work.plan?.rounds;
  return rounds?.[rounds.length - 1]?.state === "closed";
};

/**
 * Returns { handoff: true } when a handoff was run, else { handoff: false, reason }.
 * `session`: the harness's own session id (the child needs it to act as this session).
 */
export async function release({ adapter, event, session, now, state, dependencies }) {
  if (event?.reason !== "clear" || event.subagent) return { handoff: false, reason: "not_clear" };
  const open = state?.open;
  if (!open?.id || open.lifecycle !== "open" || delivered(open)) return { handoff: false, reason: "no_open_work" };
  const writtenAt = Date.parse(state.writtenAt);
  if (!Number.isFinite(writtenAt) || now - writtenAt >= T_HISTORY_MS) return { handoff: false, reason: "stale" };
  const runRelo = dependencies.runRelo;
  if (!runRelo || !adapter.sessionEnv || !session) return { handoff: false, reason: "unsupported" };
  const env = adapter.sessionEnv(dependencies.env, session);
  const run = Promise.resolve(runRelo(["work", "handoff", "--next", CLEAR_NOTE], { env, cwd: event.cwd })).catch(() => ({ code: 1 }));
  const timer = {};
  const timeout = new Promise((resolve) => { timer.id = setTimeout(() => resolve({ code: 124 }), dependencies.releaseWaitMs ?? WAIT_MS); });
  try {
    const outcome = await Promise.race([run, timeout]);
    return { handoff: outcome.code === 0, ...(outcome.code === 0 ? {} : { reason: outcome.code === 124 ? "slow" : "refused" }) };
  } finally {
    clearTimeout(timer.id);
  }
}
