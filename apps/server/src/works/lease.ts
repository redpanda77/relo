import type { Queryable,WorkRow } from "./store.js";
import { FACTS } from "@relo/notification-contracts";

/**
 * Leases (STATE-SPEC v2 2.11): scripts and services prove liveness without fake updates. A lease is
 * evidence for derive(), never declared text: a heartbeat moves only `lease_until` and `declared_at`.
 * Agent sessions never hold one (DB CHECK `works_lease_type`; no route under `/api/session`).
 */
export const LEASE_MIN_SECONDS = FACTS.lease.minSeconds;
export const LEASE_MAX_SECONDS = FACTS.lease.maxSeconds;

export type LeaseOwner =
  | { producerType: "script"; principalId: string; credentialId: string; producerKey: string }
  | { producerType: "service"; principalId: string; serviceId: string; producerKey: string };

export type LeaseRefusal = { error: "invalid_lease" | "not_found" | "not_open" | "lease_not_for_sessions"; status: 400 | 404 | 409 | 422; message: string; next?: string };

export const LEASE_NOT_FOR_SESSIONS: LeaseRefusal = {
  error: "lease_not_for_sessions",status: 422,
  message: "Sessions show they are alive by their own updates (and hooks, when enabled).",
  next: "relo work update --status \"…\"",
};

/** `60 ≤ leaseSeconds ≤ 3600`, an integer; undefined when absent. */
export function parseLeaseSeconds(value: unknown): number | undefined | LeaseRefusal {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isInteger(value) || value < LEASE_MIN_SECONDS || value > LEASE_MAX_SECONDS) {
    return { error: "invalid_lease",status: 400,message: `leaseSeconds is a whole number from ${LEASE_MIN_SECONDS} to ${LEASE_MAX_SECONDS}.` };
  }
  return value;
}

export const isLeaseRefusal = (value: unknown): value is LeaseRefusal =>
  typeof value === "object" && value !== null && "error" in value && "status" in value;

function ownerPredicate(owner: LeaseOwner): { sql: string; values: unknown[] } {
  return owner.producerType === "script"
    ? { sql: "principal_id=$1 AND producer_type='script' AND credential_id=$2 AND producer_key=$3",values: [owner.principalId,owner.credentialId,owner.producerKey] }
    : { sql: "principal_id=$1 AND producer_type='service' AND service_id=$2 AND ($3='' OR producer_key=$3)",values: [owner.principalId,owner.serviceId,owner.producerKey] };
}

/**
 * `declareHeartbeat`: `lease_until = now() + leaseSeconds`, `declared_at = now()` on an open work of
 * this producer. Never changes text, plan, version or lifecycle. Server clock only.
 */
export async function declareHeartbeat(query: Queryable,owner: LeaseOwner,workId: string,leaseSeconds: number)
  : Promise<{ work: WorkRow; leaseUntil: string } | LeaseRefusal> {
  const { sql,values } = ownerPredicate(owner);
  const found = (await query.query<WorkRow & { lease_until: Date | null }>(`SELECT * FROM works WHERE ${sql} AND id=$4`,[...values,workId])).rows[0];
  if (!found) return { error: "not_found",status: 404,message: "Work not found for this producer." };
  if (found.lifecycle !== "open") {
    return { error: "not_open",status: 409,message: found.lifecycle === "paused" ? "This work is paused; resume it before a heartbeat." : "This work is finished." };
  }
  const updated = (await query.query<WorkRow & { lease_until: Date }>(`UPDATE works
      SET lease_until=statement_timestamp() + make_interval(secs => $5), declared_at=statement_timestamp()
    WHERE ${sql} AND id=$4 AND lifecycle='open' RETURNING *`,[...values,workId,leaseSeconds])).rows[0];
  if (!updated) return { error: "not_open",status: 409,message: "This work is no longer open." };
  return { work: updated,leaseUntil: updated.lease_until.toISOString() };
}

/** Pause and finish end the lease: a stopped producer is not alive. */
export async function clearLease(query: Queryable,workId: string): Promise<void> {
  await query.query("UPDATE works SET lease_until=NULL WHERE id=$1 AND lease_until IS NOT NULL",[workId]);
}

/**
 * The evidence derive() reads for a script or service work (`scriptEvidenceSchema` /
 * `serviceEvidenceSchema` → `bindLeaseEvidence`). Agent-session rows have no lease evidence.
 * TODO(derive/load.ts owner): `derive/load.ts` still reads a legacy card's `stale_at` as the lease;
 * switch it to `leaseEvidence(workRow)` for rows from `works`.
 */
export function leaseEvidence(row: { producer_type: WorkRow["producer_type"]; lifecycle: WorkRow["lifecycle"]; lease_until?: Date | null })
  : { producer: "script" | "service"; leaseUntil: string | null } | null {
  if (row.producer_type === "agent_session") return null;
  const live = row.lifecycle === "open" && row.lease_until ? row.lease_until.toISOString() : null;
  return { producer: row.producer_type,leaseUntil: live };
}
