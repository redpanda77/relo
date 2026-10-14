import type { AgentSessionEvidence,SessionRowDerived,SessionRowInput,OwnerState } from "@relo/notification-contracts";
import { declaredMoving,iso,ms,T,type BoundEvidence,type DeclaredWork } from "./clock.js";

/**
 * Agent sessions: declared writes plus the observed state of the work's own session key (never
 * another session's): the last phase the CLI reported, when it entered it, and when the session
 * was last seen (a phase change or a heartbeat). Without hooks only the declared writes count, so
 * the observed states (waiting on you, working quietly, stopped responding, permission prompt)
 * cannot arise. Every time rule on observed state lives here: the CLI reports, the server keeps the clock.
 */
export function bindAgentSessionEvidence(evidence: AgentSessionEvidence,work: DeclaredWork): BoundEvidence {
  const declared = ms(work.lastDeclaredAt);
  const session = evidence.session;
  if (!session) {
    return {
      clock: { at: declared,source: "declared" },
      attention: () => null,
      liveness: (now) => declaredMoving(work,now) ? "moving" : null,
      turnStoppedAt: null,
      freshUntil: null,
      instants: () => [],
    };
  }
  const { phase } = session;
  const seen = ms(session.lastSeenAt);
  const since = ms(session.phaseSince);
  const openTool = session.openToolSince === null ? null : ms(session.openToolSince);
  const liveness = (now: number): OwnerState | null => {
    // The turn stopped and the agent wrote nothing since: the owner's turn.
    if (phase === "stopped" && since >= declared && now - since < T.history) return "waiting_on_you";
    // The session ended and the work was not finished: it stopped responding after T_done (6.3).
    if (phase === "ended" && now - declared >= T.done) return "stopped_responding";
    if (declaredMoving(work,now)) return "moving";
    if (phase !== "ended" && phase !== "stopped" && seen > declared && now - seen < T.quiet) return "working_quietly";
    if (openTool !== null && now - openTool < T.retire) return "working_quietly";
    // A running turn that has not been seen for T_fresh/2 (heartbeats come at most 5 minutes apart).
    if (phase === "working" && now - seen >= T.quiet) return "stopped_responding";
    if (openTool !== null) return "stopped_responding";
    return null;
  };
  return {
    clock: seen > declared ? { at: seen,source: "observed" } : { at: declared,source: "declared" },
    attention: (now) => phase === "waiting" && since >= declared && now - since < T.history ? "permission" : null,
    liveness,
    turnStoppedAt: phase === "stopped" ? since : null,
    freshUntil: null,
    instants: () => [seen + T.quiet,seen + T.fresh,seen + T.history,since + T.history,declared + T.done,
      ...(openTool === null ? [] : [openTool + T.retire])],
  };
}

/**
 * One row of the Sessions view. With hooks: working (a running turn seen within T_fresh/2),
 * waiting (a permission or input prompt up to T_history, or a turn that stopped within T_fresh:
 * the owner's turn), ended (hidden T_done after it ended), else idle (folded after T_fresh/2,
 * hidden after T_history). Without hooks: "last seen" from the session's relo commands, hidden
 * after T_retire.
 */
export function deriveSessionRow(input: SessionRowInput): SessionRowDerived {
  const now = ms(input.now);
  const current = sessionRowAt(input,now);
  const anchors = [input.observed?.lastSeenAt,input.observed?.phaseSince,input.lastDeclaredAt ?? undefined]
    .flatMap((at) => at === undefined ? [] : [ms(at)]);
  const signature = (row: Omit<SessionRowDerived,"nextChangeAt">) => `${row.phase}|${row.waitingFor}|${row.fold}|${row.hidden}`;
  const candidates = anchors.flatMap((at) => [at + T.quiet,at + T.fresh,at + T.done,at + T.retire,at + T.history])
    .filter((at) => at > now).sort((a,b) => a - b);
  const next = candidates.find((at) => signature(sessionRowAt(input,at)) !== signature(current));
  return { ...current,nextChangeAt: next === undefined ? null : iso(next) };
}

function sessionRowAt(input: SessionRowInput,now: number): Omit<SessionRowDerived,"nextChangeAt"> {
  const observed = input.observed;
  const seen = observed ? ms(observed.lastSeenAt) : null;
  const declared = input.lastDeclaredAt ? ms(input.lastDeclaredAt) : null;
  const lastSeen = Math.max(seen ?? -Infinity,declared ?? -Infinity);
  const lastSeenAt = iso(lastSeen);
  if (!observed || seen === null) {
    return { phase: null,waitingFor: null,lastSeenAt,fold: null,hidden: now - lastSeen >= T.retire };
  }
  const inPhase = now - ms(observed.phaseSince);
  switch (observed.phase) {
    case "ended": return { phase: "ended",waitingFor: null,lastSeenAt,fold: null,hidden: inPhase >= T.done };
    case "working": if (now - seen < T.quiet) return { phase: "working",waitingFor: null,lastSeenAt,fold: null,hidden: false }; break;
    case "waiting": if (inPhase < T.history) return { phase: "waiting",waitingFor: "input",lastSeenAt,fold: null,hidden: false }; break;
    case "stopped": if (inPhase < T.fresh) return { phase: "waiting",waitingFor: "turn",lastSeenAt,fold: null,hidden: false }; break;
    case "open": break;
  }
  const idleFor = now - lastSeen;
  return { phase: "idle",waitingFor: null,lastSeenAt,fold: idleFor >= T.quiet ? "idle" : null,hidden: idleFor >= T.history };
}
