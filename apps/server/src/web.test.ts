import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { resetAuthAttempts } from "./auth-throttle.js";
import { createAccountAuth } from "./account-auth.js";
import { recoverOwnerPassword } from "./account-recovery.js";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createAuthDatabase, createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { createTransportTokenEncryption } from "./token-encryption.js";
import { lockAccountLifecycle } from "./account-lifecycle.js";
import { publicId } from "./ids.js";
import { persistedPresentationColumns } from "./presentation-runtime.js";
import { systemPresentationPolicySnapshot } from "./presentation-policy.js";
import { currentTestPresentationRecord } from "./test-current-presentation.js";

import { dashboardAuthSchema } from "@relo/notification-contracts/dashboard/auth";
import { accountDashboardBootstrapSchema } from "@relo/notification-contracts/dashboard/account";
import { documentationDashboardBootstrapSchema } from "@relo/notification-contracts/dashboard/docs";
import { connectionsDashboardBootstrapSchema } from "@relo/notification-contracts/dashboard/connections";
import { projectsDashboardBootstrapSchema } from "@relo/notification-contracts/dashboard/projects";
import { testLabBootstrapSchema } from "@relo/notification-contracts/dashboard/test-lab";
import { inboxDashboardBootstrapSchema } from "@relo/notification-contracts/dashboard/inbox";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

const dashboardContracts: Record<string,{ parse(value: unknown): unknown }> = {
  auth: dashboardAuthSchema,
  account: accountDashboardBootstrapSchema,
  docs: documentationDashboardBootstrapSchema,
  connections: connectionsDashboardBootstrapSchema,
  projects: projectsDashboardBootstrapSchema,
  "test-lab": testLabBootstrapSchema,
  "inbox-overview": inboxDashboardBootstrapSchema,
  "notification-history": inboxDashboardBootstrapSchema,
  "delivery-history": inboxDashboardBootstrapSchema,
  "notification-detail": inboxDashboardBootstrapSchema,
};

/** Extracts a page's bootstrap and checks it against the schema the React app parses it with. */
function optionalDashboardBootstrap(document: string): any | null {
  const match = document.match(
    /<script id="relo-dashboard-bootstrap" type="application\/json">([^<]*)<\/script>/,
  );
  if (!match) return null;
  const bootstrap = JSON.parse(match[1]!);
  const contract = dashboardContracts[bootstrap.kind];
  expect(contract,`a shared contract for bootstrap kind ${bootstrap.kind}`).toBeDefined();
  contract!.parse(bootstrap);
  return bootstrap;
}

function dashboardBootstrap(document: string): any {
  const bootstrap = optionalDashboardBootstrap(document);
  expect(bootstrap).not.toBeNull();
  return bootstrap;
}

function currentPresentation(overrides: Record<string, any> = {}) {
  const component = { id: "progress",type: "progress_bar",colorRole: "project",value: 0.42,label: "42%" };
  return {
        content: { header: "Relo Test Lab",title: "Composable build",subtitle: "One configured card",status: "Working" },
    identity: { project: { label: "Relo",color: "#47E8B8",icon: "build",revision: 1,
      provenance: "generated" },thread: null,direct: false },
    state: { kind: "active",tone: "live",icon: "active" },
    components: [component],
    surfaces: { lock_screen: [component.id],expanded_leading: [],expanded_trailing: [component.id],
      expanded_bottom: [component.id],compact_leading: [],compact_trailing: [component.id],minimal: [component.id] },
    behavior: { type: "progress" },
    appearance: { theme: "system",roles: {
      cardIdentity: "project",componentIdentity: "thread",statusEmphasis: "state",
    } },
    privacy: "standard",
    ...overrides,
  };
}

suite("account web authentication", () => {
  let db: Database;
  let authDb: Database;
  const secret = "test-only-better-auth-secret-0123456789abcdef";

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    authDb = createAuthDatabase(databaseUrl!);
    await migrate(db);
  });

  beforeEach(async () => {
    resetAuthAttempts();
    await db.query("TRUNCATE account_identities, principal_api_keys, owner_principals CASCADE");
    await db.query("TRUNCATE auth.sessions, auth.accounts, auth.verifications, auth.users CASCADE");
    await bootstrapOwner(db, "owner", "bootstrap_owner_token_abcdefghijklmnopqrstuvwxyz");
  });

  afterAll(async () => Promise.all([db.end(), authDb.end()]));

  function app() {
    return createApp(db, {
      accountAuth: createAccountAuth(authDb, "http://127.0.0.1:8180", secret),
      bootstrapOwnerHandle: "owner",
      credentialDerivationSecret: secret,
      appUrl: "http://127.0.0.1:8180",
      apnsMode: "disabled",
    });
  }

  async function createOwnerAndSession(): Promise<{ token: string; application: ReturnType<typeof app> }> {
    const application = app();
    const signup = await application.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8180" },
      body: JSON.stringify({ name: "Relo Owner", email: "owner@example.com", password: "unique-test-password" }),
    });
    expect(signup.status).toBe(200);
    const signin = await application.request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8180" },
      body: JSON.stringify({ email: "owner@example.com", password: "unique-test-password", rememberMe: true }),
    });
    expect(signin.status).toBe(200);
    return { token: signin.headers.get("set-auth-token")!, application };
  }

  test("account delivery status uses the account session and reports configured transport truth", async () => {
    const anonymous = await app().request("/api/account/deliveries/status");
    expect(anonymous.status).toBe(401);

    const { token, application } = await createOwnerAndSession();
    const response = await application.request("/api/account/deliveries/status", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(await response.json()).toEqual({
      apns: {
        mode: "disabled",
        remoteEnqueueEnabled: false,
        providerCredentialActive: false,
        deliverySemantics: "durable_inbox_refresh_only",
      },
    });
  });

  test("mobile account session withdraws an ordinary notification idempotently", async () => {
    const { token, application } = await createOwnerAndSession();
    const principal = (await db.query<{ id: string }>(
      "SELECT id FROM owner_principals WHERE handle='owner'",
    )).rows[0]!.id;
    const event = (await db.query<{ id: string }>(
      `INSERT INTO notification_events(
         principal_id,source,kind,title,body,payload,idempotency_key
       ) VALUES ($1,'Mobile','notification','Withdraw me','Body','{}'::jsonb,$2)
       RETURNING id`,
      [principal,`mobile-withdraw-${Date.now()}`],
    )).rows[0]!;
    const path = `/api/account/notifications/${publicId("ntf",event.id)}/withdraw`;
    const headers = { authorization: `Bearer ${token}` };

    const first = await application.request(path,{ method: "POST",headers });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ state: "withdrawn",replayed: false });
    const replay = await application.request(path,{ method: "POST",headers });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ state: "withdrawn",replayed: true });
  });

  test("first sign-up claims the owner and protects the dashboard", async () => {
    const anonymous = await app().request("/dashboard");
    expect(anonymous.status).toBe(302);
    expect(anonymous.headers.get("location")).toContain("/?next=");
    const authorizeRedirect = await app().request("/cli/authorize?code=ABCD-EFGH");
    expect(authorizeRedirect.status).toBe(302);
    const login = await app().request(authorizeRedirect.headers.get("location")!);
    expect(optionalDashboardBootstrap(await login.text())).toMatchObject({
      kind: "auth",route: { nextPath: "/cli/authorize?code=ABCD-EFGH" },
    });
    const externalNext = await app().request("/?next=https%3A%2F%2Fevil.example%2F");
    expect(optionalDashboardBootstrap(await externalNext.text())).toMatchObject({
      kind: "auth",route: { nextPath: "/dashboard" },
    });

    const signup = await app().request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8180" },
      body: JSON.stringify({ name: "Relo Owner", email: "owner@example.com", password: "unique-test-password" }),
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toContain("better-auth.session_token=");
    expect((await db.query("SELECT count(*)::int AS count FROM account_identities")).rows[0].count).toBe(1);

    const dashboard = await app().request("/dashboard", { headers: { cookie: cookie! } });
    expect(dashboard.status).toBe(200);
    expect(await dashboard.text()).toContain("Inbox");

    const second = await app().request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8180" },
      body: JSON.stringify({ name: "Second", email: "second@example.com", password: "another-unique-password" }),
    });
    expect(second.status).toBe(403);
    expect(await second.json()).toEqual({ error: "registration_closed" });
  });

  test("concurrent first sign-ups are serialized by PostgreSQL and failed owner mapping leaves no orphan user", async () => {
    const signup = (application: ReturnType<typeof app>,email: string) => application.request("/api/auth/sign-up/email",{
      method: "POST",
      headers: { "content-type": "application/json",origin: "http://127.0.0.1:8180" },
      body: JSON.stringify({ name: email,email,password: "concurrent-test-password" }),
    });
    const responses = await Promise.all([
      signup(app(),"first@example.com"),
      signup(app(),"second@example.com"),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([200,403]);
    expect((await db.query("SELECT count(*)::int AS count FROM auth.users")).rows[0].count).toBe(1);
    expect((await db.query("SELECT count(*)::int AS count FROM account_identities")).rows[0].count).toBe(1);

    await db.query("TRUNCATE account_identities, principal_api_keys, owner_principals CASCADE");
    await db.query("TRUNCATE auth.sessions, auth.accounts, auth.verifications, auth.users CASCADE");
    const missingShell = await signup(app(),"orphan@example.com");
    expect(missingShell.status).toBe(503);
    expect(await missingShell.json()).toEqual({ error: "owner_not_bootstrapped" });
    expect((await db.query("SELECT count(*)::int AS count FROM auth.users")).rows[0].count).toBe(0);
  });

  test("exceptional owner-mapping failure compensates the separately committed auth identity", async () => {
    await db.query(`CREATE OR REPLACE FUNCTION reject_test_account_mapping() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'test account mapping failure'; END $$ LANGUAGE plpgsql`);
    await db.query(`CREATE TRIGGER reject_test_account_mapping
      BEFORE INSERT ON account_identities FOR EACH ROW EXECUTE FUNCTION reject_test_account_mapping()`);
    try {
      const response = await app().request("/api/auth/sign-up/email",{
        method: "POST",
        headers: { "content-type": "application/json",origin: "http://127.0.0.1:8180" },
        body: JSON.stringify({ name: "Orphan Test",email: "orphan@example.com",password: "orphan-test-password" }),
      });
      expect(response.status).toBe(500);
      expect((await db.query("SELECT count(*)::int AS count FROM auth.users")).rows[0].count).toBe(0);
      expect((await db.query("SELECT count(*)::int AS count FROM account_identities")).rows[0].count).toBe(0);
    } finally {
      await db.query("DROP TRIGGER IF EXISTS reject_test_account_mapping ON account_identities");
      await db.query("DROP FUNCTION IF EXISTS reject_test_account_mapping()");
    }
  });

  test("non-OK Better Auth completion compensates a user created before account-link failure", async () => {
    await db.query(`CREATE OR REPLACE FUNCTION reject_test_auth_account() RETURNS trigger AS $$
      BEGIN RAISE EXCEPTION 'test auth account failure'; END $$ LANGUAGE plpgsql`);
    await db.query(`CREATE TRIGGER reject_test_auth_account
      BEFORE INSERT ON auth.accounts FOR EACH ROW EXECUTE FUNCTION reject_test_auth_account()`);
    try {
      const response = await app().request("/api/auth/sign-up/email",{
        method: "POST",
        headers: { "content-type": "application/json",origin: "http://127.0.0.1:8180" },
        body: JSON.stringify({ name: "Auth Failure",email: "auth-failure@example.com",password: "auth-failure-password" }),
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect((await db.query("SELECT count(*)::int AS count FROM auth.users")).rows[0].count).toBe(0);
      expect((await db.query("SELECT count(*)::int AS count FROM auth.accounts")).rows[0].count).toBe(0);
      expect((await db.query("SELECT count(*)::int AS count FROM account_identities")).rows[0].count).toBe(0);
    } finally {
      await db.query("DROP TRIGGER IF EXISTS reject_test_auth_account ON auth.accounts");
      await db.query("DROP FUNCTION IF EXISTS reject_test_auth_account()");
    }
  });

  test("malformed successful signup response compensates an unmapped identity before an ID is decoded", async () => {
    const malformedAuth = {
      ...createAccountAuth(authDb,"http://127.0.0.1:8180",secret),
      handler: async () => {
        await authDb.query(
          `INSERT INTO auth.users(id,name,email) VALUES ($1,$2,$3)`,
          ["malformed-response-user","Malformed Response","malformed@example.com"],
        );
        return Response.json({ user: {} },{ status: 200 });
      },
    } as ReturnType<typeof createAccountAuth>;
    const application = createApp(db,{
      accountAuth: malformedAuth,
      bootstrapOwnerHandle: "owner",
      credentialDerivationSecret: secret,
      appUrl: "http://127.0.0.1:8180",
      apnsMode: "disabled",
    });
    const response = await application.request("/api/auth/sign-up/email",{
      method: "POST",
      headers: { "content-type": "application/json",origin: "http://127.0.0.1:8180" },
      body: JSON.stringify({ name: "Malformed Response",email: "malformed@example.com",password: "malformed-response-password" }),
    });
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "account_setup_failed" });
    expect((await db.query("SELECT count(*)::int AS count FROM auth.users")).rows[0].count).toBe(0);
    expect((await db.query("SELECT count(*)::int AS count FROM account_identities")).rows[0].count).toBe(0);
  });

  test("new CLI authorization requests share the account lifecycle lock", async () => {
    const application = app();
    const locker = await db.connect();
    await locker.query("BEGIN");
    await lockAccountLifecycle(locker);
    let settled = false;
    const pending = application.request("/api/device-authorizations/start",{
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientName: "Lifecycle lock test",
        scopes: ["notifications:send"],
        expiresInSeconds: 3600,
      }),
    }).then((response) => { settled = true; return response; });
    await new Promise((resolve) => setTimeout(resolve,50));
    expect(settled).toBe(false);
    await locker.query("COMMIT");
    locker.release();
    expect((await pending).status).toBe(201);
  });

  test("email sign-in exposes a mobile bearer session validated by get-session", async () => {
    await app().request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8180" },
      body: JSON.stringify({ name: "Relo Owner", email: "owner@example.com", password: "unique-test-password" }),
    });
    const signin = await app().request("/api/auth/sign-in/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8180" },
      body: JSON.stringify({ email: "owner@example.com", password: "unique-test-password", rememberMe: true }),
    });
    expect(signin.status).toBe(200);
    const token = signin.headers.get("set-auth-token");
    expect(token).toBeTruthy();

    const session = await app().request("/api/auth/get-session", {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(session.status).toBe(200);
    expect((await session.json() as { user: { email: string } }).user.email).toBe("owner@example.com");
    expect((await app().request("/api/auth/get-session", { headers: { authorization: "Bearer invalid" } })).status).toBe(401);
    const missingRememberMe = await app().request("/api/auth/sign-in/email", {
      method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:8180" },
      body: JSON.stringify({ email: "owner@example.com", password: "unique-test-password" }),
    });
    expect(missingRememberMe.status).toBe(400);
  });

  test("browser sign-out accepts JSON and invalidates the dashboard session", async () => {
    const application = app();
    const signup = await application.request("/api/auth/sign-up/email", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8180" },
      body: JSON.stringify({ name: "Relo Owner", email: "owner@example.com", password: "unique-test-password" }),
    });
    expect(signup.status).toBe(200);
    const cookie = signup.headers.get("set-cookie")?.split(";")[0];
    expect(cookie).toBeTruthy();

    const signout = await application.request("/api/auth/sign-out", {
      method: "POST",
      headers: {
        cookie: cookie!,
        "content-type": "application/json",
        origin: "http://127.0.0.1:8180",
      },
      body: "{}",
    });
    expect(signout.status).toBe(200);
    expect(await signout.json()).toEqual({ success: true });
    expect((await application.request("/dashboard", { headers: { cookie: cookie! } })).status).toBe(302);
  });

  test("protected owner recovery rotates the password and revokes every session", async () => {
    const { token, application } = await createOwnerAndSession();
    const result = await recoverOwnerPassword(db,"owner","recovered-test-password");
    expect(result.sessionsRevoked).toBeGreaterThan(0);
    expect((await application.request("/api/auth/get-session",{
      headers: { authorization: `Bearer ${token}` },
    })).status).toBe(401);
    const oldPassword = await application.request("/api/auth/sign-in/email",{
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8180" },
      body: JSON.stringify({ email: "owner@example.com", password: "unique-test-password", rememberMe: true }),
    });
    expect(oldPassword.status).toBe(401);
    const recovered = await application.request("/api/auth/sign-in/email",{
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://127.0.0.1:8180" },
      body: JSON.stringify({ email: "owner@example.com", password: "recovered-test-password", rememberMe: true }),
    });
    expect(recovered.status).toBe(200);
  });

  test("account deletion requires explicit confirmation and password, erases active data, and permits a clean reclaim", async () => {
    const { token, application } = await createOwnerAndSession();
    const headers = {
      authorization: `Bearer ${token}`,
      origin: "http://127.0.0.1:8180",
      "content-type": "application/json",
    };
    const owner = await db.query<{ id: string }>("SELECT id FROM owner_principals WHERE handle='owner'");
    await db.query(
      `INSERT INTO notification_events(principal_id,source,kind,title,body,payload,idempotency_key)
       VALUES ($1,'Account test','notification','Delete me','Stored history','{}'::jsonb,'account-delete-test')`,
      [owner.rows[0]!.id],
    );

    const crossOrigin = await application.request("/api/account/delete",{
      method: "POST",
      headers: { ...headers, origin: "http://evil.example" },
      body: JSON.stringify({ password: "unique-test-password", confirmation: "DELETE" }),
    });
    expect(crossOrigin.status).toBe(403);
    const wrongPassword = await application.request("/api/account/delete",{
      method: "POST",headers,
      body: JSON.stringify({ password: "incorrect-test-password", confirmation: "DELETE" }),
    });
    expect(wrongPassword.status).toBe(401);
    expect(await wrongPassword.json()).toEqual({ error: "invalid_password" });
    expect((await db.query("SELECT count(*)::int AS count FROM auth.users")).rows[0].count).toBe(1);

    const deleted = await application.request("/api/account/delete",{
      method: "POST",headers,
      body: JSON.stringify({ password: "unique-test-password", confirmation: "DELETE" }),
    });
    expect(deleted.status).toBe(200);
    expect(await deleted.json()).toEqual({ ok: true });
    expect((await db.query("SELECT count(*)::int AS count FROM auth.users")).rows[0].count).toBe(0);
    expect((await db.query("SELECT count(*)::int AS count FROM account_identities")).rows[0].count).toBe(0);
    expect((await db.query("SELECT count(*)::int AS count FROM notification_events")).rows[0].count).toBe(0);
    expect((await db.query("SELECT count(*)::int AS count FROM owner_principals WHERE handle='owner' AND disabled_at IS NULL")).rows[0].count).toBe(1);
    expect((await application.request("/api/auth/get-session",{
      headers: { authorization: `Bearer ${token}` },
    })).status).toBe(401);

    const reclaimed = await application.request("/api/auth/sign-up/email",{
      method: "POST",
      headers: { "content-type": "application/json",origin: "http://127.0.0.1:8180" },
      body: JSON.stringify({ name: "New Owner",email: "new-owner@example.com",password: "replacement-test-password" }),
    });
    expect(reclaimed.status).toBe(200);
    expect((await db.query("SELECT count(*)::int AS count FROM account_identities")).rows[0].count).toBe(1);
  });

  test("mobile registration is account-authorized, idempotent, rotating, and independently revocable", async () => {
    const { token: sessionToken, application } = await createOwnerAndSession();
    const registration = {
      stableDeviceId: "stable-mobile-test",
      installationId: "install-mobile-test",
      name: "Owner iPhone",
      bundleIdentifier: "com.example.relo.notifications",
      appVersion: "1.0.0",
      appBuild: "1",
      osVersion: "18.0",
      model: "iPhone",
      apnsEnvironment: "sandbox",
      notificationAuthorization: "pending",
      liveActivityAuthorization: "pending",
    };
    const submit = (key: string, body: object, authorization = `Bearer ${sessionToken}`) => application.request("/api/devices/register", {
      method: "POST",
      headers: { authorization, "content-type": "application/json", "idempotency-key": key },
      body: JSON.stringify(body),
    });

    expect((await submit("anonymous", registration, "")).status).toBe(401);
    expect((await submit("machine", registration, "Bearer bootstrap_owner_token_abcdefghijklmnopqrstuvwxyz")).status).toBe(401);
    expect((await submit("pairing-field", { ...registration, pairingCode: "REJECT-ME" })).status).toBe(400);
    expect((await submit(" ",registration)).status).toBe(400);
    expect((await submit("x".repeat(201),registration)).status).toBe(400);
    const first = await submit("x", registration);
    expect(first.status).toBe(200);
    const firstBody = await first.json() as any;
    expect(firstBody.device.credentialVersion).toBe(1);
    expect(firstBody.credential.accessToken).toMatch(/^relo_/);
    expect(firstBody).not.toHaveProperty("compatibility");

    const replay = await submit("x", registration);
    expect(replay.status).toBe(200);
    expect((await replay.json() as any).credential.accessToken).toBe(firstBody.credential.accessToken);
    expect((await db.query("SELECT count(*)::int AS count FROM devices")).rows[0].count).toBe(1);
    expect((await db.query("SELECT count(*)::int AS count FROM device_credentials")).rows[0].count).toBe(1);

    const conflict = await submit("x", { ...registration, appBuild: "2" });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ error: "idempotency_conflict" });

    const rotated = await submit("ios-register:install-mobile-test:2", { ...registration, appBuild: "2" });
    const rotatedBody = await rotated.json() as any;
    expect(rotatedBody.device.credentialVersion).toBe(2);
    expect(rotatedBody.credential.accessToken).not.toBe(firstBody.credential.accessToken);
    expect((await application.request("/api/devices/self", { headers: { authorization: `Bearer ${firstBody.credential.accessToken}` } })).status).toBe(401);
    const self = await application.request("/api/devices/self", { headers: { authorization: `Bearer ${rotatedBody.credential.accessToken}` } });
    expect(self.status).toBe(200);
    expect((await self.json() as any).account.accountId).toBe(firstBody.account.accountId);

    const revoked = await application.request(`/api/devices/${rotatedBody.device.deviceId}`, {
      method: "DELETE", headers: { authorization: `Bearer ${rotatedBody.credential.accessToken}` },
    });
    expect(revoked.status).toBe(204);
    expect((await application.request("/api/devices/self", { headers: { authorization: `Bearer ${rotatedBody.credential.accessToken}` } })).status).toBe(401);
    expect((await db.query<any>("SELECT credential_version FROM devices WHERE id=$1",[
      rotatedBody.device.deviceId.slice("dev_".length),
    ])).rows[0].credential_version).toBe(3);
    const staleReplay = await submit("ios-register:install-mobile-test:2", { ...registration, appBuild: "2" });
    expect(staleReplay.status).toBe(409);
    expect(await staleReplay.json()).toEqual({ error: "idempotency_conflict" });
    const repaired = await submit("ios-register:install-mobile-test:3", { ...registration, appBuild: "3" });
    expect((await repaired.json() as any).device.credentialVersion).toBe(4);
    expect((await application.request("/api/auth/get-session", { headers: { authorization: `Bearer ${sessionToken}` } })).status).toBe(200);
    await db.query("UPDATE owner_principals SET disabled_at=now() WHERE handle='owner'");
    expect((await submit("disabled-account", registration)).status).toBe(403);
  });

  test("CLI device authorization requires explicit same-origin approval and exchanges once", async () => {
    const { token: sessionToken, application } = await createOwnerAndSession();
    const start = await application.request("/api/device-authorizations/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        clientName: "Test Mac Codex",
        scopes: ["notifications:send", "interactions:read", "interactions:create"],
        expiresInSeconds: 7_776_000,
      }),
    });
    expect(start.status).toBe(201);
    const grant = await start.json() as any;
    expect(grant.deviceCode).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(grant.userCode).toMatch(/^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}-[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{4}$/);
    expect(grant.verificationUriComplete).toBe(`http://127.0.0.1:8180/cli/authorize?code=${grant.userCode}`);
    expect(grant.expiresInSeconds).toBe(600);
    expect(grant.intervalSeconds).toBe(5);

    const page = await application.request(`/cli/authorize?code=${grant.userCode}`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(page.status).toBe(200);
    const pageHtml = await page.text();
    expect(pageHtml).toContain("Signing in does not authorize this request");
    expect(pageHtml).toContain("Waiting for the CLI to connect");
    expect(pageHtml).toContain("Connected successfully");
    expect(pageHtml).toContain("scheduleRefresh");
    expect((await db.query("SELECT status FROM device_authorizations WHERE user_code=$1", [grant.userCode])).rows[0].status).toBe("pending");

    const inspection = await application.request(`/api/device-authorizations/requests/${grant.userCode.replace("-", " ")}`, {
      headers: { authorization: `Bearer ${sessionToken}` },
    });
    expect(inspection.status).toBe(200);
    expect((await inspection.json() as any).request.scopes).toEqual(["interactions:create", "interactions:read", "notifications:send"]);

    const foreign = await application.request(`/api/device-authorizations/requests/${grant.userCode}/approve`, {
      method: "POST", headers: { authorization: `Bearer ${sessionToken}`, origin: "http://evil.example" },
    });
    expect(foreign.status).toBe(403);

    const approved = await application.request(`/api/device-authorizations/requests/${grant.userCode}/approve`, {
      method: "POST", headers: { authorization: `Bearer ${sessionToken}`, origin: "http://127.0.0.1:8180" },
    });
    expect(approved.status).toBe(200);
    expect((await approved.json() as any).status).toBe("approved");

    const poll = () => application.request("/api/device-authorizations/token", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode: grant.deviceCode }),
    });
    const [left, right] = await Promise.all([poll(), poll()]);
    const success = left.status === 200 ? left : right;
    const replay = left.status === 200 ? right : left;
    expect(success.status).toBe(200);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toEqual({ error: "invalid_grant" });
    const issued = await success.json() as any;
    expect(issued.accessToken).toMatch(/^relo_/);
    expect(issued.credential.clientName).toBe("Test Mac Codex");
    expect(issued.credential.scopes).toEqual(["interactions:create", "interactions:read", "notifications:send"]);

    const status = await application.request("/api/clients/self", { headers: { authorization: `Bearer ${issued.accessToken}` } });
    expect(status.status).toBe(200);
    expect((await status.json() as any).authenticated).toBe(true);
    const revoke = await application.request("/api/clients/self", { method: "DELETE", headers: { authorization: `Bearer ${issued.accessToken}` } });
    expect(revoke.status).toBe(200);
    expect((await revoke.json() as any).credentialId).toBe(issued.credential.id);
    const repeatedRevoke = await application.request("/api/clients/self", { method: "DELETE", headers: { authorization: `Bearer ${issued.accessToken}` } });
    expect(repeatedRevoke.status).toBe(200);
    expect(await repeatedRevoke.json()).toEqual({ revoked: true, credentialId: issued.credential.id });
    expect((await application.request("/api/clients/self", { headers: { authorization: `Bearer ${issued.accessToken}` } })).status).toBe(401);
  });

  test("CLI polling enforces pending, slow-down, denial, and request schema", async () => {
    const { token: sessionToken, application } = await createOwnerAndSession();
    await db.query(
      `INSERT INTO device_authorizations(
         device_code_hash,user_code,client_name,requested_scopes,status,
         expires_at,credential_expires_at,resolved_at
       ) VALUES ($1,'OLD1-CODE','Expired audit row',ARRAY['notifications:send'],'denied',
         now()-interval '26 hours',now()+interval '1 hour',now()-interval '25 hours')`,
      ["d".repeat(64)],
    );
    const invalid = await application.request("/api/device-authorizations/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "Bad", scopes: ["devices:read"], expiresInSeconds: 3_600, extra: true }),
    });
    expect(invalid.status).toBe(400);

    const explicitNonDefault = await application.request("/api/device-authorizations/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "Admin-capable client", scopes: ["devices:read", "services:write"], expiresInSeconds: 3_600 }),
    });
    expect(explicitNonDefault.status).toBe(201);
    expect((await db.query("SELECT 1 FROM device_authorizations WHERE user_code='OLD1-CODE'")).rowCount).toBe(0);

    const start = await application.request("/api/device-authorizations/start", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "Denied Client", scopes: ["notifications:send"], expiresInSeconds: 3_600 }),
    });
    const grant = await start.json() as any;
    const poll = () => application.request("/api/device-authorizations/token", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ deviceCode: grant.deviceCode }),
    });
    const pending = await poll();
    expect(await pending.json()).toEqual({ error: "authorization_pending", intervalSeconds: 5 });
    const early = await poll();
    expect(await early.json()).toEqual({ error: "slow_down", intervalSeconds: 10 });
    const denied = await application.request(`/api/device-authorizations/requests/${grant.userCode}/deny`, {
      method: "POST", headers: { authorization: `Bearer ${sessionToken}`, origin: "http://127.0.0.1:8180" },
    });
    expect(denied.status).toBe(200);
    expect(await (await poll()).json()).toEqual({ error: "access_denied" });
  });

  test("dashboard manages escaped devices, clients, services, notifications, and activities", async () => {
    const { token: sessionToken, application } = await createOwnerAndSession();
    const headers = { authorization: `Bearer ${sessionToken}`, origin: "http://127.0.0.1:8180" };
    const registered = await application.request("/api/devices/register", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "dashboard-hostile-device-1" },
      body: JSON.stringify({
        stableDeviceId: "dashboard-stable", installationId: "dashboard-install",
        name: `<img src=x onerror="device()">`, bundleIdentifier: "com.example.relo.notifications",
        appVersion: "1", appBuild: "1", osVersion: "18", model: `<svg/onload='model()'>`,
        apnsEnvironment: "sandbox", apnsToken: "a".repeat(64), notificationAuthorization: "authorized",
        liveActivityAuthorization: "authorized",
      }),
    });
    const registeredBody = await registered.json() as any;
    const registeredToken = await db.query<{ apns_token: string }>(
      "SELECT apns_token FROM devices WHERE id=$1",
      [registeredBody.device.deviceId.slice("dev_".length)],
    );
    expect(registeredToken.rows[0]!.apns_token).not.toBe("a".repeat(64));
    expect(createTransportTokenEncryption(secret).decrypt(
      registeredToken.rows[0]!.apns_token,"device.apns_token",
    )).toBe("a".repeat(64));
    const owner = await db.query<{ id: string }>("SELECT id FROM owner_principals WHERE handle='owner'");
    const credential = await db.query<{ id: string }>(
      `INSERT INTO principal_api_keys(principal_id,label,token_hash,token_prefix,scopes)
       VALUES ($1,$2,$3,'relo_safe',ARRAY['notifications:send']) RETURNING id`,
      [owner.rows[0]!.id,`<b onclick="client()">Client</b>`,`f`.repeat(64)],
    );
    await db.query(
      `INSERT INTO notification_events(principal_id,source,title,body,idempotency_key)
       VALUES ($1,$2,$3,'body','dashboard-notification')`,
      [owner.rows[0]!.id,`<source onload="x">`,`<script>notify()</script>`],
    );
    const dashboardFixture = currentPresentation();
    const dashboardStored = persistedPresentationColumns({
      ...dashboardFixture,
      content: {
        ...dashboardFixture.content,
        title: `<img onerror='activity()'>`,
        status: `<status>`,
      },
    });
    const dashboardPolicy = systemPresentationPolicySnapshot("system.test.dashboard");
    await db.query(
      `INSERT INTO live_activities(
         principal_id,activity_key,title,status,detail,progress,symbol,style,privacy,accent_color,
         presentation,presentation_sha256,presentation_policy,presentation_policy_source,
         presentation_preset_id,presentation_preset_revision,start_idempotency_key
       ) VALUES ($1,'dashboard-activity',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15,
         'dashboard-activity-start')`,
      [owner.rows[0]!.id,dashboardStored.title,dashboardStored.status,dashboardStored.detail,
        dashboardStored.progress,dashboardStored.symbol,dashboardStored.style,dashboardStored.privacy,
        dashboardStored.accentColor,dashboardStored.presentation,dashboardStored.presentationHash,
        dashboardPolicy,dashboardPolicy.source,dashboardPolicy.presetId,dashboardPolicy.presetRevision],
    );

    const foreignCreate = await application.request("/api/dashboard/services", {
      method: "POST", headers: { authorization: `Bearer ${sessionToken}`, origin: "http://evil.example", "content-type": "application/json" },
      body: JSON.stringify({ title: "Rejected" }),
    });
    expect(foreignCreate.status).toBe(403);
    const created = await application.request("/api/dashboard/services", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        title: `<iframe srcdoc="service()">`,
        imageUrl: "https://images.example.test/avatar.png?size=80&fit=crop",
        destinationUrl: "https://example.test/original",
      }),
    });
    expect(created.status).toBe(201);
    const service = await created.json() as any;
    expect(service.webhookUrl).toMatch(/\/hooks\/hook_[A-Za-z0-9_-]{43}$/);
    const updatedService = await application.request(`/api/dashboard/services/${service.service.id}`, {
      method: "PATCH", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({
        title: `<iframe srcdoc="updated-service()">`, imageUrl: null,
        destinationUrl: "https://example.test/updated?from=dashboard&mode=default",
      }),
    });
    expect(updatedService.status).toBe(200);
    expect(await updatedService.json()).toMatchObject({ service: {
      id: service.service.id, title: `<iframe srcdoc="updated-service()">`, imageUrl: null,
      destinationUrl: "https://example.test/updated?from=dashboard&mode=default",
    } });
    const webhook = await application.request(new URL(service.webhookUrl).pathname, {
      method: "POST", headers: { "content-type": "application/json", "idempotency-key": "dashboard-webhook-1" },
      body: JSON.stringify({ body: "Webhook body", title: "Webhook title" }),
    });
    expect(webhook.status).toBe(201);

    const externalPresentation = currentTestPresentationRecord();
    const externallyOwnedActivities = await db.query<{ id: string; title: string }>(
      `INSERT INTO live_activities(
         principal_id,requester_service_id,requester_credential_id,activity_key,title,status,
         target_device_ids,start_idempotency_key,presentation,presentation_sha256,
         presentation_policy,presentation_policy_source,presentation_preset_id,presentation_preset_revision
       ) VALUES
         ($1,$2,NULL,'service-owned-dashboard-guard','Service-owned activity','Running',ARRAY[$4::uuid],
          'service-owned-dashboard-start',$5::jsonb,$6,$7::jsonb,$8,$9,$10),
         ($1,NULL,$3,'credential-owned-dashboard-guard','Credential-owned activity','Running',ARRAY[$4::uuid],
          'credential-owned-dashboard-start',$5::jsonb,$6,$7::jsonb,$8,$9,$10)
       RETURNING id,title`,
      [owner.rows[0]!.id,service.service.id.slice("svc_".length),credential.rows[0]!.id,
        registeredBody.device.deviceId.slice("dev_".length),externalPresentation.presentation,
        externalPresentation.presentationHash,externalPresentation.presentationPolicy,
        externalPresentation.presentationPolicySource,externalPresentation.presentationPresetId,
        externalPresentation.presentationPresetRevision],
    );
    for (const externalActivity of externallyOwnedActivities.rows) {
      const id = `act_${externalActivity.id}`;
      const mutationHeaders = { ...headers,"content-type": "application/json" };
      expect((await application.request(`/api/dashboard/live-activities/${id}/update`,{
        method: "POST",headers: mutationHeaders,body: JSON.stringify({ presentation: currentPresentation({
          content: { header: "Relo",title: "Dashboard takeover",subtitle: null,status: "Working" },
        }) }),
      })).status).toBe(409);
      expect((await application.request(`/api/dashboard/live-activities/${id}/wait`,{
        method: "POST",headers: mutationHeaders,body: JSON.stringify({ kind: "approval",prompt: "Dashboard takeover?" }),
      })).status).toBe(409);
      expect((await application.request(`/api/dashboard/live-activities/${id}/end`,{
        method: "POST",headers: mutationHeaders,body: JSON.stringify({ dismissAfterSeconds: 0 }),
      })).status).toBe(409);
      expect((await application.request(`/api/dashboard/live-activities/${id}/status`,{ headers })).status).toBe(404);
    }

    const parseTestLabBootstrap = (document: string): any => {
      const payload = JSON.stringify(dashboardBootstrap(document));
      for (const forbidden of [
        secret,
        "a".repeat(64),
        registeredBody.credential.accessToken,
        service.webhookUrl,
        "bootstrap_owner_token_abcdefghijklmnopqrstuvwxyz",
      ]) expect(payload).not.toContain(forbidden);
      expect(payload).not.toMatch(
        /"(?:accessToken|apnsToken|credentialDerivationSecret|requester_credential_id|requester_service_id|secret|tokenHash)"\s*:/i,
      );
      return JSON.parse(payload);
    };
    const sectionPaths = [
      "", "/inbox/notifications", "/inbox/delivery", "/connections", "/account", "/docs",
    ];
    const pages = new Map<string,string>();
    for (const suffix of sectionPaths) {
      const response = await application.request(`/dashboard${suffix}`, { headers });
      expect(response.status,`dashboard route ${suffix || "/"}`).toBe(200);
      expect(response.headers.get("cache-control")).toBe("private, no-store");
      const text = await response.text();
      const bootstrap = optionalDashboardBootstrap(text);
      expect(bootstrap,`dashboard route ${suffix || "/"} renders the React app`).not.toBeNull();
      expect(text).toContain('<div id="root" data-dashboard-entry=');
      expect(text).toMatch(/<script type="module"[^>]+src="\/assets\/[A-Za-z0-9._-]+\.js"/);
      expect(bootstrap).toMatchObject({ version: 1 });
      pages.set(suffix || "/", text);
    }
    const testLabResponse = await application.request("/dashboard/testing", { headers });
    expect(testLabResponse.status).toBe(200);
    expect(testLabResponse.headers.get("cache-control")).toBe("private, no-store");
    const workbenchHtml = await testLabResponse.text();
    pages.set("/testing",workbenchHtml);
    const html = [...pages.values()].join("\n");
    for (const raw of ["<img", "<svg", "<b onclick", "<script>notify()", "<source", "<iframe", "<status>"]) expect(html).not.toContain(raw);
    expect(dashboardBootstrap(pages.get("/inbox/notifications")!).notifications).toEqual(
      expect.arrayContaining([expect.objectContaining({ title: "<script>notify()</script>" })]),
    );
    expect(dashboardBootstrap(pages.get("/")!)).toMatchObject({
      kind: "inbox-overview",
      shell: { title: "Inbox",active: "inbox" },
      summary: { pendingResponses: 0,pendingApprovals: 0,notifications: 2,deliveries: 1 },
    });
    expect(dashboardBootstrap(pages.get("/connections")!)).toMatchObject({
      kind: "connections",
      shell: { title: "Connections",active: "connections" },
      services: expect.arrayContaining([expect.objectContaining({
        title: "<iframe srcdoc=\"updated-service()\">",
        destinationUrl: "https://example.test/updated?from=dashboard&mode=default",
      })]),
      phones: expect.arrayContaining([expect.objectContaining({
        name: `<img src=x onerror="device()">`,
        model: `<svg/onload='model()'>`,
        lastSeenAt: expect.any(String),
      })]),
      clients: expect.arrayContaining([
        expect.objectContaining({ label: '<b onclick="client()">Client</b>' }),
      ]),
    });
    expect(dashboardBootstrap(pages.get("/inbox/delivery")!)).toMatchObject({
      kind: "delivery-history",
      shell: { title: "Delivery",active: "inbox-delivery" },
      deliveries: [expect.objectContaining({ title: "Webhook title",state: "pending" })],
    });
    const accountBootstrap = optionalDashboardBootstrap(pages.get("/account")!);
    expect(accountBootstrap).toMatchObject({
      kind: "account",
      route: { path: "/dashboard/account" },
      shell: {
        title: "Account",
        active: "account",
        account: { name: "Relo Owner",email: "owner@example.com" },
      },
      account: {
        name: "Relo Owner",
        email: "owner@example.com",
        authentication: "Better Auth email/password session",
      },
    });
    expect(workbenchHtml).toContain('<div id="root" data-dashboard-entry="test-lab">');
    expect(workbenchHtml).not.toContain("/assets/relo-dashboard.js");
    const moduleAsset = workbenchHtml.match(
      /<script type="module"[^>]+src="(\/assets\/[A-Za-z0-9._-]+\.js)"/,
    )?.[1];
    expect(moduleAsset).toBeDefined();
    const moduleAssetResponse = await application.request(moduleAsset!);
    expect(moduleAssetResponse.status).toBe(200);
    expect(moduleAssetResponse.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const initialTestLab = parseTestLabBootstrap(workbenchHtml);
    expect(initialTestLab).toMatchObject({
      version: 1,
      kind: "test-lab",
      route: { path: "/dashboard/testing",selectedActivityId: null,compose: false },
      shell: {
        title: "Live Activity Test Lab",
        description: expect.any(String),
        active: "testing",
        account: { id: expect.any(String),initial: "R",name: "Relo Owner",email: "owner@example.com" },
      },
      summary: { total: 0,active: 0,awaitingProvider: 0,awaitingPhone: 0,awaitingResponse: 0 },
      composer: {
        defaultPreset: "standard",
      },
    });
    expect(initialTestLab.shell.releaseIdentity).toMatch(/\S/);
    expect(initialTestLab.shell.account.id).toMatch(/^acc_/);
    expect(initialTestLab.devices).toEqual([expect.objectContaining({
      id: registeredBody.device.deviceId,
      name: `<img src=x onerror="device()">`,
      model: `<svg/onload='model()'>`,
      appVersion: "1",
      osVersion: "18",
      notificationAuthorization: "authorized",
      liveActivityAuthorization: "authorized",
      lastSeenAt: expect.any(String),
      ready: true,
    })]);
    expect(initialTestLab.runs).toEqual([]);
    expect(initialTestLab.composer.presets.map((preset: any) => preset.id)).toEqual([
      "standard","ring","hero","terminal","steps","approval","shell","verdict","signal",
    ]);
    expect(initialTestLab.composer.presets.every((preset: any) => !("version" in preset.presentation))).toBe(true);
    const snapshot = await application.request(
      `/api/dashboard/snapshot?deviceId=${encodeURIComponent(registeredBody.device.deviceId)}&clientId=${encodeURIComponent(`key_${credential.rows[0]!.id}`)}`,
      { headers },
    );
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({
      counts: { devices: 1,notifications: expect.any(Number),deliveries: expect.any(Number),approvals: expect.any(Number) },
      devices: [{ id: registeredBody.device.deviceId }],
      clients: [{ id: `key_${credential.rows[0]!.id}` }],
    });
    const foreignPrincipal = await db.query<{ id: string }>(
      "INSERT INTO owner_principals(handle) VALUES ('snapshot-foreign') RETURNING id",
    );
    const foreignDevice = await db.query<{ id: string }>(
      `INSERT INTO devices(
         principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,apns_environment
       ) VALUES ($1,'snapshot-foreign-stable','snapshot-foreign-install','Foreign iPhone',
         'com.example.relo.notifications','1','1','18','sandbox') RETURNING id`,
      [foreignPrincipal.rows[0]!.id],
    );
    const foreignClient = await db.query<{ id: string }>(
      `INSERT INTO principal_api_keys(principal_id,label,token_hash,token_prefix)
       VALUES ($1,'Foreign client','snapshot-foreign-hash','snapshot_foreign') RETURNING id`,
      [foreignPrincipal.rows[0]!.id],
    );
    const foreignSnapshot = await application.request(
      `/api/dashboard/snapshot?deviceId=${encodeURIComponent(`dev_${foreignDevice.rows[0]!.id}`)}&clientId=${encodeURIComponent(`key_${foreignClient.rows[0]!.id}`)}`,
      { headers },
    );
    expect(foreignSnapshot.status).toBe(200);
    expect(await foreignSnapshot.json()).toMatchObject({ devices: [], clients: [] });
    expect((await application.request("/dashboard/not-a-section", { headers })).status).toBe(404);
    const progressPresentation = currentPresentation();
    let dashboardActivityId: string | null = null;
    let dashboardLaunchSequence = -1;
    const launch = async (requestBody: any) => {
      const firstLaunch = dashboardActivityId === null;
      const response = await application.request("/api/dashboard/live-activities/test", {
        method: "POST", headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify(requestBody),
      });
      expect(response.status).toBe(firstLaunch ? 201 : 200);
      const body = await response.json() as any;
      expect(body.activity.operation).toBe(firstLaunch ? "start" : "update");
      expect(body.activity.generation).toBe(1);
      dashboardLaunchSequence += 1;
      expect(body.activity.sequence).toBe(dashboardLaunchSequence);
      expect(body).toMatchObject({
        disposition: firstLaunch ? "created" : "reused",
        reused: !firstLaunch,resumed: false,
      });
      if (firstLaunch) dashboardActivityId = body.activity.id;
      else expect(body.activity.id).toBe(dashboardActivityId);
      expect(body.delivery).toEqual({ eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 });
      return body;
    };
    const primaryRun = await launch({
      deviceId: registeredBody.device.deviceId,presentation: progressPresentation,
    });
    const activityId = primaryRun.activity.id as string;
    expect((await db.query(
      `SELECT count(*)::int AS count FROM live_activities
       WHERE state='active' AND target_device_ids && ARRAY[$1::uuid]`,
      [registeredBody.device.deviceId.slice("dev_".length)],
    )).rows[0].count).toBeGreaterThan(1);
    await db.query(
      `UPDATE live_activities SET state='ended',ended_at=now(),updated_at=now()
       WHERE id=ANY($1::uuid[])`,
      [externallyOwnedActivities.rows.map((activity) => activity.id)],
    );
    expect(primaryRun.activity).toMatchObject({ style: "standard",title: "Composable build" });
    expect(primaryRun.activity).not.toHaveProperty("presentationVersion");
    expect(primaryRun).toMatchObject({
      presentation: {
                content: progressPresentation.content,
        components: progressPresentation.components,
        behavior: progressPresentation.behavior,
      },
      transportMode: "current",
    });
    const persistedStart = await db.query(
      "SELECT presentation,presentation_sha256 FROM live_activities WHERE id=$1",
      [activityId.slice("act_".length)],
    );
    expect(persistedStart.rows[0]).toEqual({
      presentation: primaryRun.presentation,
      presentation_sha256: primaryRun.activity.presentationHash,
    });
    const parallelPresentation = {
      ...progressPresentation,
      content: { ...progressPresentation.content,title: "Parallel same-phone build",status: "Queued" },
    };
    const parallelRun = await launch({
      deviceId: registeredBody.device.deviceId,presentation: parallelPresentation,
    });
    expect(parallelRun.activity.id).toBe(activityId);
    expect(parallelRun.activity).toMatchObject({ operation: "update",sequence: 1 });
    const selectedRunPage = await application.request(`/dashboard/testing/runs/${activityId}`,{ headers });
    expect(selectedRunPage.status).toBe(200);
    const selectedRunHtml = await selectedRunPage.text();
    const selectedTestLab = parseTestLabBootstrap(selectedRunHtml);
    expect(selectedTestLab.kind).toBe("test-lab");
    expect(selectedTestLab.route).toEqual({
      path: `/dashboard/testing/runs/${activityId}`,
      selectedActivityId: activityId,
      compose: false,
    });
    expect(selectedTestLab.runs.map((run: any) => run.id)).toEqual([activityId]);
    const selectedRun = selectedTestLab.runs.find((run: any) => run.id === activityId);
    expect(selectedRun).toMatchObject({
      id: activityId,
      title: parallelPresentation.content.title,
      status: parallelPresentation.content.status,
      state: "active",
      progress: parallelPresentation.components[0].value,
      sequence: 1,
      presentation: parallelRun.presentation,
      targetDeviceIds: [registeredBody.device.deviceId],
      targetDeviceName: `<img src=x onerror="device()">`,
      requesterLabel: "Dashboard",
      ownerControlled: true,
      evidence: {
        provider: { state: null,durableCommands: 1,apnsJobs: 0 },
        phone: { expected: 1,confirmed: 0 },
        response: { kind: null,state: null,action: null,respondedAt: null },
      },
      createdAt: expect.any(String),
      updatedAt: expect.any(String),
    });

    const presetRunIds: string[] = [];
    for (const preset of initialTestLab.composer.presets) {
      const body = await launch({ presentation: preset.presentation,deviceId: registeredBody.device.deviceId });
      presetRunIds.push(body.activity.id);
    }
    const behaviorRuns: any[] = [];
    for (const behavior of ["informational","approval","yes_no"] as const) {
      const action = behavior !== "informational";
      const body = await launch({ deviceId: registeredBody.device.deviceId,presentation: currentPresentation({
        content: { header: "Relo Test Lab",title: `${behavior} run`,
          subtitle: behavior === "informational" ? null : `Canonical ${behavior} test`,
          status: action ? "Waiting" : "Ready" },
        components: [],surfaces: {},
        behavior: behavior === "approval"
          ? { type: "approval",primary: { action: "approve",label: "Approve" },secondary: { action: "deny",label: "Deny" } }
          : behavior === "yes_no"
            ? { type: "yes_no",primary: { action: "yes",label: "Yes" },secondary: { action: "no",label: "No" } }
            : { type: "informational" },
      }) });
      expect(body.interaction === null).toBe(behavior === "informational");
      if (behavior === "informational") {
        expect(body.presentation.privacy).toBe("standard");
      }
      behaviorRuns.push(body);
    }
    const invalidPresentation = async (presentation: any) => {
      const response = await application.request("/api/dashboard/live-activities/test", {
        method: "POST",headers: { ...headers,"content-type": "application/json" },
        body: JSON.stringify({ deviceId: registeredBody.device.deviceId,presentation }),
      });
      expect(response.status).toBe(400);
    };
    await invalidPresentation({
      ...progressPresentation,
      behavior: { type: "text_reply",action: { action: "reply",label: "Reply" },placeholder: "Short reply",maxLength: 4000 },
    });
    await invalidPresentation({
      ...progressPresentation,
      appearance: { ...progressPresentation.appearance,secondaryColor: "#64D2FF" },
    });
    const launchedIds = [activityId,parallelRun.activity.id,...presetRunIds,...behaviorRuns.map((run) => run.activity.id)];
    expect(new Set(launchedIds)).toEqual(new Set([activityId]));
    expect((await db.query("SELECT count(*)::int AS count FROM live_activities WHERE activity_key LIKE 'dashboard-test-%'")).rows[0].count).toBe(1);
    const activityDetail = await application.request(`/dashboard/testing/runs/${activityId}/history`,{ headers });
    const activityDetailHtml = await activityDetail.text();
    expect(activityDetail.status).toBe(200);
    expect(activityDetailHtml).toContain(activityId);
    expect(activityDetailHtml).toContain('data-dashboard-entry="activity-history"');
    expect(activityDetailHtml).toContain('"events":[{"id":"ntf_');
    expect(activityDetailHtml).toContain('"relationships":[]');
    expect(activityDetailHtml).toContain('"correlationDecisions":[');
    expect((await db.query("SELECT count(*)::int AS count FROM interaction_requests WHERE state='pending'")).rows[0].count).toBe(1);
    const inbox = await application.request("/api/inbox/history?limit=100", {
      headers: { authorization: `Bearer ${registeredBody.credential.accessToken}` },
    });
    expect(inbox.status).toBe(200);
    const inboxBody = await inbox.json() as any;
    const commands = inboxBody.items.filter((item: any) => item.liveActivity !== null);
    expect(commands).toHaveLength(launchedIds.length);
    const canonicalStart = commands.find((item: any) => item.id === primaryRun.eventId)?.liveActivity;
    expect(canonicalStart).toMatchObject({
      activityId,operation: "start",title: "Composable build",
      behaviorType: "progress",privacy: "standard",
    });
    expect(canonicalStart).not.toHaveProperty("presentation");
    const interactiveActivityCommands = commands.filter((item: any) => item.interaction !== null);
    expect(interactiveActivityCommands).toHaveLength(6);
    expect(interactiveActivityCommands.map((item: any) => item.liveActivity.style).sort()).toEqual(
      ["approval","approval","approval","verdict","verdict","verdict"],
    );
    expect(interactiveActivityCommands.map((item: any) => item.interaction.kind).sort()).toEqual(
      ["approval","approval","approval","yes_no","yes_no","yes_no"],
    );
    for (const item of interactiveActivityCommands) {
      expect(item.liveActivity.interaction.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    }

    const secondRegistered = await application.request("/api/devices/register", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json", "idempotency-key": "dashboard-second-device-1" },
      body: JSON.stringify({
        stableDeviceId: "dashboard-stable-two", installationId: "dashboard-install-two",
        name: "Second iPhone", bundleIdentifier: "com.example.relo.notifications",
        appVersion: "1", appBuild: "1", osVersion: "18", model: "iPhone",
        apnsEnvironment: "sandbox", apnsToken: "b".repeat(64), notificationAuthorization: "authorized",
        liveActivityAuthorization: "authorized",
      }),
    });
    expect(secondRegistered.status).toBe(200);
    const secondRegisteredBody = await secondRegistered.json() as any;
    await db.query(
      `UPDATE live_activities
       SET target_device_ids=array_append(target_device_ids,$2::uuid)
       WHERE id=$1`,
      [activityId.slice("act_".length),secondRegisteredBody.device.deviceId.slice("dev_".length)],
    );

    const launchSequence = behaviorRuns.at(-1)!.activity.sequence as number;
    expect(launchSequence).toBe(launchedIds.length-1);
    const updateSequence = launchSequence+1;
    const updatedPresentation = {
      ...progressPresentation,
      content: { ...progressPresentation.content,status: "Running 73%" },
      components: progressPresentation.components.map((component) => ({ ...component,value: 0.73 })),
    };
    const updated = await application.request(`/api/dashboard/live-activities/${activityId}/update`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ presentation: updatedPresentation }),
    });
    const updatedBody = await updated.json() as any;
    expect(updated.status,JSON.stringify(updatedBody)).toBe(200);
    expect(updatedBody.activity).toMatchObject({
      id: activityId, state: "active", status: "Running 73%", progress: 0.73, sequence: updateSequence,
      presentation: updatedPresentation,presentationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(updatedBody.delivery).toEqual({ eligibleDevices: 2, durableCommands: 2, apnsJobs: 0 });
    expect(updatedBody.eventIds).toHaveLength(2);
    const persistedUpdate = await db.query(
      "SELECT presentation,presentation_sha256 FROM live_activities WHERE id=$1",
      [activityId.slice("act_".length)],
    );
    expect(persistedUpdate.rows[0]).toEqual({
      presentation: updatedPresentation,
      presentation_sha256: updatedBody.activity.presentationHash,
    });
    const dismissedPresentation = await application.request(
      `/api/devices/self/live-activities/${activityId}/dismissed`,
      {
        method: "POST",
        headers: { authorization: `Bearer ${registeredBody.credential.accessToken}` },
      },
    );
    expect(await dismissedPresentation.json()).toEqual({
      activityId,status: "dismissed",changed: true,
    });
    const reactivated = await application.request(
      `/api/dashboard/live-activities/${activityId}/reactivate`,
      { method: "POST",headers },
    );
    expect(reactivated.status).toBe(200);
    expect(await reactivated.json()).toMatchObject({
      activity: { id: activityId,state: "active",sequence: updateSequence },
      reactivatedDeviceIds: [registeredBody.device.deviceId],
      delivery: { eligibleDevices: 1,durableCommands: 1,apnsJobs: 0 },
    });
    expect((await db.query<{ state: string;reason: string }>(
      `SELECT state,reason FROM live_activity_presentation_leases
       WHERE live_activity_id=$1 AND device_id=$2`,
      [activityId.slice("act_".length),registeredBody.device.deviceId.slice("dev_".length)],
    )).rows[0]).toEqual({ state: "foreground",reason: "scope_relevance_policy" });
    expect((await application.request(
      `/api/dashboard/live-activities/${activityId}/reactivate`,
      { method: "POST",headers },
    )).status).toBe(409);
    const updateInboxByDevice = [registeredBody,secondRegisteredBody];
    for (const device of updateInboxByDevice) {
      const deviceInbox = await application.request("/api/inbox/history?limit=100", {
        headers: { authorization: `Bearer ${device.credential.accessToken}` },
      });
      const deviceInboxBody = await deviceInbox.json() as any;
      const matching = deviceInboxBody.items.find(
        (item: any) => updatedBody.eventIds.includes(item.id),
      );
      expect(matching, JSON.stringify({
        deviceId: device.device.deviceId,
        expectedEventIds: updatedBody.eventIds,
        inboxEventIds: deviceInboxBody.items.map((item: any) => item.id),
        hasMore: deviceInboxBody.hasMore,
      })).toBeDefined();
      expect(matching?.liveActivity).toMatchObject({
        activityId, operation: "update", generation: 1, sequence: updateSequence,
      });
      expect(matching.liveActivity).toMatchObject({
        title: "Composable build",status: "Running 73%",
        behaviorType: "progress",
      });
      expect(JSON.parse(matching.liveActivity.componentsJson)).toEqual(updatedPresentation.components);
      expect(matching.liveActivity).not.toHaveProperty("presentation");
      const received = await application.request(`/api/notifications/${matching.id}/interactions`, {
        method: "POST",
        headers: { authorization: `Bearer ${device.credential.accessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "received", value: {},
          idempotencyKey: `dashboard-update-received-${device.device.deviceId}` }),
      });
      expect(received.status).toBe(201);
    }
    const receivedStatus = await application.request(`/api/dashboard/live-activities/${activityId}/status`, { headers });
    const receivedActivity = (await receivedStatus.json() as any).activity;
    expect(receivedActivity).toMatchObject({
      presentation: updatedPresentation,
      presentationHash: updatedBody.activity.presentationHash,
          });
    expect(receivedActivity.deviceReceipts).toEqual(expect.arrayContaining(
      updatedBody.eventIds.map((eventId: string) => expect.objectContaining({ eventId, receivedAt: expect.any(String) })),
    ));
    expect(receivedActivity.currentCommandReceipts).toEqual(expect.arrayContaining(
      updatedBody.eventIds.map((eventId: string) => expect.objectContaining({
        eventId,activityId,operation: "update",sequence: updateSequence,receivedAt: expect.any(String),
      })),
    ));

    const cardsBeforeQuestion = (await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n;
    const waiting = await application.request(`/api/dashboard/live-activities/${activityId}/wait`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "approval", prompt: "Continue the integration test?" }),
    });
    expect(waiting.status).toBe(200);
    const waitingBody = await waiting.json() as any;
    // The question folds into the running card: same card, now asking.
    expect(waitingBody.activity).toMatchObject({ id: activityId, status: "Needs you" });
    expect(waitingBody.interaction).toMatchObject({ kind: "approval", state: "pending" });
    expect(waitingBody.delivery).toEqual({ eligibleDevices: 2, durableCommands: 2, apnsJobs: 0 });
    expect(waitingBody.eventIds).toHaveLength(2);
    expect(waitingBody.eventIds[0]).toBe(waitingBody.eventId);
    expect(waitingBody.interactions[0]).toEqual(waitingBody.interaction);
    for (const interaction of waitingBody.interactions) expect(interaction).not.toHaveProperty("credential");
    const storedWait = await db.query<any>(
      "SELECT id,payload FROM notification_events WHERE id=ANY($1::uuid[]) ORDER BY id",
      [waitingBody.eventIds.map((id: string) => id.slice("ntf_".length))],
    );
    for (const row of storedWait.rows) expect(JSON.stringify(row.payload)).not.toContain("credential");
    const waitingInbox = await application.request("/api/inbox/history?limit=100", {
      headers: { authorization: `Bearer ${registeredBody.credential.accessToken}` },
    });
    // Each phone gets its own copy of the question on the card; answer this phone's copy.
    const waitingItem = (await waitingInbox.json() as any).items.find((item: any) => waitingBody.eventIds.includes(item.id));
    const ownQuestion = waitingBody.interactions.find((interaction: any) => interaction.notificationId === waitingItem.id);
    expect(waitingItem.liveActivity.interaction).toMatchObject({
      id: ownQuestion.id, notificationId: ownQuestion.notificationId,
      kind: "approval", state: "pending",
    });
    expect(waitingItem.liveActivity.interaction.credential).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const invalidResponse = await application.request(
      `/api/live-activity-responses/${ownQuestion.id}`,
      {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notificationId: ownQuestion.notificationId,
          deviceId: registeredBody.device.deviceId,
          action: "approve",
          credential: "x".repeat(43),
          idempotencyKey: "dashboard-response-invalid",
        }),
      },
    );
    expect(invalidResponse.status).toBe(401);

    await db.query("UPDATE devices SET revoked_at=now() WHERE id=$1",[
      registeredBody.device.deviceId.slice("dev_".length),
    ]);
    const revokedResponse = await application.request(
      `/api/live-activity-responses/${ownQuestion.id}`,
      {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notificationId: ownQuestion.notificationId,
          deviceId: registeredBody.device.deviceId,
          action: "approve",
          credential: waitingItem.liveActivity.interaction.credential,
          idempotencyKey: "dashboard-response-revoked",
        }),
      },
    );
    expect(revokedResponse.status).toBe(404);
    await db.query("UPDATE devices SET revoked_at=NULL WHERE id=$1",[
      registeredBody.device.deviceId.slice("dev_".length),
    ]);

    const phoneResponse = await application.request(
      `/api/live-activity-responses/${ownQuestion.id}`,
      {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notificationId: ownQuestion.notificationId,
          deviceId: registeredBody.device.deviceId,
          action: "approve",
          credential: waitingItem.liveActivity.interaction.credential,
          idempotencyKey: "dashboard-response-approved",
        }),
      },
    );
    expect(phoneResponse.status).toBe(200);
    expect(await phoneResponse.json()).toMatchObject({ state: "approved", replayed: false });
    const replayedPhoneResponse = await application.request(
      `/api/live-activity-responses/${ownQuestion.id}`,
      {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notificationId: ownQuestion.notificationId,
          deviceId: registeredBody.device.deviceId,
          action: "approve",
          credential: waitingItem.liveActivity.interaction.credential,
          idempotencyKey: "dashboard-response-approved",
        }),
      },
    );
    expect(await replayedPhoneResponse.json()).toMatchObject({ state: "approved", replayed: true });
    const collision = await application.request(
      `/api/live-activity-responses/${ownQuestion.id}`,
      {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notificationId: ownQuestion.notificationId,
          deviceId: registeredBody.device.deviceId,
          action: "deny",
          credential: waitingItem.liveActivity.interaction.credential,
          idempotencyKey: "dashboard-response-approved",
        }),
      },
    );
    expect(collision.status).toBe(409);
    expect(await collision.json()).toEqual({ error: "idempotency_conflict" });

    const secondWaitingInbox = await application.request("/api/inbox/history?limit=100", {
      headers: { authorization: `Bearer ${secondRegisteredBody.credential.accessToken}` },
    });
    const secondWaitingItem = (await secondWaitingInbox.json() as any).items.find(
      (item: any) => waitingBody.eventIds.includes(item.id) && item.id !== ownQuestion.notificationId,
    );
    const secondQuestion = waitingBody.interactions.find((interaction: any) => interaction.notificationId === secondWaitingItem.id);
    expect(secondWaitingItem.liveActivity.targetDeviceId).toBe(secondRegisteredBody.device.deviceId);
    const secondPhoneResponse = await application.request(
      `/api/live-activity-responses/${secondQuestion.id}`,
      {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({
          notificationId: secondQuestion.notificationId,
          deviceId: secondRegisteredBody.device.deviceId,
          action: "approve",
          credential: secondWaitingItem.liveActivity.interaction.credential,
          idempotencyKey: "dashboard-response-approved-second",
        }),
      },
    );
    expect(secondPhoneResponse.status).toBe(409);
    expect(await secondPhoneResponse.json()).toMatchObject({ error: "interaction_terminal", state: "approved" });

    // Answered: the same card returns to its work, showing the answer.
    const parentStatus = await application.request(`/api/dashboard/live-activities/${activityId}/status`, { headers });
    const parentStatusBody = (await parentStatus.json() as any).activity;
    expect(parentStatusBody).toMatchObject({
      id: activityId, state: "active", progress: 0.73,
      interaction: { kind: "approval", state: "approved", action: "approve",
        device: { id: registeredBody.device.deviceId } },
      targets: expect.arrayContaining([
        expect.objectContaining({ id: registeredBody.device.deviceId, name: expect.any(String) }),
        expect.objectContaining({ id: secondRegisteredBody.device.deviceId, name: "Second iPhone" }),
      ]),
    });
    expect(parentStatusBody.status).toMatch(/^Approved · /);
    expect((await db.query("SELECT count(*)::int AS n FROM live_activities")).rows[0].n).toBe(cardsBeforeQuestion);
    const parentOrigin = (await db.query<{ origin_hash: string }>(
      "SELECT origin_hash FROM live_activities WHERE id=$1",
      [activityId.slice("act_".length)],
    )).rows[0]!.origin_hash;
    expect((await db.query<{ origin_hash: string | null }>(
      "SELECT DISTINCT origin_hash FROM notification_events WHERE id=ANY($1::uuid[])",
      [waitingBody.eventIds.map((id: string) => id.slice("ntf_".length))],
    )).rows).toEqual([{ origin_hash: parentOrigin }]);

    const typedReply = await application.request(`/api/dashboard/live-activities/${activityId}/wait`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ kind: "text", prompt: "What should happen next?" }),
    });
    expect(typedReply.status).toBe(400);

    const ended = await application.request(`/api/dashboard/live-activities/${activityId}/end`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ dismissAfterSeconds: 15 }),
    });
    expect(ended.status).toBe(200);
    const endedBody = await ended.json() as any;
    // The question (+1) and its answer (+1) moved the card on before the end.
    const terminalSequence = updateSequence+3;
    // Finishing is finished work: the measured bar fills, never "Finished" at 73%.
    const terminalPresentation = {
      ...updatedPresentation,
      content: { ...updatedPresentation.content,status: "Finished" },
      state: { kind: "completed",tone: "success",icon: "completed" },
      components: updatedPresentation.components.map((component: any) =>
        component.type === "progress_bar" ? { ...component,value: 1 } : component),
    };
    expect(endedBody.activity).toMatchObject({
      id: activityId, state: "ended", status: "Finished", progress: 1, sequence: terminalSequence,
      presentation: terminalPresentation,      presentationHash: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    const endedRunPage = await application.request(`/dashboard/testing/runs/${activityId}`,{ headers });
    expect(endedRunPage.status).toBe(200);
    const endedRunHtml = await endedRunPage.text();
    const endedTestLab = parseTestLabBootstrap(endedRunHtml);
    expect(endedTestLab.route).toEqual({
      path: `/dashboard/testing/runs/${activityId}`,
      selectedActivityId: activityId,
      compose: false,
    });
    expect(endedTestLab.runs.find((run: any) => run.id === activityId)).toMatchObject({
      id: activityId,
      state: "ended",
      status: "Finished",
      progress: 1,
      sequence: terminalSequence,
      presentation: terminalPresentation,
      ownerControlled: true,
    });
    expect((await db.query(
      "SELECT presentation,presentation_sha256 FROM live_activities WHERE id=$1",
      [activityId.slice("act_".length)],
    )).rows[0]).toEqual({
      presentation: terminalPresentation,presentation_sha256: endedBody.activity.presentationHash,
    });
    expect(endedBody.delivery).toEqual({ eligibleDevices: 2, durableCommands: 2, apnsJobs: 0 });
    expect(endedBody.eventIds).toHaveLength(2);
    const parentOperations = await db.query<any>(
      `SELECT operation,delivery_summary,companion_activity_id,activity_snapshot,
         presentation_snapshot,presentation_snapshot_sha256
       FROM live_activity_operations WHERE live_activity_id=$1 ORDER BY created_at`,
      [activityId.slice("act_".length)],
    );
    expect(parentOperations.rows[0]?.operation).toBe("start");
    expect(parentOperations.rows.filter((row) => row.operation === "update"))
      .toHaveLength(launchedIds.length+1);
    expect(parentOperations.rows.filter((row) => row.operation === "wait")).toHaveLength(1);
    expect(parentOperations.rows.at(-1)?.operation).toBe("end");
    expect(parentOperations.rows.every((row) => row.companion_activity_id === null)).toBe(true);
    expect(parentOperations.rows.every((row) => row.delivery_summary && row.activity_snapshot)).toBe(true);
    expect(parentOperations.rows.every((row) => row.presentation_snapshot
      && /^[a-f0-9]{64}$/.test(row.presentation_snapshot_sha256))).toBe(true);
    expect(parentOperations.rows.at(-1)).toMatchObject({
      operation: "end",presentation_snapshot: terminalPresentation,
      presentation_snapshot_sha256: endedBody.activity.presentationHash,
    });
    const lifecycleEventRows = (await db.query<any>(
      `SELECT payload#>'{liveActivity}' AS command,expires_at FROM notification_events
       WHERE kind='live_activity' AND payload#>>'{liveActivity,activityId}'=$1 ORDER BY created_at`,
      [activityId],
    )).rows;
    expect(lifecycleEventRows.every((row) => row.expires_at instanceof Date)).toBe(true);
    const lifecycleCommands = lifecycleEventRows.map((row) => row.command);
    const primaryCommands = lifecycleCommands.filter((command) => command.activityId === activityId);
    expect(primaryCommands.filter((command) => command.operation === "start")).toHaveLength(1);
    expect(primaryCommands.filter((command) => command.operation === "end")).toHaveLength(2);
    expect(primaryCommands.filter((command) => command.operation === "update")).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetDeviceId: registeredBody.device.deviceId,sequence: updateSequence }),
      expect.objectContaining({ targetDeviceId: secondRegisteredBody.device.deviceId,sequence: updateSequence }),
    ]));
    expect(primaryCommands.filter((command) => command.operation === "end")).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetDeviceId: registeredBody.device.deviceId,sequence: terminalSequence,dismissAfterSeconds: 15 }),
      expect.objectContaining({ targetDeviceId: secondRegisteredBody.device.deviceId,sequence: terminalSequence,dismissAfterSeconds: 15 }),
    ]));
    for (const command of primaryCommands.filter((candidate) =>
      candidate.sequence === updateSequence || candidate.sequence === terminalSequence)) {
      expect(JSON.parse(command.componentsJson)).toEqual(command.sequence === terminalSequence
        ? terminalPresentation.components : updatedPresentation.components);
    }
    const finishAll = await application.request("/api/dashboard/live-activities/end-all", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ dismissAfterSeconds: 15 }),
    });
    expect(finishAll.status).toBe(200);
    const finishAllBody = await finishAll.json() as any;
    expect(finishAllBody.alreadyTerminal).toBe(true);
    expect(finishAllBody.ended).toEqual([]);
    expect((await application.request(`/api/dashboard/live-activities/${activityId}/status`,{ headers }).then((response) => response.json())) as any)
      .toMatchObject({ activity: { state: "ended",sequence: terminalSequence } });
    const repeatedFinishAll = await application.request("/api/dashboard/live-activities/end-all", {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ dismissAfterSeconds: 15 }),
    });
    expect(await repeatedFinishAll.json()).toMatchObject({ ended: [],eventIds: [],alreadyTerminal: true });

    const boundedLaunch = async (title: string,expectedStatus: 200 | 201) => {
      const response = await application.request("/api/dashboard/live-activities/test", {
        method: "POST",headers: { ...headers,"content-type": "application/json" },
        body: JSON.stringify({
          deviceId: secondRegisteredBody.device.deviceId,
          presentation: { ...progressPresentation,content: { ...progressPresentation.content,title } },
        }),
      });
      expect(response.status).toBe(expectedStatus);
      return await response.json() as any;
    };
    const boundedFirst = await boundedLaunch("Bounded first run",201);
    expect(boundedFirst).toMatchObject({ reused: false,resumed: false,
      activity: { generation: 1 },replaced: 0,replacedEventIds: [] });
    const boundedRow = (await db.query<any>(
      "SELECT created_at,expires_at,stale_at FROM live_activities WHERE id=$1",
      [boundedFirst.activity.id.slice("act_".length)],
    )).rows[0];
    expect(boundedRow.expires_at.getTime()-boundedRow.created_at.getTime()).toBeGreaterThanOrEqual(119_000);
    expect(boundedRow.expires_at.getTime()-boundedRow.created_at.getTime()).toBeLessThanOrEqual(121_000);
    expect(boundedRow.stale_at.getTime()-boundedRow.created_at.getTime()).toBeGreaterThanOrEqual(29_000);
    expect(boundedRow.stale_at.getTime()-boundedRow.created_at.getTime()).toBeLessThanOrEqual(31_000);
    const boundedSecond = await boundedLaunch("Bounded progress run",200);
    expect(boundedSecond).toMatchObject({
      reused: true,resumed: false,
      activity: { id: boundedFirst.activity.id,operation: "update",generation: 1,
        sequence: 1,title: "Bounded progress run" },
      replaced: 0,replacedEventIds: [],
    });
    expect(boundedSecond.eventId).not.toBe(boundedFirst.eventId);
    expect((await application.request(
      `/api/dashboard/live-activities/${boundedFirst.activity.id}/status`,{ headers },
    ).then((response) => response.json())) as any).toMatchObject({
      activity: { id: boundedFirst.activity.id,state: "active",sequence: 1,title: "Bounded progress run" },
    });
    const boundedEnd = await application.request(
      `/api/dashboard/live-activities/${boundedFirst.activity.id}/end`,{
        method: "POST",headers: { ...headers,"content-type": "application/json" },body: "{}",
      },
    );
    expect(boundedEnd.status).toBe(200);
    const boundedEndBody = await boundedEnd.json() as any;
    expect(boundedEndBody).toMatchObject({
      activity: { id: boundedFirst.activity.id,state: "ended",sequence: 2 },
      delivery: { eligibleDevices: 1,durableCommands: 1 },
    });
    expect(boundedEndBody.eventIds).toHaveLength(1);
    const boundedThird = await boundedLaunch("Bounded resumed run",201);
    expect(boundedThird).toMatchObject({
      reused: false,resumed: true,
      activity: { operation: "start",generation: 2,sequence: 0,title: "Bounded resumed run" },
    });
    expect(boundedThird.activity.id).not.toBe(boundedFirst.activity.id);
    const boundedHistory = await db.query<{ activities: number;events: number;active: number }>(
      `SELECT count(DISTINCT a.id)::int AS activities,count(DISTINCT e.id)::int AS events
         ,count(DISTINCT a.id) FILTER (WHERE a.state='active')::int AS active
       FROM live_activities a JOIN notification_events e
         ON e.principal_id=a.principal_id AND e.origin_hash=a.origin_hash
       WHERE a.origin_hash=(SELECT origin_hash FROM live_activities WHERE id=$1)`,
      [boundedFirst.activity.id.slice("act_".length)],
    );
    const boundedEvents = await db.query<{ activity_id: string;operation: string }>(
      `SELECT payload#>>'{liveActivity,activityId}' AS activity_id,
         payload#>>'{liveActivity,operation}' AS operation
       FROM notification_events
       WHERE principal_id=$1 AND origin_hash=(
         SELECT origin_hash FROM live_activities WHERE id=$2
       ) ORDER BY created_at,id`,
      [owner.rows[0]!.id,boundedFirst.activity.id.slice("act_".length)],
    );
    expect(boundedEvents.rows).toEqual([
      { activity_id: boundedFirst.activity.id,operation: "start" },
      { activity_id: boundedFirst.activity.id,operation: "update" },
      { activity_id: boundedFirst.activity.id,operation: "end" },
      { activity_id: boundedThird.activity.id,operation: "start" },
    ]);
    expect(boundedHistory.rows[0]).toEqual({ activities: 2,events: 4,active: 1 });

    const currentUpdatePresentation = {
            content: { header: "Relo",title: "Bounded resumed run",subtitle: "Current update",status: "Running 63%" },
      identity: { project: null,thread: null,direct: true },
      state: { kind: "active",tone: "live",icon: "build" },
      components: [
        { id: "measured_progress",type: "progress_bar",colorRole: "project",value: 0.63,label: "63%" },
      ],
      surfaces: {
        lock_screen: ["measured_progress"],expanded_leading: [],expanded_trailing: ["measured_progress"],
        expanded_bottom: [],compact_leading: [],compact_trailing: ["measured_progress"],minimal: ["measured_progress"],
      },
      behavior: { type: "progress" },
      appearance: { theme: "system",roles: {
        cardIdentity: "project",componentIdentity: "thread",statusEmphasis: "state",
      } },
      privacy: "standard",
    };
    const currentUpdate = await application.request(
      `/api/dashboard/live-activities/${boundedThird.activity.id}/update`,{
        method: "POST",headers: { ...headers,"content-type": "application/json" },
        body: JSON.stringify({ presentation: currentUpdatePresentation }),
      },
    );
    expect(currentUpdate.status).toBe(200);
    expect(await currentUpdate.json()).toMatchObject({
      activity: { id: boundedThird.activity.id,state: "active",sequence: 1,
        progress: 0.63,presentation: currentUpdatePresentation },
    });

    const rotated = await application.request(`/api/dashboard/services/${service.service.id}/rotate`, { method: "POST", headers });
    expect(rotated.status).toBe(200);
    expect((await rotated.json() as any).webhookUrl).not.toBe(service.webhookUrl);
    expect((await application.request(new URL(service.webhookUrl).pathname, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ body: "old" }) })).status).toBe(404);
    expect((await application.request(`/api/dashboard/devices/${registeredBody.device.deviceId}/revoke`, { method: "POST", headers })).status).toBe(200);
    expect((await application.request(`/api/dashboard/credentials/key_${credential.rows[0]!.id}/revoke`, { method: "POST", headers })).status).toBe(200);
    expect((await application.request(`/api/dashboard/services/${service.service.id}`, { method: "DELETE", headers })).status).toBe(200);
  });

  test("control-plane inventories paginate without silent device, client, service, or approval caps", async () => {
    const { token: sessionToken, application } = await createOwnerAndSession();
    const headers = { authorization: `Bearer ${sessionToken}`, origin: "http://127.0.0.1:8180" };
    const owner = (await db.query<{ id: string }>("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0]!;
    await Promise.all([
      db.query(
        `INSERT INTO devices(
           principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
           os_version,model,apns_environment,last_seen_at
         ) SELECT $1,'inventory-stable-'||n,'inventory-install-'||n,'Inventory Device '||n,
           'com.example.relo.notifications','1.0','1','18.0','iPhone','sandbox',now()+(n*interval '1 second')
           FROM generate_series(1,26) n`,
        [owner.id],
      ),
      db.query(
        `INSERT INTO principal_api_keys(principal_id,label,token_hash,token_prefix,created_at)
         SELECT $1,'Inventory Client '||n,'inventory-client-hash-'||n,'inventory_'||n,
           now()+(n*interval '1 second') FROM generate_series(1,26) n`,
        [owner.id],
      ),
      db.query(
        `INSERT INTO webhook_services(principal_id,title,secret_hash,secret_prefix,created_at,updated_at)
         SELECT $1,'Inventory Service '||n,'inventory-service-hash-'||n,'hook_inventory_'||n,
           now()+(n*interval '1 second'),now()+(n*interval '1 second') FROM generate_series(1,26) n`,
        [owner.id],
      ),
      db.query(
        `INSERT INTO device_authorizations(
           device_code_hash,user_code,client_name,requested_scopes,status,expires_at,
           credential_expires_at,created_at
         ) SELECT 'inventory-device-code-'||n,'INVT-'||lpad(n::text,4,'0'),'Inventory Approval '||n,
           ARRAY['notifications:send'],'pending',now()+interval '10 minutes',now()+interval '1 day',
           now()+(n*interval '1 second') FROM generate_series(1,26) n`,
      ),
    ]);
    const connections = dashboardBootstrap(await (await application.request("/dashboard/connections",{ headers })).text());
    expect(connections.phones).toHaveLength(26);
    expect(connections.clients.length).toBeGreaterThanOrEqual(27);
    expect(connections.services).toHaveLength(26);
    expect(connections.summary).toMatchObject({ phones: 26,services: 26 });
    for (const [path,item,total] of [
      ["/dashboard","Inventory Approval 1",26],
    ] as const) {
      const response = await application.request(`${path}?page=2`,{ headers });
      expect(response.status,`dashboard pagination route ${path}`).toBe(200);
      const html = await response.text();
      const bootstrap = optionalDashboardBootstrap(html);
      expect(bootstrap,`dashboard pagination route ${path} renders the React app`).not.toBeNull();
      expect(JSON.stringify(bootstrap)).toContain(item);
      const pagination = bootstrap.pagination ?? bootstrap.approvalPagination;
      expect(pagination).toMatchObject({
        page: 2,pageCount: 2,total,previousHref: `${path}?page=1`,nextHref: null,
      });
    }
    const excessiveSelection = new URL("http://127.0.0.1:8180/api/dashboard/snapshot");
    for (let index = 0; index < 51; index += 1) excessiveSelection.searchParams.append(
      "deviceId",`dev_00000000-0000-4000-8000-${String(index).padStart(12,"0")}`,
    );
    expect((await application.request(excessiveSelection.pathname+excessiveSelection.search,{ headers })).status).toBe(400);
  });

  test("notification history paginates, filters, and exposes an account-scoped safe detail", async () => {
    const { token: sessionToken, application } = await createOwnerAndSession();
    const headers = { authorization: `Bearer ${sessionToken}` };
    const owner = (await db.query<{ id: string }>("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0]!;
    await db.query(
      `INSERT INTO notification_events(principal_id,source,kind,title,body,idempotency_key,created_at)
       SELECT $1,'History source','notification',format('History event %s',n),format('History body %s',n),
         format('history-page-%s',n),now()+(n*interval '1 second') FROM generate_series(1,31) n`,
      [owner.id],
    );
    const detailEvent = await db.query<{ id: string }>(
      `INSERT INTO notification_events(
         principal_id,source,kind,title,body,deep_link,payload,idempotency_key,target_mode
       ) VALUES ($1,'History service','question','Review this event','Visible phone reply request',
         'https://example.test/result?from=relo',
         '{"privacy":"standard","secret":"never-render-this-payload"}'::jsonb,
         'never-render-this-idempotency','explicit') RETURNING id`,
      [owner.id],
    );
    const device = await db.query<{ id: string }>(
      `INSERT INTO devices(
         principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,apns_environment,notification_authorization
       ) VALUES ($1,'history-device','history-install','History iPhone','com.example.relo.notifications',
         '1','1','18','sandbox','authorized') RETURNING id`,
      [owner.id],
    );
    const request = await db.query<{ id: string }>(
      `INSERT INTO interaction_requests(
         principal_id,notification_event_id,kind,prompt,state,response,response_token_hash,expires_at,responded_at
       ) VALUES ($1,$2,'text','Reply with the release label','replied',
         '{"response":"Safe phone reply"}'::jsonb,$3,now()+interval '1 hour',now()) RETURNING id`,
      [owner.id,detailEvent.rows[0]!.id,"e".repeat(64)],
    );
    await db.query(
      "INSERT INTO notification_event_targets(notification_event_id,device_id) VALUES ($1,$2)",
      [detailEvent.rows[0]!.id,device.rows[0]!.id],
    );
    await db.query(
      `INSERT INTO delivery_jobs(
         notification_event_id,device_id,state,attempt_count,provider_message_id,accepted_at
       ) VALUES ($1,$2,'accepted',1,'provider-safe-id',now())`,
      [detailEvent.rows[0]!.id,device.rows[0]!.id],
    );
    await db.query(
      `INSERT INTO interactions(
         principal_id,notification_event_id,interaction_request_id,device_id,kind,value,idempotency_key
       ) VALUES ($3,$1,$4,$2,'answer','{"response":"Safe phone reply"}'::jsonb,'history-receipt')`,
      [detailEvent.rows[0]!.id,device.rows[0]!.id,owner.id,request.rows[0]!.id],
    );

    const first = await application.request("/dashboard/inbox/notifications",{ headers });
    const firstHtml = await first.text();
    expect(first.status).toBe(200);
    expect(dashboardBootstrap(firstHtml).pagination).toMatchObject({
      page: 1,pageCount: 2,total: 32,previousHref: null,
      nextHref: "/dashboard/inbox/notifications?page=2",
    });
    const second = await application.request("/dashboard/inbox/notifications?page=2",{ headers });
    const secondHtml = await second.text();
    const secondBootstrap = dashboardBootstrap(secondHtml);
    expect(secondBootstrap.pagination).toMatchObject({
      page: 2,pageCount: 2,total: 32,
      previousHref: "/dashboard/inbox/notifications?page=1",nextHref: null,
    });
    expect(JSON.stringify(secondBootstrap)).toContain(`ntf_${detailEvent.rows[0]!.id}`);
    const filtered = await application.request("/dashboard/inbox/notifications?kind=question&state=active",{ headers });
    const filteredHtml = await filtered.text();
    const filteredBootstrap = dashboardBootstrap(filteredHtml);
    expect(filteredBootstrap.notifications).toEqual([
      expect.objectContaining({ title: "Review this event" }),
    ]);
    expect(filteredBootstrap.pagination.total).toBe(1);

    const detail = await application.request(`/dashboard/inbox/notifications/ntf_${detailEvent.rows[0]!.id}`,{ headers });
    const detailHtml = await detail.text();
    expect(detail.status).toBe(200);
    const detailBootstrap = dashboardBootstrap(detailHtml);
    for (const expected of [
      "Review this event","Visible phone reply request","Safe phone reply","History iPhone",
      "provider-safe-id","standard",
    ]) expect(JSON.stringify(detailBootstrap)).toContain(expected);
    expect(detailBootstrap.notification.destination).toEqual({
      state: "safe",href: "https://example.test/result?from=relo",
    });
    expect(detailHtml).not.toContain("never-render-this-payload");
    expect(detailHtml).not.toContain("never-render-this-idempotency");
    expect(detailHtml).not.toContain("response_token_hash");

    const foreign = await db.query<{ id: string }>(
      `WITH principal AS (
         INSERT INTO owner_principals(handle) VALUES ('foreign-history-owner') RETURNING id
       ) INSERT INTO notification_events(principal_id,source,title,body,idempotency_key)
         SELECT id,'Foreign','Foreign event','Foreign body','foreign-history-event' FROM principal RETURNING id`,
    );
    expect((await application.request(`/dashboard/inbox/notifications/ntf_${foreign.rows[0]!.id}`,{ headers })).status).toBe(404);
  });
});
