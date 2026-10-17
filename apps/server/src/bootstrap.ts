import type { Database } from "./db.js";
import { setBootstrapLogin } from "./credentials/login.js";

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
    await setBootstrapLogin(client,owner.rows[0]!.id,token);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
