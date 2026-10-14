import { declaredMoving,ms,T,type BoundEvidence,type DeclaredWork } from "./clock.js";

/**
 * The lease primitive scripts and services share (spec 11.1): declared writes plus an optional
 * lease the producer renews. A live lease keeps the work moving; nothing is observed.
 */
export function bindLeaseEvidence(leaseUntil: string | null,work: DeclaredWork): BoundEvidence {
  const declared = ms(work.lastDeclaredAt);
  const lease = leaseUntil === null ? null : ms(leaseUntil);
  return {
    clock: { at: declared,source: "declared" },
    attention: () => null,
    liveness: (now) => declaredMoving(work,now) || (lease !== null && now < lease) ? "moving" : null,
    turnStoppedAt: null,
    freshUntil: lease !== null && lease > declared + T.fresh ? lease : null,
    instants: () => lease === null ? [] : [lease],
  };
}
