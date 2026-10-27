import { workEndRequestSchema } from "@relo/notification-contracts";
import type { ApnsMode } from "../activity-commands/schemas.js";
import type { Database } from "../db.js";
import { internalId } from "../ids.js";
import { credentialCardActor,serviceCardActor,type CardActor } from "./card-actor.js";
import { projectWorkCard } from "./card-projection.js";
import { endOwnerWork } from "./session-commands.js";
import { activeCardFor,serializeWork,workInternalId,type WorkRow } from "./store.js";

export type OwnerEndResult = { status: 200; body: { work: ReturnType<typeof serializeWork> } }
  | { status: 400 | 404 | 409; body: Record<string,unknown> };

/** The card actor of the producer that holds the work: a card is ended by the credential or service that started it. */
async function holderCardActor(db: Database,work: WorkRow): Promise<CardActor | null> {
  if (work.producer_type === "service") {
    if (!work.service_id) return null;
    const service = (await db.query<{ id: string; principal_id: string; title: string; secret_hash: string; live_activity_policy: unknown }>(
      `SELECT id,principal_id,title,secret_hash,live_activity_policy FROM webhook_services
       WHERE id=$1 AND principal_id=$2 AND revoked_at IS NULL`,[work.service_id,work.principal_id])).rows[0];
    return service ? serviceCardActor(db,service) : null;
  }
  if (!work.credential_id) return null;
  return credentialCardActor(db,{ kind: "credential",principalId: work.principal_id,credentialId: work.credential_id,
    sourceName: work.source_name ?? "Relo" });
}

/**
 * The work an id names: `wrk_…`, or the `act_…` card id Now lists it by (the phone and the Dashboard end the card
 * they hold). A card of another account, or one without a work, is no work at all.
 */
async function endTarget(db: Database,principalId: string,rawId: string): Promise<string | undefined> {
  const card = internalId("act",rawId);
  if (!card) return workInternalId(rawId);
  return (await db.query<{ work_id: string | null }>(
    `SELECT work_id FROM live_activities WHERE id=$1 AND principal_id=$2`,[card,principalId])).rows[0]?.work_id ?? undefined;
}

/**
 * `POST /api/works/:workId/end` for the phone, and the Dashboard's twin: the owner ends a work that is not moving.
 * The caller has proved it is the owner of `principalId`; a foreign or unknown id is the same `not_found`. No
 * notification: the owner did it, so the card ends quietly (a delivered work has no live card left to end).
 */
export async function endWorkForOwner(db: Database,apnsMode: ApnsMode,principalId: string,rawWorkId: string,rawBody: unknown)
  : Promise<OwnerEndResult> {
  const id = await endTarget(db,principalId,rawWorkId);
  if (!id) return { status: 404,body: { error: "not_found",message: "Work not found." } };
  const parsed = workEndRequestSchema.safeParse(rawBody ?? {});
  if (!parsed.success) return { status: 400,body: { error: "invalid_request",message: "The body of End is {}." } };
  const outcome = await endOwnerWork(db,principalId,id);
  if ("error" in outcome) {
    const { status,...rest } = outcome;
    return { status: status as 404 | 409 | 400,body: rest };
  }
  const actor = await holderCardActor(db,outcome.work);
  if (actor) await projectWorkCard(db,apnsMode,actor,outcome.work);
  return { status: 200,body: { work: serializeWork(outcome.work,await activeCardFor(db,outcome.work.id),{ producerSealed: false }) } };
}
