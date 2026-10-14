// Local session state machine (EDGE.1, ADR 0008 "the CLI is the edge"). Canonical events in, one
// observed phase per session out; the server only ever receives the phase and its timestamps.
//
// Phases:
//   open     the session started and has not been prompted yet
//   working  a prompt or a tool is running
//   waiting  blocked on the owner (a permission or input prompt)
//   stopped  the turn ended: it is the owner's turn
//   ended    the session ended
//
// Rules (principle 10, subagents roll up into their session):
//   - subagents never have a phase of their own; their events are activity of the parent session;
//   - once the parent stopped or ended, a subagent event only extends lastSeenAt (never revives working);
//   - start with source "compact" keeps the phase; any other start (startup, resume, clear, fork) begins
//     a fresh turn state ("open"), with seq kept so the server still sees a monotonic sequence;
//   - tool_start opens a tool (openToolSince), tool_end closes it; a tool_end that arrives before its
//     tool_start (hooks run asynchronously) cancels that tool_start.
export const PHASES = Object.freeze(["open", "working", "waiting", "stopped", "ended"]);
export const HEARTBEAT_MS = 5 * 60_000;
// Async hooks can land out of order: a tool event processed just after the Stop that followed it must
// not reopen the turn. A main-thread tool_start more than this after the Stop is a new turn.
export const REORDER_GRACE_MS = 3_000;
const MAX_TRACKED = 32;
const ANONYMOUS = "_";

const iso = (ms) => new Date(ms).toISOString();

export function initialState(session, harness, now) {
  return {
    v: 1, session, harness,
    phase: "open", phaseSince: iso(now), lastSeenAt: iso(now),
    openTools: {}, closedTools: [], openToolSince: null, subagents: [],
    seq: 0, lastSentSeq: 0, lastSentAt: null, lastSentPhase: null, lastSentOpenToolSince: null,
  };
}

function earliest(openTools) {
  const times = Object.values(openTools).filter((value) => typeof value === "string").sort();
  return times[0] ?? null;
}

const trim = (list) => list.slice(-MAX_TRACKED);

/** Pure: the next state for one canonical event at `now` (ms). Never mutates `previous`. */
export function reduce(previous, event, now) {
  const at = iso(now);
  const s = previous ? structuredClone(previous) : initialState(event.session, event.harness, now);
  s.lastSeenAt = at;
  const setPhase = (phase) => {
    if (s.phase !== phase) { s.phase = phase; s.phaseSince = at; }
  };
  const openTool = (key) => {
    if ((key !== ANONYMOUS && s.closedTools.includes(key)) || s.openTools[key]) return;
    s.openTools[key] = at;
    const keys = Object.keys(s.openTools);
    if (keys.length > MAX_TRACKED) delete s.openTools[keys[0]];
  };
  const closeTool = (key) => {
    delete s.openTools[key];
    // Without a tool id (some harnesses) there is nothing to pair: just close the open one.
    if (key !== ANONYMOUS) s.closedTools = trim([...s.closedTools.filter((k) => k !== key), key]);
  };
  const resetTurn = () => { s.openTools = {}; s.closedTools = []; };
  const done = () => { s.openToolSince = earliest(s.openTools); return s; };
  const toolKey = event.toolKey ?? ANONYMOUS;

  // Subagent bookkeeping is the same whoever reports it: the count is the session's.
  if (event.event === "subagent_start" || event.event === "subagent_stop") {
    if (s.phase === "ended") return done();
    const key = event.agentKey ?? "_";
    s.subagents = s.subagents.filter((k) => k !== key);
    if (event.event === "subagent_start" && !["stopped", "ended"].includes(s.phase)) s.subagents = trim([...s.subagents, key]);
    return done();
  }

  if (event.subagent) {
    // Activity of the parent: only a live turn moves. A subagent's permission prompt blocks the session.
    if (s.phase === "working" && event.event === "wait") setPhase("waiting");
    else if (s.phase === "waiting" && ["tool_start", "tool_end", "prompt"].includes(event.event)) setPhase("working");
    return done();
  }

  if (s.phase === "ended" && event.event !== "start") return done();

  switch (event.event) {
    case "start":
      if (event.source === "compact" && previous) break;
      resetTurn();
      s.subagents = [];
      setPhase("open");
      break;
    case "prompt":
      setPhase("working");
      break;
    case "tool_start":
      if (s.phase === "stopped" && now - Date.parse(s.phaseSince) < REORDER_GRACE_MS) {
        // Most likely the tail of the turn that just stopped, processed late.
        if (toolKey !== ANONYMOUS) s.closedTools = trim([...s.closedTools, toolKey]);
        break;
      }
      openTool(toolKey);
      setPhase("working");
      break;
    case "tool_end":
      closeTool(toolKey);
      if (s.phase === "open" || s.phase === "waiting") setPhase("working");
      break;
    case "wait":
      setPhase("waiting");
      break;
    case "stop":
      resetTurn();
      setPhase("stopped");
      break;
    case "end":
      resetTurn();
      s.subagents = [];
      setPhase("ended");
      break;
    case "compact":
    default:
      break;
  }
  return done();
}

/**
 * True when the server should hear about this state: the first snapshot, a phase change, a change of
 * openToolSince, or a heartbeat at most every HEARTBEAT_MS while working.
 */
export function snapshotDue(state, now) {
  if (!state.lastSentAt) return true;
  if (state.lastSentPhase !== state.phase) return true;
  if ((state.lastSentOpenToolSince ?? null) !== (state.openToolSince ?? null)) return true;
  return state.phase === "working" && now - Date.parse(state.lastSentAt) >= HEARTBEAT_MS;
}

/** The state after a snapshot was queued: next seq and what the server now knows. */
export function markSent(state, now) {
  const seq = (Number.isInteger(state.seq) ? state.seq : 0) + 1;
  return { ...state, seq, lastSentSeq: seq, lastSentAt: iso(now), lastSentPhase: state.phase, lastSentOpenToolSince: state.openToolSince ?? null };
}
