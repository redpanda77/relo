import { createHash } from "node:crypto";
import type { Database } from "../db.js";
import { publicId } from "../ids.js";
import { prepareNotificationContent, type NotificationContentCipher } from "../notification-content.js";
import { createNotification } from "../notifications/commands.js";
import { persistWithdrawal } from "../notifications/store.js";
import type { SubjectTransaction } from "../relevance/commands.js";
import type { ApnsMode } from "./schemas.js";

/** How long a question may wait for its card to appear before the owner is told by notification. */
export const QUESTION_CARD_GRACE_SECONDS = 45;

/**
 * A question lives on a Live Activity. When the phone cannot show that card (Live Activities off,
 * no start token, or iOS never created it), send one plain notification that says so. It never
 * carries answer buttons: the owner answers in Relo.
 */
export async function notifyQuestionFallback(db: Database, input: {
  principalId: string; activityId: string; apnsMode: ApnsMode;
  contentCipher?: NotificationContentCipher | null | undefined;
}): Promise<boolean> {
  const claimed = await db.query<any>(
    `UPDATE live_activities SET question_fallback_at=clock_timestamp()
     WHERE id=$1 AND principal_id=$2 AND state='active' AND resume_presentation IS NOT NULL
       AND question_fallback_at IS NULL
     RETURNING id,sequence,title,context,target_device_ids,requester_credential_id,requester_service_id`,
    [input.activityId,input.principalId],
  );
  const row = claimed.rows[0];
  if (!row) return false;
  const source = await db.query<{ source: string }>(
    `SELECT source FROM notification_events
     WHERE principal_id=$1 AND payload#>>'{liveActivity,activityId}'=$2 ORDER BY created_at,id LIMIT 1`,
    [input.principalId,publicId("act",row.id)],
  );
  const actor = row.requester_credential_id
    ? { kind: "credential" as const,principalId: input.principalId,credentialId: row.requester_credential_id }
    : row.requester_service_id
      ? { kind: "service" as const,principalId: input.principalId,serviceId: row.requester_service_id }
      : { kind: "owner" as const,principalId: input.principalId };
  const idempotencyKey = `question-fallback:${row.id}:${row.sequence}`;
  await createNotification(db,actor,{
    idempotencyKey,
    requestHash: createHash("sha256").update(idempotencyKey).digest("hex"),
    sourceName: source.rows[0]?.source ?? "Relo",
    title: row.title,
    content: prepareNotificationContent({ body: "Relo needs you. Open Relo to answer under Needs you." }),
    imageUrl: null,deepLink: null,
    payload: { ...(row.context ? { context: row.context } : {}),questionFallback: { activityId: publicId("act",row.id) } },
    deviceIds: row.target_device_ids?.length ? row.target_device_ids : null,
    originHash: null,
  },{ apnsMode: input.apnsMode,contentCipher: input.contentCipher ?? null });
  return true;
}

/** Questions whose card never appeared on the phone within the grace period. */
export async function notifyUnseenQuestionCards(db: Database, input: {
  apnsMode: ApnsMode; contentCipher?: NotificationContentCipher | null | undefined;
}): Promise<number> {
  const due = await db.query<{ id: string; principal_id: string }>(
    `SELECT a.id,a.principal_id FROM live_activities a
     WHERE a.state='active' AND a.resume_presentation IS NOT NULL AND a.question_fallback_at IS NULL
       AND a.updated_at < clock_timestamp()-($1::integer*interval '1 second')
       AND NOT EXISTS (SELECT 1 FROM live_activity_update_tokens t
         WHERE t.live_activity_id=a.id AND t.generation=a.generation)
     ORDER BY a.updated_at LIMIT 20`,
    [QUESTION_CARD_GRACE_SECONDS],
  );
  let sent = 0;
  for (const row of due.rows) {
    if (await notifyQuestionFallback(db,{ principalId: row.principal_id,activityId: row.id,...input })) sent += 1;
  }
  return sent;
}

/** Once a card's question is settled or the card ends, its fallback notification is withdrawn. */
export async function withdrawQuestionFallbacks(query: SubjectTransaction, input: {
  principalId: string; activityId: string;
}): Promise<number> {
  const events = await query.query<{ id: string; requester_credential_id: string | null; requester_service_id: string | null }>(
    `SELECT id,requester_credential_id,requester_service_id FROM notification_events
     WHERE principal_id=$1 AND payload#>>'{questionFallback,activityId}'=$2 AND withdrawn_at IS NULL FOR UPDATE`,
    [input.principalId,publicId("act",input.activityId)],
  );
  for (const event of events.rows) {
    const actor = event.requester_credential_id
      ? { kind: "credential" as const,principalId: input.principalId,credentialId: event.requester_credential_id }
      : event.requester_service_id
        ? { kind: "service" as const,principalId: input.principalId,serviceId: event.requester_service_id }
        : { kind: "owner" as const,principalId: input.principalId };
    await persistWithdrawal(query,actor,{ eventId: event.id,idempotencyKey: `question-fallback-withdrawn:${event.id}` });
  }
  return events.rows.length;
}
