import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AccountAuth, AppleSignInConfig } from "./account-auth.js";
import { appleSignInEnabled } from "./account-auth.js";
import { lockAccountLifecycle } from "./account-lifecycle.js";
import type { ApnsMode } from "./activities.js";
import { authAttemptLimited } from "./auth-throttle.js";
import type { Database } from "./db.js";
import {
  issuePendingSignIn, mintPhoneSession, mobileSignInHintHeader, mobileSignInRedirectUri, pendingSignInRedirect, tokenBody,
} from "./mobile-sign-in.js";
import type { NotificationContentCipher } from "./notification-content.js";
import {
  claimBootstrappedOwner, createAccountPrincipal, registrationMode, requestAccountApproval, signInRefusal,
} from "./server-accounts.js";
import { safeNextPath } from "./web.js";

// Sign in with Apple, for the web and the iPhone app. Both end in one Apple ID token that Better Auth verifies
// against Apple's keys (audience: the Services ID or the app's bundle ID, and the nonce we chose), so no Apple
// private key is needed. An email that already has an account joins it when Apple verified that email; a new person
// follows the email sign-up's rules: the first person claims the server, later ones get an account of their own under
// the registration mode (closed, approval, open).
// 1. Web: GET /api/auth/apple/start sets a state+nonce cookie and sends the browser to Apple; Apple form-posts the ID
//    token to /api/auth/apple/callback, which signs the browser in and returns to `next`.
// 2. iPhone: the app runs ASAuthorizationAppleIDProvider with a hashed nonce and posts the token to
//    POST /api/mobile/sign-in/apple, which answers like /api/mobile/sign-in/token (or with a pending ticket).

const stateCookie = "relo_apple_sign_in";
const stateCookiePath = "/api/auth/apple";
const stateLifetimeSeconds = 10 * 60;

export type AppleSignInRefusal =
  | "invalid_token" | "registration_closed" | "approval_pending" | "account_disabled" | "account_exists" | "owner_not_bootstrapped";

type AppleSignInDependencies = {
  accountAuth: AccountAuth;
  appUrl: string;
  apple: AppleSignInConfig | undefined;
  bootstrapOwnerHandle: string;
  apnsMode: ApnsMode;
  contentCipher: NotificationContentCipher | null;
};

type AppleName = { firstName?: string | undefined; lastName?: string | undefined };

type AppleSignedIn = { userId: string; sessionToken: string; setCookies: string[]; user: { id: string; name: string; email: string } };

/** Apple's display name arrives only on the first authorization, from the app or Apple's form post. */
const nameSchema = z.object({
  firstName: z.string().trim().max(120).optional(),
  lastName: z.string().trim().max(120).optional(),
}).strict();

const mobileSchema = z.object({
  identityToken: z.string().min(20).max(8192),
  /** The raw nonce; the app sent its SHA-256 to Apple. */
  nonce: z.string().regex(/^[A-Za-z0-9_-]{16,128}$/),
  /** The app's PKCE challenge, so a pending account can poll /api/mobile/sign-in/pending with its verifier. */
  codeChallenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  installationId: z.string().trim().min(8).max(200),
  name: nameSchema.optional(),
}).strict();

/** Which sign-in methods this server offers the apps; the iPhone shows Sign in with Apple only when `apple` is true. */
export function appleSignInMethods(apple: AppleSignInConfig | undefined): { apple: boolean; appleWeb: boolean } {
  return { apple: Boolean(apple?.bundleId), appleWeb: Boolean(apple?.servicesId) };
}

function refusalCode(error: unknown): AppleSignInRefusal {
  const body = (error as { body?: { code?: unknown } } | null)?.body;
  const code = typeof body?.code === "string" ? body.code : "";
  // An existing account joins only when Apple verified the email (account-auth.ts); otherwise that person signs in
  // with the password.
  return /LINK|NOT_LINKED/u.test(code) ? "account_exists" : "invalid_token";
}

/**
 * Signs in (or up) with a verified Apple ID token. On success Better Auth has created an account session (its cookie
 * in `setCookies`); on refusal no session is left behind and a new identity the rules refuse is removed.
 */
export async function signInWithAppleToken(
  db: Database,
  dependencies: AppleSignInDependencies,
  input: { idToken: string; nonce: string; name?: AppleName | undefined; headers: Headers },
): Promise<AppleSignedIn | { refusal: AppleSignInRefusal; userId?: string }> {
  const client = await db.connect();
  try {
    await client.query("BEGIN");
    await lockAccountLifecycle(client);
    const claimed = Boolean((await client.query("SELECT 1 FROM account_identities LIMIT 1")).rowCount);
    const mode = claimed ? await registrationMode(client, dependencies.appUrl) : null;
    let result: { headers: Headers; response: { token: string; user: { id: string; name: string; email: string } } };
    try {
      result = await dependencies.accountAuth.api.signInSocial({
        body: { provider: "apple", idToken: { token: input.idToken, nonce: input.nonce,
          ...(input.name ? { user: { name: { firstName: input.name.firstName ?? "", lastName: input.name.lastName ?? "" } } } : {}) } },
        headers: input.headers,
        returnHeaders: true,
      }) as typeof result;
    } catch (error) {
      await client.query("ROLLBACK");
      return { refusal: refusalCode(error) };
    }
    const user = result.response.user;
    const mapped = await client.query("SELECT 1 FROM account_identities WHERE provider='better-auth' AND subject=$1", [user.id]);
    let approvalRequested = false;
    if (!mapped.rowCount) {
      if (mode === "closed") {
        await client.query("DELETE FROM auth.users WHERE id=$1", [user.id]);
        await client.query("COMMIT");
        return { refusal: "registration_closed" };
      }
      if (claimed) {
        // ADR 0004: everyone after the first person gets an empty account of their own.
        await createAccountPrincipal(client, user.id, { approved: mode === "open" });
        approvalRequested = mode === "approval";
      } else if (!await claimBootstrappedOwner(client, dependencies.bootstrapOwnerHandle, user.id)) {
        await client.query("DELETE FROM auth.users WHERE id=$1", [user.id]);
        await client.query("COMMIT");
        return { refusal: "owner_not_bootstrapped" };
      }
    }
    const refusal = await signInRefusal(client, user.id);
    if (refusal) await client.query("DELETE FROM auth.sessions WHERE user_id=$1 AND token=$2", [user.id, result.response.token]);
    await client.query("COMMIT");
    if (approvalRequested && dependencies.contentCipher) {
      try {
        await requestAccountApproval(db, { subject: user.id, name: user.name || "Someone", email: user.email },
          { apnsMode: dependencies.apnsMode, contentCipher: dependencies.contentCipher, appUrl: dependencies.appUrl });
      } catch (error) {
        // The request stays pending in the Dashboard even when the phone cannot be asked.
        console.error("account request approval failed", { message: error instanceof Error ? error.message : "unknown" });
      }
    }
    if (refusal) return { refusal, userId: user.id };
    return { userId: user.id, sessionToken: result.response.token, setCookies: result.headers.getSetCookie(), user };
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch {
      // The transaction already ended.
    }
    throw error;
  } finally {
    client.release();
  }
}

/** Only what Better Auth records on the session; never the browser's cookies or Apple's origin. */
function sessionHeaders(context: Context): Headers {
  const headers = new Headers();
  for (const name of ["user-agent", "x-forwarded-for", "x-real-ip", "cf-connecting-ip"]) {
    const value = context.req.header(name);
    if (value) headers.set(name, value);
  }
  return headers;
}

function readStateCookie(context: Context): { state: string; nonce: string; next: string } | null {
  const raw = context.req.header("cookie")?.split(/;\s*/u).find(part => part.startsWith(`${stateCookie}=`))?.slice(stateCookie.length + 1);
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as { state?: unknown; nonce?: unknown; next?: unknown };
    if (typeof value.state !== "string" || typeof value.nonce !== "string" || typeof value.next !== "string") return null;
    return { state: value.state, nonce: value.nonce, next: safeNextPath(value.next) };
  } catch {
    return null;
  }
}

function sameSecret(left: string, right: string): boolean {
  const a = Buffer.from(left), b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

const clearStateCookie = `${stateCookie}=; Path=${stateCookiePath}; Max-Age=0; HttpOnly; Secure; SameSite=None`;

function redirectWith(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, "cache-control": "private, no-store" });
  for (const cookie of [clearStateCookie, ...cookies]) headers.append("set-cookie", cookie);
  return new Response(null, { status: 303, headers });
}

/** The query of an app's /mobile/sign-in link this web sign-in belongs to, as the Dashboard forwards it. */
function mobileHint(next: string): Headers {
  const headers = new Headers();
  if (next.startsWith("/mobile/sign-in?")) headers.set(mobileSignInHintHeader, next.slice("/mobile/sign-in?".length));
  return headers;
}

export function registerAppleSignInRoutes(app: Hono, db: Database, dependencies: AppleSignInDependencies): void {
  const { apple, appUrl } = dependencies;
  const callbackUrl = new URL("/api/auth/apple/callback", appUrl).toString();

  // Better Auth's own social routes would sign people in around the registration rules: only the routes below.
  for (const path of ["/api/auth/sign-in/social", "/api/auth/callback/*", "/api/auth/link-social", "/api/auth/sign-in/oauth2"]) {
    app.on(["GET", "POST"], path, context => context.json({ error: "not_found" }, 404));
  }

  app.get("/api/mobile/sign-in/methods", context => {
    context.header("cache-control", "no-store");
    return context.json(appleSignInMethods(apple));
  });

  app.get("/api/auth/apple/start", context => {
    if (!apple?.servicesId) return context.json({ error: "apple_sign_in_unavailable" }, 404);
    const state = randomBytes(24).toString("base64url");
    const nonce = randomBytes(24).toString("base64url");
    const next = safeNextPath(context.req.query("next"));
    const cookie = Buffer.from(JSON.stringify({ state, nonce, next })).toString("base64url");
    // Apple form-posts back from its own site: only a SameSite=None cookie comes along, so it holds no credential,
    // just this attempt's state and nonce.
    context.header("set-cookie", `${stateCookie}=${cookie}; Path=${stateCookiePath}; Max-Age=${stateLifetimeSeconds}; HttpOnly; Secure; SameSite=None`);
    context.header("cache-control", "private, no-store");
    const authorize = new URL("https://appleid.apple.com/auth/authorize");
    authorize.search = new URLSearchParams({
      client_id: apple.servicesId, redirect_uri: callbackUrl, response_type: "code id_token", response_mode: "form_post",
      scope: "name email", state, nonce,
    }).toString();
    return context.redirect(authorize.toString(), 302);
  });

  app.post("/api/auth/apple/callback", async context => {
    if (!apple?.servicesId) return context.json({ error: "apple_sign_in_unavailable" }, 404);
    const throttled = authAttemptLimited(context, "sign-in");
    if (throttled) return throttled;
    const saved = readStateCookie(context);
    const form = await context.req.parseBody();
    const fail = (reason: string, next = "/dashboard") =>
      redirectWith(`/sign-in?next=${encodeURIComponent(next)}&apple=${reason}`, []);
    if (!saved || typeof form.state !== "string" || !sameSecret(form.state, saved.state)) return fail("expired");
    // The person closed Apple's sheet: back to the sign-in page, no message.
    if (typeof form.error === "string") return redirectWith(`/sign-in?next=${encodeURIComponent(saved.next)}`, []);
    if (typeof form.id_token !== "string") return fail("invalid_token", saved.next);
    let name: AppleName | undefined;
    if (typeof form.user === "string" && form.user.length <= 2000) {
      try {
        const parsed = nameSchema.safeParse((JSON.parse(form.user) as { name?: unknown } | null)?.name);
        if (parsed.success) name = parsed.data;
      } catch {
        // A name Apple sent malformed is left out; the account keeps its email.
      }
    }
    const result = await signInWithAppleToken(db, dependencies, {
      idToken: form.id_token, nonce: saved.nonce, name, headers: sessionHeaders(context),
    }).catch(() => ({ refusal: "invalid_token" as const }));
    if ("refusal" in result) {
      if (result.refusal === "approval_pending" && "userId" in result && result.userId) {
        // Inside an app's browser sign-in, the browser goes back to the app with a ticket it can poll.
        const ticket = await pendingSignInRedirect(db, mobileHint(saved.next), result.userId);
        if (ticket) return redirectWith(ticket, []);
      }
      return fail(result.refusal, saved.next);
    }
    return redirectWith(saved.next, result.setCookies);
  });

  app.post("/api/mobile/sign-in/apple", async context => {
    if (!appleSignInEnabled(apple) || !apple.bundleId) return context.json({ error: "apple_sign_in_unavailable" }, 404);
    const throttled = authAttemptLimited(context, "sign-in");
    if (throttled) return throttled;
    const input = mobileSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_request" }, 400);
    context.header("cache-control", "private, no-store");
    const result = await signInWithAppleToken(db, dependencies, {
      idToken: input.data.identityToken, nonce: input.data.nonce, name: input.data.name, headers: sessionHeaders(context),
    });
    if ("refusal" in result) {
      if (result.refusal === "approval_pending" && result.userId) {
        const redirect = await issuePendingSignIn({ db, subject: result.userId, request: {
          code_challenge: input.data.codeChallenge, code_challenge_method: "S256", redirect_uri: mobileSignInRedirectUri,
          state: randomBytes(16).toString("base64url"), device: "iphone",
        } });
        const ticket = new URL(redirect).searchParams.get("pending");
        return context.json({ status: "approval_pending", pending: ticket }, 202);
      }
      const status = result.refusal === "invalid_token" ? 401 : result.refusal === "account_exists" ? 409 : 403;
      return context.json({ error: result.refusal }, status);
    }
    // The app holds a 30-day phone session of its own, as after the browser sign-in; Better Auth's is not needed.
    const now = new Date();
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM auth.sessions WHERE token=$1", [result.sessionToken]);
      const session = await mintPhoneSession(client, result.userId, now);
      const principal = await client.query<{ principal_id: string }>(
        "SELECT principal_id FROM account_identities WHERE provider='better-auth' AND subject=$1", [result.userId]);
      await client.query("COMMIT");
      return context.json(tokenBody({ ...session, principalId: principal.rows[0]!.principal_id, user: result.user }));
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  });
}
