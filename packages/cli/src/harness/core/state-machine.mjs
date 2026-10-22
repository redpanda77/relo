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
//   - a session is not the owner's turn while its subagents run: a Stop with subagents still running
//     (background agents) keeps it working until the last one stops, then it is stopped;
//   - a background subagent that ends after the Stop wakes the parent with its result, so it is held like a
//     background job until that woken turn's Stop (never a flash of "the owner's turn" in between);
//   - any tool_end well after the Stop (REORDER_GRACE_MS) is a woken turn: working again;
//   - running subagents count as an open tool (openToolSince), so a quiet one keeps the session live on
//     the server up to T_retire; one silent for SUBAGENT_RETIRE_MS (a missed SubagentStop) is dropped;
//   - a backgrounded tool (a tool_end flagged `background`: a background shell, a monitor, a workflow) is a
//     background job: like a subagent it holds the turn's Stop as working and counts as an open tool. No
//     hook says when it finishes; it wakes the agent, so the job ends with the next turn's Stop (or after
//     SUBAGENT_RETIRE_MS);
//   - once the parent stopped or ended, an uncounted subagent's event only extends lastSeenAt;
//   - start with source "compact" keeps the phase; any other start (startup, resume, clear, fork) begins
//     a fresh turn state ("open"), with seq kept so the server still sees a monotonic sequence;
//   - tool_start opens a tool (openToolSince), tool_end closes it; a tool_end that arrives before its
//     tool_start (hooks run asynchronously) cancels that tool_start.
import { FACTS } from "../../shared/facts.generated.mjs";
export const HEARTBEAT_MS = 5 * 60_000;
// Async hooks can land out of order: a tool event processed just after the Stop that followed it must
// not reopen the turn. A main-thread tool_start more than this after the Stop is a new turn.
export const REORDER_GRACE_MS = 3_000;
// A subagent with no event for this long is gone (its SubagentStop was lost): the server's T_retire.
export const SUBAGENT_RETIRE_MS = FACTS.card.retireSeconds * 1000;
// A move of context use or cost worth a snapshot of its own.
export const CONTEXT_STEP = 5;
export const COST_STEP_USD = 0.5;
/** The context size (tokens) is sent first always, then after a move of this many tokens or this share of the last one sent. */
export const CONTEXT_TOKENS_STEP = 10_000;
export const CONTEXT_TOKENS_STEP_SHARE = 0.05;

function contextTokensMoved(state) {
  if (!Number.isInteger(state.lastSentContextTokens)) return true;
  const moved = Math.abs(state.contextTokens - state.lastSentContextTokens);
  return moved >= CONTEXT_TOKENS_STEP || moved >= state.lastSentContextTokens * CONTEXT_TOKENS_STEP_SHARE;
}
const MAX_TRACKED = 32;
const ANONYMOUS = "_";

const iso = (ms) => new Date(ms).toISOString();

function initialState(session, harness, now) {
  return {
    v: 1, session, harness,
    phase: "open", phaseSince: iso(now), lastSeenAt: iso(now),
    openTools: {}, closedTools: [], openToolSince: null, subagents: {}, endedSubagents: [], backgroundJobs: {}, stopPendingSince: null,
    seq: 0, lastSentSeq: 0, lastSentAt: null, lastSentPhase: null, lastSentOpenToolSince: null,
  };
}

function earliest(openTools, subagents, backgroundJobs) {
  const times = [...Object.values(openTools), ...[...Object.values(subagents), ...Object.values(backgroundJobs)].map((item) => item.since)]
    .filter((value) => typeof value === "string").sort();
  return times[0] ?? null;
}

const trim = (list) => list.slice(-MAX_TRACKED);

/** Pure: the next state for one canonical event at `now` (ms). Never mutates `previous`. */
export function reduce(previous, event, now) {
  // The Relo MCP server's heartbeat for a session at a permission prompt (a hook sends nothing while it waits): only a
  // waiting session takes it, and the state it leaves marks one heartbeat snapshot due. Never a phase change.
  if (event.event === "heartbeat") {
    if (!previous || previous.phase !== "waiting") return previous;
    return { ...structuredClone(previous), lastSeenAt: iso(now), heartbeat: true };
  }
  // The flag marks one snapshot only: any other event clears it.
  if (previous?.heartbeat) previous = Object.fromEntries(Object.entries(previous).filter(([key]) => key !== "heartbeat"));
  // The status line's reading (relo statusline): context use and cost of a session that is already tracked. Not
  // activity (the clock stays), and never a phase: a session the hooks did not see is not created by it.
  if (event.event === "context") {
    if (!previous || previous.phase === "ended") return previous ?? initialState(event.session, event.harness, now);
    const next = structuredClone(previous);
    if (Number.isInteger(event.contextPct)) next.contextPct = Math.min(100, Math.max(0, event.contextPct));
    if (Number.isFinite(event.costUsd) && event.costUsd >= 0) next.costUsd = Math.round(event.costUsd * 100) / 100;
    if (Number.isInteger(event.contextTokens) && event.contextTokens >= 0) next.contextTokens = event.contextTokens;
    return next;
  }
  const at = iso(now);
  const s = previous ? structuredClone(previous) : initialState(event.session, event.harness, now);
  s.lastSeenAt = at;
  // A hook's own reading of the context size (from the transcript); the status line's percent and cost stay as they were.
  if (Number.isInteger(event.contextTokens) && event.contextTokens >= 0) s.contextTokens = event.contextTokens;
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
  const clearSubagents = () => { s.subagents = {}; s.endedSubagents = []; s.backgroundJobs = {}; s.stopPendingSince = null; };
  const running = () => Object.keys(s.subagents).length + Object.keys(s.backgroundJobs).length > 0;
  // The turn ended while subagents or background jobs ran: it is the owner's turn once the last one ends.
  const settle = () => {
    if (s.stopPendingSince && !running()) { s.stopPendingSince = null; setPhase("stopped"); }
  };
  const done = () => { s.openToolSince = earliest(s.openTools, s.subagents, s.backgroundJobs); return s; };
  const toolKey = event.toolKey ?? ANONYMOUS;
  if (!s.subagents || typeof s.subagents !== "object" || Array.isArray(s.subagents)) s.subagents = {};
  if (!Array.isArray(s.endedSubagents)) s.endedSubagents = [];
  if (!s.backgroundJobs || typeof s.backgroundJobs !== "object" || Array.isArray(s.backgroundJobs)) s.backgroundJobs = {};
  for (const [key, agent] of Object.entries(s.subagents)) {
    if (!(now - Date.parse(agent?.seen) < SUBAGENT_RETIRE_MS)) delete s.subagents[key];
  }
  for (const [key, job] of Object.entries(s.backgroundJobs)) {
    if (!(now - Date.parse(job?.since) < SUBAGENT_RETIRE_MS)) delete s.backgroundJobs[key];
  }
  settle();

  // Subagent bookkeeping is the same whoever reports it: the count is the session's.
  if (event.event === "subagent_start" || event.event === "subagent_stop") {
    if (s.phase === "ended") return done();
    const key = event.agentKey ?? ANONYMOUS;
    if (event.event === "subagent_stop") {
      const counted = Boolean(s.subagents[key]);
      delete s.subagents[key];
      // Async hooks: a stop processed before its start cancels it.
      if (key !== ANONYMOUS) s.endedSubagents = trim([...s.endedSubagents.filter((k) => k !== key), key]);
      // A background subagent ending after the parent's Stop wakes the parent with its result: like a
      // background job, it holds the session working until that woken turn's Stop. One ending just after
      // the Stop is the tail of the turn (a foreground subagent's hook ran late) and holds nothing.
      if (counted && s.stopPendingSince && now - Date.parse(s.stopPendingSince) >= REORDER_GRACE_MS) {
        s.backgroundJobs[`${ANONYMOUS}agent:${key}:${now}`] = { since: at, stops: 1 };
      }
      settle();
    } else if (!s.subagents[key] && !(key !== ANONYMOUS && s.endedSubagents.includes(key))) {
      s.subagents[key] = { since: at, seen: at };
      const keys = Object.keys(s.subagents);
      if (keys.length > MAX_TRACKED) delete s.subagents[keys[0]];
      // A subagent starting after the parent's Stop (its hook ran late) keeps the session working.
      if (s.phase === "stopped") { s.stopPendingSince = s.phaseSince; setPhase("working"); }
    }
    return done();
  }

  if (event.subagent) {
    if (event.agentKey && s.subagents[event.agentKey]) s.subagents[event.agentKey].seen = at;
    // Activity of the parent: only a live turn moves. A subagent's permission prompt blocks the session.
    if (s.phase === "working" && event.event === "wait") setPhase("waiting");
    else if (s.phase === "waiting" && ["tool_start", "tool_end", "prompt"].includes(event.event)) setPhase("working");
    return done();
  }

  if (s.phase === "ended" && event.event !== "start") {
    // An end is final unless the session goes on: Claude Code can send SessionEnd and keep the session (on 19 Oct one
    // ran for hours after it, its card hidden as a finished session's). A prompt starts a turn, so it is never the late
    // tail of the last one; other activity counts once the reorder grace is over.
    const goesOn = event.event === "prompt" || (event.event !== "end" && event.event !== "compact" && now - Date.parse(s.phaseSince) >= REORDER_GRACE_MS);
    if (!goesOn) return done();
    delete s.endReason;
    resetTurn();
    clearSubagents();
    setPhase("open");
  }

  switch (event.event) {
    case "start":
      if (event.source === "compact" && previous && previous.phase !== "ended") break;
      resetTurn();
      clearSubagents();
      setPhase("open");
      break;
    case "prompt":
      s.stopPendingSince = null;
      setPhase("working");
      break;
    case "tool_start": {
      const stoppedAt = s.phase === "stopped" ? s.phaseSince : s.stopPendingSince;
      if (stoppedAt && now - Date.parse(stoppedAt) < REORDER_GRACE_MS) {
        // Most likely the tail of the turn that just stopped, processed late.
        if (toolKey !== ANONYMOUS) s.closedTools = trim([...s.closedTools, toolKey]);
        break;
      }
      // A new turn (the harness woke the agent, e.g. a subagent's result): its own Stop decides.
      s.stopPendingSince = null;
      openTool(toolKey);
      setPhase("working");
      break;
    }
    case "tool_end":
      closeTool(toolKey);
      if (event.background) {
        // A backgrounded tool returned at once and keeps running. Landing just after the Stop (async hooks),
        // it belongs to the turn that stopped: that Stop already counted, and the turn is not the owner's.
        const late = s.phase === "stopped" && now - Date.parse(s.phaseSince) < REORDER_GRACE_MS;
        const key = toolKey === ANONYMOUS ? `${ANONYMOUS}${now}` : toolKey;
        s.backgroundJobs[key] = { since: at, stops: late ? 1 : 0 };
        const keys = Object.keys(s.backgroundJobs);
        if (keys.length > MAX_TRACKED) delete s.backgroundJobs[keys[0]];
        if (late) { s.stopPendingSince = s.phaseSince; setPhase("working"); }
      }
      if (s.phase === "open" || s.phase === "waiting") setPhase("working");
      // Any tool finishing well after the Stop is a new turn (the harness woke the agent): only Bash and
      // subagents send a tool_start, so a woken turn that reads and edits shows here first.
      else if (s.phase === "stopped" && !event.background && now - Date.parse(s.phaseSince) >= REORDER_GRACE_MS) setPhase("working");
      break;
    case "wait":
      setPhase("waiting");
      break;
    case "stop":
      resetTurn();
      // A background job outlives the Stop of the turn that started it; the next turn's Stop (the agent woke
      // to its result) ends it.
      for (const [key, job] of Object.entries(s.backgroundJobs)) {
        job.stops = (Number.isInteger(job.stops) ? job.stops : 0) + 1;
        if (job.stops >= 2) delete s.backgroundJobs[key];
      }
      if (running()) {
        // Subagents or background jobs still run: not idle, not the owner's turn yet.
        s.stopPendingSince = at;
        setPhase("working");
      } else {
        s.stopPendingSince = null;
        setPhase("stopped");
      }
      break;
    case "end":
      resetTurn();
      clearSubagents();
      // How it ended, for the wire: the liveness sweep's synthetic end is "gone", the Relo MCP server's "mcp", anything else the harness's own end hook.
      s.endReason = event.reason === "gone" || event.reason === "mcp" ? event.reason : "hook";
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
 * openToolSince, a heartbeat at most every HEARTBEAT_MS while working, or the MCP server's heartbeat of a waiting session
 * (its tick: once a minute).
 */
export function snapshotDue(state, now) {
  if (!state.lastSentAt) return true;
  if (state.heartbeat === true && state.phase === "waiting") return true;
  if (state.lastSentPhase !== state.phase) return true;
  // Context use and cost ride along; they alone make a snapshot due only after a real move (send changes, not streams).
  if (Number.isInteger(state.contextPct) && !(Math.abs(state.contextPct - state.lastSentContextPct) < CONTEXT_STEP)) return true;
  if (Number.isFinite(state.costUsd) && !(Math.abs(state.costUsd - state.lastSentCostUsd) < COST_STEP_USD)) return true;
  if (Number.isInteger(state.contextTokens) && contextTokensMoved(state)) return true;
  if ((state.lastSentOpenToolSince ?? null) !== (state.openToolSince ?? null)) return true;
  return state.phase === "working" && now - Date.parse(state.lastSentAt) >= HEARTBEAT_MS;
}

/** The state after a snapshot was queued: next seq and what the server now knows. */
export function markSent(state, now) {
  const seq = (Number.isInteger(state.seq) ? state.seq : 0) + 1;
  return {
    ...state, seq, lastSentSeq: seq, lastSentAt: iso(now), lastSentPhase: state.phase, lastSentOpenToolSince: state.openToolSince ?? null,
    ...(Number.isInteger(state.contextPct) ? { lastSentContextPct: state.contextPct } : {}),
    ...(Number.isFinite(state.costUsd) ? { lastSentCostUsd: state.costUsd } : {}),
    ...(Number.isInteger(state.contextTokens) ? { lastSentContextTokens: state.contextTokens } : {}),
  };
}
