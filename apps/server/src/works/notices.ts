import type { Database } from "../db.js";

type Client = any;
type Created = { kind: string; eventId?: string; delivery?: { apnsJobs: number } & Record<string,unknown> };

/**
 * A notice sent in an agent session (`Relo-Session-Key`) while the session has an open work folds
 * into that work (spec 7, 2.13): recorded with `work_id` and `folded`, every delivery job canceled
 * before commit (no buzz of its own; the finish outcome is the notification), and the work's clock
 * moves. It never changes the work's text, plan or lifecycle. Without a session or an open work the
 * notice is standalone (`create` as before). Returns the created result plus the work it folded into.
 */
export async function createNoticeMaybeFolded<T extends Created>(db: Database,input: { principalId: string; sessionKey?: string | undefined },
  create: (tx: Client) => Promise<T>): Promise<T & { foldedInto: string | null }> {
  const key = input.sessionKey?.trim();
  const tx = await db.connect();
  try {
    await tx.query("BEGIN");
    const result = await create(tx);
    let foldedInto: string | null = null;
    if (result.kind === "created" && result.eventId && key && /^[A-Za-z0-9_-]{16,128}$/.test(key)) {
      const work = (await tx.query<{ id: string }>(`UPDATE works SET declared_at=statement_timestamp(),updated_at=statement_timestamp()
        WHERE principal_id=$1 AND producer_type='agent_session' AND session_key=$2 AND lifecycle='open' RETURNING id`,
      [input.principalId,key])).rows[0];
      if (work) {
        await tx.query("DELETE FROM delivery_jobs WHERE notification_event_id=$1",[result.eventId]);
        await tx.query("UPDATE notification_events SET work_id=$2,folded=true WHERE id=$1",[result.eventId,work.id]);
        foldedInto = work.id;
        if (result.delivery) result.delivery = { ...result.delivery,apnsJobs: 0 };
      }
    }
    await tx.query(result.kind === "created" ? "COMMIT" : "ROLLBACK");
    return { ...result,foldedInto };
  } catch (error) {
    await tx.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    tx.release();
  }
}
