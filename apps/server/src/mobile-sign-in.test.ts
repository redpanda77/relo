import { createHash, randomBytes } from "node:crypto";
import { resetAuthAttempts } from "./auth-throttle.js";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createAccountAuth } from "./account-auth.js";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createAuthDatabase, createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { changeAccountAccess, setRegistrationMode } from "./server-accounts.js";
import { mobileSignInHint } from "./mobile-sign-in.js";

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
  // Tickets have no key on the account, and the registration mode is server-wide: both are reset so no test (here or
  // in another file on the same database) sees another's.
  afterAll(async () => {
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

  test("the page names the app that asks: iPhone by default, the Mac, the Windows PC; another name is refused", async () => {
    const { challenge } = pkce();
    const page = async (extra: Record<string, string>) => app().request(`/mobile/sign-in?${query(challenge, extra)}`, { headers: { cookie } });
    expect(await (await page({})).text()).toContain("Relo · iPhone");
    expect(await (await page({ device: "mac" })).text()).toContain("Relo · Mac");
    const windows = await (await page({ device: "windows" })).text();
    expect(windows).toContain("Relo · Windows PC");
    expect(windows).toContain("Sign in to Relo on your Windows PC?");
    expect(windows).toContain('name="device" value="windows"');
    expect((await page({ device: "android" })).status).toBe(400);
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

  describe("an account that waits for approval", () => {
    const guest = { name: "Guest", email: "guest@example.com", password: "unique-guest-password" };
    const hint = (challenge: string, extra: Record<string, string> = {}) => query(challenge, extra).toString();
    const post = (path: string, body: unknown, headers: Record<string, string> = {}) => app().request(path, {
      method: "POST", headers: { "content-type": "application/json", origin, ...headers }, body: JSON.stringify(body),
    });
    const poll = (ticket: string, codeVerifier: string, installationId = "installation-one") =>
      post("/api/mobile/sign-in/pending", { ticket, codeVerifier, installationId });
    const ticketFrom = (location: string) => new URL(location).searchParams.get("pending")!;
    const guestId = async () => (await db.query("SELECT id FROM auth.users WHERE email=$1", [guest.email])).rows[0].id as string;
    const adminId = async () => (await db.query("SELECT id FROM auth.users WHERE email='owner@example.com'")).rows[0].id as string;

    async function signUpPending(challenge: string, extra: Record<string, string> = {}) {
      await setRegistrationMode(db, "approval");
      const response = await post("/api/auth/sign-up/email", guest, { "x-relo-mobile-sign-in": hint(challenge, extra) });
      expect(response.status).toBe(202);
      return response;
    }

    test("a sign-up inside a mobile sign-in gets a ticket, then the session once approved", async () => {
      const { verifier, challenge } = pkce();
      const body = await (await signUpPending(challenge)).json() as { status: string; redirect: string };
      expect(body.status).toBe("approval_pending");
      const url = new URL(body.redirect);
      expect(`${url.protocol}//${url.host}${url.pathname}`).toBe("relo://auth/callback");
      expect(url.searchParams.get("state")).toBe(state);
      const ticket = ticketFrom(body.redirect);
      expect(ticket).toMatch(/^relo_pending_[A-Za-z0-9_-]{43}$/);
      const stored = await db.query("SELECT * FROM mobile_sign_in_pending");
      expect(stored.rows).toHaveLength(1);
      expect(JSON.stringify(stored.rows[0])).not.toContain(ticket);

      expect((await poll(ticket, pkce().verifier)).status).toBe(400);
      const waiting = await poll(ticket, verifier);
      expect(waiting.status).toBe(202);
      expect(await waiting.json()).toEqual({ status: "pending" });

      await changeAccountAccess(db, await adminId(), await guestId(), "approve", "disabled");
      const approved = await poll(ticket, verifier);
      expect(approved.status).toBe(200);
      const session = await approved.json() as any;
      expect(session.user.email).toBe(guest.email);
      expect(Object.keys(session).sort()).toEqual(["session", "sessionToken", "user"]);
      expect((await app().request("/api/auth/get-session", { headers: { authorization: `Bearer ${session.sessionToken}` } })).status).toBe(200);
      expect((await poll(ticket, verifier)).status).toBe(400);
    });

    test("a pending sign-in (not a sign-up) inside a mobile sign-in gets a ticket; outside one it does not", async () => {
      const { verifier, challenge } = pkce();
      await signUpPending(challenge);
      const credentials = { email: guest.email, password: guest.password, rememberMe: true };
      const plain = await post("/api/auth/sign-in/email", credentials);
      expect(plain.status).toBe(403);
      expect(await plain.json()).toEqual({ error: "approval_pending" });
      const inApp = await post("/api/auth/sign-in/email", credentials, { "x-relo-mobile-sign-in": hint(challenge) });
      expect(inApp.status).toBe(403);
      const body = await inApp.json() as { error: string; redirect: string };
      expect(body.error).toBe("approval_pending");
      // One live ticket per account and challenge: the new one replaced the first.
      expect((await db.query("SELECT count(*)::int AS n FROM mobile_sign_in_pending")).rows[0].n).toBe(1);
      expect((await poll(ticketFrom(body.redirect), verifier)).status).toBe(202);
    });

    test("an invalid hint issues no ticket", async () => {
      const { challenge } = pkce();
      await setRegistrationMode(db, "approval");
      const response = await post("/api/auth/sign-up/email", guest, { "x-relo-mobile-sign-in": hint(challenge, { redirect_uri: "https://evil.example/cb" }) });
      expect(await response.json()).toEqual({ status: "approval_pending" });
      expect((await db.query("SELECT count(*)::int AS n FROM mobile_sign_in_pending")).rows[0].n).toBe(0);
    });

    test("an expired ticket answers expired", async () => {
      const { verifier, challenge } = pkce();
      const ticket = ticketFrom(((await (await signUpPending(challenge)).json()) as any).redirect);
      await db.query("UPDATE mobile_sign_in_pending SET created_at=now()-interval '15 days', expires_at=now()-interval '1 day'");
      const response = await poll(ticket, verifier);
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ status: "expired" });
    });

    test("a declined request or a disabled account answers declined", async () => {
      const { verifier, challenge } = pkce();
      const ticket = ticketFrom(((await (await signUpPending(challenge)).json()) as any).redirect);
      await changeAccountAccess(db, await adminId(), await guestId(), "disable", "disabled");
      const response = await poll(ticket, verifier);
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ status: "declined" });
      // Removing the account (a declined request deletes it) answers the same.
      await db.query("DELETE FROM auth.users WHERE email=$1", [guest.email]);
      expect((await poll(ticket, verifier)).status).toBe(410);
    });

    test("a malformed poll is refused", async () => {
      expect((await post("/api/mobile/sign-in/pending", { ticket: "nope", codeVerifier: "x", installationId: "installation-one" })).status).toBe(400);
      expect((await post("/api/mobile/sign-in/pending", { ticket: `relo_pending_${"a".repeat(43)}`, codeVerifier: pkce().verifier, installationId: "installation-one", extra: 1 })).status).toBe(400);
      expect((await poll(`relo_pending_${"a".repeat(43)}`, pkce().verifier)).status).toBe(400);
    });
  });
});

describe("the mobile sign-in hint", () => {
  const challenge = "A".repeat(43);
  const base = { code_challenge: challenge, code_challenge_method: "S256", redirect_uri: "relo://auth/callback", state: "state_abcdefghijklmnop" };
  const hintOf = (params: Record<string, string>) => mobileSignInHint(new Headers({ "x-relo-mobile-sign-in": new URLSearchParams(params).toString() }));

  test("accepts only relo://auth/callback, S256 and a well-formed state", () => {
    expect(hintOf({ ...base, device: "mac" })?.device).toBe("mac");
    expect(hintOf({ ...base, redirect_uri: "https://evil.example/cb" })).toBeNull();
    expect(hintOf({ ...base, redirect_uri: "relo://auth/callback/../x" })).toBeNull();
    expect(hintOf({ ...base, code_challenge_method: "plain" })).toBeNull();
    expect(hintOf({ ...base, state: "short" })).toBeNull();
    expect(hintOf({ ...base, device: "toaster" })).toBeNull();
    expect(mobileSignInHint(new Headers())).toBeNull();
  });
});
