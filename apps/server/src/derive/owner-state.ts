import {
  OWNER_STATE_SURFACES,
  type NeedsYouReason,
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
    nextChangeAt: nextChange(input,evidence,now),
  };
}

/** The single dispatch from a producer type to its evidence module (spec 11.1a). */
function bindEvidence(evidence: ProducerEvidence,work: DeclaredWork): BoundEvidence {
  switch (evidence.producer) {
    case "agent_session": return bindAgentSessionEvidence(evidence,work);
    case "script": return bindScriptEvidence(evidence,work);
    case "service": return bindServiceEvidence(evidence,work);
  }
}

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
    const silentFor = now - evidence.clock.at;
    if (silentFor >= T.history) return "left_unfinished";
    if (work.lifecycle === "paused") return "paused";
    const live = evidence.liveness(now);
    if (live) return live;
    return silentFor >= T.retire ? "no_signal" : "stale";
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
      : evidence.turnStoppedAt;
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
    ...(evidence.turnStoppedAt === null ? [] : [evidence.turnStoppedAt + T.fresh]),
    ...evidence.instants(),
  ].filter((at) => at > now).sort((a,b) => a - b);
  const current = signature(input,evidence,now);
  for (const at of candidates) {
    if (signature(input,evidence,at) !== current) return iso(at);
  }
  return null;
}
