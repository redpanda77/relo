import { createHash, randomBytes } from "node:crypto";
import { LOGIN_SCOPES } from "@relo/notification-contracts";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createAccountAuth } from "../account-auth.js";
import { createApp } from "../app.js";
import { resetAuthAttempts } from "../auth-throttle.js";
import { redeemInvite } from "../computer-invites.js";
import { createAuthDatabase, createDatabase, type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { LOCAL_OWNER_EMAIL } from "./layout.js";
import { ensureLocalOwner, localInvite } from "./owner.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const appUrl = "http://127.0.0.1:8187";
const secret = "local_owner_test_secret_abcdefghijklmnopqrstuvwxyz_0123";
const input = { handle: "owner", bootstrapToken: "local_owner_bootstrap_abcdefghijklmnopqrstuvwxyz_0123",
  password: "local-owner-password-0123", name: "Owner", appUrl, authSecret: secret };

// Local mode (plan 16): the owner exists, signed in, before the API listens, so nobody else can claim the server.
suite("local mode owner", () => {
  let db: Database, authDb: Database;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    authDb = createAuthDatabase(databaseUrl!);
    await migrate(db);
  });
  afterAll(async () => { await Promise.all([db.end(), authDb.end()]); });
  beforeEach(async () => {
    resetAuthAttempts();
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await db.query("DELETE FROM auth.users");
  });

  test("claims the bootstrapped owner once, as an approved server admin with no session", async () => {
    expect(await ensureLocalOwner(db, authDb, input)).toBe("claimed");
    expect(await ensureLocalOwner(db, authDb, input)).toBe("existing");
    const identities = await db.query<{ server_admin: boolean; approved: boolean; email: string }>(
      `SELECT i.server_admin, i.approved_at IS NOT NULL AS approved, u.email FROM account_identities i
       JOIN auth.users u ON u.id=i.subject`);
    expect(identities.rows).toEqual([{ server_admin: true, approved: true, email: LOCAL_OWNER_EMAIL }]);
    expect((await db.query("SELECT 1 FROM auth.sessions")).rowCount).toBe(0);
  });

  test("never requires end-to-end encryption, and puts an earlier install right on its next start", async () => {
    await ensureLocalOwner(db, authDb, input);
    await db.query("UPDATE owner_principals SET require_end_to_end=true");
    await ensureLocalOwner(db, authDb, input);
    expect((await db.query("SELECT require_end_to_end FROM owner_principals WHERE handle='owner'")).rows[0].require_end_to_end).toBe(false);
  });

  test("closes sign-up: nobody else on the Mac can claim the server", async () => {
    await ensureLocalOwner(db, authDb, input);
    const app = createApp(db, { accountAuth: createAccountAuth(authDb, appUrl, secret), bootstrapOwnerHandle: "owner",
      credentialDerivationSecret: secret, appUrl, apnsMode: "disabled" });
    const response = await app.request("/api/auth/sign-up/email", { method: "POST",
      headers: { "content-type": "application/json", origin: appUrl },
      body: JSON.stringify({ email: "someone@example.com", password: "someone-password-0123", name: "Someone" }) });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "registration_closed" });
  });

  test("an invite made with Relo for Mac signs the app in", async () => {
    await ensureLocalOwner(db, authDb, input);
    const invite = await localInvite(db, "owner", { level: "track", approvals: false, macApp: true }, appUrl);
    const verifier = randomBytes(32).toString("base64url");
    const redeemed = await redeemInvite(db, { code: invite.code, clientName: "This Mac", scopes: [...LOGIN_SCOPES],
      expiresInSeconds: 86_400, macAppChallenge: createHash("sha256").update(verifier).digest("base64url") });
    expect(redeemed).toMatchObject({ desktopAppSignInCode: expect.any(String) });
  });
});
