import { OWNER_STATE_QUIET_SECONDS,OWNER_STATE_TIMING,type OwnerStateInput,type NeedsYouReason,type OwnerState } from "@relo/notification-contracts";

/**
 * Shared primitives of the derivation: the four constants in milliseconds and the declared-write
 * rule every producer type shares ("moving": a declared write within T_fresh, or a declared
 * `--waiting` within T_retire). Nothing here knows about a producer type.
 */
export const T = Object.freeze({
  fresh: OWNER_STATE_TIMING.freshSeconds * 1000,
  quiet: OWNER_STATE_QUIET_SECONDS * 1000,
  retire: OWNER_STATE_TIMING.retireSeconds * 1000,
  done: OWNER_STATE_TIMING.doneSeconds * 1000,
  history: OWNER_STATE_TIMING.historySeconds * 1000,
});

export type DeclaredWork = OwnerStateInput["work"];

export const ms = (value: string): number => Date.parse(value);
export const iso = (value: number): string => new Date(value).toISOString();

export function declaredMoving(work: DeclaredWork,now: number): boolean {
  if (now - ms(work.lastDeclaredAt) < T.fresh) return true;
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
  /** When the owner's turn began (the anchor of "your turn" on the Lock Screen); null when not observable. */
  readonly turnStoppedAt: number | null;
  /** The type's own extension of staleDate beyond clock + T_fresh (a lease); null when none. */
  readonly freshUntil: number | null;
  /** Instants after which this type's rules may change their answer. */
  instants(): number[];
}
