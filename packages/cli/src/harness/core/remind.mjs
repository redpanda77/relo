// Stop reminder (plan 05 §3.3): soft context for the agent, never a decision, once per state change, fail
// open. Harness-neutral: it reads the canonical event and returns a neutral outcome the adapter renders.
import { createHash } from "node:crypto";
import { T_HISTORY_MS } from "../../work/state-file.mjs";

export const REMINDER_TURN_SECONDS = 120;
export const T_FRESH_MS = 20 * 60_000;

const TAIL = "this note will not repeat until the work changes.";
const isClosed = (step) => step?.state === "done" || step?.state === "skipped";

export function reminderText(kind, work, now) {
  const goal = work.goal ?? "";
  const steps = work.plan?.steps ?? [];
  const current = steps.find((s) => s.state === "current");
  if (kind === "R1") return `Relo: every step of "${goal}" is done, but the work is still open on the owner's Lock Screen. If it is finished: relo work finish --outcome "<what was achieved>". If more is needed: relo work update --add "<next step>". If neither, end your turn; ${TAIL}`;
  if (kind === "R2") {
    const total = (current ?? work).progress?.total;
    if (!current) return `Relo: "${goal}" shows ${total} of ${total} done but is still open. If it is finished: relo work finish --outcome "<what was achieved>". If more is needed: relo work update --add "<next step>". If neither, end your turn; ${TAIL}`;
    return `Relo: the current step "${current.label ?? current.id}" shows ${total} of ${total} done, but it is still the current step. If the step is finished: relo work update --next-step (or relo work finish --outcome "…" if it was the last). If nothing changed, end your turn; ${TAIL}`;
  }
  const minutes = Math.max(0, Math.floor((now - Date.parse(work.lastWriteAt)) / 60_000));
  const index = current ? steps.filter((s) => s.state !== "skipped").indexOf(current) + 1 : 0;
  const at = current ? ` (now at step ${index}: "${current.label ?? current.id}")` : "";
  return `Relo: "${goal}" is open and its card was last updated ${minutes} min ago${at}. If the work moved on: relo work update --status "<what changed>" [--next-step]. If it is done: relo work finish --outcome "<what was achieved>". If nothing changed, end your turn; ${TAIL}`;
}

/** Which reminder applies (R1, R2, R3) or undefined. */
export function reminderKind(work, { now, turnStartedAt }) {
  const steps = work.plan?.steps ?? [];
  if (steps.length > 0 && steps.every(isClosed)) return "R1";
  const current = steps.find((s) => s.state === "current");
  const progress = (current ?? (steps.length === 0 ? work : undefined))?.progress;
  if (progress && Number.isFinite(progress.total) && progress.total > 0 && progress.done === progress.total) return "R2";
  const last = Date.parse(work.lastWriteAt);
  if (!Number.isFinite(last)) return undefined;
  if (Number.isFinite(turnStartedAt) && last < turnStartedAt && now - turnStartedAt >= REMINDER_TURN_SECONDS * 1000) return "R3";
  if (now - last >= T_FRESH_MS) return "R3";
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
  const work = { ...open, lastWriteAt: state.writtenAt };
  const kind = reminderKind(work, { now, turnStartedAt: bookkeeping.turnStartedAt });
  if (!kind) return undefined;
  const fingerprint = createHash("sha256").update(`${open.id}|${open.plan?.version ?? open.version ?? ""}|${state.writtenAt}|${kind}`).digest("hex");
  if (bookkeeping.reminded?.fingerprint === fingerprint) return undefined;
  return {
    context: reminderText(kind, work, now),
    reminded: { fingerprint, kind, at: new Date(now).toISOString() },
  };
}
