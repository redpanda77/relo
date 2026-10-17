import { LOGIN_SCOPES } from "@relo/notification-contracts";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.js";
import { generateToken,hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { issueLogin } from "../credentials/login.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { updateComputer } from "../computers/store.js";
import { createTransportTokenEncryption } from "../token-encryption.js";
import { changeAppearance } from "./reproject.js";

/** Plan 11 phase 2: a changed policy or icon reaches a computer's open cards, once per card, without re-declaring them. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const secret = "test-only-reproject-secret-0123456789abcdef";
const ownerToken = "reproject_owner_token_abcdefghijklmnopqrstuvwxyz";

suite("open cards follow an appearance change", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let principalId: string;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret });
  });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, principal_api_keys, request_rate_limits CASCADE");
    await bootstrapOwner(db,"reproject-owner",ownerToken);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='reproject-owner'")).rows[0].id;
    const deviceId = randomUUID();
    const encryption = createTransportTokenEncryption(secret);
    await db.query(
      `INSERT INTO devices (id,principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,model,apns_environment,apns_token,live_activity_push_to_start_token,notification_authorization,
         live_activity_authorization,credential_version)
       VALUES ($1,$2,$3,$4,'Phone','com.example.relo.notifications','1','1','18','iPhone','sandbox',$5,$6,
         'authorized','authorized',1)`,
      [deviceId,principalId,`stable-${deviceId}`,randomUUID(),encryption.encrypt("a".repeat(64),"device.apns_token"),
        encryption.encrypt("b".repeat(64),"device.live_activity_push_to_start_token")]);
    await db.query("INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",[deviceId,hashToken(generateToken())]);
  });
  afterAll(async () => db.end());

  const signIn = async (label: string) => {
    const issued = await issueLogin(db,{ principalId,label,scopes: [...LOGIN_SCOPES],expiresAt: null });
    if (typeof issued === "string") throw new Error(issued);
    const computerId = (await db.query<{ id: string }>("SELECT id FROM computers WHERE login_key_id=$1",[issued.row.id])).rows[0]!.id;
    return { ...issued,computerId };
  };
  const call = (token: string,path: string,body: unknown) => app.request(path,{
    method: "POST",headers: { authorization: `Bearer ${token}`,"content-type": "application/json","idempotency-key": randomUUID() },
    body: JSON.stringify(body),
  });
  async function card(token: string,key: string,project = "Relo") {
    const started = await call(token,"/api/live-activities",{
      key,title: "Export",status: "Running",context: { project,threadName: `Run ${key}` } });
    expect(started.status,await started.clone().text()).toBe(201);
    return (await started.json() as any).activity.id.slice("act_".length) as string;
  }
  const row = async (id: string) => (await db.query<any>(
    "SELECT sequence,declared_at,stale_at,presentation FROM live_activities WHERE id=$1",[id])).rows[0];
  const events = async (id: string) => Number((await db.query<{ n: string }>(
    `SELECT count(*) AS n FROM notification_events WHERE payload#>>'{liveActivity,activityId}'=$1`,[`act_${id}`])).rows[0]!.n);

  test("a policy change shows the open cards again once each; another computer's cards and freshness are untouched", async () => {
    const mac = await signIn("Studio Mac");
    const other = await signIn("Build box");
    const a = await card(mac.token,"a");
    const b = await card(mac.token,"b","Heard");
    const foreign = await card(other.token,"c");
    const before = { a: await row(a),b: await row(b),foreign: await row(foreign) };
    expect(before.a.presentation.identity.project).toMatchObject({ icon: "laptop",provenance: "generated" });
    const eventsBefore = { a: await events(a),b: await events(b),foreign: await events(foreign) };
    await db.query("UPDATE live_activities SET declared_at=declared_at-interval '10 minutes'");
    const declared = (await row(a)).declared_at;

    const policy = { colorStrategy: "fixed",accentColor: "#112233" };
    const saved = await changeAppearance(db,{ principalId,credentialId: mac.row.id },"sandbox",
      async (tx) => (await tx.query("UPDATE principal_api_keys SET live_activity_policy=$2::jsonb WHERE id=$1",
        [mac.row.id,policy])).rowCount ? true : null);
    expect(saved).toBe(true);

    for (const [id,name] of [[a,"a"],[b,"b"]] as const) {
      const after = await row(id);
      expect(after.presentation.identity.project.color).toBe("#112233");
      expect(Number(after.sequence)).toBe(Number(before[name].sequence) + 1);
      expect(await events(id)).toBe(eventsBefore[name] + 1);
    }
    // The producer declared nothing: freshness did not move, and the card's content is as it was.
    expect((await row(a)).declared_at).toEqual(declared);
    expect((await row(a)).presentation.content).toEqual(before.a.presentation.content);
    // Another computer's card is not shown again.
    const untouched = await row(foreign);
    expect(Number(untouched.sequence)).toBe(Number(before.foreign.sequence));
    expect(untouched.presentation).toEqual(before.foreign.presentation);
    expect(await events(foreign)).toBe(eventsBefore.foreign);
  });

  test("a new icon becomes the open card's project icon, and clearing it falls back to the default", async () => {
    const mac = await signIn("Studio Mac");
    const id = await card(mac.token,"a");
    const set = (icon: "server" | null) => changeAppearance(db,{ principalId,credentialId: mac.row.id },"sandbox",
      async (tx) => await updateComputer(tx,principalId,mac.computerId,{ icon }) ? true : null);
    expect(await set("server")).toBe(true);
    expect((await row(id)).presentation.identity.project).toMatchObject({ icon: "server",label: "Relo" });
    expect(await set(null)).toBe(true);
    expect((await row(id)).presentation.identity.project).toMatchObject({ icon: "laptop" });
  });

  test("a change that matches nothing writes nothing and shows no card", async () => {
    const mac = await signIn("Studio Mac");
    const id = await card(mac.token,"a");
    const before = await row(id);
    expect(await changeAppearance(db,{ principalId,credentialId: mac.row.id },"sandbox",async () => null)).toBeNull();
    expect(Number((await row(id)).sequence)).toBe(Number(before.sequence));
  });

  test("question cards from a login use its policy, accent and computer icon", async () => {
    const mac = await signIn("Studio Mac");
    await db.query("UPDATE principal_api_keys SET live_activity_policy=$2::jsonb WHERE id=$1",
      [mac.row.id,{ colorStrategy: "fixed",accentColor: "#AA5500" }]);
    await db.query("UPDATE computers SET icon='cloud' WHERE id=$1",[mac.computerId]);
    const asked = await call(mac.token,"/api/interactions",{ type: "approval",title: "Release",prompt: "Ship 1.2?",
      presentation: "live_activity",expiresInSeconds: 120,context: { project: "Relo" } });
    expect(asked.status,await asked.clone().text()).toBe(201);
    const stored = (await db.query<any>(
      `SELECT accent_color,presentation,presentation_policy_source FROM live_activities
       WHERE requester_credential_id=$1 AND start_idempotency_key LIKE 'interaction:%'`,[mac.row.id])).rows[0];
    expect(stored.accent_color).toBe("#AA5500");
    expect(stored.presentation_policy_source).toBe("client");
    expect(stored.presentation.identity.project).toMatchObject({ color: "#AA5500",icon: "cloud" });
    expect(stored.presentation.behavior.type).toBe("approval");
  });
});
