import type { Database } from "./db.js";
import { publicId } from "./ids.js";

export const deliveryReconciliationActions = ["mark_accepted","retry","cancel"] as const;
export type DeliveryReconciliationAction = typeof deliveryReconciliationActions[number];

export class DeliveryReconciliationError extends Error {
  constructor(public readonly code: string,public readonly status: 400 | 404 | 409) {
    super(code);
  }
}

type ReconciliationActor =
  | { kind: "credential"; credentialId: string }
  | { kind: "dashboard" };

export function allowedDeliveryReconciliationActions(row: {
  state?: string | null;
  last_error_code?: string | null;
  provider_message_id?: string | null;
  transport?: string | null;
  payload?: unknown;
}): DeliveryReconciliationAction[] {
  if (row.state !== "reconciliation_required") return [];
  const actions: DeliveryReconciliationAction[] = [];
  if (row.last_error_code === "known_apns_acceptance_persistence_failed"
    && typeof row.provider_message_id === "string" && row.provider_message_id.length > 0) {
    actions.push("mark_accepted");
  }
  const payload = row.payload && typeof row.payload === "object" && !Array.isArray(row.payload)
    ? row.payload as Record<string,unknown> : null;
  const liveActivity = payload?.liveActivity && typeof payload.liveActivity === "object"
    && !Array.isArray(payload.liveActivity)
    ? payload.liveActivity as Record<string,unknown> : null;
  if (row.transport === "live_activity_update"
    && ["update","end"].includes(String(liveActivity?.operation))) {
    actions.push("retry");
  }
  actions.push("cancel");
  return actions;
}

export async function reconcileDeliveryJob(
  db: Database,
  input: {
    principalId: string;
    deliveryJobId: string;
    action: DeliveryReconciliationAction;
    actor: ReconciliationActor;
  },
) {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<any>(
      `SELECT j.*,e.principal_id,e.requester_credential_id,e.payload,
         r.action AS reconciliation_action,r.resulting_state AS reconciliation_resulting_state
       FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
       LEFT JOIN delivery_reconciliation_resolutions r ON r.delivery_job_id=j.id
       WHERE j.id=$1 AND e.principal_id=$2 FOR UPDATE OF j`,
      [input.deliveryJobId,input.principalId],
    );
    if (!result.rowCount) throw new DeliveryReconciliationError("delivery_not_found",404);
    const row = result.rows[0]!;
    if (input.actor.kind === "credential" && row.requester_credential_id !== input.actor.credentialId) {
      throw new DeliveryReconciliationError("delivery_not_found",404);
    }
    if (row.reconciliation_action) {
      if (row.reconciliation_action !== input.action) {
        throw new DeliveryReconciliationError("reconciliation_already_resolved",409);
      }
      await client.query("COMMIT");
      return {
        deliveryId: publicId("job",row.id),action: input.action,
        state: String(row.reconciliation_resulting_state),replayed: true,
      };
    }
    if (row.state !== "reconciliation_required") {
      throw new DeliveryReconciliationError("reconciliation_not_required",409);
    }
    if (!allowedDeliveryReconciliationActions(row).includes(input.action)) {
      throw new DeliveryReconciliationError("unsafe_reconciliation_action",409);
    }
    const nextState = input.action === "mark_accepted" ? "accepted"
      : input.action === "retry" ? "retry" : "canceled";
    await client.query(
      `UPDATE delivery_jobs SET state=$2::delivery_state,
         accepted_at=CASE WHEN $2::delivery_state='accepted'
           THEN COALESCE(accepted_at,last_provider_attempt_at,updated_at,now()) ELSE accepted_at END,
         available_at=CASE WHEN $2::delivery_state='retry' THEN now() ELSE available_at END,
         last_error_code=CASE WHEN $2::delivery_state='retry'
           THEN 'operator_retry_after_reconciliation'
           WHEN $2::delivery_state='canceled'
           THEN 'operator_canceled_after_reconciliation' ELSE NULL END,
         last_error_message=CASE WHEN $2::delivery_state='retry'
           THEN 'Operator authorized a safe Live Activity replay'
           WHEN $2::delivery_state='canceled'
           THEN 'Operator canceled an ambiguous APNs delivery' ELSE NULL END,
         claim_token=NULL,claim_started_at=NULL,claim_phase=NULL,lease_expires_at=NULL,updated_at=now()
       WHERE id=$1 AND state='reconciliation_required'`,
      [input.deliveryJobId,nextState],
    );
    await client.query(
      `INSERT INTO delivery_reconciliation_resolutions(
         delivery_job_id,principal_id,actor_kind,actor_credential_id,action,previous_error_code,resulting_state
       ) VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [input.deliveryJobId,input.principalId,input.actor.kind,
        input.actor.kind === "credential" ? input.actor.credentialId : null,
        input.action,row.last_error_code ?? null,nextState],
    );
    await client.query(
      "UPDATE notification_events SET updated_at=now() WHERE id=$1",
      [row.notification_event_id],
    );
    await client.query("COMMIT");
    return { deliveryId: publicId("job",row.id),action: input.action,state: nextState,replayed: false };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
