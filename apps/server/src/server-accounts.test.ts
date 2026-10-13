import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { resetAuthAttempts } from "./auth-throttle.js";
import { createWebhookService } from "./services.js";
import { createAccountAuth } from "./account-auth.js";
import { createApp } from "./app.js";
import { generateToken,hashToken } from "./auth.js";
import { randomUUID } from "node:crypto";
import { bootstrapOwner } from "./bootstrap.js";
import { createAuthDatabase, createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

/** ADR 0004: the first account administers the server and controls who registers and keeps access. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const appUrl = "http://127.0.0.1:8180";
const secret = "test-only-server-accounts-secret-0123456789abcdef";
const json = { "content-type": "application/json",origin: appUrl };

suite("server admin and registration (ADR 0004)", () => {
  let db: Database;
  let authDb: Database;
  let app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    authDb = createAuthDatabase(databaseUrl!);
    await migrate(db);
    app = createApp(db,{
      accountAuth: createAccountAuth(authDb,appUrl,secret),
      bootstrapOwnerHandle: "owner",
      credentialDerivationSecret: secret,
      appUrl,
      apnsMode: "disabled",
    });
  });

  beforeEach(async () => {
    resetAuthAttempts();
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await db.query("TRUNCATE auth.sessions, auth.accounts, auth.verifications, auth.users CASCADE");
    await db.query("UPDATE server_settings SET registration_mode='closed'");
    await bootstrapOwner(db,"owner","bootstrap_owner_token_abcdefghijklmnopqrstuvwxyz");
  });

  afterAll(async () => {
    // Registration mode is installation state; leave it as a fresh install has it for other suites.
    await db.query("UPDATE server_settings SET registration_mode='closed'");
    await Promise.all([db.end(),authDb.end()]);
  });

  const signUp = (name: string) => app.request("/api/auth/sign-up/email",{
    method: "POST",headers: json,
    body: JSON.stringify({ name,email: `${name}@accounts.example`,password: `${name}-password-123` }),
  });
  const signIn = (name: string) => app.request("/api/auth/sign-in/email",{
    method: "POST",headers: json,
    body: JSON.stringify({ email: `${name}@accounts.example`,password: `${name}-password-123`,rememberMe: true }),
  });
  async function session(name: string): Promise<string> {
    const response = await signIn(name);
    expect(response.status,await response.clone().text()).toBe(200);
    return response.headers.get("set-auth-token")!;
  }
  const as = (token: string,method: string,path: string,body?: unknown) => app.request(path,{
    method,headers: { ...json,authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const userId = async (name: string) => (await db.query<{ id: string }>(
    "SELECT id FROM auth.users WHERE email=$1",[`${name}@accounts.example`])).rows[0]!.id;
  const principalOf = async (name: string) => (await db.query<{ principal_id: string }>(
    "SELECT principal_id FROM account_identities WHERE subject=$1",[await userId(name)])).rows[0]?.principal_id;

  async function adminAndMode(mode: "closed" | "approval" | "open"): Promise<string> {
    expect((await signUp("admin")).status).toBe(200);
    const admin = await session("admin");
    expect((await as(admin,"PUT","/api/dashboard/server/registration",{ mode })).status).toBe(200);
    return admin;
  }

  test("the first account claims the server, becomes admin, and registration starts closed", async () => {
    expect((await signUp("admin")).status).toBe(200);
    const identity = (await db.query(
      `SELECT i.server_admin,i.approved_at IS NOT NULL AS approved,p.handle
       FROM account_identities i JOIN owner_principals p ON p.id=i.principal_id`)).rows;
    expect(identity).toEqual([{ server_admin: true,approved: true,handle: "owner" }]);
    const second = await signUp("guest");
    expect(second.status).toBe(403);
    expect(await second.json()).toEqual({ error: "registration_closed" });
    expect((await db.query("SELECT count(*)::int AS n FROM auth.users")).rows[0].n).toBe(1);
  });

  test("open registration gives each person a separate, signed-in account", async () => {
    await adminAndMode("open");
    const guest = await signUp("guest");
    expect(guest.status).toBe(200);
    expect(guest.headers.get("set-auth-token")).toBeTruthy();
    expect(await principalOf("guest")).not.toBe(await principalOf("admin"));
    const dashboard = await app.request("/dashboard",{ headers: { authorization: `Bearer ${await session("guest")}` } });
    expect(dashboard.status).toBe(200);
  });

  test("approval registration waits for the admin before anyone can sign in", async () => {
    const admin = await adminAndMode("approval");
    const pending = await signUp("guest");
    expect(pending.status).toBe(202);
    expect(await pending.json()).toEqual({ status: "approval_pending" });
    expect(pending.headers.get("set-auth-token")).toBeNull();
    const refused = await signIn("guest");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "approval_pending" });
    expect((await db.query("SELECT count(*)::int AS n FROM auth.sessions WHERE user_id=$1",[await userId("guest")])).rows[0].n).toBe(0);

    const listing = await (await as(admin,"GET","/api/dashboard/server")).json() as any;
    expect(listing.registrationMode).toBe("approval");
    expect(listing.accounts.map((account: any) => [account.email,account.status,account.admin])).toEqual([
      ["admin@accounts.example","active",true],["guest@accounts.example","pending",false],
    ]);
    expect((await as(admin,"POST",`/api/dashboard/server/accounts/${await userId("guest")}/approve`,{})).status).toBe(200);
    await session("guest");
  });

  test("only the server admin reaches account administration", async () => {
    await adminAndMode("open");
    expect((await signUp("guest")).status).toBe(200);
    const guest = await session("guest");
    const adminId = await userId("admin");
    for (const [method,path,body] of [
      ["GET","/api/dashboard/server",undefined],
      ["PUT","/api/dashboard/server/registration",{ mode: "open" }],
      ["POST","/api/dashboard/server/accounts",{ name: "x",email: "x@accounts.example",password: "x-password-123" }],
      ["POST",`/api/dashboard/server/accounts/${adminId}/disable`,{}],
      ["POST",`/api/dashboard/server/accounts/${adminId}/delete`,{ confirmation: "DELETE" }],
    ] as const) {
      const response = await as(guest,method,path,body);
      expect(response.status,`${method} ${path}`).toBe(403);
      expect(await response.json()).toEqual({ error: "server_admin_required" });
    }
  });

  test("disabling revokes every credential and enabling restores them; data stays", async () => {
    const admin = await adminAndMode("open");
    expect((await signUp("guest")).status).toBe(200);
    const guest = await session("guest");
    const key = "guest_cli_key_abcdefghijklmnopqrstuvwxyz_0123456789";
    await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash) VALUES ($1,'cli',$2)",
      [await principalOf("guest"),hashToken(key)]);
    expect((await as(key,"GET","/api/clients/self")).status).toBe(200);
    const id = await userId("guest");

    expect((await as(admin,"POST",`/api/dashboard/server/accounts/${id}/disable`,{})).status).toBe(200);
    expect((await as(guest,"GET","/api/dashboard/server")).status).toBe(401);
    expect((await as(key,"GET","/api/clients/self")).status).toBe(401);
    const refused = await signIn("guest");
    expect(refused.status).toBe(403);
    expect(await refused.json()).toEqual({ error: "account_disabled" });

    expect((await as(admin,"POST",`/api/dashboard/server/accounts/${id}/enable`,{})).status).toBe(200);
    expect((await as(key,"GET","/api/clients/self")).status).toBe(200);
    await session("guest");
  });

  test("sign-out ends sessions only", async () => {
    const admin = await adminAndMode("open");
    expect((await signUp("guest")).status).toBe(200);
    const guest = await session("guest");
    expect((await as(admin,"POST",`/api/dashboard/server/accounts/${await userId("guest")}/sign-out`,{})).status).toBe(200);
    expect((await app.request("/dashboard",{ headers: { authorization: `Bearer ${guest}` } })).status).toBe(302);
    await session("guest");
  });

  test("the admin cannot lock themself out, and deleting another account removes all of it", async () => {
    const admin = await adminAndMode("open");
    expect((await signUp("guest")).status).toBe(200);
    const adminId = await userId("admin");
    for (const action of ["disable","approve","enable"]) {
      const response = await as(admin,"POST",`/api/dashboard/server/accounts/${adminId}/${action}`,{});
      expect(response.status).toBe(409);
    }
    expect((await as(admin,"POST",`/api/dashboard/server/accounts/${adminId}/delete`,{ confirmation: "DELETE" })).status).toBe(409);
    const ownDelete = await as(admin,"POST","/api/account/delete",{ password: "admin-password-123",confirmation: "DELETE" });
    expect(ownDelete.status).toBe(409);
    expect(await ownDelete.json()).toEqual({ error: "admin_has_other_accounts" });

    const guestPrincipal = await principalOf("guest");
    expect((await as(admin,"POST",`/api/dashboard/server/accounts/${await userId("guest")}/delete`,{ confirmation: "DELETE" })).status).toBe(200);
    expect((await db.query("SELECT count(*)::int AS n FROM owner_principals WHERE id=$1",[guestPrincipal])).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM auth.users WHERE email='guest@accounts.example'")).rows[0].n).toBe(0);
    expect((await db.query("SELECT count(*)::int AS n FROM owner_principals WHERE handle='owner'")).rows[0].n).toBe(1);
  });

  test("an admin-created account is separate and can sign in at once", async () => {
    const admin = await adminAndMode("closed");
    const created = await as(admin,"POST","/api/dashboard/server/accounts",
      { name: "guest",email: "guest@accounts.example",password: "guest-password-123" });
    expect(created.status).toBe(201);
    await session("guest");
    expect(await principalOf("guest")).not.toBe(await principalOf("admin"));
    const duplicate = await as(admin,"POST","/api/dashboard/server/accounts",
      { name: "guest",email: "GUEST@accounts.example",password: "guest-password-123" });
    expect(duplicate.status).toBe(409);
  });

  test("the account list carries metadata, never account content", async () => {
    const admin = await adminAndMode("open");
    expect((await signUp("guest")).status).toBe(200);
    await db.query(
      `INSERT INTO notification_events(principal_id,source,kind,title,body,payload,idempotency_key)
       VALUES ($1,'Guest','notification','private-guest-title','private-guest-body','{}'::jsonb,'guest-private')`,
      [await principalOf("guest")]);
    const listing = await (await as(admin,"GET","/api/dashboard/server")).text();
    expect(listing).not.toContain("private-guest");
    expect(Object.keys(JSON.parse(listing).accounts[1]).sort())
      .toEqual(["admin","createdAt","devices","email","id","name","sessions","status"]);
  });

  describe("account requests are Relo approvals on the admin's phone", () => {
    async function adminPhone(options: { liveActivities?: boolean } = {}): Promise<string> {
      const principalId = await principalOf("admin");
      const deviceId = randomUUID();
      await db.query(
        `INSERT INTO devices (id,principal_id,stable_device_id,installation_id,name,bundle_identifier,
           app_version,app_build,os_version,model,apns_environment,notification_authorization,
           live_activity_authorization,credential_version)
         VALUES ($1,$2,$3,$4,'Admin iPhone','com.example.relo.notifications','1.0.0','1','18.0','iPhone',
           'sandbox','authorized',$5,1)`,[deviceId,principalId,`stable-${deviceId}`,randomUUID(),
          options.liveActivities === false ? "denied" : "authorized"]);
      const credential = generateToken();
      await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[deviceId,hashToken(credential)]);
      return credential;
    }
    type Member = { eventId: string; state: string; expiresAt: Date; card: boolean; cardState: string | null };
    /** The request's decision group: its waiting notification first, then its card. */
    async function members(): Promise<Member[]> {
      const rows = (await db.query(
        `SELECT e.id,r.state,r.expires_at,e.kind,e.title,e.principal_id,s.title AS service,s.system_purpose,
           (SELECT l.state::text FROM live_activities l WHERE l.id::text=split_part(e.payload#>>'{liveActivity,activityId}','_',2)) AS card_state
         FROM account_requests a JOIN interaction_requests r ON r.decision_group_id=a.decision_group_id
         JOIN notification_events e ON e.id=r.notification_event_id
         JOIN webhook_services s ON s.id=coalesce(e.service_id,e.requester_service_id)
         WHERE a.subject=$1 ORDER BY (e.kind='live_activity'),e.created_at`,[await userId("guest")])).rows;
      for (const row of rows) {
        expect(row).toMatchObject({ principal_id: await principalOf("admin"),service: "Relo accounts",
          system_purpose: "account_requests" });
      }
      return rows.map((row: any) => ({ eventId: `ntf_${row.id}`,state: row.state,expiresAt: row.expires_at,
        card: row.kind === "live_activity",cardState: row.card_state }));
    }
    const answer = (phone: string,eventId: string,kind: "approve" | "deny") => as(phone,"POST",
      `/api/notifications/${eventId}/interactions`,{ kind,value: {},idempotencyKey: `answer-${randomUUID()}` });
    const hours = (member: Member) => (member.expiresAt.getTime() - Date.now()) / 3_600_000;

    test("a registration asks once, as a waiting notification and a question card", async () => {
      await adminAndMode("approval");
      const phone = await adminPhone();
      expect((await signUp("guest")).status).toBe(202);
      const [notification,card] = await members();
      expect(notification).toMatchObject({ card: false,state: "pending" });
      expect(hours(notification!)).toBeGreaterThan(29*24);
      expect(card).toMatchObject({ card: true,state: "pending",cardState: "active" });
      expect(hours(card!)).toBeGreaterThan(7.9);
      expect(hours(card!)).toBeLessThanOrEqual(8);
      const pendingList = await (await as(phone,"GET","/api/inbox/pending")).text();
      expect(pendingList).toContain(notification!.eventId);
      // One request counts once on the phone: its card's copy is not listed again.
      expect(pendingList).not.toContain(card!.eventId);
    });

    test("approving on the card lets the person in and the notification takes the answer", async () => {
      await adminAndMode("approval");
      const phone = await adminPhone();
      expect((await signUp("guest")).status).toBe(202);
      const [,card] = await members();
      const approved = await answer(phone,card!.eventId,"approve");
      expect(approved.status,await approved.clone().text()).toBeLessThan(300);
      const [notification,settledCard] = await members();
      expect(notification!.state).toBe("approved");
      expect(settledCard).toMatchObject({ state: "approved",cardState: "ended" });
      await session("guest");
    });

    test("denying on the notification turns access off and ends the card", async () => {
      await adminAndMode("approval");
      const phone = await adminPhone();
      expect((await signUp("guest")).status).toBe(202);
      expect((await answer(phone,(await members())[0]!.eventId,"deny")).status).toBeLessThan(300);
      const [notification,card] = await members();
      expect(notification!.state).toBe("denied");
      expect(card).toMatchObject({ state: "denied",cardState: "ended" });
      expect(await (await signIn("guest")).json()).toEqual({ error: "account_disabled" });
      expect((await answer(phone,card!.eventId,"approve")).status).toBe(409);
    });

    test("answering the card and the notification at once makes exactly one decision", async () => {
      await adminAndMode("approval");
      const phone = await adminPhone();
      for (let round = 0; round < 5; round++) {
        await db.query("DELETE FROM auth.users WHERE email='guest@accounts.example'");
        expect((await signUp("guest")).status).toBe(202);
        const [notification,card] = await members();
        const results = await Promise.all([answer(phone,notification!.eventId,"deny"),answer(phone,card!.eventId,"approve")]);
        expect(results.map(result => result.status < 300 ? "accepted" : result.status).sort()).toEqual([409,"accepted"]);
        const states = (await members()).map(member => member.state).sort();
        expect([["approved","approved"],["denied","denied"]]).toContainEqual(states);
        const access = await signIn("guest");
        expect(access.status).toBe(states.includes("approved") ? 200 : 403);
      }
    });

    test("without Live Activities the notification alone asks", async () => {
      await adminAndMode("approval");
      const phone = await adminPhone({ liveActivities: false });
      expect((await signUp("guest")).status).toBe(202);
      const group = await members();
      expect(group.map(member => member.card)).toEqual([false]);
      expect((await answer(phone,group[0]!.eventId,"approve")).status).toBeLessThan(300);
      await session("guest");
    });

    test("deciding in the Dashboard settles the notification and the card with that decision", async () => {
      const admin = await adminAndMode("approval");
      const phone = await adminPhone();
      expect((await signUp("guest")).status).toBe(202);
      const before = await members();
      expect((await as(admin,"POST",`/api/dashboard/server/accounts/${await userId("guest")}/approve`,{})).status).toBe(200);
      const after = await members();
      expect(after.map(member => [member.state,member.cardState])).toEqual([["approved",null],["approved","ended"]]);
      expect((await answer(phone,before[0]!.eventId,"deny")).status).toBe(409);
      await session("guest");
    });

    test("deleting a waiting account clears its notification and card", async () => {
      const admin = await adminAndMode("approval");
      await adminPhone();
      expect((await signUp("guest")).status).toBe(202);
      const group = (await db.query("SELECT decision_group_id FROM account_requests")).rows[0].decision_group_id;
      expect((await as(admin,"POST",`/api/dashboard/server/accounts/${await userId("guest")}/delete`,{ confirmation: "DELETE" })).status).toBe(200);
      expect((await db.query("SELECT state FROM interaction_requests WHERE decision_group_id=$1 ORDER BY state",[group])).rows
        .map((row: any) => row.state)).toEqual(["canceled","canceled"]);
    });
  });

  describe("review fixes", () => {
    test("a member the owner adds can sign in", async () => {
      const admin = await adminAndMode("closed");
      const created = await as(admin,"POST","/api/dashboard/users",
        { name: "member",email: "member@accounts.example",password: "member-password-123" });
      expect(created.status,await created.clone().text()).toBe(201);
      await session("member");
    });

    test("revoking an account's access stops its webhook services", async () => {
      const admin = await adminAndMode("open");
      expect((await signUp("guest")).status).toBe(200);
      const service = await createWebhookService(db,(await principalOf("guest"))!,"Guest service","http://127.0.0.1:8180");
      const hook = new URL(service.webhookUrl).pathname;
      const send = () => app.request(hook,{ method: "POST",headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Build",body: "Done",context: { project: "Guest app",threadName: "Builds" } }) });
      expect((await send()).status).toBeLessThan(300);
      expect((await as(admin,"POST",`/api/dashboard/server/accounts/${await userId("guest")}/disable`,{})).status).toBe(200);
      const refused = await send();
      expect(refused.status).toBe(404);
      expect(await refused.json()).toMatchObject({ error: "unknown_webhook" });
    });

    test("registration never reveals whether an email already has an account", async () => {
      await adminAndMode("approval");
      expect((await signUp("guest")).status).toBe(202);
      const requests = async () => Number((await db.query("SELECT count(*) FROM account_requests")).rows[0].count);
      expect(await requests()).toBe(1);
      const again = await signUp("guest");
      expect(again.status).toBe(202);
      expect(await again.json()).toEqual({ status: "approval_pending" });
      expect(await requests()).toBe(1);
      const existing = await signUp("admin");
      expect(existing.status).toBe(202);
      expect(await existing.json()).toEqual({ status: "approval_pending" });

      await db.query("UPDATE server_settings SET registration_mode='open'");
      const open = await signUp("admin");
      expect(open.status).toBe(400);
      const body = JSON.stringify(await open.json());
      expect(body).toContain("sign_up_failed");
      expect(body.toLowerCase()).not.toContain("exist");
    });

    test("sign-up and sign-in are throttled", async () => {
      resetAuthAttempts();
      const attempt = () => app.request("/api/auth/sign-up/email",{ method: "POST",headers: json,body: "{}" });
      for (let index = 0; index < 30; index++) expect((await attempt()).status).not.toBe(429);
      const limited = await attempt();
      expect(limited.status).toBe(429);
      expect(limited.headers.get("retry-after")).toBe("60");
      resetAuthAttempts();
    });

    test("a long name still reaches the admin as a one-line question", async () => {
      await adminAndMode("approval");
      const name = "Alexandria Wilhelmina Bartholomew-Featherstonehaugh the Third of Many Names";
      const response = await app.request("/api/auth/sign-up/email",{ method: "POST",headers: json,
        body: JSON.stringify({ name,email: "long@accounts.example",password: "long-name-password-123" }) });
      expect(response.status).toBe(202);
      const prompts = (await db.query(
        `SELECT r.prompt FROM account_requests a JOIN interaction_requests r ON r.decision_group_id=a.decision_group_id`)).rows;
      expect(prompts.length).toBeGreaterThan(0);
      for (const { prompt } of prompts) {
        expect(Array.from(prompt as string).length).toBeLessThanOrEqual(60);
        expect(prompt).toMatch(/^Let Alexandria .*… join\?$/u);
      }
    });
  });
});
