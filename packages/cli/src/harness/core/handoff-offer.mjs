// The handoff offer (plan 12 §5.1b): at session start, a handoff another session left for this project is
// offered to the agent as context. Reads the pending-handoff file of this project on this computer (local,
// no network) and nothing of any other session beyond what that file names: goal, round title and the note.
// Fail open; harness-neutral: returns { context } or undefined.
import { readPendingHandoff, sessionHash } from "../../work/handoff-store.mjs";

const MAX_CHARS = 400;
const SOURCES = ["startup", "clear", "resume"];

const cut = (text, length) => {
  const clean = String(text ?? "").replace(/\s+/gu, " ").trim().replace(/"/gu, "'");
  return clean.length > length ? `${clean.slice(0, length - 1).trimEnd()}…` : clean;
};

/** The offer text; every quoted part is cut until the whole fits MAX_CHARS. Pure. */
export function offerText(pending, { ownOpen = false } = {}) {
  const build = (goalMax, titleMax, nextMax) => {
    const round = pending.round?.n ? `round ${pending.round.n}${pending.round.title ? ` "${cut(pending.round.title, titleMax)}"` : ""}` : "";
    const parts = [`"${cut(pending.goal ?? "a work", goalMax)}"`, round, `next: "${cut(pending.next, nextMax)}"`].filter(Boolean);
    const own = ownOpen ? " This session has its own open work; taking over parks it." : "";
    return `Relo: a handoff is waiting from another session: ${parts.join(", ")}. Continue it: relo work start --from ${pending.handle}. A new goal instead: relo work start --new --goal "…".${own}`;
  };
  for (const [goal, title, next] of [[70, 40, 80], [50, 30, 60], [35, 20, 45], [25, 12, 30]]) {
    const text = build(goal, title, next);
    if (text.length <= MAX_CHARS) return text;
  }
  return build(20, 8, 20).slice(0, MAX_CHARS);
}

/** event: the canonical start event; state: this session's own file or undefined. */
export async function handoffOffer({ event, now, state, dependencies }) {
  if (!SOURCES.includes(event?.source) || event.subagent) return undefined;
  const pending = await readPendingHandoff(dependencies, event.cwd ?? dependencies.cwd, now);
  if (!pending || pending.fromSession === sessionHash(event.session)) return undefined;
  const ownOpen = Boolean(state?.open && state.open.lifecycle === "open" && state.open.id && state.open.id !== pending.workId);
  return { context: offerText(pending, { ownOpen }) };
}
