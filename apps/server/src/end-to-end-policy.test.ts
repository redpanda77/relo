import { randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { carriesCardText } from "./end-to-end-policy.js";

const b64 = (length: number) => randomBytes(length).toString("base64url");
const envelope = (devices: string[],kind: string) => ({
  v: "relo.e2e.v1",kind,context: "acct:a/idem:1",sender: "k_AAAAAAAAAAAAAAAAAAAAAA",
  recipients: devices.map((device) => ({ device,prekey: "pk_1",enc: b64(65),key: b64(48) })),
  nonce: b64(12),ct: b64(272),sig: b64(64),
});

describe("card text detection",() => {
  test("numbers, symbols and timings are not text; titles, statuses and steps are",() => {
    expect(carriesCardText({ progress: 0.5,symbol: "terminal",staleAfterSeconds: 60 })).toBe(false);
    for (const field of ["title","status","detail","progressLabel","steps","presentation"]) {
      expect(carriesCardText({ [field]: "x" })).toBe(true);
    }
    expect(carriesCardText({ detail: null })).toBe(false);
  });
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("require end-to-end encryption (E6.1)",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>;
  const owner = "end_to_end_owner_abcdefghijklmnopqrstuvwxyz0123";
  const secret = "end-to-end-policy-secret-with-32-characters";
  const context = { providerName: "Claude Code",project: "relo",threadName: "Release" };

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret });
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function request(method: string,path: string,body: unknown,token: string) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json",
      "idempotency-key": randomUUID() },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  async function phone() {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,apns_token,
      live_activity_push_to_start_token) VALUES ($1,$2,$3,'Phone','com.example.relo.notifications','1','1','26','sandbox',
      'authorized','authorized','fixture-alert','fixture-start') RETURNING id`,[principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [id,hashToken(credential)]);
    return { id,publicId: `dev_${id}`,credential };
  }

  test("off by default; once on, readable CLI content is refused and sealed content is accepted",async () => {
    const device = await phone();
    expect((await request("GET","/api/end-to-end/policy",undefined,owner)).body).toEqual({ required: false,mode: "auto" });
    expect((await request("POST","/api/notifications",{ sourceName: "Claude Code",title: "Plain",body: "Readable",context },owner)).status).toBe(201);

    expect((await request("PUT","/api/end-to-end/policy",{ required: true },owner))).toEqual({ status: 200,body: { required: true,mode: "on" } });
    expect((await request("PUT","/api/end-to-end/policy",{ required: false },device.credential)).status).toBe(403);
    expect((await request("GET","/api/end-to-end/policy",undefined,device.credential)).body).toEqual({ required: true,mode: "on" });

    const refused = { status: 409,body: expect.objectContaining({ error: "end_to_end_required" }) };
    expect(await request("POST","/api/notifications",{ sourceName: "Claude Code",title: "Plain",body: "Readable",context },owner)).toMatchObject(refused);
    expect(await request("POST","/api/interactions",{ title: "Deploy",prompt: "Deploy?",type: "approval",answerInApp: true,context },owner)).toMatchObject(refused);
    expect(await request("POST","/api/live-activities",{ key: "plain-card",title: "Release",status: "Working",context },owner)).toMatchObject(refused);

    const sealedNotice = { alerts: [envelope([device.publicId],"notice")],content: envelope([device.publicId],"notice") };
    expect((await request("POST","/api/notifications",{ sourceName: "Claude Code",context,sealed: sealedNotice },owner)).status).toBe(201);
    const sealedCard = { alerts: [envelope([device.publicId],"card")],content: envelope([device.publicId],"card") };
    const card = await request("POST","/api/live-activities",{ key: "sealed-card",title: "Encrypted card",status: "Updating…",
      context,deviceIds: [device.publicId],sealed: sealedCard },owner);
    expect(card.status).toBe(201);
    // Progress alone carries no text; a readable status does.
    expect((await request("PATCH",`/api/live-activities/${card.body.activity.id}`,{ progress: 0.4 },owner)).status).toBe(200);
    expect(await request("PATCH",`/api/live-activities/${card.body.activity.id}`,{ status: "Readable" },owner)).toMatchObject(refused);
    expect(await request("POST",`/api/live-activities/${card.body.activity.id}/wait`,{ type: "approval",prompt: "Plain?",expiresInSeconds: 60 },owner))
      .toMatchObject(refused);

    expect((await request("PUT","/api/end-to-end/policy",{ required: false },owner)).body).toEqual({ required: false,mode: "off" });
    expect((await request("POST","/api/notifications",{ sourceName: "Claude Code",title: "Plain",body: "Readable",context },owner)).status).toBe(201);
  });

  test("automatic by default: required once a phone of the account has published keys",async () => {
    const device = await phone();
    expect((await request("GET","/api/end-to-end/policy",undefined,owner)).body).toEqual({ required: false,mode: "auto" });
    await db.query(`INSERT INTO device_identity_keys(device_id,principal_id,key_id,public_key)
      VALUES ($1,$2,'k_AAAAAAAAAAAAAAAAAAAAAA',$3)`,[device.id,principalId,"A".repeat(87)]);
    expect((await request("GET","/api/end-to-end/policy",undefined,owner)).body).toEqual({ required: true,mode: "auto" });
    expect((await request("POST","/api/notifications",{ sourceName: "Claude Code",title: "Plain",body: "Readable",context },owner)).status).toBe(409);
    expect((await request("PUT","/api/end-to-end/policy",{ required: false },owner)).body).toEqual({ required: false,mode: "off" });
    expect((await request("POST","/api/notifications",{ sourceName: "Claude Code",title: "Plain",body: "Readable",context },owner)).status).toBe(201);
    expect((await request("PUT","/api/end-to-end/policy",{ required: null },owner)).body).toEqual({ required: true,mode: "auto" });
    await db.query("UPDATE devices SET revoked_at=now() WHERE id=$1",[device.id]);
    expect((await request("GET","/api/end-to-end/policy",undefined,owner)).body).toEqual({ required: false,mode: "auto" });
  });
});
