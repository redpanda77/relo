import { OWNER_STATE_QUIET_SECONDS,OWNER_STATE_TIMING,type OwnerStateInput,type QuietReason,type NeedsYouReason,type OwnerState } from "@relo/notification-contracts";

/**
 * Shared primitives of the derivation: the timing constants in milliseconds and the declared-write
 * rule every producer type shares ("moving": a declared write within T_fresh, or a declared
 * `--waiting` within T_retire). Nothing here knows about a producer type.
 */
export const T = Object.freeze({
  fresh: OWNER_STATE_TIMING.freshSeconds * 1000,
  quiet: OWNER_STATE_QUIET_SECONDS * 1000,
  retire: OWNER_STATE_TIMING.retireSeconds * 1000,
  done: OWNER_STATE_TIMING.doneSeconds * 1000,
  history: OWNER_STATE_TIMING.historySeconds * 1000,
  /** A stopped turn is the owner's turn this long, on the card and in Sessions; after it the session is idle (Quiet). */
  yourTurn: OWNER_STATE_TIMING.yourTurnSeconds * 1000,
});

export type DeclaredWork = OwnerStateInput["work"];

export const ms = (value: string): number => Date.parse(value);
export const iso = (value: number): string => new Date(value).toISOString();

export function declaredMoving(work: DeclaredWork,now: number): boolean {
  return now - ms(work.lastDeclaredAt) < T.fresh || declaredWaiting(work,now);
}

/** A declared `--waiting` (CI, a background job) within T_retire. */
export function declaredWaiting(work: Pick<DeclaredWork,"waitingSince">,now: number): boolean {
  return work.waitingSince !== null && now - ms(work.waitingSince) < T.retire;
}

/**
 * What a producer type's evidence contributes to derive(), bound to one work. Each type builds it
 * in its own module from its own typed evidence; the core never looks inside the evidence.
 */
export interface BoundEvidence {
  /** The evidence clock: max(last declared write, the type's own newer evidence). */
  readonly clock: { at: number; source: "declared" | "observed" };
  /** Needs-you reasons only this type can observe (a permission prompt); null when none. */
  attention(now: number): NeedsYouReason | null;
  /** The type's open-work states (waiting on you, moving, working quietly, stopped responding); null falls to the time bands. */
  liveness(now: number): OwnerState | null;
  /** When the owner's turn began (the anchor of "your turn" on the Lock Screen) while it holds at `now`; null otherwise. */
  turnStoppedAt(now: number): number | null;
  /** The session ended (presence); false for types that observe no session. */
  readonly sessionEnded: boolean;
  /** Why and since when an open work that fell to Quiet is quiet: only this type knows (presence vs. no update). */
  quietCause(now: number): { reason: QuietReason; since: number };
  /** The type's own extension of staleDate beyond clock + T_fresh (a lease); null when none. */
  readonly freshUntil: number | null;
  /** Instants after which this type's rules may change their answer. */
  instants(now: number): number[];
}
