// Stop reminder (plan 05 §3.3): soft context for the agent, never a decision, once per state change, fail
// open. Harness-neutral: it reads the canonical event and returns a neutral outcome the adapter renders.
import { createHash } from "node:crypto";
import { T_FRESH_MS, T_HISTORY_MS } from "../../work/state-file.mjs";

export const REMINDER_TURN_SECONDS = 120;

const TAIL = "this note will not repeat until the work changes.";
const isClosed = (step) => step?.state === "done" || step?.state === "skipped";

/** The open round's steps (the whole plan before any round was delivered) and whether the last round is closed. */
function openRoundSteps(work) {
  const rounds = work.plan?.rounds;
  const last = rounds?.[rounds.length - 1];
  const steps = work.plan?.steps ?? [];
  return { delivered: last?.state === "closed", steps: last ? steps.filter((s) => (s.round ?? 1) === last.n) : steps };
}

export function reminderText(kind, work, now) {
  const goal = work.goal ?? "";
  const { steps } = openRoundSteps(work);
  const current = steps.find((s) => s.state === "current");
  if (kind === "R0") {
    const refusal = work.pendingRefusal;
    return `Relo: your relo work ${refusal.verb} was refused (${refusal.what}) and "${goal}" is still open on the owner's Lock Screen. Fix it: ${refusal.next ?? `relo work ${refusal.verb} --outcome "…"`}. If you no longer need it, end your turn; ${TAIL}`;
  }
  if (kind === "R1") return `Relo: every step of "${goal}" is done, but this round is still open on the owner's Lock Screen. If it is done and nothing is left: relo work finish --outcome "<what was achieved>". If this request is done and more of the goal is to come: relo work deliver --outcome "<what was delivered>". If more is needed now: relo work update --add "<next step>". If none of these, end your turn; ${TAIL}`;
  if (kind === "R2") {
    const total = (current ?? work).progress?.total;
    if (!current) return `Relo: "${goal}" shows ${total} of ${total} done but is still open. If it is done and nothing is left: relo work finish --outcome "<what was achieved>"; if this request is done and more of the goal is to come: relo work deliver --outcome "<what was delivered>". If more is needed: relo work update --add "<next step>". If neither, end your turn; ${TAIL}`;
    return `Relo: the current step "${current.label ?? current.id}" shows ${total} of ${total} done, but it is still the current step. If the step is finished: relo work update --next-step (or relo work deliver --outcome "…" if it was the last). If nothing changed, end your turn; ${TAIL}`;
  }
  if (kind === "R4") {
    const live = steps.filter((s) => s.state !== "skipped");
    const at = current ? ` at "${current.label ?? current.id}" (step ${live.indexOf(current) + 1} of ${live.length})` : "";
    return `Relo: your turn is ending with "${goal}" open${at}. If this request is done: relo work deliver --outcome "<what it delivered>" (the goal itself done: relo work finish). A deploy, CI or a job still running: relo work update --waiting "<what>". If you asked the owner something, or the step is accurate, end your turn; ${TAIL}`;
  }
  const minutes = Math.max(0, Math.floor((now - Date.parse(work.lastWriteAt)) / 60_000));
  const index = current ? steps.filter((s) => s.state !== "skipped").indexOf(current) + 1 : 0;
  const at = current ? ` (now at step ${index}: "${current.label ?? current.id}")` : "";
  return `Relo: "${goal}" is open and its card was last updated ${minutes} min ago${at}. If the work moved on: relo work update --status "<what changed>" [--next-step]. If it is done and nothing is left: relo work finish --outcome "<what was achieved>"; if this request is done and more of the goal is to come: relo work deliver --outcome "<what was delivered>" (refused while steps are open; the owner must act mid-plan: relo ask or --waiting). If nothing changed, end your turn; ${TAIL}`;
}

/** Which reminder applies (R1, R2, R3) or undefined. A delivered work (last round closed) needs none of them. */
function reminderKind(work, { now, turnStartedAt }) {
  const { delivered, steps } = openRoundSteps(work);
  if (delivered) return undefined;
  if (steps.length > 0 && steps.every(isClosed)) return "R1";
  const current = steps.find((s) => s.state === "current");
  const progress = (current ?? (steps.length === 0 ? work : undefined))?.progress;
  if (progress && Number.isFinite(progress.total) && progress.total > 0 && progress.done === progress.total) return "R2";
  const last = Date.parse(work.lastWriteAt);
  if (!Number.isFinite(last)) return undefined;
  if (Number.isFinite(turnStartedAt) && last < turnStartedAt && now - turnStartedAt >= REMINDER_TURN_SECONDS * 1000) return "R3";
  if (now - last >= T_FRESH_MS) return "R3";
  // R4: a turn of real work ends with the round open and steps left, and no declared wait: delivered, or waiting?
  if (!work.waiting && Number.isFinite(turnStartedAt) && now - turnStartedAt >= REMINDER_TURN_SECONDS * 1000 && steps.some((s) => !isClosed(s))) return "R4";
  return undefined;
}

/**
 * event: the canonical stop event. state: the CLI session file (read-only) or undefined. bookkeeping: the
 * hook's own. Returns { context, reminded } or undefined.
 */
export function remind({ event, now, state, bookkeeping = {} }) {
  if (event?.stopActive === true) return undefined;
  if (event?.subagent) return undefined;
  if (!state) return undefined;
  const writtenAt = Date.parse(state.writtenAt);
  if (!Number.isFinite(writtenAt) || now - writtenAt >= T_HISTORY_MS) return undefined;
  const open = state.open;
  if (!open || !open.id || open.lifecycle === "finished" || open.lifecycle === "paused") return undefined;
  if (state.question && !state.question.answered) return undefined;
  const refusal = state.pendingRefusal?.verb ? state.pendingRefusal : undefined;
  const work = { ...open, lastWriteAt: state.writtenAt, ...(refusal ? { pendingRefusal: refusal } : {}) };
  // R0: a refused finish or deliver is chased first, whatever the card's freshness; once per refusal.
  const kind = refusal ? "R0" : reminderKind(work, { now, turnStartedAt: bookkeeping.turnStartedAt });
  if (!kind) return undefined;
  const fingerprint = createHash("sha256").update(kind === "R0" ? `${open.id}|R0|${refusal.at}` : `${open.id}|${open.plan?.version ?? open.version ?? ""}|${state.writtenAt}|${kind}`).digest("hex");
  if (bookkeeping.reminded?.fingerprint === fingerprint) return undefined;
  return {
    context: reminderText(kind, work, now),
    reminded: { fingerprint, kind, at: new Date(now).toISOString() },
  };
}
