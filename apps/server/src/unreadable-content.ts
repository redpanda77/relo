import { recordTerminalOperation } from "./activity-commands/runtime.js";
import type { ActivityRow } from "./activity-commands/types.js";
import type { ApnsMode } from "./activities.js";
import type { Database } from "./db.js";
import { terminalPresentationColumnsFromRow } from "./presentation-runtime.js";

/**
 * Content no reader can open any more (docs/END-TO-END-ENCRYPTION.md, "Retention"): when a phone's
 * identity key changes, or a phone or linked browser is removed, what was sealed only to the readers
 * that are gone is deleted. Active cards sealed only to them are ended with a real end push; their
 * events and the other unreadable notices, with their pending questions, are deleted. Anything
 * another phone or a linked browser can still open stays.
 */
export async function purgeUnreadableContent(
  db: Database,
  principalId: string,
  apnsMode: ApnsMode,
): Promise<{ cardsEnded: number; eventsPurged: number }> {
  let cardsEnded = 0;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const cards = await client.query<ActivityRow>(
      `SELECT * FROM live_activities WHERE principal_id=$1 AND state='active'
         AND jsonb_typeof(sealed->'content')='object' AND NOT sealed_envelope_readable($1,sealed->'content')
       ORDER BY created_at FOR UPDATE`,
      [principalId],
    );
    for (const current of cards.rows) {
      const stored = terminalPresentationColumnsFromRow(current,"Ended","warning");
      const row = (await client.query<ActivityRow>(
        `UPDATE live_activities SET state='ended',title=$2,status=$3,detail=$4,progress=$5,
           symbol=$6,privacy=$7,accent_color=$8,style=$9,presentation=$10,presentation_sha256=$11,
           terminal_reason='keys_replaced',terminal_actor='system',terminal_policy='unreadable_content',
           terminal_transition_at=statement_timestamp(),
           sequence=sequence+1,ended_at=statement_timestamp(),updated_at=statement_timestamp()
         WHERE id=$1 AND state='active' RETURNING *`,
        [current.id,stored.title,stored.status,stored.detail,stored.progress,stored.symbol,
          stored.privacy,stored.accentColor,stored.style,stored.presentation,stored.presentationHash],
      )).rows[0];
      if (!row) continue;
      await recordTerminalOperation(client,{ principalId,sourceName: "Relo",activity: row,state: "ended",apnsMode });
      cardsEnded += 1;
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
  const purged = await db.query<{ purged: number }>("SELECT purge_unreadable_sealed_events($1) AS purged",[principalId]);
  return { cardsEnded,eventsPurged: Number(purged.rows[0]?.purged ?? 0) };
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
  let cardsEnded = 0;
  let eventsPurged = 0;
  for (const { id } of principals.rows) {
    try {
      const result = await purgeUnreadableContent(db,id,apnsMode);
      cardsEnded += result.cardsEnded;
      eventsPurged += result.eventsPurged;
    } catch (error) {
      console.warn(JSON.stringify({ event: "unreadable_content_purge_failed",
        message: error instanceof Error ? error.message : String(error) }));
    }
  }
  return { cardsEnded,eventsPurged };
}
