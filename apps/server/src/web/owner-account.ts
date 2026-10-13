import type { AccountAuth,AccountSession } from "../account-auth.js";
import { getAccountSession } from "../account-auth.js";
import type { Database } from "../db.js";
import { publicId } from "../ids.js";

export type OwnerAccount = AccountSession & { principalId: string; accountId: string };

export async function getOwnerAccount(db: Database, accountAuth: AccountAuth, headers: Headers): Promise<OwnerAccount | null> {
  const session = await getAccountSession(accountAuth, headers);
  if (!session) return null;
  const mapped = await db.query<{ principal_id: string }>(
    `SELECT i.principal_id FROM account_identities i
     JOIN owner_principals p ON p.id=i.principal_id
     WHERE i.provider='better-auth' AND i.subject=$1 AND p.disabled_at IS NULL
       AND i.disabled_at IS NULL`,
    [session.user.id],
  );
  if (!mapped.rowCount) return null;
  const principalId = mapped.rows[0]!.principal_id;
  return { ...session, principalId, accountId: publicId("acc", principalId) };
}

