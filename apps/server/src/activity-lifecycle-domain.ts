import { internalId } from "./ids.js";
import { canonicalOriginHash } from "./origin-slots.js";

export type ActivityLifecycleIdentity = { provider: string; runId: string };
export type ActivityLifecycleSelector = {
  origin?: { sourceInstance: string; project: string; thread: string; channel: string } | undefined;
  lifecycle?: ActivityLifecycleIdentity | undefined;
  current?: true | undefined;
};
export type ActivityOwner = {
  principalId: string;
  credentialId: string | null;
  serviceId: string | null;
};
export type ActivityReplayResult<TDelivery> = {
  conflict: boolean;
  snapshot?: any;
  delivery?: TDelivery;
  dismissAfterSeconds?: number | null;
};
type Queryable = { query: <T = any>(text: string, values?: unknown[]) => Promise<any> };
type ReleasableQueryable = Queryable & { release: () => void };
type Connectable = { connect: () => Promise<ReleasableQueryable> };

export type ActivityTransaction = {
  client: Queryable;
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
  close: () => Promise<void>;
};

function assertOwner(owner: ActivityOwner): void {
  if (Boolean(owner.credentialId) === Boolean(owner.serviceId)) {
    throw new Error("activity owner must identify exactly one requester");
  }
}

export async function beginActivityTransaction(database: Connectable): Promise<ActivityTransaction> {
  const client = await database.connect();
  try {
    await client.query("BEGIN");
  } catch (error) {
    client.release();
    throw error;
  }
  let state: "active" | "committed" | "rolled_back" = "active";
  const settle = async (command: "COMMIT" | "ROLLBACK") => {
    if (state !== "active") return;
    await client.query(command);
    state = command === "COMMIT" ? "committed" : "rolled_back";
  };
  let released = false;
  return {
    client,
    commit: () => settle("COMMIT"),
    rollback: () => settle("ROLLBACK"),
    close: async () => {
      if (released) return;
      try {
        await settle("ROLLBACK");
      } finally {
        released = true;
        client.release();
      }
    },
  };
}

export function lifecycleMutationAllowed(
  row: { lifecycle_provider?: string | null; lifecycle_run_id?: string | null },
  lifecycle: ActivityLifecycleIdentity | undefined,
): boolean {
  const provider = row.lifecycle_provider ?? null;
  const runId = row.lifecycle_run_id ?? null;
  if (lifecycle === undefined) return true;
  if (provider === null && runId === null) return false;
  return lifecycle.provider === provider && lifecycle.runId === runId;
}

export function sameActivityTargets(current: unknown, requested: string[]): boolean {
  const currentIds = Array.isArray(current) ? current.map(String).sort() : [];
  return JSON.stringify(currentIds) === JSON.stringify([...requested].sort());
}

export async function resolveActivityReplay<TDelivery>(
  query: Queryable,
  owner: ActivityOwner,
  key: string | undefined,
  operation: "update" | "end",
  requestHash: string,
  parseDelivery: (value: unknown) => TDelivery,
): Promise<ActivityReplayResult<TDelivery> | null> {
  if (!key) return null;
  assertOwner(owner);
  const result = owner.credentialId
    ? await query.query(
      `SELECT o.operation,o.request_hash,o.delivery_summary,o.dismiss_after_seconds,o.activity_snapshot,
         o.requester_credential_id,o.requester_service_id
       FROM live_activity_operations o
       WHERE o.principal_id=$1 AND o.requester_service_id IS NULL
         AND (o.requester_credential_id=$2 OR o.requester_credential_id IS NULL)
         AND o.idempotency_key=$3
       ORDER BY (o.requester_credential_id=$2) DESC LIMIT 1`,
      [owner.principalId,owner.credentialId,key],
    )
    : await query.query(
      `SELECT o.operation,o.request_hash,o.delivery_summary,o.dismiss_after_seconds,o.activity_snapshot,
         o.requester_credential_id,o.requester_service_id
       FROM live_activity_operations o
       WHERE o.principal_id=$1 AND o.requester_credential_id IS NULL
         AND o.requester_service_id=$2 AND o.idempotency_key=$3
       LIMIT 1`,
      [owner.principalId,owner.serviceId,key],
    );
  if (!result.rowCount) return null;
  const row = result.rows[0]!;
  if (row.requester_credential_id !== owner.credentialId
    || row.requester_service_id !== owner.serviceId
    || row.operation !== operation
    || row.request_hash !== requestHash
    || !row.activity_snapshot) return { conflict: true };
  return {
    conflict: false,
    snapshot: row.activity_snapshot,
    delivery: parseDelivery(row.delivery_summary),
    dismissAfterSeconds: row.dismiss_after_seconds,
  };
}

export async function resolveActivityByIdentifier(
  query: Queryable,
  owner: ActivityOwner,
  identifier: string,
  forUpdate = false,
): Promise<any | undefined> {
  assertOwner(owner);
  const activityId = internalId("act",identifier);
  const result = activityId
    ? await query.query(
      `SELECT * FROM live_activities WHERE id=$1 AND principal_id=$2
         AND requester_credential_id IS NOT DISTINCT FROM $3::uuid
         AND requester_service_id IS NOT DISTINCT FROM $4::uuid
         AND presentation IS NOT NULL${forUpdate ? " FOR UPDATE" : ""}`,
      [activityId,owner.principalId,owner.credentialId,owner.serviceId],
    )
    : await query.query(
      `SELECT * FROM live_activities WHERE principal_id=$1 AND activity_key=$4
         AND requester_credential_id IS NOT DISTINCT FROM $2::uuid
         AND requester_service_id IS NOT DISTINCT FROM $3::uuid AND origin_hash IS NULL
         AND presentation IS NOT NULL
       ORDER BY (state='active') DESC,created_at DESC LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [owner.principalId,owner.credentialId,owner.serviceId,identifier],
    );
  return result.rows[0];
}

export async function resolveActivitySelector(
  query: Queryable,
  owner: ActivityOwner,
  selector: ActivityLifecycleSelector,
  forUpdate = false,
): Promise<{ activity?: any; ambiguous: boolean }> {
  assertOwner(owner);
  const ownerValues = [owner.principalId,owner.credentialId,owner.serviceId];
  const ownerWhere = `principal_id=$1
    AND requester_credential_id IS NOT DISTINCT FROM $2::uuid
    AND requester_service_id IS NOT DISTINCT FROM $3::uuid`;
  const presentationWhere = "presentation IS NOT NULL";
  const result = selector.origin
    ? await query.query(
      `SELECT * FROM live_activities WHERE ${ownerWhere} AND origin_hash=$4
         AND ${presentationWhere}
       ORDER BY generation DESC,created_at DESC LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
      [...ownerValues,canonicalOriginHash(owner.principalId,selector.origin)],
    )
    : selector.lifecycle
      ? await query.query(
        `SELECT * FROM live_activities WHERE ${ownerWhere}
           AND lifecycle_provider=$4 AND lifecycle_run_id=$5 AND ${presentationWhere}
         LIMIT 1${forUpdate ? " FOR UPDATE" : ""}`,
        [...ownerValues,selector.lifecycle.provider,selector.lifecycle.runId],
      )
      : await query.query(
        `SELECT * FROM live_activities WHERE ${ownerWhere} AND state='active'
           AND ${presentationWhere}
         ORDER BY updated_at DESC,id DESC LIMIT 2${forUpdate ? " FOR UPDATE" : ""}`,
        ownerValues,
      );
  return selector.current && Number(result.rowCount) > 1
    ? { ambiguous: true }
    : { activity: result.rows[0],ambiguous: false };
}
