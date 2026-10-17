import {
  OWNER_STATE_SURFACES,
  type NeedsYouReason,
  COMPUTER_OFFLINE_SECONDS,
  type Absence,
  type OwnerState,
  type OwnerStateInput,
  type OwnerStateResult,
  type ProducerEvidence,
} from "@relo/notification-contracts";
import { bindAgentSessionEvidence } from "./agent-session-evidence.js";
import { iso,ms,T,type BoundEvidence,type DeclaredWork } from "./clock.js";
import { bindScriptEvidence } from "./script-evidence.js";
import { bindServiceEvidence } from "./service-evidence.js";

/**
 * derive(): the one place the owner state is computed (STATE-SPEC v2, 2.3 and 6). Pure: declared
 * work fields + the work's typed producer evidence + its question + now → one owner state, with
 * every surface looked up from the fixed table in the contracts. It never writes anything, and no
 * client repeats it.
 */
export function deriveOwnerState(input: OwnerStateInput): OwnerStateResult {
  const now = ms(input.now);
  const evidence = bindEvidence(input.evidence,input.work);
  const current = evaluate(input,evidence,now);
  const surface = OWNER_STATE_SURFACES[current.state];
  const placement = placementAt(input,evidence,current.state,now);
  const waitingUntil = input.work.waitingSince === null ? -Infinity : ms(input.work.waitingSince) + T.retire;
  return {
    state: current.state,
    needsYou: current.needsYou,
    evidenceAt: iso(evidence.clock.at),
    evidenceSource: evidence.clock.source,
    staleDate: iso(Math.max(evidence.clock.at + T.fresh,evidence.freshUntil ?? -Infinity,waitingUntil)),
    lockScreen: placement.lockScreen,
    lockScreenUntil: placement.lockScreenUntil === null ? null : iso(placement.lockScreenUntil),
    now: placement.now,
    interruptionLevel: surface.interruptionLevel,
    relevance: surface.relevance,
    apnsPriority: surface.apnsPriority,
    ...quietOf(input,evidence,current.state,now),
    ...absenceOf(input,evidence,current.state,now),
    nextChangeAt: nextChange(input,evidence,now),
  };
}

/** Why and since when an open work reads as Quiet; nothing for any other state. */
function quietOf(input: OwnerStateInput,evidence: BoundEvidence,state: OwnerState,now: number): Pick<OwnerStateResult,"quietReason" | "quietSince"> {
  if (input.work.lifecycle !== "open" || (state !== "stale" && state !== "no_signal" && state !== "stopped_responding")) return {};
  const cause = evidence.quietCause(now);
  return { quietReason: cause.reason,quietSince: iso(cause.since) };
}

/**
 * The one reason an item left the screen or dimmed (workstream 6): shown only, never stored. An open work
 * that fell quiet, stopped responding or was left unfinished whose computer has been silent longer than
 * COMPUTER_OFFLINE_SECONDS (session not ended) reads "computer offline since its last-seen time"; else its quiet
 * cause; a failed work reads failed. Moving, finished, dropped and owner-waiting items need no reason.
 */
function absenceOf(input: OwnerStateInput,evidence: BoundEvidence,state: OwnerState,now: number): { absence?: Absence } {
  if (state === "failed") return { absence: { reason: "failed",since: input.work.finishedAt ?? iso(evidence.clock.at) } };
  if (input.work.lifecycle !== "open") return {};
  if (state !== "stale" && state !== "no_signal" && state !== "stopped_responding" && state !== "left_unfinished") return {};
  const seen = input.evidence.producer === "agent_session" ? input.evidence.computerLastSeenAt : undefined;
  if (seen && !evidence.sessionEnded && now - ms(seen) > COMPUTER_OFFLINE_SECONDS * 1000) {
    return { absence: { reason: "computer_offline",since: seen } };
  }
  if (state === "stopped_responding") return { absence: { reason: "stopped_responding",since: iso(evidence.clock.at) } };
  if (state === "left_unfinished") return { absence: { reason: "left_unfinished",since: iso(evidence.clock.at) } };
  const cause = evidence.quietCause(now);
  return { absence: { reason: cause.reason,since: iso(cause.since) } };
}

/** The single dispatch from a producer type to its evidence module (spec 11.1a). */
function bindEvidence(evidence: ProducerEvidence,work: DeclaredWork): BoundEvidence {
  switch (evidence.producer) {
    case "agent_session": return bindAgentSessionEvidence(evidence,work);
    case "script": return bindScriptEvidence(evidence,work);
    case "service": return bindServiceEvidence(evidence,work);
  }
}

const roundClosedAt = (work: OwnerStateInput["work"]): number | null =>
  work.lifecycle === "open" && work.roundClosedAt ? ms(work.roundClosedAt) : null;

type Evaluated = { state: OwnerState; needsYou: NeedsYouReason | null };

/** Spec 6.1 in the contracts' evaluation order; the first match wins. */
function evaluate(input: OwnerStateInput,evidence: BoundEvidence,now: number): Evaluated {
  const { work,question } = input;
  const open = work.lifecycle === "open";
  const needsYou: NeedsYouReason | null = question?.standing === "pending" ? "question"
    // A missed question needs the owner until opened or dismissed (their decision it no longer does).
    : question?.standing === "missed" && question.openedAt === null && !question.dismissedAt ? "missed_question"
      : open ? evidence.attention(now) : null;
  if (needsYou) return { state: "needs_you",needsYou };
  const state = (): OwnerState => {
    switch (work.lifecycle) {
      case "failed": return "failed";
      case "finished": return "done";
      case "dropped": return "dropped";
      case "open": case "paused": break;
    }
    // Delivered: an open work whose last round is closed is the owner's turn for T_deliveredYourTurn, then History as
    // delivered. When its session ended it is a finished item: the final card for T_done, then History.
    const closedAt = roundClosedAt(work);
    if (closedAt !== null) {
      const turn = evidence.sessionEnded ? T.done : T.deliveredYourTurn;
      return now - closedAt < turn ? "waiting_on_you" : "done";
    }
    // An open work whose session ended is treated like a finished item too: Quiet (the final card) for T_done,
    // then no signal and History only (placementAt takes it out of Now). Shown only, never written.
    if (work.lifecycle === "open" && evidence.sessionEnded) {
      return now - evidence.quietCause(now).since < T.done ? "stale" : "no_signal";
    }
    const silentFor = now - evidence.clock.at;
    if (silentFor >= T.history) return "left_unfinished";
    if (work.lifecycle === "paused") return "paused";
    const live = evidence.liveness(now);
    if (live) return live;
    // Quiet: dimmed until it has been quiet for T_retire (from when the session went idle or ended, else the last evidence).
    const quietFor = now - evidence.quietCause(now).since;
    return Math.max(silentFor,quietFor) >= T.retire ? "no_signal" : "stale";
  };
  return { state: state(),needsYou: null };
}

type Placement = Pick<OwnerStateResult,"lockScreen" | "now"> & { lockScreenUntil: number | null };

/** The table's surfaces for a state, with its windows (a final card, "your turn", Now until seen). */
function placementAt(input: OwnerStateInput,evidence: BoundEvidence,state: OwnerState,now: number): Placement {
  const surface = OWNER_STATE_SURFACES[state];
  let lockScreen = surface.lockScreen;
  let lockScreenUntil: number | null = null;
  if (surface.lockScreenSeconds !== null) {
    const from = surface.lockScreenFrom === "finished"
      ? (input.work.finishedAt === null ? null : ms(input.work.finishedAt))
      : roundClosedAt(input.work) ?? evidence.turnStoppedAt(now);
    const until = from === null ? null : from + surface.lockScreenSeconds * 1000;
    if (until === null || now >= until) lockScreen = "none";
    else lockScreenUntil = until;
  }
  let section = surface.now;
  if (section === "since_you_looked") {
    // An outcome stays in Now until the owner opens it or for T_history; "left unfinished" is
    // counted once from the moment the work was left, then lives in History.
    const from = state === "left_unfinished" ? evidence.clock.at + T.history
      : input.work.finishedAt === null ? null : ms(input.work.finishedAt);
    const seen = input.work.seenAt !== null && from !== null && ms(input.work.seenAt) >= from;
    if (from === null || seen || now >= from + T.history) section = null;
  }
  // A delivered round whose session ended is not "your turn" in Now: only the final card, then History.
  if (state === "waiting_on_you" && roundClosedAt(input.work) !== null && evidence.sessionEnded) section = null;
  // An open work whose session ended leaves Now with its final card (T_done): History only.
  if (state === "no_signal" && input.work.lifecycle === "open" && evidence.sessionEnded) section = null;
  return { lockScreen,lockScreenUntil,now: section };
}

const signature = (input: OwnerStateInput,evidence: BoundEvidence,now: number) => {
  const evaluated = evaluate(input,evidence,now);
  const placement = placementAt(input,evidence,evaluated.state,now);
  return `${evaluated.state}|${evaluated.needsYou}|${placement.lockScreen}|${placement.now}`;
};

/** The next instant the output changes by time alone (thresholds of every rule, checked in order). */
function nextChange(input: OwnerStateInput,evidence: BoundEvidence,now: number): string | null {
  const { work } = input;
  const declared = ms(work.lastDeclaredAt);
  const clock = evidence.clock.at;
  const candidates = [
    declared + T.fresh,
    clock + T.fresh,clock + T.retire,clock + T.history,clock + 2 * T.history,
    ...(work.waitingSince === null ? [] : [ms(work.waitingSince) + T.retire]),
    ...(work.finishedAt === null ? [] : [ms(work.finishedAt) + T.done,ms(work.finishedAt) + T.retire,ms(work.finishedAt) + T.history]),
    ...(roundClosedAt(work) === null ? [] : [roundClosedAt(work)! + T.fresh,roundClosedAt(work)! + T.done,roundClosedAt(work)! + T.deliveredYourTurn]),
    ...evidence.instants(now),
  ].filter((at) => at > now).sort((a,b) => a - b);
  const current = signature(input,evidence,now);
  for (const at of candidates) {
    if (signature(input,evidence,at) !== current) return iso(at);
  }
  return null;
}
