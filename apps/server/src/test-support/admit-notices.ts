import type { Database } from "../db.js";
import { admitOrdinaryEvent } from "../relevance/ordinary-admission.js";

/** Admit raw fixture events the way createNotification does, so they carry relevance like
 * every production notification. Inserts stay in SQL for speed; admission is the real code. */
export async function admitFixtureNotices<Row extends { id: string }>(
  db: Database, principalId: string, rows: Row[],
): Promise<Row[]> {
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const events = (await tx.query<{ id: string; created_at: Date; idempotency_key: string }>(
      "SELECT id,created_at,idempotency_key FROM notification_events WHERE id=ANY($1::uuid[]) ORDER BY created_at,id",
      [rows.map((row) => row.id)],
    )).rows;
    for (const event of events) {
      await admitOrdinaryEvent(tx,{ principalId,sourceId: `account:${principalId}` },{
        kind: "notice",apnsMode: "disabled",eventId: event.id,createdAt: event.created_at,
        idempotencyKey: event.idempotency_key,intentHash: "f".repeat(64),
      });
    }
    await tx.query("COMMIT");
    return rows;
  } catch (error) {
    await tx.query("ROLLBACK");
    throw error;
  } finally {
    tx.release();
  }
}
