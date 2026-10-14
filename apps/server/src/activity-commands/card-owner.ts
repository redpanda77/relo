import type { OwnerStateInput,OwnerStateResult,ProducerEvidence } from "@relo/notification-contracts";
import { loadOwnerStateInputs } from "../derive/load.js";
import { deriveOwnerState } from "../derive/owner-state.js";
import { publicId } from "../ids.js";

type Queryable = { query: (text: string, values?: unknown[]) => Promise<any> };
export type CardOwner = OwnerStateResult & { changed: boolean };

const iso = (value: Date | string | null | undefined): string | null =>
  value == null ? null : new Date(value).toISOString();

/**
 * The card row's own half of the owner-state input at command time: lifecycle (an end in flight is
 * already terminal), declared clock and lease. `cardOwner` completes it from the loader.
 */
export function ownerStateInputFromRow(row: any,operation: "start" | "update" | "end",now = new Date()): OwnerStateInput {
  const ended = operation === "end" || row.state !== "active";
  const presentationState = row.presentation?.state?.kind as string | undefined;
  const lifecycle = !ended ? "open"
    : row.state === "replaced" ? "dropped"
      : presentationState === "failed" ? "failed" : presentationState === "cancelled" ? "dropped" : "finished";
  const declaredAt = iso(row.declared_at ?? row.updated_at ?? row.created_at)!;
  const leaseUntil = row.lifecycle_provider ? iso(row.stale_at) : null;
  const evidence: ProducerEvidence = row.producer_type === "agent_session"
    ? { producer: "agent_session",session: null }
    : row.producer_type === "service" ? { producer: "service",leaseUntil } : { producer: "script",leaseUntil };
  return {
    now: now.toISOString(),
    work: {
      lifecycle,startedAt: iso(row.created_at)!,lastDeclaredAt: declaredAt,
      finishedAt: ended ? iso(row.ended_at) ?? now.toISOString() : null,
      waitingSince: null,seenAt: null,
    },
    question: row.resume_presentation ? { standing: "pending",askedAt: declaredAt,openedAt: null } : null,
    evidence,
  };
}

/**
 * The command-time input: the row's lifecycle and declared clock (the command in flight), completed
 * by the owner-state loader (hook evidence of the card's own session, seen/opened times, the
 * question's standing, the work's declared waiting and paused lifecycle).
 */
export async function cardOwnerInput(query: Queryable,activity: any,operation: "start" | "update" | "end",now = new Date()): Promise<OwnerStateInput> {
  const base = ownerStateInputFromRow(activity,operation,now);
  const loaded = (await loadOwnerStateInputs(query as any,activity.principal_id,[activity.id],now))[0];
  if (!loaded) return base;
  const declared = Math.max(Date.parse(base.work.lastDeclaredAt),Date.parse(loaded.input.work.lastDeclaredAt));
  return {
    ...base,
    work: {
      ...base.work,
      lifecycle: base.work.lifecycle === "open" && loaded.input.work.lifecycle === "paused" ? "paused" : base.work.lifecycle,
      lastDeclaredAt: new Date(declared).toISOString(),
      waitingSince: base.work.lifecycle === "open" ? loaded.input.work.waitingSince : null,
      seenAt: loaded.input.work.seenAt,
    },
    question: loaded.input.question ?? base.question,
    evidence: loaded.input.evidence.producer === "agent_session" ? loaded.input.evidence : base.evidence,
  };
}

/** Owner state for a card command, `changed` when it differs from the last pushed one. */
export async function cardOwner(query: Queryable,activity: any,operation: "start" | "update" | "end"): Promise<CardOwner> {
  const owner = deriveOwnerState(await cardOwnerInput(query,activity,operation));
  const previous = operation === "start" ? null : (await query.query(
    `SELECT payload#>>'{liveActivity,owner,state}' AS state FROM notification_events
     WHERE principal_id=$1 AND payload#>>'{liveActivity,activityId}'=$2
     ORDER BY created_at DESC,id DESC LIMIT 1`,
    [activity.principal_id,publicId("act",activity.id)],
  )).rows[0]?.state as string | undefined;
  return { ...owner,changed: operation === "start" || previous !== owner.state };
}
