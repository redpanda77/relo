import { randomBytes } from "node:crypto";
import type { Context, Hono } from "hono";
import { z } from "zod";
import type { AccountAuth } from "./account-auth.js";
import { clientAddress } from "./client-address.js";
import { generateToken, hashMachineToken, hashToken } from "./auth.js";
import type { Database } from "./db.js";
import { publicId } from "./ids.js";
import { getOwnerAccount } from "./web.js";
import { lockAccountLifecycle } from "./account-lifecycle.js";
import { publicPageStyle, publicPageTopBar } from "./web/public-page.js";

export const allowedCliScopes = [
  "notifications:send",
  "interactions:create",
  "interactions:read",
  "activities:write",
  "activities:read",
  "devices:read",
  "services:read",
  "services:write",
] as const;

const startSchema = z.object({
  clientName: z.string().trim().min(1).max(80),
  scopes: z.array(z.enum(allowedCliScopes)).min(1).max(allowedCliScopes.length)
    .transform((scopes) => [...new Set(scopes)].sort()),
  expiresInSeconds: z.number().int().min(3_600).max(31_536_000),
}).strict();
const tokenSchema = z.object({ deviceCode: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();

const CODE_ALPHABET = "23456789ABCDEFGHJKLMNPQRSTUVWXYZ";
const AUTHORIZATION_LIFETIME_SECONDS = 600;
const START_INTERVAL_SECONDS = 5;
const startAttempts = new Map<string, number[]>();
const pollAttempts = new Map<string, number[]>();

const cliAuthorizationPage = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="referrer" content="no-referrer">
  <title>Authorize CLI · Relo</title>
  <meta name="theme-color" content="#08080d">
  <style>${publicPageStyle}
    .lede{max-width:62ch;margin:0 0 24px}
    label{display:grid;gap:8px;font-weight:600}.code-input{width:100%;min-height:52px;padding:12px 16px;border:1px solid rgba(255,255,255,.12);border-radius:14px;background:rgba(0,0,0,.3);color:var(--text);font:600 1.15rem/1.3 var(--mono);letter-spacing:.18em;text-transform:uppercase}.code-input:focus{border-color:var(--coral)}
    #request{margin-top:24px;padding-top:20px;border-top:1px solid var(--border)}.request-code,.expiry{color:var(--muted);font-size:.9rem}.request-code strong{color:var(--text);font-family:var(--mono);letter-spacing:.08em}
    .scope-list{display:flex;flex-wrap:wrap;gap:8px;margin:16px 0}.scope{padding:5px 11px;border:1px solid rgba(255,255,255,.1);border-radius:999px;background:rgba(255,255,255,.03);font:500 .8rem/1.3 var(--mono);color:#cfd3e2}
    .actions{margin-top:20px}
    .state{margin-top:24px;padding:16px 18px;border:1px solid var(--border);border-radius:16px;background:rgba(0,0,0,.25)}.state[data-state="approved"]{border-color:rgba(255,107,87,.45)}.state[data-state="consumed"]{border-color:rgba(52,211,153,.5)}.state[data-state="denied"],.state[data-state="expired"],.state[data-state="error"]{border-color:rgba(248,113,113,.48)}
    .state-row{display:flex;align-items:flex-start;gap:12px}.state-mark{flex:0 0 auto;width:12px;height:12px;margin-top:6px;border:2px solid currentColor;border-radius:50%;color:var(--muted)}.state[data-state="approved"] .state-mark{color:var(--coral);border-right-color:transparent;animation:spin .8s linear infinite}.state[data-state="consumed"] .state-mark{color:var(--mint);background:var(--mint);box-shadow:0 0 10px var(--mint)}.state[data-state="denied"] .state-mark,.state[data-state="expired"] .state-mark,.state[data-state="error"] .state-mark{color:var(--red);background:var(--red)}
    .state strong{display:block;font-size:1rem}.state p{margin:3px 0 0}.terminal-actions{margin-top:16px}.terminal-actions .button-link{flex:0 1 auto}
    @keyframes spin{to{transform:rotate(360deg)}}
  </style>
</head>
<body>
  ${publicPageTopBar}
  <header class="hero"><span class="orb" aria-hidden="true"></span><span class="mono">Relo · Command line</span></header>
  <main class="card">
    <h1>Authorize a client</h1>
    <p class="lede">Signing in does not authorize this request. Verify the code, client, requested access, and expiry before choosing.</p>
    <label id="code-field">Authorization code
      <input class="code-input" id="code" autocomplete="one-time-code" inputmode="text" maxlength="9" placeholder="XXXX-XXXX">
    </label>
    <section id="request" hidden aria-labelledby="client">
      <h2 id="client"></h2>
      <div class="request-code">Code: <strong id="shown-code"></strong></div>
      <div class="scope-list" id="scopes" aria-label="Requested access"></div>
      <p class="expiry" id="expiry"></p>
      <div class="actions" id="decision-actions">
        <button class="deny" id="deny" type="button">Deny</button>
        <button class="approve" id="approve" type="button">Authorize</button>
      </div>
    </section>
    <section class="state" id="message" role="status" aria-live="polite" tabindex="-1" hidden>
      <div class="state-row"><span class="state-mark" aria-hidden="true"></span><div><strong id="state-title"></strong><p id="state-detail"></p></div></div>
      <div class="terminal-actions" id="terminal-actions" hidden><a class="button-link deny" href="/dashboard">Return to dashboard</a></div>
    </section>
  </main>
  <script src="/cli/authorize.js"></script>
</body>
</html>`;

// Served as a same-origin file so the page's CSP allows no inline script.
const cliAuthorizationScript = `const code=document.querySelector('#code');
const codeField=document.querySelector('#code-field');
const box=document.querySelector('#request');
const message=document.querySelector('#message');
const title=document.querySelector('#state-title');
const detail=document.querySelector('#state-detail');
const actions=document.querySelector('#decision-actions');
const terminalActions=document.querySelector('#terminal-actions');
const approve=document.querySelector('#approve');
const deny=document.querySelector('#deny');
let refreshTimer;
let busy=false;
code.value=new URLSearchParams(location.search).get('code')||'';

function clearRefresh(){if(refreshTimer){clearTimeout(refreshTimer);refreshTimer=undefined}}
function scheduleRefresh(){clearRefresh();refreshTimer=setTimeout(()=>load(false),750)}
function showState(state,heading,description,terminal=false){
  message.hidden=false;message.dataset.state=state;title.textContent=heading;detail.textContent=description;
  terminalActions.hidden=!terminal;
  if(terminal)message.focus();
}
function hideState(){message.hidden=true;message.removeAttribute('data-state');terminalActions.hidden=true}
function renderRequest(request){
  document.querySelector('#client').textContent=request.clientName;
  document.querySelector('#shown-code').textContent=request.userCode;
  document.querySelector('#scopes').replaceChildren(...request.scopes.map((scope)=>{const item=document.createElement('div');item.className='scope';item.textContent=scope;return item}));
  document.querySelector('#expiry').textContent='Request expires '+new Date(request.expiresAt).toLocaleString()+' · credential expires '+new Date(request.credentialExpiresAt).toLocaleString();
  box.hidden=request.status==='consumed';codeField.hidden=request.status==='consumed';
  actions.hidden=request.status!=='pending';approve.disabled=busy||request.status!=='pending';deny.disabled=busy||request.status!=='pending';
  clearRefresh();
  if(request.status==='pending'){hideState();return}
  if(request.status==='approved'){
    showState('approved','Waiting for the CLI to connect','Authorization is approved. Keep the CLI window open while it securely collects the credential.');
    scheduleRefresh();return;
  }
  if(request.status==='consumed'){
    showState('consumed','Connected successfully','The CLI collected its credential. You can close this tab.',true);return;
  }
  if(request.status==='denied'){
    showState('denied','Request denied','No credential was issued. You can close this tab.',true);return;
  }
  if(request.status==='expired'){
    showState('expired','Request expired','Start authorization again from the CLI to receive a new code.',true);return;
  }
  showState('error','Authorization unavailable','Return to the CLI and start authorization again.',true);
}
async function load(announce=true){
  const normalized=code.value.trim();if(!normalized){box.hidden=true;hideState();return}
  try{
    const response=await fetch('/api/device-authorizations/requests/'+encodeURIComponent(normalized),{cache:'no-store'});
    const body=await response.json();
    if(!response.ok){box.hidden=true;showState('error','Request not found',body.error==='authorization_not_found'?'Check the code or start authorization again from the CLI.':'Unable to inspect this request. Try again.');return}
    renderRequest(body.request);
    if(announce&&body.request.status!=='pending')message.focus();
  }catch{
    showState('error','Connection interrupted','Check your connection. Relo will try this request again.');scheduleRefresh();
  }
}
async function decide(action){
  if(busy)return;busy=true;approve.disabled=true;deny.disabled=true;
  showState('approved',action==='approve'?'Authorizing…':'Denying…','Recording your decision securely.');
  try{
    const response=await fetch('/api/device-authorizations/requests/'+encodeURIComponent(code.value)+'/'+action,{method:'POST'});
    if(!response.ok&&response.status!==409){const body=await response.json();showState('error','Decision not recorded',body.error||'Try again from the CLI.');return}
    await load();
  }catch{
    showState('error','Decision not recorded','Check your connection and try again.');
  }finally{busy=false;if(!actions.hidden){approve.disabled=false;deny.disabled=false}}
}
code.addEventListener('change',()=>load());
approve.addEventListener('click',()=>decide('approve'));
deny.addEventListener('click',()=>decide('deny'));
load();
`;

// The page fetches only this server and runs only /cli/authorize.js; nothing may frame it or post elsewhere.
const cliAuthorizationContentSecurityPolicy =
  "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'";

function domainHash(domain: string, value: string): string {
  return hashToken(`relo:${domain}:v1\n${value}`);
}

function randomUserCode(): string {
  const bytes = randomBytes(8);
  const raw = [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join("");
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeUserCode(value: string): string | undefined {
  const raw = value.toUpperCase().replace(/[\s-]/g, "");
  if (raw.length !== 8 || [...raw].some((character) => !CODE_ALPHABET.includes(character))) return undefined;
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function authorizationRateLimitBuckets(context?: Context): string[] {
  const address = clientAddress(context);
  return address ? ["global", `client:${address}`] : ["global"];
}

/**
 * Records an attempt in every bucket unless one of them is already full. A rejected attempt is not
 * recorded, so a full bucket empties a window after the last accepted attempt instead of staying
 * full for as long as someone keeps sending.
 */
export function limitedAcrossBuckets(
  store: Map<string, number[]>,
  buckets: string[],
  clientLimit: number,
  globalLimit: number,
  windowMs: number,
  now = Date.now(),
): boolean {
  const recent = buckets.map((bucket) => {
    const kept = (store.get(bucket) ?? []).filter((timestamp) => timestamp > now - windowMs);
    store.set(bucket, kept);
    return kept;
  });
  if (buckets.some((bucket, index) => recent[index]!.length >= (bucket.endsWith("global") ? globalLimit : clientLimit))) return true;
  for (const kept of recent) kept.push(now);
  return false;
}

export async function cleanupTerminalDeviceAuthorizations(db: Database): Promise<number> {
  const result = await db.query(
    `DELETE FROM device_authorizations
     WHERE status IN ('denied','expired','consumed')
       AND COALESCE(consumed_at,resolved_at,expires_at,created_at) < now()-interval '24 hours'`,
  );
  return result.rowCount ?? 0;
}

function credentialMetadata(row: any) {
  return {
    id: publicId("key", row.id),
    clientName: row.label,
    prefix: row.token_prefix,
    scopes: row.scopes,
    createdAt: new Date(row.created_at).toISOString(),
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    lastUsedAt: row.last_used_at ? new Date(row.last_used_at).toISOString() : null,
    revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  };
}

export function registerPublicDeviceAuthorizationRoutes(app: Hono, db: Database, accountAuth: AccountAuth, appUrl: string): void {
  const origin = new URL(appUrl).origin;

  app.post("/api/device-authorizations/start", async (context) => {
    if (limitedAcrossBuckets(startAttempts, authorizationRateLimitBuckets(context), 10, 40, 60_000)) {
      context.header("Retry-After", "60");
      return context.json({ error: "rate_limited" }, 429);
    }
    const input = startSchema.parse(await context.req.json());
    await cleanupTerminalDeviceAuthorizations(db);
    const deviceCode = randomBytes(32).toString("base64url");
    let userCode: string | undefined;
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await lockAccountLifecycle(client);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const candidate = randomUserCode();
        const inserted = await client.query(
          `INSERT INTO device_authorizations(
             device_code_hash,user_code,client_name,requested_scopes,expires_at,credential_expires_at
           ) VALUES ($1,$2,$3,$4,now()+interval '600 seconds',now()+($5::text||' seconds')::interval)
           ON CONFLICT DO NOTHING RETURNING id`,
          [domainHash("device-code",deviceCode),candidate,input.clientName,input.scopes,input.expiresInSeconds],
        );
        if (inserted.rowCount) { userCode = candidate; break; }
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
    if (!userCode) return context.json({ error: "temporarily_unavailable" }, 503);
    const verificationUri = `${origin}/cli/authorize`;
    return context.json({
      deviceCode,userCode,verificationUri,
      verificationUriComplete: `${verificationUri}?code=${encodeURIComponent(userCode)}`,
      expiresInSeconds: AUTHORIZATION_LIFETIME_SECONDS,
      intervalSeconds: START_INTERVAL_SECONDS,
    }, 201);
  });

  app.post("/api/device-authorizations/token", async (context) => {
    if (limitedAcrossBuckets(pollAttempts, authorizationRateLimitBuckets(context), 180, 600, 60_000)) {
      context.header("Retry-After", "60");
      return context.json({ error: "rate_limited", intervalSeconds: 60 }, 429);
    }
    const input = tokenSchema.parse(await context.req.json());
    const client = await db.connect();
    try {
      await client.query("BEGIN");
      const request = await client.query<any>(
        "SELECT * FROM device_authorizations WHERE device_code_hash=$1 FOR UPDATE",
        [domainHash("device-code",input.deviceCode)],
      );
      if (!request.rowCount) {
        await client.query("ROLLBACK");
        return context.json({ error: "invalid_request" }, 400);
      }
      const row = request.rows[0];
      if (new Date(row.expires_at).getTime() <= Date.now() && ["pending","approved"].includes(row.status)) {
        await client.query("UPDATE device_authorizations SET status='expired',resolved_at=COALESCE(resolved_at,now()) WHERE id=$1", [row.id]);
        await client.query("COMMIT");
        return context.json({ error: "expired_token" }, 400);
      }
      if (row.status === "expired") { await client.query("ROLLBACK"); return context.json({ error: "expired_token" }, 400); }
      if (row.status === "denied") { await client.query("ROLLBACK"); return context.json({ error: "access_denied" }, 400); }
      if (row.status === "consumed") { await client.query("ROLLBACK"); return context.json({ error: "invalid_grant" }, 400); }
      if (row.last_poll_at) {
        const elapsed = Date.now() - new Date(row.last_poll_at).getTime();
        if (elapsed < row.poll_interval_seconds * 1_000) {
          const interval = Math.min(30, row.poll_interval_seconds + 5);
          await client.query("UPDATE device_authorizations SET poll_interval_seconds=$2,last_poll_at=now() WHERE id=$1", [row.id,interval]);
          await client.query("COMMIT");
          return context.json({ error: "slow_down", intervalSeconds: interval }, 400);
        }
      }
      if (row.status === "pending") {
        await client.query("UPDATE device_authorizations SET last_poll_at=now() WHERE id=$1", [row.id]);
        await client.query("COMMIT");
        return context.json({ error: "authorization_pending", intervalSeconds: row.poll_interval_seconds }, 400);
      }
      if (row.status !== "approved" || !row.approved_owner_id) {
        await client.query("ROLLBACK");
        return context.json({ error: "invalid_grant" }, 400);
      }

      const existing = await client.query("SELECT id FROM principal_api_keys WHERE principal_id=$1 AND label=$2 FOR UPDATE", [row.approved_owner_id,row.client_name]);
      if (!existing.rowCount) {
        const count = await client.query<{ count: number }>(
          "SELECT count(*)::int AS count FROM principal_api_keys WHERE principal_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>now())",
          [row.approved_owner_id],
        );
        if (count.rows[0]!.count >= 50) {
          await client.query("ROLLBACK");
          return context.json({ error: "credential_limit_reached" }, 409);
        }
      }
      const accessToken = generateToken();
      const tokenPrefix = accessToken.slice(0, 15);
      const credential = await client.query<any>(
        `INSERT INTO principal_api_keys(principal_id,label,token_hash,token_prefix,scopes,expires_at)
         VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (principal_id,label) DO UPDATE SET
           token_hash=EXCLUDED.token_hash,token_prefix=EXCLUDED.token_prefix,
           scopes=EXCLUDED.scopes,expires_at=EXCLUDED.expires_at,
           created_at=now(),last_used_at=NULL,revoked_at=NULL
         RETURNING *`,
        [row.approved_owner_id,row.client_name,hashMachineToken(accessToken),tokenPrefix,row.requested_scopes,row.credential_expires_at],
      );
      await client.query("UPDATE device_authorizations SET status='consumed',consumed_at=now(),last_poll_at=now() WHERE id=$1 AND status='approved'", [row.id]);
      await client.query("COMMIT");
      return context.json({ accessToken, credential: credentialMetadata(credential.rows[0]) });
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally { client.release(); }
  });

  app.get("/api/device-authorizations/requests/:userCode", async (context) => {
    const account = await getOwnerAccount(db, accountAuth, context.req.raw.headers);
    if (!account) return context.json({ error: "unauthorized" }, 401);
    const code = normalizeUserCode(context.req.param("userCode"));
    if (!code) return context.json({ error: "authorization_not_found" }, 404);
    const result = await db.query<any>(
      `UPDATE device_authorizations SET status='expired',resolved_at=COALESCE(resolved_at,now())
       WHERE user_code=$1 AND status IN ('pending','approved') AND expires_at<=now()
       RETURNING id`, [code],
    );
    void result;
    const request = await db.query<any>(
      `SELECT * FROM device_authorizations WHERE user_code=$1
       AND (approved_owner_id IS NULL OR approved_owner_id=$2)`, [code,account.principalId],
    );
    if (!request.rowCount) return context.json({ error: "authorization_not_found" }, 404);
    const row = request.rows[0];
    return context.json({ request: {
      clientName: row.client_name, scopes: row.requested_scopes, status: row.status,
      userCode: row.user_code, expiresAt: new Date(row.expires_at).toISOString(),
      credentialExpiresAt: new Date(row.credential_expires_at).toISOString(),
    } });
  });

  for (const decision of ["approve", "deny"] as const) {
    app.post(`/api/device-authorizations/requests/:userCode/${decision}`, async (context) => {
      const account = await getOwnerAccount(db, accountAuth, context.req.raw.headers);
      if (!account) return context.json({ error: "unauthorized" }, 401);
      if (context.req.header("origin") !== origin) return context.json({ error: "forbidden" }, 403);
      const code = normalizeUserCode(context.req.param("userCode"));
      if (!code) return context.json({ error: "authorization_not_found" }, 404);
      const result = await db.query<any>(
        `UPDATE device_authorizations SET status=$3,
           approved_owner_id=CASE WHEN $3='approved' THEN $2::uuid ELSE NULL END,
           resolved_at=now()
         WHERE user_code=$1 AND status='pending' AND expires_at>now()
         RETURNING user_code,status`,
        [code,account.principalId,decision === "approve" ? "approved" : "denied"],
      );
      if (!result.rowCount) {
        const exists = await db.query("SELECT 1 FROM device_authorizations WHERE user_code=$1", [code]);
        return exists.rowCount
          ? context.json({ error: "authorization_not_pending" }, 409)
          : context.json({ error: "authorization_not_found" }, 404);
      }
      return context.json({ status: result.rows[0].status, userCode: result.rows[0].user_code });
    });
  }

  app.get("/cli/authorize", async (context) => {
    const account = await getOwnerAccount(db, accountAuth, context.req.raw.headers);
    if (!account) {
      const next = `/cli/authorize${new URL(context.req.url).search}`;
      return context.redirect(`/sign-in?next=${encodeURIComponent(next)}`);
    }
    return context.html(cliAuthorizationPage, 200, {
      "Content-Security-Policy": cliAuthorizationContentSecurityPolicy,
      "Referrer-Policy": "no-referrer",
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    });
  });

  app.get("/cli/authorize.js", (context) => context.body(cliAuthorizationScript, 200, {
    "Content-Type": "text/javascript; charset=utf-8",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
  }));
}

export function registerMachineAuthRoutes(app: Hono, db: Database): void {
  app.get("/api/clients/self", async (context) => {
    const auth = context.get("auth");
    if (auth.credentialKind !== "principal" || !auth.credentialId) return context.json({ error: "forbidden" }, 403);
    const result = await db.query<any>("SELECT * FROM principal_api_keys WHERE id=$1 AND principal_id=$2", [auth.credentialId,auth.principalId]);
    if (!result.rowCount) return context.json({ error: "unauthorized" }, 401);
    return context.json({ authenticated: true, credential: credentialMetadata(result.rows[0]) });
  });

}

export function registerIdempotentMachineRevokeRoute(app: Hono, db: Database): void {
  app.delete("/api/clients/self", async (context) => {
    const match = context.req.header("authorization")?.match(/^Bearer\s+(.+)$/i);
    if (!match?.[1]) return context.json({ error: "unauthorized" }, 401);
    const token = match[1];
    const result = await db.query<{ id: string }>(
      `UPDATE principal_api_keys k SET revoked_at=COALESCE(k.revoked_at,now())
       FROM owner_principals p
       WHERE k.principal_id=p.id AND k.token_hash=ANY($1::text[])
         AND (k.expires_at IS NULL OR k.expires_at>now()) AND p.disabled_at IS NULL
       RETURNING k.id`,
      [[hashToken(token),hashMachineToken(token)]],
    );
    if (!result.rowCount) return context.json({ error: "unauthorized" }, 401);
    return context.json({ revoked: true, credentialId: publicId("key",result.rows[0]!.id) });
  });
}
