import type { ApnsMode } from "./activities.js";
import type { Database } from "./db.js";

/**
 * Content no reader can open any more (docs/ENCRYPTION-PROTOCOL.md, "Retention"): when a phone's
 * identity key changes, or a phone or linked browser is removed, what was sealed only to the readers
 * that are gone is deleted: the unreadable notices, with their pending questions. An active card keeps
 * running and only loses its unreadable envelopes (ADR 0007). Anything another phone or a linked
 * browser can still open stays.
 */
export async function purgeUnreadableContent(
  db: Database,
  principalId: string,
  _apnsMode: ApnsMode,
): Promise<{ cardsUnsealed: number; eventsPurged: number }> {
  // ADR 0007: a key change never ends work. An active card whose sealed text no reader can open keeps
  // running on its placeholders ("Open Relo to read"); the holder's next write seals it again for the
  // phones' current keys. Only the unreadable envelopes are dropped.
  const unsealed = await db.query(
    `UPDATE live_activities SET sealed=NULL
     WHERE principal_id=$1 AND state='active'
       AND jsonb_typeof(sealed->'content')='object' AND NOT sealed_envelope_readable($1,sealed->'content')`,
    [principalId],
  );
  const purged = await db.query<{ purged: number }>("SELECT purge_unreadable_sealed_events($1) AS purged",[principalId]);
  return { cardsUnsealed: unsealed.rowCount ?? 0,eventsPurged: Number(purged.rows[0]?.purged ?? 0) };
}

/** The worker's sweep: every account with sealed content; one account's failure never stops the rest. */
export async function purgeAllUnreadableContent(db: Database,apnsMode: ApnsMode) {
  const principals = await db.query<{ id: string }>(
    `SELECT id FROM owner_principals principal WHERE EXISTS (
       SELECT 1 FROM notification_events event WHERE event.principal_id=principal.id
         AND (jsonb_typeof(event.payload#>'{sealed,content}')='object' OR jsonb_typeof(event.payload#>'{liveActivity,sealed}')='object'))
     OR EXISTS (SELECT 1 FROM live_activities card WHERE card.principal_id=principal.id AND card.state='active'
         AND jsonb_typeof(card.sealed->'content')='object')`,
  );
  let cardsUnsealed = 0;
  let eventsPurged = 0;
  for (const { id } of principals.rows) {
    try {
      const result = await purgeUnreadableContent(db,id,apnsMode);
      cardsUnsealed += result.cardsUnsealed;
      eventsPurged += result.eventsPurged;
    } catch (error) {
      console.warn(JSON.stringify({ event: "unreadable_content_purge_failed",
        message: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { cardsUnsealed,eventsPurged };
}
