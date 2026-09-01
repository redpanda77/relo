import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import type { Database } from "./db.js";

export async function recoverOwnerPassword(
  db: Database,
  handle: string,
  password: string,
): Promise<{ sessionsRevoked: number }> {
  const validated = z.object({
    handle: z.string().trim().min(1).max(120),
    password: z.string().min(8).max(128),
  }).parse({ handle, password });
  const passwordHash = await hashPassword(validated.password);
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    const account = await client.query<{ subject: string }>(
      `SELECT i.subject FROM owner_principals p
       JOIN account_identities i ON i.principal_id=p.id AND i.provider='better-auth'
       WHERE p.handle=$1 AND p.disabled_at IS NULL`,
      [validated.handle],
    );
    if (!account.rowCount) throw new Error("Active owner account not found");
    const updated = await client.query(
      `UPDATE auth.accounts SET password=$2,updated_at=now()
       WHERE user_id=$1 AND provider_id='credential' RETURNING id`,
      [account.rows[0]!.subject,passwordHash],
    );
    if (!updated.rowCount) throw new Error("Owner password credential not found");
    const revoked = await client.query(
      "DELETE FROM auth.sessions WHERE user_id=$1",
      [account.rows[0]!.subject],
    );
    await client.query("COMMIT");
    return { sessionsRevoked: revoked.rowCount ?? 0 };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
