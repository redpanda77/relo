import { createAccountAuth } from "../account-auth.js";
import { lockAccountLifecycle } from "../account-lifecycle.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createInvite, type CreateInvite } from "../computer-invites.js";
import type { Database } from "../db.js";
import { claimBootstrappedOwner } from "../server-accounts.js";
import { LOCAL_OWNER_EMAIL } from "./layout.js";

export type LocalOwnerInput = {
  handle: string;
  bootstrapToken: string;
  password: string;
  name: string;
  appUrl: string;
  authSecret: string;
};

/**
 * Local mode's owner exists, signed in, before the API listens (plan 16): the owner, its better-auth user and its
 * approved server-admin identity. From then on sign-up is closed, as after any first account, so no other user on the
 * Mac can claim the server through loopback. Idempotent: a claimed server is left as it is.
 */
export async function ensureLocalOwner(db: Database, authDb: Database, input: LocalOwnerInput): Promise<"claimed" | "existing"> {
  await bootstrapOwner(db, input.handle, input.bootstrapToken);
  // Nothing leaves this Mac: the account never requires end-to-end encryption, on every start (an install made
  // before this rule existed is put right too).
  await db.query("UPDATE owner_principals SET require_end_to_end=false WHERE handle=$1 AND require_end_to_end IS DISTINCT FROM false",[input.handle]);
  if ((await db.query("SELECT 1 FROM account_identities LIMIT 1")).rowCount) return "existing";
  const auth = createAccountAuth(authDb, input.appUrl, input.authSecret);
  const created = await auth.api.signUpEmail({ body: { email: LOCAL_OWNER_EMAIL, password: input.password, name: input.name } });
  const subject = created.user.id;
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await lockAccountLifecycle(client);
    const claimed = !(await client.query("SELECT 1 FROM account_identities LIMIT 1")).rowCount
      && await claimBootstrappedOwner(client, input.handle, subject);
    if (!claimed) await client.query("DELETE FROM auth.users WHERE id=$1", [subject]);
    // The sign-up's own session is not a sign-in anyone made.
    await client.query("DELETE FROM auth.sessions WHERE user_id=$1", [subject]);
    await client.query("COMMIT");
    return claimed ? "claimed" : "existing";
  } catch (error) {
    await client.query("ROLLBACK");
    await db.query("DELETE FROM auth.users u WHERE u.id=$1 AND NOT EXISTS (SELECT 1 FROM account_identities i WHERE i.subject=u.id)", [subject]);
    throw error;
  } finally { client.release(); }
}

/** The name the local computer gets on its invite. */
export const localComputerName = (platform: NodeJS.Platform = process.platform) => platform === "win32" ? "This PC" : "This Mac";

/** A one-time computer invite for this computer, made with the installer's choices; the code is shown once. */
export async function localInvite(db: Database, handle: string, input: CreateInvite, appUrl: string, platform: NodeJS.Platform = process.platform) {
  const owner = await db.query<{ id: string }>("SELECT id FROM owner_principals WHERE handle=$1 AND disabled_at IS NULL", [handle]);
  if (!owner.rows[0]) throw new Error("local mode has no owner yet: start it first");
  return createInvite(db, owner.rows[0].id, { kind: "computer", name: localComputerName(platform) }, input, appUrl);
}
