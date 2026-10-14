// `relo ask … --wait DURATION` for scripts (plan 04 §2.9): loop 300 s hops until answered or DURATION.
// Exit codes: 0 approved/yes/chosen (verified), 5 denied/no, 8 expired/canceled/unverified, 4 still open.
import { EXIT } from "../errors.mjs";
import { CLOSED_STATES, NEGATIVE_STATES, waitForInteraction } from "../commands/notify.mjs";
import { parseDuration } from "./producer.mjs";
import { WorkRefusal } from "../work/refusal.mjs";

/** `--wait` bounds: at least 1 s; the question expires no sooner than max(DURATION, 300 s). */
export function waitPlan(waitOption) {
  const seconds = parseDuration(waitOption);
  if (seconds === undefined || seconds < 1) {
    throw new WorkRefusal("WAIT_INVALID", { what: "--wait takes a duration of at least 1s (30s, 30m, 2h)", state: `--wait ${waitOption}`, next: 'relo ask "…" --approval --wait 30m' });
  }
  return { waitSeconds: seconds, expiresInSeconds: Math.max(seconds, 300) };
}

/** Map a terminal wait (answer payload or TerminalInteractionError state) to the exit code. */
export function exitCodeFor(outcome) {
  if (outcome.ok) return EXIT.OK;
  const state = outcome.state;
  if (NEGATIVE_STATES.has(state)) return EXIT.NEGATIVE;
  if (state === "timeout") return EXIT.TERMINAL; // our DURATION ended; the question is still open
  if (CLOSED_STATES.has(state) || state === "unverified") return EXIT.CLOSED;
  return EXIT.API;
}

/** Waits up to `waitSeconds` on question `id`; returns { exitCode, state, result }. */
export async function waitForAnswer(client, id, waitSeconds, dependencies, expected = {}) {
  try {
    const result = await waitForInteraction(client, id, waitSeconds, dependencies, expected);
    return { exitCode: exitCodeFor({ ok: true }), state: "answered", result };
  } catch (error) {
    const state = error?.details?.state;
    if (state === undefined) throw error;
    return { exitCode: exitCodeFor({ ok: false, state }), state, result: error.details };
  }
}
