import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createAccountAuth } from "./account-auth.js";
import { createApp } from "./app.js";
import { KNOWN_DEVICE_COOKIE, resetAuthAttempts } from "./auth-throttle.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createAuthDatabase, createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = "http://127.0.0.1:8180";

// docs/HARDENING.md gap 2: sign-in backs off per account, and the owner's own browser is never locked out.
suite("per-account sign-in backoff", () => {
  let db: Database, authDb: Database;
  const secret = "test-only-better-auth-secret-0123456789abcdef";
  const app = () => createApp(db, {
    accountAuth: createAccountAuth(authDb, origin, secret), bootstrapOwnerHandle: "owner",
    credentialDerivationSecret: secret, appUrl: origin, apnsMode: "disabled",
  });
  const signIn = (password: string, cookie?: string, email = "owner@example.com") => app().request("/api/auth/sign-in/email", {
    method: "POST", headers: { "content-type": "application/json", origin, ...(cookie ? { cookie } : {}) },
    body: JSON.stringify({ email, password, rememberMe: true }),
  });

  beforeAll(async () => { db = createDatabase(databaseUrl!); authDb = createAuthDatabase(databaseUrl!); await migrate(db); });
  afterAll(async () => Promise.all([db.end(), authDb.end()]));
  beforeEach(async () => {
    resetAuthAttempts();
    await db.query("TRUNCATE account_identities, principal_api_keys, owner_principals CASCADE");
    await db.query("TRUNCATE auth.sessions, auth.accounts, auth.verifications, auth.users CASCADE");
    await bootstrapOwner(db, "owner", "bootstrap_owner_token_abcdefghijklmnopqrstuvwxyz");
    expect((await app().request("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ name: "Relo Owner", email: "owner@example.com", password: "unique-test-password" }),
    })).status).toBe(200);
  });

  test("wrong passwords make the account wait; the owner's known browser still signs in", async () => {
    const first = await signIn("unique-test-password");
    expect(first.status).toBe(200);
    const known = first.headers.getSetCookie().find((cookie) => cookie.startsWith(`${KNOWN_DEVICE_COOKIE}=`))!;
    expect(known).toMatch(/HttpOnly/);
    const knownCookie = known.split(";")[0]!;

    for (let index = 0; index < 5; index++) expect((await signIn("wrong-password-guess")).status).toBe(401);
    const waiting = await signIn("unique-test-password");
    expect(waiting.status).toBe(429);
    expect(Number(waiting.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another account is unaffected, and so is the owner's browser that signed in before.
    expect((await signIn("whatever-password", undefined, "someone@example.com")).status).toBe(401);
    // A forged cookie does not skip the wait.
    expect((await signIn("unique-test-password", `${KNOWN_DEVICE_COOKIE}=${"A".repeat(43)}`)).status).toBe(429);
    expect((await signIn("unique-test-password", knownCookie)).status).toBe(200);
    expect((await signIn("x", knownCookie, "someone@example.com")).status).toBe(401);
  });
});
