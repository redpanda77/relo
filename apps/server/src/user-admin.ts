import { randomUUID } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import { z } from "zod";
import type { Database } from "./db.js";

const passwordSchema = z.string().min(8).max(128);
const emailSchema = z.string().trim().email().max(320).transform(value => value.toLowerCase());

export async function assertOwnerRole(db: Database, principalId: string, subject: string): Promise<boolean> {
  const result = await db.query(
    `SELECT 1 FROM account_identities
     WHERE principal_id=$1 AND subject=$2 AND role='owner' AND disabled_at IS NULL`,
    [principalId,subject],
  );
  return Boolean(result.rowCount);
}

export async function createAccountUser(input: {
  db: Database; principalId: string; name: string; email: string; password: string;
}): Promise<{ id: string }> {
  const value = z.object({ name: z.string().trim().min(1).max(120), email: emailSchema, password: passwordSchema }).parse(input);
  const id = randomUUID();
  const accountId = randomUUID();
  const password = await hashPassword(value.password);
  const client = await input.db.connect();
  try {
    await client.query("BEGIN");
    await client.query(`INSERT INTO auth.users(id,name,email) VALUES ($1,$2,$3)`,[id,value.name,value.email]);
    await client.query(
      `INSERT INTO auth.accounts(id,account_id,provider_id,user_id,password)
       VALUES ($1,$2,'credential',$3,$4)`,[randomUUID(),accountId,id,password],
    );
    await client.query(
      `INSERT INTO account_identities(principal_id,provider,subject,role,approved_at)
       VALUES ($1,'better-auth',$2,'member',now())`,[input.principalId,id],
    );
    await client.query("COMMIT");
    return { id };
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}

export async function resetAccountUserPassword(input: {
  db: Database; principalId: string; subject: string; password: string;
}): Promise<void> {
  const password = await hashPassword(passwordSchema.parse(input.password));
  const client = await input.db.connect();
  try {
    await client.query("BEGIN");
    const updated = await client.query(
      `UPDATE auth.accounts a SET password=$3,updated_at=now()
       FROM account_identities i
       WHERE a.user_id=i.subject AND a.provider_id='credential'
         AND i.principal_id=$1 AND i.subject=$2 RETURNING a.id`,
      [input.principalId,input.subject,password],
    );
    if (!updated.rowCount) throw new Error("user_not_found");
    await client.query("DELETE FROM auth.sessions WHERE user_id=$1",[input.subject]);
    // A reset is also the way back for someone who lost their authenticator: they set it up again.
    await client.query("DELETE FROM auth.two_factors WHERE user_id=$1",[input.subject]);
    await client.query("UPDATE auth.users SET two_factor_enabled=false WHERE id=$1",[input.subject]);
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; }
  finally { client.release(); }
}
