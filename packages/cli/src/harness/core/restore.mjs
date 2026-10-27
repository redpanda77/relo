// Start re-injection (plan 05 §3.4): after compact/resume (or startup with an existing file), the
// session's open work as context for the agent. Reads the CLI session file only; no network; fail open.
// Harness-neutral: returns { context } for the adapter to render.
import { T_RETIRE_MS } from "../../work/state-file.mjs";

const MAX_CHARS = 1_500;
const MARK = { done: "[x]", current: "[>]", skipped: "[-]" };
const hhmm = (ms) => { const d = new Date(ms); return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

function stepLines(steps) {
  const i = steps.findIndex((s) => s.state === "current");
  const center = i === -1 ? steps.length - 1 : i;
  const from = Math.max(0, center - 3);
  const to = Math.min(steps.length, center + 4);
  const byId = new Map(steps.map((s) => [s.id, s]));
  const depth = (step) => { let d = 0; for (let at = step; at?.parent && d < 4; at = byId.get(at.parent)) d += 1; return d; };
  const lines = [];
  if (from > 0) lines.push(`  … ${from} more done`);
  for (const s of steps.slice(from, to)) {
    const count = s.progress && Number.isFinite(s.progress.total) ? `   (${s.progress.done}/${s.progress.total})` : "";
    lines.push(`  ${"  ".repeat(depth(s))}${MARK[s.state] ?? "[ ]"} ${s.id} ${s.label ?? ""}`.trimEnd() + count);
  }
  if (to < steps.length) lines.push(`  … ${steps.length - to} more ahead`);
  return lines;
}

const clip = (text, length) => (String(text).length > length ? `${String(text).slice(0, length - 1).trimEnd()}…` : String(text));

/** One line per closed round: its number, title (round 1 is titled by the goal) and what it delivered; the last `max`. */
function roundLines(work, max) {
  const closed = (work.plan?.rounds ?? []).filter((round) => round.state === "closed");
  const lines = closed.slice(-max).slice(0, max).map((round) => {
    const title = round.title ?? (round.n === 1 ? work.goal : undefined);
    return `  Round ${round.n}${title ? ` "${clip(title, 40)}"` : ""}${round.outcome ? `: ${clip(round.outcome, 120)}` : " closed"}`;
  });
  return closed.length > max ? [`  … ${closed.length - max} earlier rounds`, ...lines] : lines;
}

/** The text with as many closed-round lines as fit the budget (the Next line is never the part that is cut). */
export function restoreText(state, now) {
  let text;
  for (const rounds of [5, 2, 1, 0]) {
    text = compose(state, now, rounds);
    if (!text || text.length <= MAX_CHARS) return text;
  }
  return `${text.slice(0, MAX_CHARS - 1)}…`;
}

function compose(state, now, maxRounds) {
  const open = state.open && state.open.lifecycle !== "finished" ? state.open : null;
  const parked = Array.isArray(state.parked) ? state.parked : [];
  if (!open && parked.length === 0) return undefined;
  const at = Date.parse(state.writtenAt);
  const stale = Number.isFinite(at) && now - at > T_RETIRE_MS;
  const when = Number.isFinite(at) ? hhmm(at) : "unknown";
  const lines = [`Relo: this session has ${open ? "open" : "parked"} work (as of ${when}${stale ? ", possibly out of date: relo state --sync" : ""}; Relo keeps it on the owner's screen).`];
  const rounds = open?.plan?.rounds;
  const delivered = rounds?.[rounds.length - 1]?.state === "closed";
  if (open) {
    lines.push(`Work ${open.id} "${open.goal ?? ""}" (${open.lifecycle ?? "open"}${delivered ? `, round ${rounds.length} delivered` : ""})`);
    if (maxRounds > 0) lines.push(...roundLines(open, maxRounds));
    const last = rounds?.[rounds.length - 1];
    if (!delivered) lines.push(...stepLines(last ? (open.plan.steps ?? []).filter((s) => (s.round ?? 1) === last.n) : open.plan?.steps ?? []));
  }
  for (const p of parked.slice(0, 5)) lines.push(`Parked: ${p.id} "${p.goal ?? ""}" (${p.lifecycle ?? "paused"})`);
  if (state.question && !state.question.answered) {
    const asked = Date.parse(state.question.askedAt ?? state.question.at);
    lines.push(`Question pending: "${state.question.prompt ?? state.question.text ?? ""}"${Number.isFinite(asked) ? ` asked ${hhmm(asked)}` : ""}, no answer yet.`);
  }
  if (open && delivered) {
    lines.push('Next: a follow-up on this goal: relo work start --round "<the request in a few words>" --plan "…"  |  goal done: relo work finish --outcome "…"');
  } else if (open) {
    const paused = open.lifecycle === "paused";
    const hasNext = !paused && (open.plan?.steps ?? []).some((s) => s.state !== "done" && s.state !== "skipped" && s.state !== "current");
    lines.push(`Next: ${paused ? "relo work resume  |  " : ""}${hasNext ? "relo work update --next-step  |  " : ""}relo work finish --outcome "…"  (deliver instead when this request is done and more of the goal is to come)`);
  } else {
    lines.push("Next: relo work resume");
  }
  return lines.join("\n");
}

/** event: the canonical start event; state: CLI session file or undefined. Returns { context } or undefined. */
export function restore({ event, now, state }) {
  if (!["compact", "resume", "startup"].includes(event?.source)) return undefined;
  if (event?.subagent) return undefined;
  if (!state) return undefined;
  const text = restoreText(state, now);
  if (!text) return undefined;
  return { context: text };
}
