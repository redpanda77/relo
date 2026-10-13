import type { Database } from "../db.js";

/** Removes a test account with its cards. Like account deletion, it opts in to removing active
 * cards: test fixtures never reach a phone, so nothing is left behind on a device. */
export async function deleteFixtureOwner(db: Database, principalId: string): Promise<void> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL relo.allow_active_activity_delete = 'on'");
    await client.query("DELETE FROM owner_principals WHERE id=$1",[principalId]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
