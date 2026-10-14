import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resetAuthAttempts } from "./auth-throttle.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createAccountAuth } from "./account-auth.js";
import { createApp } from "./app.js";
import { generateToken, hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createAuthDatabase, createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { createTransportTokenEncryption } from "./token-encryption.js";

/**
 * ADR 0004: one account never reads, changes or learns about another account's resources.
 * Account A attacks every route with account B's identifiers, using every credential A holds.
 * A foreign identifier must answer exactly like one that does not exist, and B's rows must not move.
 */
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const appUrl = "http://127.0.0.1:8180";
const secret = "test-only-tenant-isolation-secret-0123456789abcdef";
const MARK = "zzb-tenant-marker";
const mergeTarget = `prj_${randomUUID()}`;

/** Routes that only ever act on the calling phone: every other id, foreign or missing, is forbidden. */
const callingDeviceOnly = new Set(["PUT /api/devices/:deviceId","DELETE /api/devices/:deviceId"]);

type Account = {
  principalId: string;
  apiKey: string;
  device: { credential: string; deviceId: string };
  session: string;
  userId: string;
};

/** Identifiers each route parameter receives; `missing` holds well-formed ids that do not exist. */
type Ids = Record<string, string>;

/** Routes that take no owner resource identifier, and why they are out of the by-id attack. */
const notOwnerScopedById: Record<string, string> = {
  "GET /": "public landing",
  "GET /agents.md": "public docs",
  "GET /docs": "public docs",
  "GET /docs.md": "public docs",
  "GET /llms.txt": "public docs",
  "GET /assets/:dashboardAsset": "static Dashboard bundle",
  "GET /health/live": "health",
  "GET /health/ready": "health",
  "GET /health/browser-candidate-attestation": "health",
  "GET /cli/authorize": "page that holds a user code typed by the person",
  "GET /cli/authorize.js": "static script for the CLI authorization page",
  "GET /mobile/sign-in": "sign-in page",
  "POST /mobile/sign-in": "sign-in approval for the signed-in account",
  "POST /api/mobile/sign-in/token": "single-use code exchange",
  "GET /api/auth/*": "Better Auth",
  "POST /api/auth/*": "Better Auth",
  "GET /api/auth/get-session": "own session",
  "POST /api/auth/sign-in/email": "sign-in",
  "POST /api/auth/two-factor/verify-totp": "second sign-in step, bound to the challenge cookie",
  "POST /api/auth/two-factor/verify-backup-code": "second sign-in step, bound to the challenge cookie",
  "POST /api/auth/sign-up/email": "sign-up",
  "POST /api/dashboard/browser": "registers the calling browser's own keys for the signed-in account",
  "DELETE /api/dashboard/browser/:browserId": "the signed-in account revokes one of its own browsers; unlinkBrowser matches it by account",
  "PUT /api/dashboard/end-to-end/policy": "sets the signed-in account's own end-to-end requirement",
  "POST /api/devices/self/approvals": "approves a phone of the calling phone's own account; approveDevice matches it by account",
  "POST /api/devices/self/links": "links a browser of the calling phone's own account; linkBrowser matches it by account",
  "POST /api/device-authorizations/start": "unauthenticated CLI login start",
  "POST /api/device-authorizations/token": "device code exchange",
  "GET /api/device-authorizations/requests/:userCode": "user code is the shared secret of the login",
  "POST /api/device-authorizations/requests/:userCode/approve": "user code is the shared secret of the login",
  "POST /api/device-authorizations/requests/:userCode/deny": "user code is the shared secret of the login",
  "POST /hooks/:secret": "webhook secret identifies the service",
  "POST /hooks/:secret/live-activities": "webhook secret identifies the service",
  "POST /hooks/:secret/live-activities/resolve": "webhook secret identifies the service",
  "POST /api/devices/register": "registers the caller's own device",
  "PUT /api/devices/self/keys": "publishes the caller's own device keys; device-keys.test.ts",
  "PUT /api/clients/self/keys": "publishes the calling CLI's own identity key; device-keys.test.ts",
  "PUT /api/end-to-end/policy": "the caller's own account setting; end-to-end-policy.test.ts",
  "POST /api/account/delete": "deletes the caller's own account",
  "GET /api/inbox/events": "stream; covered by its snapshot",
  "GET /api/dashboard/server": "server admin account metadata (ADR 0004); server-accounts.test.ts",
  "PUT /api/dashboard/server/registration": "server admin setting; server-accounts.test.ts",
  "PUT /api/dashboard/server/question-wait": "server admin setting; long-question.test.ts",
  "PUT /api/dashboard/server/private-callbacks": "server admin setting; callback-destinations.test.ts",
  "POST /api/dashboard/server/accounts": "server admin creates an isolated account; server-accounts.test.ts",
  "POST /api/dashboard/server/accounts/:userId/delete": "server admin manages accounts by design; server-accounts.test.ts",
  "POST /api/dashboard/server/accounts/:userId/:action": "server admin manages accounts by design; server-accounts.test.ts",
  "DELETE /api/clients/self": "revokes the caller's own credential",
  "GET /api/session/works/:workId": "scoped in SQL to account + Relo-Session-Key; works/session-works.test.ts (foreign session and account)",
  "PATCH /api/session/works/:workId": "scoped in SQL to account + Relo-Session-Key; works/session-works.test.ts",
  "POST /api/session/works/:workId/pause": "scoped in SQL to account + Relo-Session-Key; works/session-works.test.ts",
  "POST /api/session/works/:workId/resume": "scoped in SQL to account + Relo-Session-Key; works/session-works.test.ts",
  "POST /api/session/works/:workId/finish": "scoped in SQL to account + Relo-Session-Key; works/session-works.test.ts",
  "POST /api/session/works": "creates in the caller's own session; works/session-works.test.ts",
  "GET /api/session/works": "the caller's own session; works/session-works.test.ts",
  "POST /api/producers/:producerKey/works": "creates under the calling key's own producer key; works/producer-works.test.ts",
  "GET /api/producers/:producerKey/works": "the calling key's own producer works; scoped in SQL to account + producer",
  "GET /api/producers/:producerKey/works/:workId": "scoped in SQL to account + producer key",
  "PATCH /api/producers/:producerKey/works/:workId": "scoped in SQL to account + producer key",
  "POST /api/producers/:producerKey/works/:workId/pause": "scoped in SQL to account + producer key",
  "POST /api/producers/:producerKey/works/:workId/resume": "scoped in SQL to account + producer key",
  "POST /api/producers/:producerKey/works/:workId/finish": "scoped in SQL to account + producer key",
  "POST /api/producers/:producerKey/works/:workId/heartbeat": "scoped in SQL to account + producer key",
  "POST /hooks/:secret/works": "webhook secret identifies the service",
  "GET /hooks/:secret/works": "webhook secret identifies the service; lists its own works",
};

/** Creates that name other resources in the body: B's ids must answer like missing ones. */
const bodyIdRoutes: Record<string,(values: Ids) => unknown> = {
  "POST /api/notifications": v => ({ sourceName: "A",title: "A",body: "A",deviceIds: [v.deviceId] }),
  "POST /api/interactions": v => ({ title: "A",prompt: "A?",type: "approval",deviceIds: [v.deviceId] }),
  "POST /api/live-activities": v => ({ key: "tenant-a-card",title: "A",status: "A",deviceIds: [v.deviceId] }),
  "POST /api/inbox/read-items": v => ({ notificationIds: [v.notificationId] }),
};

/** Actions on the caller's own account; running them as A must leave every row of B unchanged. */
const ownAccountRoutes: Record<string,unknown> = {
  "PUT /api/dashboard/account/live-activity-policy": {},
  "DELETE /api/dashboard/account/live-activity-policy": undefined,
  "POST /api/dashboard/users": { name: "A member",email: "member@tenant-a.example",password: "member-password-123" },
  "POST /api/dashboard/services": { title: "A dashboard service" },
  "POST /api/dashboard/live-activities/test": { deviceId: "dev_00000000-0000-4000-8000-000000000000" },
  "POST /api/dashboard/live-activities/end-all": {},
  "POST /api/dashboard/inbox/read": {},
  "POST /api/services": { title: "A service" },
  "POST /api/presentation-assets": { url: "https://127.0.0.1/a.png" },
  "POST /api/live-activities/resolve": { current: true },
  "POST /api/agent-sessions/observed": { session: "a".repeat(64),harness: "codex",phase: "open",phaseSince: new Date().toISOString(),
    lastSeenAt: new Date().toISOString(),openToolSince: null,seq: 1,computer: "tenant-a-mac" },
  "POST /api/harness-credentials": { name: "A computer hooks" },
};

suite("tenant isolation (ADR 0004)", () => {
  let db: Database;
  let authDb: Database;
  let app: ReturnType<typeof createApp>;
  let a: Account;
  let b: Account;
  const ids: Ids = {};
  const missing: Ids = {};
  const bSecrets: string[] = [];
  let aHookSecret: string;
  let bPresentation: unknown;
  let bLoginCode: string;

  beforeAll(async () => {
    resetAuthAttempts();
    db = createDatabase(databaseUrl!);
    authDb = createAuthDatabase(databaseUrl!);
    await migrate(db);
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await db.query("TRUNCATE auth.sessions, auth.accounts, auth.verifications, auth.users CASCADE");
    await db.query("UPDATE server_settings SET registration_mode='closed'");
    app = createApp(db,{
      accountAuth: createAccountAuth(authDb,appUrl,secret),
      bootstrapOwnerHandle: "tenant-a",
      credentialDerivationSecret: secret,
      appUrl,
      apnsMode: "sandbox",
    });
    a = await account("tenant-a","a");
    b = await account("tenant-b","b");
    await seedB();
    aHookSecret = await seedService(a,"tenant-a-service");
  });

  afterAll(async () => {
    // Registration mode is installation state; leave it as a fresh install has it for other suites.
    await db.query("UPDATE server_settings SET registration_mode='closed'");
    await Promise.all([db.end(),authDb.end()]);
  });

  /** A claims the server through the first sign-up; B registers its own account afterwards. */
  async function account(handle: string,letter: string): Promise<Account> {
    const apiKey = `${handle}_owner_abcdefghijklmnopqrstuvwxyz_0123456789`;
    if (letter === "a") await bootstrapOwner(db,handle,apiKey);
    else await db.query("UPDATE server_settings SET registration_mode='open'");
    const email = `${letter}@tenant.example`;
    const password = `tenant-${letter}-password-123`;
    const signup = await app.request("/api/auth/sign-up/email",{
      method: "POST",headers: { "content-type": "application/json",origin: appUrl },
      body: JSON.stringify({ name: `Tenant ${letter}`,email,password }),
    });
    expect(signup.status,await signup.clone().text()).toBe(200);
    const userId = (await signup.json() as any).user.id as string;
    const principalId = (await db.query<{ principal_id: string }>(
      "SELECT principal_id FROM account_identities WHERE subject=$1",[userId])).rows[0]!.principal_id;
    if (letter !== "a") {
      await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash) VALUES ($1,'tenant-key',$2)",
        [principalId,hashToken(apiKey)]);
    }
    const signin = await app.request("/api/auth/sign-in/email",{
      method: "POST",headers: { "content-type": "application/json",origin: appUrl },
      body: JSON.stringify({ email,password,rememberMe: true }),
    });
    expect(signin.status).toBe(200);
    return { principalId,apiKey,userId,session: signin.headers.get("set-auth-token")!,
      device: await pair(principalId,letter) };
  }

  async function pair(principalId: string,letter: string): Promise<Account["device"]> {
    const deviceId = randomUUID();
    const encryption = createTransportTokenEncryption(secret);
    await db.query(
      `INSERT INTO devices (
         id,principal_id,stable_device_id,installation_id,name,bundle_identifier,
         app_version,app_build,os_version,model,apns_environment,apns_token,
         live_activity_push_to_start_token,notification_authorization,
         live_activity_authorization,credential_version
       ) VALUES ($1,$2,$3,$4,$5,'com.example.relo.notifications',
         '1.0.0','1','18.0','iPhone','sandbox',$6,$7,'authorized','authorized',1)`,
      [deviceId,principalId,`stable-${deviceId}`,randomUUID(),
        letter === "b" ? `${MARK} phone` : "Tenant A phone",
        encryption.encrypt(letter.repeat(64).slice(0,64).replace(/[^a-f]/g,"a"),"device.apns_token"),
        encryption.encrypt("b".repeat(64),"device.live_activity_push_to_start_token")],
    );
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",
      [deviceId,hashToken(credential)]);
    return { credential,deviceId: `dev_${deviceId}` };
  }

  async function as(owner: Account,kind: "key" | "device" | "session",method: string,path: string,body?: unknown) {
    const token = kind === "key" ? owner.apiKey : kind === "device" ? owner.device.credential : owner.session;
    return await app.request(path,{
      method,
      headers: { authorization: `Bearer ${token}`,"content-type": "application/json",origin: appUrl,
        "idempotency-key": `iso-${randomUUID()}` },
      body: body === undefined || method === "GET" ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(5_000),
    });
  }

  async function ok(response: Response): Promise<any> {
    const text = await response.text();
    expect(response.status,text).toBeLessThan(300);
    return text ? JSON.parse(text) : null;
  }

  async function seedService(owner: Account,title: string): Promise<string> {
    const created = await ok(await as(owner,"key","POST","/api/services",{ title }));
    if (owner === b) ids.serviceId = created.service.id;
    return new URL(created.webhookUrl).pathname.split("/")[2]!;
  }

  async function seedB(): Promise<void> {
    const context = { project: `${MARK} project`,threadName: `${MARK} topic` };
    const notification = await ok(await as(b,"key","POST","/api/notifications",
      { sourceName: "Codex",title: `${MARK} notification`,body: `${MARK} body`,context }));
    ids.notificationId = notification.id ?? notification.notification?.id ?? notification.eventId;
    const interaction = await ok(await as(b,"key","POST","/api/interactions",
      { title: `${MARK} question`,prompt: `${MARK} prompt`,type: "approval",context }));
    ids.interactionId = interaction.interaction.id;
    ids.eventId = interaction.eventId;
    const activity = await ok(await as(b,"key","POST","/api/live-activities",
      { key: "tenant-b-card",title: `${MARK} card`,status: `${MARK} status`,context }));
    ids.activityId = activity.activity.id;
    ids.identifier = activity.activity.id;
    const detail = await ok(await as(b,"key","GET",`/api/live-activities/${activity.activity.id}`));
    bPresentation = detail.activity?.presentation ?? detail.presentation;
    expect(bPresentation,"B's card has a presentation to replay").toBeDefined();
    bSecrets.push(await seedService(b,`${MARK} service`));
    const assetId = `ast_${randomUUID().replaceAll("-","")}`;
    await db.query(
      `INSERT INTO presentation_assets(asset_id,principal_id,sha256,media_type,byte_size,pixel_width,pixel_height,content)
       VALUES ($1,$2,$3,'image/png',$5,1,1,$4)`,
      [assetId,b.principalId,createHash("sha256").update(MARK).digest("hex"),Buffer.from(MARK),Buffer.byteLength(MARK)],
    );
    ids.assetId = assetId;
    const projects = await ok(await as(b,"key","GET","/api/resources/projects"));
    const project = projects.items.find((item: any) => item.name.includes(MARK));
    expect(project,"B's project exists").toBeDefined();
    ids.projectId = project.id;
    const alias = await ok(await as(b,"session","POST",`/api/dashboard/resources/projects/${project.id}/aliases`,
      { expectedRevision: project.revision,displayName: `${MARK} alias` }));
    ids.aliasId = JSON.stringify(alias).match(/als_[0-9a-f-]{36}/i)![0];
    const deliveries = await ok(await as(b,"key","GET","/api/deliveries"));
    expect(deliveries.deliveries.length,"B has a delivery").toBeGreaterThan(0);
    ids.deliveryId = deliveries.deliveries[0].id ?? deliveries.deliveries[0].deliveryId;
    const hooks = await ok(await as(b,"key","POST","/api/harness-credentials",{ name: `${MARK} hooks` }));
    ids.harnessCredentialId = hooks.id;
    const observedAt = new Date().toISOString();
    await ok(await app.request("/api/agent-sessions/observed",{ method: "POST",
      headers: { authorization: `Bearer ${hooks.token}`,"content-type": "application/json" },
      body: JSON.stringify({ session: "b".repeat(64),harness: "codex",phase: "open",phaseSince: observedAt,lastSeenAt: observedAt,
        openToolSince: null,seq: 1,computer: `${MARK} mac`,project: `${MARK} project` }) }));
    ids.credentialId = (await ok(await as(b,"key","GET","/api/clients/self"))).credential.id;
    // B's own CLI starts signing in: its code must never reach another account.
    const login = await ok(await app.request("/api/device-authorizations/start",{
      method: "POST",headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: `${MARK} laptop`,scopes: ["notifications:send"],expiresInSeconds: 86_400 }),
    }));
    bLoginCode = login.userCode ?? login.user_code;
    expect(bLoginCode,"B's pending CLI login code").toBeTruthy();
    ids.deviceId = b.device.deviceId;
    ids.userId = b.userId;
    ids.action = "disable";
    ids.secret = "";

    for (const [name,value] of Object.entries(ids)) {
      missing[name] = name === "assetId" ? `ast_${randomUUID().replaceAll("-","")}`
        : /^[a-z]{3}_[0-9a-f-]{36}$/i.test(value)
        ? `${value.slice(0,4)}${randomUUID()}`
        : /^[0-9a-f-]{36}$/i.test(value) ? randomUUID() : value;
    }
  }

  /** Every row B owns, so any change an attack makes is visible. */
  async function bFingerprint(): Promise<Record<string,string>> {
    const owned = (await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema='public' AND column_name='principal_id' ORDER BY table_name`)).rows.map(row => row.table_name);
    const result: Record<string,string> = {};
    const digest = async (label: string,sql: string,values: unknown[]) => {
      const rows = (await db.query(sql,values)).rows.map(row => JSON.stringify(row)).sort();
      result[label] = createHash("sha256").update(rows.join("\n")).digest("hex");
    };
    for (const table of owned) {
      await digest(table,`SELECT * FROM ${table} WHERE principal_id=$1`,[b.principalId]);
    }
    await digest("device_credentials",
      "SELECT c.* FROM device_credentials c JOIN devices d ON d.id=c.device_id WHERE d.principal_id=$1",[b.principalId]);
    const viaEvent = (table: string) => digest(table,
      `SELECT t.* FROM ${table} t JOIN notification_events e ON e.id=t.notification_event_id WHERE e.principal_id=$1`,[b.principalId]);
    await viaEvent("delivery_jobs");
    await viaEvent("notification_contents");
    await viaEvent("notification_event_targets");
    await digest("delivery_attempts",
      `SELECT x.* FROM delivery_attempts x JOIN delivery_jobs j ON j.id=x.delivery_job_id
       JOIN notification_events e ON e.id=j.notification_event_id WHERE e.principal_id=$1`,[b.principalId]);
    await digest("live_activity_update_tokens",
      `SELECT t.* FROM live_activity_update_tokens t JOIN live_activities l ON l.id=t.live_activity_id
       WHERE l.principal_id=$1`,[b.principalId]);
    await digest("auth.users","SELECT * FROM auth.users WHERE id=$1",[b.userId]);
    await digest("auth.accounts","SELECT * FROM auth.accounts WHERE user_id=$1",[b.userId]);
    await digest("auth.sessions","SELECT id,token,expires_at FROM auth.sessions WHERE user_id=$1",[b.userId]);
    return result;
  }

  function fill(path: string,values: Ids,hookSecret: string): string {
    return path.replace(/:([A-Za-z]+)/g,(_,name: string) =>
      name === "secret" ? hookSecret : encodeURIComponent(values[name] ?? `unmapped-${name}`));
  }

  /** A plausible body, so a foreign id reaches the ownership check instead of stopping at validation. */
  function bodyFor(route: string): unknown {
    if (route.endsWith("/card-limit")) return { limit: 2 };
    if (route === "PATCH /api/dashboard/services/:serviceId") return { title: "A rename",imageUrl: null,destinationUrl: null };
    if (route === "POST /api/dashboard/live-activities/:activityId/update") return { presentation: bPresentation };
    if (route === "POST /api/dashboard/live-activities/:activityId/wait") return { kind: "approval",prompt: "A?" };
    if (route === "POST /api/dashboard/live-activities/:activityId/end") return { dismissAfterSeconds: 0 };
    if (route.endsWith("/reconcile")) return { action: "cancel" };
    if (route.includes("live-activity-responses")) return { notificationId: ids.eventId,deviceId: a.device.deviceId,action: "approve",
      credential: "A".repeat(43),idempotencyKey: `iso-${randomUUID()}` };
    if (route.endsWith("/heartbeat")) return { lifecycle: { provider: "codex",runId: "tenant-a-run" } };
    if (route === "POST /api/live-activities/:activityId/wait") return { type: "approval",prompt: "A?",expiresInSeconds: 120 };
    if (route.includes("/resources/projects/") && route.endsWith("/aliases")) return { expectedRevision: 1,displayName: "A alias" };
    if (route.endsWith("/merge")) return { expectedRevision: 1,targetProjectId: mergeTarget,targetExpectedRevision: 1 };
    if (route.endsWith("/split")) return { expectedRevision: 1,conversationIds: [`cnv_${randomUUID()}`],destination: { kind: "new",displayName: "A" } };
    if (route.endsWith("/restore") || route.startsWith("DELETE /api/dashboard/resources/projects/:projectId")) return { expectedRevision: 1 };
    if (route.startsWith("PATCH /api/dashboard/resources/projects/")) return { expectedRevision: 1,displayName: "A rename" };
    if (route.endsWith("/interactions")) return { kind: "approve",value: {},idempotencyKey: `iso-${randomUUID()}` };
    if (route.endsWith("/reset-password")) return { password: "attacker-password-123" };
    if (route.endsWith("/token")) return { generation: 1,nativeActivityId: "native",environment: "sandbox",token: "c".repeat(64) };
    if (route.endsWith("/live-activity-policy")) return {};
    if (route.includes("/services/")) return { title: "A rename" };
    if (route.endsWith("/devices/:deviceId/approve")) return { browserId: `brw_${randomUUID()}`,
      identityKey: Buffer.concat([Buffer.from([4]),randomBytes(64)]).toString("base64url"),signedAt: new Date().toISOString(),
      signature: randomBytes(64).toString("base64url") };
    if (route.includes("/devices/:deviceId")) return { name: "A rename" };
    if (route.endsWith("/end")) return { status: "Ended by A" };
    if (route.includes("live-activities")) return { status: "Changed by A" };
    return {};
  }

  test("every route is classified for isolation", () => {
    const unclassified = routes().filter(route =>
      !notOwnerScopedById[route] && !bodyIdRoutes[route] && !(route in ownAccountRoutes)
      && !isListRoute(route) && !isByIdRoute(route));
    expect(unclassified).toEqual([]);
  });

  test("a foreign id answers like a missing id, leaks nothing and changes nothing", async () => {
    const before = await bFingerprint();
    const failures: string[] = [];
    const reached = new Set<string>();
    const unreached: string[] = [];
    for (const route of routes().filter(isByIdRoute)) {
      const [method,path] = route.split(" ") as [string,string];
      for (const kind of ["key","device","session"] as const) {
        await db.query("DELETE FROM request_rate_limits");
        const foreign = await attempt(kind,method,fill(path,ids,aHookSecret),route);
        await db.query("DELETE FROM request_rate_limits");
        const absent = await attempt(kind,method,fill(path,missing,aHookSecret),route);
        if (foreign.status >= 200 && foreign.status < 300) {
          failures.push(`${route} as ${kind}: foreign id accepted (${foreign.status}) ${foreign.text.slice(0,160)}`);
        } else if (foreign.status !== absent.status
          || normalizedIds(foreign.text,ids) !== normalizedIds(absent.text,missing)) {
          failures.push(`${route} as ${kind}: foreign ${foreign.status} ${foreign.text.slice(0,120)} differs from missing ${absent.status} ${absent.text.slice(0,120)}`);
        }
        if (foreign.text.includes(MARK)) failures.push(`${route} as ${kind}: response contains B's content`);
        if (process.env.RELO_ISOLATION_TRACE) console.log(`TRACE ${route} ${kind} ${foreign.status} ${foreign.text.slice(0,70)}`);
        if (![400,401,403].includes(foreign.status) || foreign.status !== absent.status
          || (callingDeviceOnly.has(route) && kind === "device" && foreign.status === 403)) reached.add(route);
      }
      if (!reached.has(route)) unreached.push(route);
    }
    for (const [route,body] of Object.entries(bodyIdRoutes)) {
      const [method,path] = route.split(" ") as [string,string];
      for (const kind of ["key","device","session"] as const) {
        await db.query("DELETE FROM request_rate_limits");
        const foreign = await attempt(kind,method,path,route,body(ids));
        await db.query("DELETE FROM request_rate_limits");
        const absent = await attempt(kind,method,path,route,body(missing));
        const shape = (text: string,values: Ids) => normalizedIds(text,values).replace(/[a-z]{3}_[0-9a-f-]{36}/gi,"<new>");
        if (foreign.status !== absent.status || shape(foreign.text,ids) !== shape(absent.text,missing)) {
          failures.push(`${route} as ${kind}: B's id in body ${foreign.status} ${foreign.text.slice(0,120)} differs from missing ${absent.status} ${absent.text.slice(0,120)}`);
        }
        if (foreign.text.includes(MARK)) failures.push(`${route} as ${kind}: response contains B's content`);
      }
    }
    const after = await bFingerprint();
    const changed = Object.keys(before).filter(table => before[table] !== after[table]);
    expect({ failures,changedTablesOfB: changed,unreached })
      .toEqual({ failures: [],changedTablesOfB: [],unreached: [] });
  },120_000);

  test("actions on your own account never reach another account", async () => {
    const before = await bFingerprint();
    for (const [route,body] of Object.entries(ownAccountRoutes)) {
      const [method,path] = route.split(" ") as [string,string];
      for (const kind of ["key","device","session"] as const) {
        await db.query("DELETE FROM request_rate_limits");
        await attempt(kind,method,path,route,body);
      }
    }
    const after = await bFingerprint();
    expect(Object.keys(before).filter(table => before[table] !== after[table])).toEqual([]);
  },60_000);

  test("lists, snapshots and Dashboard pages never show another account", async () => {
    const leaks: string[] = [];
    const bIds = Object.values(ids).filter(value => value.length >= 30).map(value => value.replace(/^[a-z]{3}_/,""));
    for (const route of routes().filter(isListRoute)) {
      const path = route.split(" ")[1]!;
      for (const kind of ["key","device","session"] as const) {
        const response = await attempt(kind,"GET",path,route);
        // A page that fails proves nothing about leaks: every list must answer.
        if (response.status >= 500 || response.status === 0) leaks.push(`${route} as ${kind}: unchecked, status ${response.status}`);
        // A is the server admin: its account page lists accounts by id, name and email, never content.
        const allowed = route === "GET /dashboard/account" && kind === "session" ? [ids.userId] : [];
        const found = [MARK,bLoginCode,...bIds.filter(value => !allowed.includes(value))]
          .filter(value => response.text.includes(value));
        if (found.length) leaks.push(`${route} as ${kind}: ${found.join(", ")}`);
      }
    }
    let visibleToB = 0;
    for (const route of routes().filter(isListRoute)) {
      for (const kind of ["key","session"] as const) {
        const response = await as(b,kind,"GET",route.split(" ")[1]!).catch(() => null);
        if (response && (await response.text()).includes(MARK)) { visibleToB++; break; }
      }
    }
    expect(visibleToB,"control: B's own lists show B's content").toBeGreaterThanOrEqual(5);
    expect(leaks).toEqual([]);
  },60_000);

  function normalizedIds(text: string,values: Ids): string {
    return Object.values(values).filter(Boolean).reduce((acc,value) => acc.split(value).join("<id>"),text);
  }

  async function attempt(kind: "key" | "device" | "session",method: string,path: string,route: string,body = bodyFor(route)) {
    try {
      const response = await as(a,kind,method,path,body);
      return { status: response.status,text: await response.text() };
    } catch (error) {
      return { status: 0,text: `request did not complete: ${(error as Error).name}` };
    }
  }

  function routes(): string[] {
    return [...new Set(app.routes.filter(route => route.method !== "ALL").map(route => `${route.method} ${route.path}`))];
  }

  function isByIdRoute(route: string): boolean {
    return !notOwnerScopedById[route] && /:[A-Za-z]+/.test(route);
  }

  function isListRoute(route: string): boolean {
    return !notOwnerScopedById[route] && route.startsWith("GET ") && !route.includes(":");
  }
});
