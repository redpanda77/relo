import { createHmac } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createAccountAuth } from "./account-auth.js";
import { createApp } from "./app.js";
import { resetAuthAttempts } from "./auth-throttle.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createAuthDatabase, createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = "http://127.0.0.1:8180";

/** RFC 6238 with the authenticator defaults (SHA-1, 6 digits, 30 seconds). */
function totp(base32: string, at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32.replace(/=+$/, "").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6, "0");
}

const cookiesOf = (response: Response) => response.headers.getSetCookie().map((cookie) => cookie.split(";")[0]!).filter((cookie) => !cookie.endsWith("="));

// docs/HARDENING.md gap 1: an account can require an authenticator code after the password.
suite("two-step sign-in", () => {
  let db: Database, authDb: Database;
  const secret = "test-only-better-auth-secret-0123456789abcdef";
  const app = () => createApp(db, {
    accountAuth: createAccountAuth(authDb, origin, secret), bootstrapOwnerHandle: "owner",
    credentialDerivationSecret: secret, appUrl: origin, apnsMode: "disabled",
  });
  const post = (path: string, body: unknown, cookie?: string) => app().request(path, {
    method: "POST", headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) }, body: JSON.stringify(body),
  });
  const signIn = () => post("/api/auth/sign-in/email", { email: "owner@example.com", password: "unique-test-password", rememberMe: true });

  beforeAll(async () => { db = createDatabase(databaseUrl!); authDb = createAuthDatabase(databaseUrl!); await migrate(db); });
  afterAll(async () => Promise.all([db.end(), authDb.end()]));
  beforeEach(async () => {
    resetAuthAttempts();
    await db.query("TRUNCATE account_identities, principal_api_keys, owner_principals CASCADE");
    await db.query("TRUNCATE auth.sessions, auth.accounts, auth.verifications, auth.two_factors, auth.users CASCADE");
    await bootstrapOwner(db, "owner", "bootstrap_owner_token_abcdefghijklmnopqrstuvwxyz");
    expect((await post("/api/auth/sign-up/email", { name: "Relo Owner", email: "owner@example.com", password: "unique-test-password" })).status).toBe(200);
  });

  test("after setup, the password alone no longer signs in; a code or a backup code does", async () => {
    const session = cookiesOf(await signIn()).find((cookie) => cookie.includes("session_token"))!;
    const enabled = await post("/api/auth/two-factor/enable", { password: "unique-test-password" }, session);
    expect(enabled.status).toBe(200);
    const { totpURI, backupCodes } = await enabled.json() as { totpURI: string; backupCodes: string[] };
    const totpSecret = new URL(totpURI).searchParams.get("secret")!;
    expect(new URL(totpURI).searchParams.get("issuer")).toBe("Relo");
    // Setup finishes only when the owner proves the app works.
    expect((await authDb.query("SELECT two_factor_enabled FROM auth.users")).rows[0].two_factor_enabled).toBe(false);
    const confirmed = await post("/api/auth/two-factor/verify-totp", { code: totp(totpSecret) }, session);
    expect(confirmed.status).toBe(200);
    expect((await authDb.query("SELECT two_factor_enabled FROM auth.users")).rows[0].two_factor_enabled).toBe(true);
    // The Dashboard's Account → Security reads it from the session (renewed by the confirmation).
    const renewed = cookiesOf(confirmed).find((cookie) => cookie.includes("session_token")) ?? session;
    const current = await app().request("/api/auth/get-session", { headers: { cookie: renewed, origin } });
    expect((await current.json() as any).user.twoFactorEnabled).toBe(true);
    // Nothing secret is stored readable.
    const stored = (await authDb.query("SELECT secret,backup_codes FROM auth.two_factors")).rows[0];
    expect(stored.secret).not.toContain(totpSecret);
    expect(stored.backup_codes).not.toContain(backupCodes[0]);

    resetAuthAttempts();
    const challenged = await signIn();
    expect(challenged.status).toBe(200);
    expect(await challenged.json()).toMatchObject({ twoFactorRedirect: true });
    const challenge = cookiesOf(challenged);
    expect(challenge.some((cookie) => cookie.includes("session_token"))).toBe(false);
    const pending = challenge.join("; ");
    expect((await post("/api/auth/two-factor/verify-totp", { code: "000000" === totp(totpSecret) ? "111111" : "000000" }, pending)).status).toBe(401);
    const verified = await post("/api/auth/two-factor/verify-totp", { code: totp(totpSecret) }, pending);
    expect(verified.status).toBe(200);
    expect(cookiesOf(verified).some((cookie) => cookie.includes("session_token"))).toBe(true);
    expect(cookiesOf(verified).some((cookie) => cookie.startsWith("relo_known_device="))).toBe(true);

    resetAuthAttempts();
    const again = cookiesOf(await signIn()).join("; ");
    const backup = await post("/api/auth/two-factor/verify-backup-code", { code: backupCodes[0] }, again);
    expect(backup.status).toBe(200);
    resetAuthAttempts();
    const reused = cookiesOf(await signIn()).join("; ");
    expect((await post("/api/auth/two-factor/verify-backup-code", { code: backupCodes[0] }, reused)).status).not.toBe(200);
  });

  test("a disabled account is refused after the code too", async () => {
    const session = cookiesOf(await signIn()).find((cookie) => cookie.includes("session_token"))!;
    const { totpURI } = await (await post("/api/auth/two-factor/enable", { password: "unique-test-password" }, session)).json() as { totpURI: string };
    const totpSecret = new URL(totpURI).searchParams.get("secret")!;
    await post("/api/auth/two-factor/verify-totp", { code: totp(totpSecret) }, session);
    expect((await db.query("UPDATE account_identities SET disabled_at=now() WHERE provider='better-auth'")).rowCount).toBe(1);
    resetAuthAttempts();
    const pending = cookiesOf(await signIn()).join("; ");
    const refused = await post("/api/auth/two-factor/verify-totp", { code: totp(totpSecret, Date.now() + 30_000) }, pending);
    expect(refused.status).toBe(403);
  });
});
