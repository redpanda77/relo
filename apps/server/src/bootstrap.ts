import type { Database } from "./db.js";
import { hashToken } from "./auth.js";

export async function bootstrapOwner(db: Database, handle: string, token: string | undefined): Promise<void> {
  if (!token) return;
  if (token.length < 32) throw new Error("Bootstrap owner token must contain at least 32 characters");
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const owner = await client.query<{ id: string }>(
      `INSERT INTO owner_principals(handle) VALUES ($1)
       ON CONFLICT (handle) DO UPDATE SET handle = EXCLUDED.handle
       RETURNING id`,
      [handle],
    );
    const digest = hashToken(token);
    await client.query(
      `UPDATE principal_api_keys SET revoked_at=now()
       WHERE principal_id=$1 AND label='bootstrap-owner' AND token_hash<>$2 AND revoked_at IS NULL`,
      [owner.rows[0]!.id, digest],
    );
    await client.query(
      `INSERT INTO principal_api_keys(principal_id, label, token_hash)
       VALUES ($1, 'bootstrap-owner', $2)
       ON CONFLICT (token_hash) DO UPDATE SET revoked_at=NULL`,
      [owner.rows[0]!.id, digest],
    );
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
