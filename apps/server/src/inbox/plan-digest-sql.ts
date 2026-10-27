import { PLAN_ROUNDS_WITH_STEPS } from "@relo/notification-contracts";

/** Rounds a card event lists, newest kept: the current round must never be the one dropped. */
export const PLAN_DIGEST_ROUNDS_MAX = 60;

/**
 * SQL conditions that keep a card event small however many rounds a work has run: steps only for the newest
 * PLAN_ROUNDS_WITH_STEPS rounds (steps without a round always), and the newest PLAN_DIGEST_ROUNDS_MAX rounds.
 * The CLI's sealed card applies the same rule. `step` is a jsonb step alias, `position` the ordinality alias.
 */
export function planStepKeptSql(step: string,plan = "work.plan"): string {
  // jsonb_typeof of a missing key is NULL, and NULL<>'number' is not true: COALESCE keeps roundless steps.
  return `(COALESCE(jsonb_typeof(${step}->'round'),'none')<>'number' OR (${step}->>'round')::numeric >= COALESCE((SELECT max((newest.round->>'n')::numeric)
    FROM jsonb_array_elements(CASE WHEN jsonb_typeof(${plan}->'rounds')='array' THEN ${plan}->'rounds' ELSE '[]'::jsonb END) newest(round)
    WHERE jsonb_typeof(newest.round->'n')='number'),0)-${PLAN_ROUNDS_WITH_STEPS - 1})`;
}

export function planRoundKeptSql(position: string,plan = "work.plan"): string {
  return `${position}>jsonb_array_length(${plan}->'rounds')-${PLAN_DIGEST_ROUNDS_MAX}`;
}
