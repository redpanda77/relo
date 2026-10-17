import type { AgentSessionEvidence,OwnerState } from "@relo/notification-contracts";
import { declaredMoving,ms,T,type BoundEvidence,type DeclaredWork } from "./clock.js";
import { hasEnded,presence,reconcile,type ObservedSession } from "./presence.js";

/**
 * Agent sessions on the card: declared writes plus the observed state of the work's own session key
 * (never another session's). What the session is doing comes from the one presence function and the
 * one reconcile rule (derive/presence.ts), the same result the Sessions row reads (derive/sessions-view.ts):
 * this adapter only maps it to owner states. Without hooks only the declared writes count, so the observed
 * states (waiting on you, working quietly, stopped responding, permission prompt) cannot arise.
 *
 *   needs_input → needs_you (permission)      your_turn → waiting_on_you        working → moving / working_quietly
 *   silent → stopped_responding               idle → quiet (session_idle)       ended → quiet (session_ended)
 */
export function bindAgentSessionEvidence(evidence: AgentSessionEvidence,work: DeclaredWork): BoundEvidence {
  const declared = ms(work.lastDeclaredAt);
  const session = evidence.session;
  if (!session) {
    return {
      clock: { at: declared,source: "declared" },
      attention: () => null,
      liveness: (now) => declaredMoving(work,now) ? "moving" : null,
      turnStoppedAt: () => null,
      sessionEnded: false,
      quietCause: () => ({ reason: "no_update",since: declared }),
      freshUntil: null,
      instants: () => [],
    };
  }
  const observed: ObservedSession = session;
  const declaredSide = { lastDeclaredAt: declared,waitingSince: work.waitingSince === null ? null : ms(work.waitingSince) };
  const current = (now: number) => reconcile(presence(observed,now),declaredSide,now);
  const seen = ms(session.lastSeenAt);
  const since = ms(session.phaseSince);
  const ended = hasEnded(observed);
  return {
    clock: seen > declared ? { at: seen,source: "observed" } : { at: declared,source: "declared" },
    attention: (now) => current(now).kind === "needs_input" ? "permission" : null,
    liveness: (now): OwnerState | null => {
      switch (current(now).kind) {
        case "your_turn": return "waiting_on_you";
        case "working": return declaredMoving(work,now) ? "moving" : "working_quietly";
        case "silent": return "stopped_responding";
        // needs_input is attention (Needs you); an idle or ended session is Quiet.
        case "needs_input": case "idle": case "ended": return null;
      }
    },
    turnStoppedAt: (now) => {
      const turn = current(now);
      return turn.kind === "your_turn" ? turn.since : null;
    },
    sessionEnded: ended,
    quietCause: (now) => {
      const turn = current(now);
      if (turn.kind === "ended") return { reason: "session_ended",since };
      if (turn.kind === "idle" && turn.afterTurn && since >= declared) return { reason: "session_idle",since };
      return { reason: "no_update",since: Math.max(declared,seen) };
    },
    freshUntil: null,
    instants: (now) => [...current(now).changesAt,since + T.retire,seen + T.fresh,seen + T.history,since + T.history,declared + T.done,
      ...(ended ? [since + T.done] : [])],
  };
}
