import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Hono } from "hono";
import { z } from "zod";
import type { AccountAuth } from "./account-auth.js";
import type { Database } from "./db.js";
import { escapeHtml } from "./web/http.js";
import { getOwnerAccount } from "./web/owner-account.js";

// Browser sign-in for the iPhone (authorization code + PKCE, RFC 7636).
// 1. The app opens GET /mobile/sign-in in ASWebAuthenticationSession with a S256 challenge and a state.
// 2. The owner signs in to the web app if needed, then approves on a plain form (no script).
// 3. The server redirects to relo://auth/callback with a one-time code; only its hash is stored.
// 4. The app exchanges code + verifier at POST /api/mobile/sign-in/token for a phone account session,
//    then registers the device exactly as before.

export const mobileSignInRedirectUri = "relo://auth/callback";
const codeLifetimeMs = 5 * 60 * 1000;
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;

const challengeSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const stateSchema = z.string().regex(/^[A-Za-z0-9_-]{16,200}$/);
const verifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
const requestSchema = z.object({
  code_challenge: challengeSchema,
  code_challenge_method: z.literal("S256"),
  redirect_uri: z.literal(mobileSignInRedirectUri),
  state: stateSchema,
});
const tokenSchema = z.object({
  code: z.string().regex(/^relo_signin_[A-Za-z0-9_-]{43}$/),
  codeVerifier: verifierSchema,
  installationId: z.string().trim().min(8).max(200),
}).strict();

type SignInRequest = z.infer<typeof requestSchema>;

export function hashMobileSignInCode(code: string): string {
  return createHash("sha256").update(`relo:mobile-sign-in-code:v1\n${code}`).digest("hex");
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

function callback(params: Record<string, string>): string {
  return `${mobileSignInRedirectUri}?${new URLSearchParams(params).toString()}`;
}

// The app's Welcome deck in CSS: ink canvas, a blue glow, the rounded wordmark, mono HUD labels,
// a glass card and the blue Sign in that shimmers now and then.
const pageStyle = `:root{color-scheme:dark;--bg:#08080d;--surface:rgba(255,255,255,.04);--border:rgba(255,255,255,.08);--text:#f3f5f8;--muted:#a4a4b6;--cyan:#5ce1ff}
*{box-sizing:border-box}body{margin:0;min-height:100vh;color:var(--text);font:16px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;
background:radial-gradient(circle at 50% 120px,rgba(92,225,255,.16),rgba(77,141,255,.06) 160px,transparent 330px),linear-gradient(160deg,#17142e,var(--bg) 45%,#160d12)}
.mono{font:600 .7rem/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.25em;text-transform:uppercase;color:var(--muted)}
header{display:grid;justify-items:center;gap:6px;padding:clamp(28px,8vh,72px) 16px 24px}
.mark{font:700 3.6rem/1 ui-rounded,"SF Pro Rounded",system-ui,sans-serif;letter-spacing:-.02em;color:#fff;text-shadow:0 0 24px rgba(92,225,255,.55)}
.status{display:flex;align-items:center;gap:8px;color:var(--cyan)}.status.warn{color:#ff8a3d}.status::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor;box-shadow:0 0 8px currentColor}
main{width:min(520px,calc(100% - 32px));margin:0 auto 48px;padding:clamp(22px,5vw,32px);border:1px solid var(--border);border-radius:20px;background:var(--surface);
box-shadow:inset 0 1px 0 rgba(255,255,255,.1),0 12px 24px rgba(0,0,0,.45);backdrop-filter:blur(20px)}
h1{margin:0 0 10px;font:700 clamp(1.6rem,6vw,2.1rem)/1.15 ui-rounded,"SF Pro Rounded",system-ui,sans-serif;letter-spacing:-.02em}p{margin:0 0 14px;color:var(--muted)}
dl{display:grid;gap:12px;margin:18px 0 24px;padding:14px 16px;border:1px solid var(--border);border-radius:14px;background:rgba(0,0,0,.25)}dl div{display:grid;gap:6px}
dt{margin:0}dd{margin:0;overflow-wrap:anywhere;font:.9rem/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.actions{display:flex;gap:10px}button{flex:1 1 0;min-height:52px;padding:10px 17px;border:1px solid transparent;border-radius:999px;font:600 1.05rem/1 system-ui;cursor:pointer}
.approve{position:relative;overflow:hidden;background:linear-gradient(90deg,#2a5fe8,#6650e6);color:#fff;box-shadow:0 6px 18px rgba(77,141,255,.4),inset 0 1px 0 rgba(255,255,255,.3)}
.approve::after{content:"";position:absolute;inset:-20% auto -20% -40%;width:35%;transform:skewX(-18deg);background:linear-gradient(90deg,transparent,rgba(255,255,255,.32),transparent);animation:shimmer 5.6s ease-in-out 1.2s infinite}
@keyframes shimmer{0%{left:-40%}20%,100%{left:120%}}@media (prefers-reduced-motion:reduce){.approve::after{display:none}}.deny{border-color:var(--border);background:rgba(255,255,255,.06);color:var(--text)}
button:focus-visible{outline:3px solid rgba(92,225,255,.45);outline-offset:2px}`;

function page(title: string, body: string, status = "Sign in", warn = false): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="same-origin"><title>${escapeHtml(title)} · Relo</title><style>${pageStyle}</style></head>
<body><header><span class="mono">Relo · iPhone</span><span class="mark" aria-hidden="true">relo</span><span class="mono status${warn ? " warn" : ""}">${escapeHtml(status)}</span></header>
<main>${body}</main></body></html>`;
}

function approvalPage(request: SignInRequest, account: { name: string; email: string }, origin: string): string {
  const hidden = Object.entries(request)
    .map(([name, value]) => `<input type="hidden" name="${name}" value="${escapeHtml(value)}">`).join("");
  return page("Sign in on your iPhone", `<h1>Sign in to Relo on your iPhone?</h1>
<p>The Relo app asked to sign in to this server. Approve only if you just tapped Sign in in the app.</p>
<dl><div><dt class="mono">Account</dt><dd>${escapeHtml(account.name)} · ${escapeHtml(account.email)}</dd></div><div><dt class="mono">Server</dt><dd>${escapeHtml(origin)}</dd></div></dl>
<form method="post" action="/mobile/sign-in">${hidden}
<div class="actions"><button class="deny" name="decision" value="deny" type="submit">Cancel</button>
<button class="approve" name="decision" value="approve" type="submit">Sign in</button></div></form>`);
}

const invalidPage = page("Sign-in link not valid", `<h1>This sign-in link is not valid</h1>
<p>Return to the Relo app on your iPhone and tap Sign in again.</p>`, "Not valid", true);

function securePage(context: any, html: string, status = 200): Response {
  // No script runs on these pages; the form posts only to this server.
  context.header("content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self' relo:; base-uri 'none'; frame-ancestors 'none'");
  context.header("cache-control", "private, no-store");
  // same-origin, not no-referrer: under no-referrer browsers send `Origin: null` on the approval
  // form's POST, the origin check below rejects it, and every sign-in ends on the invalid page.
  context.header("referrer-policy", "same-origin");
  context.header("x-content-type-options", "nosniff");
  return context.html(html, status);
}

export async function issueMobileSignInCode(input: {
  db: Database; principalId: string; subject: string; codeChallenge: string; now?: Date;
}): Promise<string> {
  const now = input.now ?? new Date();
  const code = `relo_signin_${randomBytes(32).toString("base64url")}`;
  await input.db.query(
    `INSERT INTO mobile_sign_in_codes(principal_id,subject,code_hash,code_challenge,expires_at,created_at)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [input.principalId, input.subject, hashMobileSignInCode(code), input.codeChallenge,
      new Date(now.valueOf() + codeLifetimeMs), now],
  );
  return code;
}

export type MobileSignInSession = {
  sessionId: string; sessionToken: string; expiresAt: Date; principalId: string;
  user: { id: string; name: string; email: string };
};

/** Redeems a code once, for the verifier that matches its challenge, into a phone account session. */
export async function redeemMobileSignInCode(input: {
  db: Database; code: string; codeVerifier: string; installationId: string; now?: Date;
}): Promise<MobileSignInSession | "invalid" | "expired" | "consumed" | "disabled"> {
  const now = input.now ?? new Date();
  const client = await input.db.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query<{
      id: string; principal_id: string; subject: string; code_challenge: string; expires_at: Date;
      consumed_at: Date | null; name: string; email: string; disabled_at: Date | null;
    }>(
      `SELECT c.id,c.principal_id,c.subject,c.code_challenge,c.expires_at,c.consumed_at,u.name,u.email,
         COALESCE(i.disabled_at,p.disabled_at) AS disabled_at
       FROM mobile_sign_in_codes c
       JOIN owner_principals p ON p.id=c.principal_id
       JOIN auth.users u ON u.id=c.subject
       LEFT JOIN account_identities i ON i.principal_id=c.principal_id AND i.subject=c.subject
       WHERE c.code_hash=$1 FOR UPDATE OF c`,
      [hashMobileSignInCode(input.code)],
    );
    const row = result.rows[0];
    // A wrong verifier is indistinguishable from an unknown code.
    if (!row || pkceChallenge(input.codeVerifier) !== row.code_challenge) { await client.query("ROLLBACK"); return "invalid"; }
    if (row.consumed_at) { await client.query("ROLLBACK"); return "consumed"; }
    if (row.expires_at <= now) { await client.query("ROLLBACK"); return "expired"; }
    if (row.disabled_at) { await client.query("ROLLBACK"); return "disabled"; }
    const sessionToken = randomBytes(32).toString("base64url");
    const sessionId = randomUUID();
    const expiresAt = new Date(now.valueOf() + sessionLifetimeMs);
    await client.query(
      `INSERT INTO auth.sessions(id,expires_at,token,user_id,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)`,
      [sessionId, expiresAt, sessionToken, row.subject, now],
    );
    await client.query(
      `UPDATE mobile_sign_in_codes SET consumed_at=$2,consumed_by_installation_id=$3 WHERE id=$1`,
      [row.id, now, input.installationId],
    );
    await client.query("COMMIT");
    return { sessionId, sessionToken, expiresAt, principalId: row.principal_id,
      user: { id: row.subject, name: row.name, email: row.email } };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export function registerMobileSignInRoutes(app: Hono, db: Database, accountAuth: AccountAuth, appUrl: string): void {
  const origin = new URL(appUrl).origin;

  app.get("/mobile/sign-in", async (context) => {
    const request = requestSchema.safeParse(context.req.query());
    if (!request.success) return securePage(context, invalidPage, 400);
    const account = await getOwnerAccount(db, accountAuth, context.req.raw.headers);
    if (!account) {
      const next = `/mobile/sign-in${new URL(context.req.url).search}`;
      return context.redirect(`/?next=${encodeURIComponent(next)}`);
    }
    return securePage(context, approvalPage(request.data, account.user, origin));
  });

  app.post("/mobile/sign-in", async (context) => {
    if (context.req.header("origin") !== origin) return securePage(context, invalidPage, 403);
    const form = await context.req.parseBody();
    const request = requestSchema.safeParse(form);
    if (!request.success) return securePage(context, invalidPage, 400);
    const account = await getOwnerAccount(db, accountAuth, context.req.raw.headers);
    if (!account) return securePage(context, invalidPage, 401);
    if (form.decision !== "approve") {
      return context.redirect(callback({ error: "access_denied", state: request.data.state }), 303);
    }
    const code = await issueMobileSignInCode({
      db, principalId: account.principalId, subject: account.user.id, codeChallenge: request.data.code_challenge,
    });
    context.header("cache-control", "private, no-store");
    return context.redirect(callback({ code, state: request.data.state }), 303);
  });

  app.post("/api/mobile/sign-in/token", async (context) => {
    const input = tokenSchema.safeParse(await context.req.json().catch(() => null));
    if (!input.success) return context.json({ error: "invalid_request" }, 400);
    const result = await redeemMobileSignInCode({ db, ...input.data });
    if (result === "disabled") return context.json({ error: "account_disabled" }, 403);
    if (typeof result === "string") return context.json({ error: "invalid_grant" }, 400);
    context.header("cache-control", "private, no-store");
    return context.json({
      sessionToken: result.sessionToken,
      session: { id: result.sessionId, expiresAt: result.expiresAt.toISOString() },
      user: result.user,
    });
  });
}
