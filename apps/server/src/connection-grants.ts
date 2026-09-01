import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import type { Database } from "./db.js";

const grantLifetimeMs = 10 * 60 * 1000;
const installationIdSchema = z.string().trim().min(8).max(200);

export type ConnectionDocument = {
  type: "relo.connection";
  origin: string;
  grant: string;
  expiresAt: string;
};

export function hashConnectionGrant(value: string): string {
  return createHash("sha256").update(`relo:connection-grant:current\n${value}`).digest("hex");
}

export async function createConnectionGrant(input: {
  db: Database;
  principalId: string;
  userId: string;
  origin: string;
  now?: Date;
}): Promise<{ id: string; document: ConnectionDocument }> {
  const now = input.now ?? new Date();
  const expiresAt = new Date(now.valueOf() + grantLifetimeMs);
  const grant = `relo_pair_${randomBytes(32).toString("base64url")}`;
  const result = await input.db.query<{ id: string }>(
    `INSERT INTO connection_grants(
       principal_id,created_by_subject,grant_hash,grant_prefix,expires_at,created_at
     ) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [input.principalId,input.userId,hashConnectionGrant(grant),grant.slice(0,18),expiresAt,now],
  );
  return {
    id: result.rows[0]!.id,
    document: { type: "relo.connection", origin: input.origin, grant, expiresAt: expiresAt.toISOString() },
  };
}

export type ConsumedConnectionGrant = {
  sessionId: string;
  sessionToken: string;
  user: { id: string; name: string; email: string };
  principalId: string;
  expiresAt: Date;
  replayed: boolean;
};

export async function consumeConnectionGrant(input: {
  db: Database;
  grant: string;
  installationId: string;
  now?: Date;
}): Promise<ConsumedConnectionGrant | "invalid" | "expired" | "revoked" | "consumed"> {
  const installationId = installationIdSchema.parse(input.installationId);
  const now = input.now ?? new Date();
  const client = await input.db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      id: string; principal_id: string; expires_at: Date; consumed_at: Date | null;
      consumed_by_installation_id: string | null; revoked_at: Date | null;
      subject: string; name: string; email: string; disabled_at: Date | null;
    }>(
      `SELECT g.id,g.principal_id,g.expires_at,g.consumed_at,g.consumed_by_installation_id,
        g.revoked_at,i.subject,u.name,u.email,i.disabled_at
       FROM connection_grants g
       JOIN account_identities i ON i.principal_id=g.principal_id AND i.subject=g.created_by_subject
       JOIN auth.users u ON u.id=i.subject
       WHERE g.grant_hash=$1
       ORDER BY i.created_at ASC LIMIT 1 FOR UPDATE OF g`,
      [hashConnectionGrant(input.grant)],
    );
    if (!result.rowCount) { await client.query("ROLLBACK"); return "invalid"; }
    const row = result.rows[0]!;
    if (row.revoked_at) { await client.query("ROLLBACK"); return "revoked"; }
    if (row.disabled_at) { await client.query("ROLLBACK"); return "revoked"; }
    if (row.expires_at <= now) { await client.query("ROLLBACK"); return "expired"; }
    if (row.consumed_at && row.consumed_by_installation_id !== installationId) {
      await client.query("ROLLBACK"); return "consumed";
    }

    const replayed = Boolean(row.consumed_at);
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const sessionExpiresAt = new Date(now.valueOf() + 30 * 24 * 60 * 60 * 1000);
    await client.query(
      `INSERT INTO auth.sessions(id,expires_at,token,user_id,created_at,updated_at)
       VALUES ($1,$2,$3,$4,$5,$5)`,
      [sessionId,sessionExpiresAt,sessionToken,row.subject,now],
    );
    if (!replayed) {
      await client.query(
        `UPDATE connection_grants SET consumed_at=$2,consumed_by_installation_id=$3 WHERE id=$1`,
        [row.id,now,installationId],
      );
    }
    await client.query("COMMIT");
    return {
      sessionId,
      sessionToken,
      user: { id: row.subject, name: row.name, email: row.email },
      principalId: row.principal_id,
      expiresAt: sessionExpiresAt,
      replayed,
    };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
