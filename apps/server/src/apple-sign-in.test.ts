import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from "vitest";
import { createAccountAuth } from "./account-auth.js";
import { appleSignInMethods } from "./apple-sign-in.js";
import { createApp } from "./app.js";
import { resetAuthAttempts } from "./auth-throttle.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createAuthDatabase, createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { setRegistrationMode } from "./server-accounts.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = "http://127.0.0.1:8180";
const apple = { servicesId: "com.example.relo.web", bundleId: "com.example.relo" };

// Apple's signing key, stood in for by one made here: the server fetches it from appleid.apple.com/auth/keys.
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const kid = "test-apple-key";
const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig" };

function appleIdToken(claims: { sub: string; email: string; aud: string; nonce: string; email_verified?: string }): string {
  const now = Math.floor(Date.now() / 1000);
  const encode = (value: object) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const signingInput = `${encode({ alg: "ES256", kid })}.${encode({
    iss: "https://appleid.apple.com", iat: now, exp: now + 600, email_verified: "true", ...claims,
  })}`;
  const signature = sign("sha256", Buffer.from(signingInput), { key: privateKey, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${signature.toString("base64url")}`;
}

test("the apps see which Apple sign-ins a server offers", () => {
  expect(appleSignInMethods(undefined)).toEqual({ apple: false, appleWeb: false });
  expect(appleSignInMethods({ bundleId: "com.example.relo" })).toEqual({ apple: true, appleWeb: false });
  expect(appleSignInMethods(apple)).toEqual({ apple: true, appleWeb: true });
});

suite("Sign in with Apple", () => {
  let db: Database, authDb: Database;
  const secret = "test-only-better-auth-secret-0123456789abcdef";
  const app = () => createApp(db, {
    accountAuth: createAccountAuth(authDb, origin, secret, undefined, apple), bootstrapOwnerHandle: "owner",
    credentialDerivationSecret: secret, appUrl: origin, apnsMode: "disabled", appleSignIn: apple,
  });
  const realFetch = globalThis.fetch;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!); authDb = createAuthDatabase(databaseUrl!); await migrate(db);
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) =>
      String(input instanceof Request ? input.url : input) === "https://appleid.apple.com/auth/keys"
        ? Response.json({ keys: [jwk] })
        : realFetch(input, init));
  });
  afterAll(async () => {
    vi.restoreAllMocks();
    await db.query("TRUNCATE mobile_sign_in_pending");
    await setRegistrationMode(db, "closed");
    await Promise.all([db.end(), authDb.end()]);
  });
  beforeEach(async () => {
    resetAuthAttempts();
    await db.query("TRUNCATE mobile_sign_in_pending");
    await setRegistrationMode(db, "closed");
    await db.query("TRUNCATE account_identities, principal_api_keys, owner_principals CASCADE");
    await db.query("TRUNCATE auth.sessions, auth.accounts, auth.verifications, auth.users CASCADE");
    await bootstrapOwner(db, "owner", "bootstrap_owner_token_abcdefghijklmnopqrstuvwxyz");
    const signup = await app().request("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ name: "Relo Owner", email: "owner@example.com", password: "unique-test-password" }),
    });
    expect(signup.status).toBe(200);
  });

  async function startWeb(next = "/dashboard") {
    const response = await app().request(`/api/auth/apple/start?next=${encodeURIComponent(next)}`);
    expect(response.status).toBe(302);
    const authorize = new URL(response.headers.get("location")!);
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toMatch(/HttpOnly; Secure; SameSite=None/u);
    return { authorize, cookie: cookie.split(";")[0]!, state: authorize.searchParams.get("state")!, nonce: authorize.searchParams.get("nonce")! };
  }

  async function webCallback(started: Awaited<ReturnType<typeof startWeb>>, idToken: string, state = started.state) {
    return app().request("/api/auth/apple/callback", {
      method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", cookie: started.cookie, origin: "https://appleid.apple.com" },
      body: new URLSearchParams({ state, id_token: idToken, code: "unused", user: JSON.stringify({ name: { firstName: "Ada", lastName: "Lovelace" } }) }),
    });
  }

  function pkce() {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  }

  async function mobile(idToken: string, nonce: string, challenge = pkce().challenge) {
    return app().request("/api/mobile/sign-in/apple", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ identityToken: idToken, nonce, codeChallenge: challenge, installationId: "installation-apple-1" }),
    });
  }

  test("the web sends the browser to Apple with this attempt's state and nonce", async () => {
    const started = await startWeb();
    expect(started.authorize.origin + started.authorize.pathname).toBe("https://appleid.apple.com/auth/authorize");
    expect(started.authorize.searchParams.get("client_id")).toBe(apple.servicesId);
    expect(started.authorize.searchParams.get("redirect_uri")).toBe(`${origin}/api/auth/apple/callback`);
    expect(started.authorize.searchParams.get("response_mode")).toBe("form_post");
  });

  test("a new person with open registration gets an account of their own and lands signed in", async () => {
    await setRegistrationMode(db, "open");
    const started = await startWeb("/dashboard/inbox");
    const response = await webCallback(started, appleIdToken({ sub: "apple-ada", email: "ada@example.com", aud: apple.servicesId, nonce: started.nonce }));
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/dashboard/inbox");
    const cookies = response.headers.getSetCookie().join("\n");
    expect(cookies).toMatch(/session_token=/u);
    const account = await db.query<{ name: string; approved: boolean }>(
      `SELECT u.name,i.approved_at IS NOT NULL AS approved FROM auth.users u
       JOIN account_identities i ON i.subject=u.id WHERE u.email='ada@example.com'`);
    expect(account.rows).toEqual([{ name: "Ada Lovelace", approved: true }]);
  });

  test("a token for another attempt's nonce, or a forged state, signs nobody in", async () => {
    await setRegistrationMode(db, "open");
    const started = await startWeb();
    const wrongNonce = await webCallback(started, appleIdToken({ sub: "apple-ada", email: "ada@example.com", aud: apple.servicesId, nonce: "another-nonce-123456" }));
    expect(wrongNonce.headers.get("location")).toContain("apple=invalid_token");
    const wrongState = await webCallback(started, appleIdToken({ sub: "apple-ada", email: "ada@example.com", aud: apple.servicesId, nonce: started.nonce }), "forged-state-abcdefgh");
    expect(wrongState.headers.get("location")).toContain("apple=expired");
    expect((await db.query("SELECT 1 FROM auth.users WHERE email='ada@example.com'")).rowCount).toBe(0);
  });

  test("closed registration leaves no account behind", async () => {
    const started = await startWeb();
    const response = await webCallback(started, appleIdToken({ sub: "apple-ada", email: "ada@example.com", aud: apple.servicesId, nonce: started.nonce }));
    expect(response.headers.get("location")).toContain("apple=registration_closed");
    expect((await db.query("SELECT 1 FROM auth.users WHERE email='ada@example.com'")).rowCount).toBe(0);
  });

  test("an email that already has a password account joins it on the iPhone, whatever the registration mode", async () => {
    const owner = await db.query<{ id: string }>("SELECT id FROM auth.users WHERE email='owner@example.com'");
    const nonce = "nonce-owner-1234567890";
    const response = await mobile(appleIdToken({ sub: "apple-owner", email: "owner@example.com", aud: apple.bundleId, nonce }), nonce);
    expect(response.status).toBe(200);
    const body = await response.json() as { sessionToken: string; user: { id: string; email: string } };
    expect(body.user).toMatchObject({ id: owner.rows[0]!.id, email: "owner@example.com" });
    const accounts = await db.query<{ provider_id: string; account_id: string }>(
      "SELECT provider_id, account_id FROM auth.accounts WHERE user_id=$1 ORDER BY provider_id", [owner.rows[0]!.id]);
    expect(accounts.rows).toEqual([{ provider_id: "apple", account_id: "apple-owner" }, { provider_id: "credential", account_id: owner.rows[0]!.id }]);
    expect((await db.query("SELECT 1 FROM auth.users")).rowCount).toBe(1);
    // The password keeps working.
    const password = await app().request("/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email: "owner@example.com", password: "unique-test-password", rememberMe: true }),
    });
    expect(password.status).toBe(200);
  });

  test("an email that already has a password account joins it on the web, and the next Apple sign-in finds it", async () => {
    for (const attempt of [1, 2]) {
      const started = await startWeb("/dashboard/inbox");
      const response = await webCallback(started, appleIdToken({ sub: "apple-owner", email: "owner@example.com", aud: apple.servicesId, nonce: started.nonce }));
      expect(response.headers.get("location"), `attempt ${attempt}`).toBe("/dashboard/inbox");
      expect(response.headers.getSetCookie().join("\n")).toMatch(/session_token=/u);
    }
    expect((await db.query("SELECT 1 FROM auth.users")).rowCount).toBe(1);
    expect((await db.query("SELECT 1 FROM auth.accounts WHERE provider_id='apple'")).rowCount).toBe(1);
  });

  test("an email Apple has not verified never joins an existing account", async () => {
    await setRegistrationMode(db, "open");
    const nonce = "nonce-owner-unverified-12";
    const response = await mobile(appleIdToken({
      sub: "apple-owner", email: "owner@example.com", aud: apple.bundleId, nonce, email_verified: "false",
    }), nonce);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: "account_exists" });
    expect((await db.query("SELECT 1 FROM auth.accounts WHERE provider_id='apple'")).rowCount).toBe(0);
  });

  test("a private-relay address joins no account with another email; with closed registration it gets none", async () => {
    const nonce = "nonce-relay-1234567890ab";
    const response = await mobile(appleIdToken({
      sub: "apple-owner", email: "abc123@privaterelay.appleid.com", aud: apple.bundleId, nonce,
    }), nonce);
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: "registration_closed" });
    expect((await db.query("SELECT 1 FROM auth.accounts WHERE provider_id='apple'")).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM auth.users")).rowCount).toBe(1);
  });

  test("a new person on the iPhone with closed registration gets no account", async () => {
    const nonce = "nonce-ada-closed-1234567";
    const response = await mobile(appleIdToken({ sub: "apple-ada", email: "ada@example.com", aud: apple.bundleId, nonce }), nonce);
    expect(response.status).toBe(403);
    expect((await db.query("SELECT 1 FROM auth.users WHERE email='ada@example.com'")).rowCount).toBe(0);
  });

  test("the iPhone gets its own phone session for an approved account", async () => {
    await setRegistrationMode(db, "open");
    const nonce = "nonce-ada-1234567890ab";
    const response = await mobile(appleIdToken({ sub: "apple-ada", email: "ada@example.com", aud: apple.bundleId, nonce }), nonce);
    expect(response.status).toBe(200);
    const body = await response.json() as { sessionToken: string; user: { email: string } };
    expect(body.user.email).toBe("ada@example.com");
    const sessions = await db.query<{ token: string }>(
      "SELECT s.token FROM auth.sessions s JOIN auth.users u ON u.id=s.user_id WHERE u.email='ada@example.com'");
    // Only the phone's session: Better Auth's own is removed.
    expect(sessions.rows).toEqual([{ token: body.sessionToken }]);
  });

  test("with approval, the iPhone gets a ticket it polls until the admin decides", async () => {
    await setRegistrationMode(db, "approval");
    const { verifier, challenge } = pkce();
    const nonce = "nonce-ada-approval-1234";
    const response = await mobile(appleIdToken({ sub: "apple-ada", email: "ada@example.com", aud: apple.bundleId, nonce }), nonce, challenge);
    expect(response.status).toBe(202);
    const { pending } = await response.json() as { pending: string };
    const poll = await app().request("/api/mobile/sign-in/pending", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: pending, codeVerifier: verifier, installationId: "installation-apple-1" }),
    });
    expect(poll.status).toBe(202);
    expect((await db.query("SELECT 1 FROM auth.sessions s JOIN auth.users u ON u.id=s.user_id WHERE u.email='ada@example.com'")).rowCount).toBe(0);
  });

  test("Better Auth's own social routes are closed", async () => {
    await setRegistrationMode(db, "open");
    const nonce = "nonce-direct-1234567890";
    const response = await app().request("/api/auth/sign-in/social", {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ provider: "apple", idToken: { token: appleIdToken({ sub: "apple-x", email: "x@example.com", aud: apple.bundleId, nonce }), nonce } }),
    });
    expect(response.status).toBe(404);
  });
});
