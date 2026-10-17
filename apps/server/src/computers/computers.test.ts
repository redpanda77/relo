import { LOGIN_SCOPES } from "@relo/notification-contracts";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createAccountAuth } from "../account-auth.js";
import { createApp } from "../app.js";
import { resetAuthAttempts } from "../auth-throttle.js";
import { bootstrapOwner } from "../bootstrap.js";
import { issueLogin, findLogin, mintCiToken, revokeLogin } from "../credentials/login.js";
import { mintHarnessCredential } from "../credentials/harness.js";
import { createAuthDatabase, createDatabase, type Database } from "../db.js";
import { dashboardDevices } from "../device-overview.js";
import { listClientKeys } from "../device-keys.js";
import { migrate } from "../migrate.js";
import { internalId } from "../ids.js";
import { computerDisplayName, effectiveIcon, findComputer, listComputers, updateComputer } from "./store.js";
import { computerFacts, unlinkedHooks } from "./summary.js";
import { loadComputerRecords } from "./record.js";

/** ADR 0011: a computer per login, renamed and given an icon by the owner, never touching the login's label. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const appUrl = "http://127.0.0.1:8180";
const secret = "test-only-computers-secret-0123456789abcdef";
const ownerToken = "computers_owner_token_abcdefghijklmnopqrstuvwxyz";
const otherToken = "computers_other_token_abcdefghijklmnopqrstuvwxyz";

suite("computers", () => {
  let db: Database;
  let authDb: Database;
  let principalId: string;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    authDb = createAuthDatabase(databaseUrl!);
    await migrate(db);
  });
  beforeEach(async () => {
    resetAuthAttempts();
    await db.query("TRUNCATE account_identities, principal_api_keys, owner_principals, request_rate_limits CASCADE");
    await db.query("TRUNCATE auth.sessions, auth.accounts, auth.verifications, auth.users CASCADE");
    await bootstrapOwner(db,"owner",ownerToken);
    principalId = (await db.query<{ id: string }>("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0]!.id;
  });
  afterAll(async () => Promise.all([db.end(),authDb.end()]));

  const signIn = async (label: string) => {
    const issued = await issueLogin(db,{ principalId,label,scopes: [...LOGIN_SCOPES],expiresAt: null });
    if (typeof issued === "string") throw new Error(issued);
    return issued;
  };
  const computerCount = async (label: string) => Number((await db.query<{ n: string }>(
    "SELECT count(*) AS n FROM computers c JOIN principal_api_keys k ON k.id=c.login_key_id WHERE k.label=$1",[label])).rows[0]!.n);

  test("a sign-in creates exactly one computer, a re-login keeps it, a CI token and the bootstrap key behave", async () => {
    const first = await signIn("Studio Mac");
    expect(await computerCount("Studio Mac")).toBe(1);
    const before = (await db.query<{ id: string }>("SELECT id FROM computers WHERE login_key_id=$1",[first.row.id])).rows[0]!.id;
    await updateComputer(db,principalId,before,{ name: "Desk",icon: "desktop" });
    const again = await signIn("Studio Mac");
    expect(again.row.id).toBe(first.row.id);
    expect(await computerCount("Studio Mac")).toBe(1);
    const kept = await findComputer(db,principalId,before);
    expect(kept).toMatchObject({ id: before,display_name: "Desk",icon: "desktop",label: "Studio Mac" });
    // The bootstrap owner key is a login, so it has one; a CI token never does.
    expect(await computerCount("bootstrap-owner")).toBe(1);
    const ci = await mintCiToken(db,{ principalId,name: "pipeline",scopes: ["notifications:send"],expiresInDays: 7,
      maker: { credentialId: null,kind: "owner",scopes: "all" } });
    expect(typeof ci).toBe("object");
    expect(await computerCount("pipeline")).toBe(0);
    expect(Number((await db.query<{ n: string }>("SELECT count(*) AS n FROM computers")).rows[0]!.n)).toBe(2);
  });

  test("rename and icon set and clear without touching the label; the icon check refuses unknown values", async () => {
    const login = await signIn("Studio Mac");
    const id = (await db.query<{ id: string }>("SELECT id FROM computers WHERE login_key_id=$1",[login.row.id])).rows[0]!.id;
    expect(await updateComputer(db,principalId,id,{ name: "Studio" })).toBe(true);
    let row = (await findComputer(db,principalId,id))!;
    expect(computerDisplayName(row)).toBe("Studio");
    expect(row.icon).toBeNull();
    expect(effectiveIcon(row)).toEqual({ icon: "laptop",source: "default" });
    await updateComputer(db,principalId,id,{ icon: "server" });
    row = (await findComputer(db,principalId,id))!;
    expect(row).toMatchObject({ display_name: "Studio",icon: "server",label: "Studio Mac" });
    expect(effectiveIcon(row)).toEqual({ icon: "server",source: "owner" });
    await updateComputer(db,principalId,id,{ name: null,icon: null });
    row = (await findComputer(db,principalId,id))!;
    expect(computerDisplayName(row)).toBe("Studio Mac");
    expect(row.icon).toBeNull();
    await expect(db.query("UPDATE computers SET icon='toaster' WHERE id=$1",[id])).rejects.toThrow();
    // The machine's own kind hint decides only when the owner chose nothing.
    expect(effectiveIcon({ icon: null,report: { machineKind: "cloud" } })).toEqual({ icon: "cloud",source: "detected" });
    expect(effectiveIcon({ icon: "build",report: { machineKind: "cloud" } })).toEqual({ icon: "build",source: "owner" });
  });

  test("the display name is what the login row, client keys and devices show", async () => {
    const login = await signIn("Studio Mac");
    const id = (await db.query<{ id: string }>("SELECT id FROM computers WHERE login_key_id=$1",[login.row.id])).rows[0]!.id;
    expect((await findLogin(db,login.token))?.display_name).toBeNull();
    await updateComputer(db,principalId,id,{ name: "Desk" });
    expect((await findLogin(db,login.token))?.display_name).toBe("Desk");
    await db.query("INSERT INTO client_identity_keys(api_key_id,principal_id,key_id,public_key) VALUES ($1,$2,$3,$4)",
      [login.row.id,principalId,`k_${"A".repeat(22)}`,"B".repeat(87)]);
    expect((await listClientKeys(db,principalId)).map((key) => key.name)).toEqual(["Desk"]);
    expect((await listClientKeys(db,principalId)).map((key) => key.icon)).toEqual(["laptop"]);
    await updateComputer(db,principalId,id,{ icon: "server" });
    expect((await listClientKeys(db,principalId)).map((key) => key.icon)).toEqual(["server"]);
    const devices = await dashboardDevices(db,principalId);
    expect(devices.filter((device) => device.kind === "computer").map((device) => `${device.name}:${device.icon}`).sort())
      .toEqual(["Desk:server","bootstrap-owner:laptop"]);
    expect(devices.filter((device) => device.kind === "computer").map((device) => device.name).sort()).toEqual(["Desk","bootstrap-owner"]);
  });

  test("hooks credentials link to the computer of the login that mints them, and show as unlinked once it is revoked", async () => {
    const login = await signIn("Studio Mac");
    const id = (await db.query<{ id: string }>("SELECT id FROM computers WHERE login_key_id=$1",[login.row.id])).rows[0]!.id;
    const minted = await mintHarnessCredential(db,principalId,"studio hooks",login.row.id);
    expect(typeof minted).toBe("object");
    expect((await db.query("SELECT 1 FROM harness_credentials WHERE computer_id=$1",[id])).rowCount).toBe(1);
    const facts = (await computerFacts(db,[id])).get(id)!;
    expect(facts.hooks.map((hook) => hook.name)).toEqual(["studio hooks"]);
    expect(await unlinkedHooks(db,principalId,50)).toEqual([]);
    await revokeLogin(db,principalId,login.row.id);
    expect((await unlinkedHooks(db,principalId,50)).map((hook) => hook.name)).toEqual(["studio hooks"]);
    expect((await listComputers(db,principalId,50)).map((row) => row.label)).toEqual(["bootstrap-owner"]);
    expect(await findComputer(db,principalId,id)).toBeUndefined();
  });

  test("the summary counts tools, open cards and last use per computer in one pass", async () => {
    const mac = await signIn("Studio Mac");
    const other = await signIn("Build box");
    const id = (await db.query<{ id: string }>("SELECT id FROM computers WHERE login_key_id=$1",[mac.row.id])).rows[0]!.id;
    const otherId = (await db.query<{ id: string }>("SELECT id FROM computers WHERE login_key_id=$1",[other.row.id])).rows[0]!.id;
    for (const harness of ["claude-code","codex","claude-code"]) {
      await db.query(
        `INSERT INTO works(principal_id,producer_type,credential_id,session_key,harness,lifecycle,paused_reason)
         VALUES ($1,'agent_session',$2,$3,$4,'paused','declared')`,
        [principalId,mac.row.id,`session-${randomUUID()}`,harness],
      );
    }
    await db.query(`INSERT INTO devices (principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
      os_version,model,apns_environment,notification_authorization,live_activity_authorization,credential_version)
      VALUES ($1,'s','i','Phone','com.example.relo.notifications','1','1','18','iPhone','sandbox','authorized','authorized',1)`,[principalId]);
    const app = createApp(db,{ apnsMode: "disabled",credentialDerivationSecret: secret });
    const card = await app.request("/api/live-activities",{ method: "POST",
      headers: { authorization: `Bearer ${mac.token}`,"content-type": "application/json","idempotency-key": randomUUID() },
      body: JSON.stringify({ key: "export",acquireMode: "ensure",title: "Export",status: "Running" }) });
    expect(card.status).toBe(201);
    await db.query("UPDATE principal_api_keys SET last_used_at=now() WHERE id=$1",[mac.row.id]);
    const facts = await computerFacts(db,[id,otherId]);
    expect(facts.get(id)).toMatchObject({ tools: ["claude-code","codex"],openCards: 1,encryption: "no_keys" });
    expect(facts.get(id)!.lastSeenAt).not.toBeNull();
    expect(facts.get(otherId)).toMatchObject({ tools: [],openCards: 0,lastSeenAt: null,hooks: [] });
    const records = await loadComputerRecords(db,principalId,50);
    const record = records.find((entry) => entry.name === "Studio Mac")!;
    expect(record).toMatchObject({ id: `cmp_${id}`,loginId: `key_${mac.row.id}`,icon: "laptop",iconSource: "default",
      tools: ["claude-code","codex"],openCards: 1 });
  });

  describe("PATCH /api/dashboard/computers/:id", () => {
    const app = () => createApp(db,{
      accountAuth: createAccountAuth(authDb,appUrl,secret),bootstrapOwnerHandle: "owner",
      credentialDerivationSecret: secret,appUrl,apnsMode: "disabled",
    });
    async function session(application: ReturnType<typeof app>) {
      const credentials = { name: "Relo Owner",email: "owner@example.com",password: "unique-test-password" };
      const headers = { "content-type": "application/json",origin: appUrl };
      expect((await application.request("/api/auth/sign-up/email",{ method: "POST",headers,body: JSON.stringify(credentials) })).status).toBe(200);
      const signin = await application.request("/api/auth/sign-in/email",{ method: "POST",headers,
        body: JSON.stringify({ email: credentials.email,password: credentials.password,rememberMe: true }) });
      expect(signin.status).toBe(200);
      return signin.headers.get("set-auth-token")!;
    }
    const patch = (application: ReturnType<typeof app>,token: string,id: string,body: unknown) => application.request(
      `/api/dashboard/computers/${id}`,{ method: "PATCH",
        headers: { authorization: `Bearer ${token}`,"content-type": "application/json",origin: appUrl },body: JSON.stringify(body) });

    test("renames, sets and clears the icon, refuses bad input, and finds only the account's own live computers", async () => {
      const application = app();
      const token = await session(application);
      const login = await signIn("Studio Mac");
      const id = `cmp_${(await db.query<{ id: string }>("SELECT id FROM computers WHERE login_key_id=$1",[login.row.id])).rows[0]!.id}`;

      const renamed = await patch(application,token,id,{ name: "  Desk  ",icon: "desktop" });
      expect(renamed.status).toBe(200);
      expect(await renamed.json()).toMatchObject({ id,name: "Desk",label: "Studio Mac",icon: "desktop",iconSource: "owner",loginId: `key_${login.row.id}` });
      expect((await db.query("SELECT label FROM principal_api_keys WHERE id=$1",[login.row.id])).rows[0].label).toBe("Studio Mac");
      const cleared = await patch(application,token,id,{ name: null,icon: null });
      expect(await cleared.json()).toMatchObject({ name: "Studio Mac",icon: "laptop",iconSource: "default" });

      for (const bad of [{},{ icon: "toaster" },{ name: "" },{ name: "x".repeat(81) },{ label: "x" }]) {
        expect((await patch(application,token,id,bad)).status,JSON.stringify(bad)).toBe(400);
      }
      expect((await patch(application,token,"cmp_not-a-uuid",{ name: "x" })).status).toBe(404);
      expect((await patch(application,token,`cmp_${randomUUID()}`,{ name: "x" })).status).toBe(404);

      // Another account's computer answers like a missing one and does not change.
      await bootstrapOwner(db,"other",otherToken);
      const foreign = `cmp_${(await db.query<{ id: string }>(
        `SELECT c.id FROM computers c JOIN owner_principals p ON p.id=c.principal_id WHERE p.handle='other'`)).rows[0]!.id}`;
      expect((await patch(application,token,foreign,{ name: "Hijacked" })).status).toBe(404);
      expect((await db.query("SELECT display_name FROM computers WHERE id=$1",[internalId("cmp",foreign)])).rows[0].display_name).toBeNull();

      // A revoked login's computer is gone from the owner's view.
      await revokeLogin(db,principalId,login.row.id);
      expect((await patch(application,token,id,{ name: "Late" })).status).toBe(404);
      expect((await application.request(`/api/dashboard/computers/${id}`,{ method: "PATCH",
        headers: { "content-type": "application/json",origin: appUrl },body: JSON.stringify({ name: "x" }) })).status).toBe(401);
    });
  });
});
