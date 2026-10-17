// Mid-turn guard (plan 12 §4.6): before an edit, one line of context when the card cannot be right: no card yet, a
// delivered round with new work under way, or a card left on one step for a while. Before a relo command, a reply the
// agent would never read (sent to /dev/null or filtered) is refused, so the agent runs it alone. Context and that one
// refusal only: a guard never changes a card. Reads the CLI session file and the hook's bookkeeping; fail open.
import { T_HISTORY_MS } from "../../work/state-file.mjs";
import { noCardText } from "./turn.mjs";

// A card on one step this long while the agent keeps editing is likely a step behind.
export const LAG_MS = 10 * 60_000;

export const HIDDEN_REPLY = "Relo: run this relo command alone, without >/dev/null, 2>/dev/null or a pipe: its reply says what reached the owner (Owner sees:) or why it was refused.";

const cut = (text, length) => {
  const clean = String(text ?? "").replace(/\s+/gu, " ").trim();
  return clean.length > length ? `${clean.slice(0, length - 1).trimEnd()}…` : clean;
};

/**
 * The line for an edit, with the key that keeps it to once per occasion, or undefined. state: the session file;
 * bookkeeping: the hook's own (turnStartedAt, guardKey).
 */
export function editGuard({ now, state, bookkeeping = {} }) {
  const writtenAt = Date.parse(state?.writtenAt);
  const current = Number.isFinite(writtenAt) && now - writtenAt < T_HISTORY_MS;
  const open = current && state.open?.id && state.open.lifecycle === "open" ? state.open : undefined;
  const turn = bookkeeping.turnStartedAt ?? "-";
  let found;
  if (!open) {
    found = { key: `none:${turn}`, context: noCardText(current ? state : undefined) };
  } else if (!(current && state.question && !state.question.answered)) {
    const rounds = open.plan?.rounds;
    const last = rounds?.[rounds.length - 1];
    if (last?.state === "closed") {
      found = { key: `round:${open.id}:${last.n}:${turn}`,
        context: `Relo: round ${last.n} of "${cut(open.goal, 60)}" was delivered and you are editing for a new request. First: relo work start --round "<the request in a few words>" --plan "…" (another goal: relo work start --new --goal "…").` };
    } else if (!open.waiting && now - writtenAt >= LAG_MS) {
      const steps = (open.plan?.steps ?? []).filter((step) => (step.round ?? 1) === (last?.n ?? 1) && step.state !== "skipped");
      const step = steps.find((candidate) => candidate.state === "current");
      const where = step ? `still shows "${cut(step.label ?? step.id, 50)}" (step ${steps.indexOf(step) + 1} of ${steps.length})` : "has not changed";
      const minutes = Math.floor((now - writtenAt) / 60_000);
      found = { key: `lag:${open.id}:${state.writtenAt}`,
        context: `Relo: the card ${where}, updated ${minutes} min ago. If that step is done: relo work update --next-step --status "<what you do now>"; further along: --step "<the step you are on>". Still on it: carry on.` };
    }
  }
  if (!found || bookkeeping.guardKey === found.key) return undefined;
  return found;
}
