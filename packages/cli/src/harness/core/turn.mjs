// Prompt-time decision (ADR 0012 §4): when the owner's next request arrives, the session's open work as one
// short context line for the agent, with the three moves: same goal (a new round), another goal, goal done.
// Reads the CLI session file only (no network, no write); fail open. Harness-neutral: returns { context }.
import { T_HISTORY_MS } from "../../work/state-file.mjs";

const MAX_CHARS = 400;
const cut = (text, length) => {
  const clean = String(text ?? "").replace(/\s+/gu, " ").trim();
  return clean.length > length ? `${clean.slice(0, length - 1).trimEnd()}…` : clean;
};

/** The last round of an open work's plan, and whether the owner's turn is on (it is closed). */
function roundOf(work) {
  const rounds = work.plan?.rounds;
  const last = rounds?.[rounds.length - 1] ?? { n: 1, state: "open" };
  return { ...last, title: last.title ?? (last.n === 1 ? work.goal : undefined) };
}

export function turnText(work) {
  const round = roundOf(work);
  const title = round.title ? ` "${cut(round.title, 40)}"` : "";
  const head = `Relo: open work "${cut(work.goal, 70)}"; round ${round.n}${title}`;
  const NEW = 'new goal → relo work start --new --goal "…"; goal done → relo work finish --outcome "…".';
  if (round.state === "closed") return `${head} delivered. Same goal → before your first edit: relo work start --round "<the request in a few words>" --plan "…"; ${NEW}`;
  const steps = (work.plan?.steps ?? []).filter((step) => (step.round ?? 1) === round.n);
  const current = steps.find((step) => step.state === "current");
  const where = current ? `in progress: current step "${cut(current.label ?? current.id, 50)}"` : "in progress";
  return `${head} ${where}. Same goal → keep updating (relo work update); ${NEW}`;
}

// How to shape a plan, said once where a card starts (the block's planning module says it at length).
export const PLAN_SHAPES = 'one sitting: 3 to 6 milestones; a large body of work: its phases, each given its steps on entry (--add "…" --under s1)';

/** No open work: the session has no card, or only a paused or parked one. */
export function noCardText(state) {
  const held = [state?.open?.lifecycle === "paused" ? state.open : undefined, ...(Array.isArray(state?.parked) ? state.parked : [])].find((work) => work?.goal);
  const start = `relo work start --goal "<the goal>" --plan "A,B,C" (${PLAN_SHAPES})`;
  if (held) return `Relo: this session's work "${cut(held.goal, 70)}" is paused. Same goal → relo work resume; another request past a couple of minutes → before your first edit: ${start}.`;
  return `Relo: this session has no card. If this request takes more than a couple of minutes, before your first edit: ${start}.`;
}

/** event: the canonical prompt event; state: the CLI session file or undefined. Returns { context } or undefined. */
export function turnContext({ event, now, state }) {
  if (event?.subagent) return undefined;
  const writtenAt = Date.parse(state?.writtenAt);
  const current = Number.isFinite(writtenAt) && now - writtenAt < T_HISTORY_MS;
  const open = current ? state.open : undefined;
  if (!open || !open.id || open.lifecycle !== "open") return { context: noCardText(current ? state : undefined) };
  const text = turnText(open);
  return { context: text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text };
}

// Efficiency nudges (plan 12 §4.6, optimize). Both are one line of context, never a decision, and fire only where the
// optimize install put their source: the status line wrapper (it writes the context reading) and the Agent|Task hook.
export const DEFAULT_HANDOFF_THRESHOLD = 60;
export const SUBAGENT_NUDGE = "Relo: name a model for this subagent: haiku for search and reading, sonnet for implementing, opus for planning and review.";

/** The owner's threshold (whole percent, 1-100) from RELO_HANDOFF_THRESHOLD; the default 60 when unset or unusable. */
export function handoffThreshold(env) {
  const value = Number(String(env?.RELO_HANDOFF_THRESHOLD ?? "").trim());
  return Number.isInteger(value) && value >= 1 && value <= 100 ? value : DEFAULT_HANDOFF_THRESHOLD;
}

/**
 * The handoff nudge for this prompt, once per round: { line, key } when the status line's reading is at or past the
 * threshold (or the window passed 200K tokens) and this round was not nudged yet; else undefined. `key` names the round
 * the request belongs to (a delivered round's next request is the next round), kept in the session's bookkeeping.
 */
export function handoffNudge({ context, threshold, state, bookkeeping }) {
  const known = Number.isInteger(context?.pct);
  if (!context || !((known && context.pct >= threshold) || context.over === true)) return undefined;
  const open = state?.open?.lifecycle === "open" && state.open.id ? state.open : undefined;
  const round = open ? roundOf(open) : undefined;
  const key = open ? `${open.id}:${round.state === "closed" ? round.n + 1 : round.n}` : "-";
  if (bookkeeping?.handoffNudgeKey === key) return undefined;
  const reading = known && context.pct >= threshold ? `Context at ${context.pct}%` : "Context is past 200K tokens";
  return { key, line: `Relo: ${reading}: deliver with \`relo work handoff --next "…"\` and continue in a fresh session.` };
}
