import { createHash, randomBytes } from "node:crypto";
import { resetAuthAttempts } from "./auth-throttle.js";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createAccountAuth } from "./account-auth.js";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createAuthDatabase, createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const origin = "http://127.0.0.1:8180";

suite("Browser sign-in for the iPhone", () => {
  let db: Database, authDb: Database, cookie: string;
  const secret = "test-only-better-auth-secret-0123456789abcdef";
  const app = () => createApp(db, {
    accountAuth: createAccountAuth(authDb, origin, secret), bootstrapOwnerHandle: "owner",
    credentialDerivationSecret: secret, appUrl: origin, apnsMode: "disabled",
  });

  beforeAll(async () => { db = createDatabase(databaseUrl!); authDb = createAuthDatabase(databaseUrl!); await migrate(db); });
  afterAll(async () => Promise.all([db.end(), authDb.end()]));
  beforeEach(async () => {
    resetAuthAttempts();
    await db.query("TRUNCATE account_identities, principal_api_keys, owner_principals CASCADE");
    await db.query("TRUNCATE auth.sessions, auth.accounts, auth.verifications, auth.users CASCADE");
    await bootstrapOwner(db, "owner", "bootstrap_owner_token_abcdefghijklmnopqrstuvwxyz");
    const signup = await app().request("/api/auth/sign-up/email", {
      method: "POST", headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ name: "Relo Owner", email: "owner@example.com", password: "unique-test-password" }),
    });
    expect(signup.status).toBe(200);
    cookie = signup.headers.get("set-cookie")!.split(";")[0]!;
  });

  function pkce() {
    const verifier = randomBytes(32).toString("base64url");
    return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
  }
  const state = "state_abcdefghijklmnop";
  const query = (challenge: string, extra: Record<string, string> = {}) => new URLSearchParams({
    code_challenge: challenge, code_challenge_method: "S256", redirect_uri: "relo://auth/callback", state, ...extra,
  });
  async function approve(challenge: string, decision = "approve", headers: Record<string, string> = {}) {
    const body = query(challenge); body.set("decision", decision);
    return app().request("/mobile/sign-in", {
      method: "POST", body,
      headers: { "content-type": "application/x-www-form-urlencoded", origin, cookie, ...headers },
    });
  }
  async function exchange(code: string, codeVerifier: string, installationId = "installation-one") {
    return app().request("/api/mobile/sign-in/token", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, codeVerifier, installationId }),
    });
  }
  const codeFrom = (response: Response) => new URL(response.headers.get("location")!).searchParams.get("code")!;

  test("a signed-out browser is sent to sign in and back to the approval", async () => {
    const { challenge } = pkce();
    const response = await app().request(`/mobile/sign-in?${query(challenge)}`);
    expect(response.status).toBe(302);
    const next = new URL(response.headers.get("location")!, origin).searchParams.get("next")!;
    expect(next).toBe(`/mobile/sign-in?${query(challenge)}`);
  });

  test("the approval page names the account and server and runs no script", async () => {
    const { challenge } = pkce();
    const response = await app().request(`/mobile/sign-in?${query(challenge)}`, { headers: { cookie } });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("owner@example.com");
    expect(html).toContain(origin);
    expect(html).not.toContain("<script");
    expect(response.headers.get("content-security-policy")).toContain("default-src 'none'");
    // Under no-referrer, browsers post the form with `Origin: null` and the approval is refused.
    expect(response.headers.get("referrer-policy")).toBe("same-origin");
    expect(html).not.toContain("no-referrer");
  });

  test("approving issues a one-time code that only the matching verifier redeems, once", async () => {
    const { verifier, challenge } = pkce();
    const approved = await approve(challenge);
    expect(approved.status).toBe(303);
    const location = new URL(approved.headers.get("location")!);
    expect(`${location.protocol}//${location.host}${location.pathname}`).toBe("relo://auth/callback");
    expect(location.searchParams.get("state")).toBe(state);
    const code = codeFrom(approved);

    expect((await exchange(code, pkce().verifier)).status).toBe(400);
    const redeemed = await exchange(code, verifier);
    expect(redeemed.status).toBe(200);
    const body = await redeemed.json() as any;
    expect(body.user.email).toBe("owner@example.com");
    const session = await app().request("/api/auth/get-session", { headers: { authorization: `Bearer ${body.sessionToken}` } });
    expect(session.status).toBe(200);
    expect((await exchange(code, verifier)).status).toBe(400);
  });

  test("an expired code is refused", async () => {
    const { verifier, challenge } = pkce();
    const code = codeFrom(await approve(challenge));
    await db.query("UPDATE mobile_sign_in_codes SET created_at=now()-interval '10 minutes', expires_at=now()-interval '1 minute'");
    expect((await exchange(code, verifier)).status).toBe(400);
  });

  test("cancel returns access_denied and issues nothing", async () => {
    const { challenge } = pkce();
    const denied = await approve(challenge, "deny");
    expect(denied.status).toBe(303);
    expect(new URL(denied.headers.get("location")!).searchParams.get("error")).toBe("access_denied");
    expect((await db.query("SELECT count(*)::int AS n FROM mobile_sign_in_codes")).rows[0].n).toBe(0);
  });

  test("a cross-site post, a signed-out post, or another redirect target issue nothing", async () => {
    const { challenge } = pkce();
    expect((await approve(challenge, "approve", { origin: "https://evil.example" })).status).toBe(403);
    expect((await app().request("/mobile/sign-in", {
      method: "POST", body: new URLSearchParams({ ...Object.fromEntries(query(challenge)), decision: "approve" }),
      headers: { "content-type": "application/x-www-form-urlencoded", origin },
    })).status).toBe(401);
    expect((await app().request(`/mobile/sign-in?${query(challenge, { redirect_uri: "https://evil.example/cb" })}`,
      { headers: { cookie } })).status).toBe(400);
    expect((await app().request(`/mobile/sign-in?${query(challenge, { code_challenge_method: "plain" })}`,
      { headers: { cookie } })).status).toBe(400);
    expect((await db.query("SELECT count(*)::int AS n FROM mobile_sign_in_codes")).rows[0].n).toBe(0);
  });
});
