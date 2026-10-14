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
  const lines = [];
  if (from > 0) lines.push(`  … ${from} more done`);
  for (const s of steps.slice(from, to)) {
    const count = s.progress && Number.isFinite(s.progress.total) ? `   (${s.progress.done}/${s.progress.total})` : "";
    lines.push(`  ${MARK[s.state] ?? "[ ]"} ${s.id} ${s.label ?? ""}`.trimEnd() + count);
  }
  if (to < steps.length) lines.push(`  … ${steps.length - to} more ahead`);
  return lines;
}

export function restoreText(state, now) {
  const open = state.open && state.open.lifecycle !== "finished" ? state.open : null;
  const parked = Array.isArray(state.parked) ? state.parked : [];
  if (!open && parked.length === 0) return undefined;
  const at = Date.parse(state.writtenAt);
  const stale = Number.isFinite(at) && now - at > T_RETIRE_MS;
  const when = Number.isFinite(at) ? hhmm(at) : "unknown";
  const lines = [`Relo: this session has ${open ? "open" : "parked"} work (as of ${when}${stale ? ", possibly out of date: relo state --sync" : ""}; Relo keeps it on the owner's Lock Screen).`];
  if (open) {
    lines.push(`Work ${open.id} "${open.goal ?? ""}" (${open.lifecycle ?? "open"})`);
    lines.push(...stepLines(open.plan?.steps ?? []));
  }
  for (const p of parked.slice(0, 5)) lines.push(`Parked: ${p.id} "${p.goal ?? ""}" (${p.lifecycle ?? "paused"})`);
  if (state.question && !state.question.answered) {
    const asked = Date.parse(state.question.askedAt ?? state.question.at);
    lines.push(`Question pending: "${state.question.prompt ?? state.question.text ?? ""}"${Number.isFinite(asked) ? ` asked ${hhmm(asked)}` : ""}, no answer yet.`);
  }
  if (open) {
    const hasNext = (open.plan?.steps ?? []).some((s) => s.state !== "done" && s.state !== "skipped" && s.state !== "current");
    lines.push(`Next: ${hasNext ? "relo work update --next-step  |  " : ""}relo work finish --outcome "…"`);
  } else {
    lines.push("Next: relo work resume");
  }
  const text = lines.join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text;
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
