import { randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import type { SealedEnvelope } from "./sealed-content.js";
import { purgeUnreadableContent } from "./unreadable-content.js";

const b64 = (length: number) => randomBytes(length).toString("base64url");

function envelope(devices: string[],kind: SealedEnvelope["kind"] = "notice",context = "ntf:test"): SealedEnvelope {
  return { v: "relo.e2e.v1",kind,context,sender: "k_AAAAAAAAAAAAAAAAAAAAAA",
    recipients: devices.map((device) => ({ device,prekey: "pk_1",enc: b64(65),key: b64(48) })),
    nonce: b64(12),ct: b64(272),sig: b64(64) };
}

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("content no reader can open any more is deleted (owner request)",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>;
  const owner = "unreadable_content_owner_abcdefghijklmnopqrstuv";
  const context = { providerName: "Claude Code",project: "relo",threadName: "Release" };

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: "unreadable-content-secret-with-32-characters" });
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function request(method: string,path: string,body: unknown,token = owner) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json",
      "idempotency-key": randomUUID() },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  /** A phone with an identity and the prekey pk_1 in the key directory. */
  async function phone() {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token) VALUES ($1,$2,$3,'Phone',
      'com.example.relo.notifications','1','1','26','sandbox','authorized','fixture-alert') RETURNING id`,
    [principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [id,hashToken(credential)]);
    await db.query("INSERT INTO device_identity_keys(device_id,principal_id,key_id,public_key) VALUES ($1,$2,$3,$4)",
      [id,principalId,`k_${b64(16)}`,b64(65)]);
    await db.query(`INSERT INTO device_prekeys(device_id,principal_id,prekey_id,public_key,signature,signed_created_at)
      VALUES ($1,$2,'pk_1',$3,$4,$5)`,[id,principalId,b64(65),b64(64),new Date().toISOString()]);
    return { id,publicId: `dev_${id}`,credential };
  }
  const notice = async (devices: string[]) => {
    const bound = `ntf:${randomUUID()}`;
    const created = await request("POST","/api/notifications",{ sourceName: "Claude Code",context,
      sealed: { alerts: devices.filter((device) => device.startsWith("dev_")).map((device) => envelope([device],"notice",bound)),
        content: envelope(devices,"notice",bound) } });
    expect(created.status).toBe(201);
    return created.body.eventId.slice(4) as string;
  };
  const exists = async (eventId: string) => Boolean((await db.query("SELECT 1 FROM notification_events WHERE id=$1",[eventId])).rowCount);
  /** What a new identity does to the key directory: the old prekeys are gone. */
  const replaceKeys = (deviceId: string) => db.query("DELETE FROM device_prekeys WHERE device_id=$1",[deviceId]);

  test("a replaced key deletes what only it could open; what another phone can open stays",async () => {
    const [mine,other] = [await phone(),await phone()];
    const onlyMine = await notice([mine.publicId]);
    const both = await notice([mine.publicId,other.publicId]);
    const asked = await request("POST","/api/interactions",{ type: "approval",context,answerInApp: true,
      sealed: { alerts: [envelope([mine.publicId],"question")],content: envelope([mine.publicId],"question") } });
    expect(asked.status).toBe(201);
    const question = asked.body.eventId.slice(4) as string;
    const readable = await purgeUnreadableContent(db,principalId,"sandbox");
    expect(readable.eventsPurged).toBe(0);

    await replaceKeys(mine.id);
    const purged = await purgeUnreadableContent(db,principalId,"sandbox");
    expect(purged.eventsPurged).toBe(2);
    expect(await exists(onlyMine)).toBe(false);
    expect(await exists(question)).toBe(false);
    expect(await exists(both)).toBe(true);
    // A retried send of a deleted notice stays a duplicate instead of coming back.
    expect((await db.query("SELECT 1 FROM notification_idempotency_tombstones WHERE original_event_id=$1",[onlyMine])).rowCount).toBe(1);

    // The other phone signs out: now nothing can open the shared notice either.
    expect((await request("DELETE",`/api/devices/${other.publicId}`,undefined,other.credential)).status).toBe(204);
    expect(await exists(both)).toBe(false);
  });

  test("a linked browser keeps content readable; unlinking it lets the purge go on",async () => {
    const mine = await phone();
    const browserId = randomUUID();
    await db.query(`INSERT INTO linked_browsers(id,principal_id,name,key_id,identity_key,prekey_id,prekey_public_key,prekey_signature,
      prekey_created_at,linked_at) VALUES ($1,$2,'Chrome',$3,$4,'pk_1',$5,$6,$7,now())`,
    [browserId,principalId,`k_${b64(16)}`,b64(65),b64(65),b64(64),new Date().toISOString()]);
    const shared = await notice([mine.publicId,`brw_${browserId}`]);
    await replaceKeys(mine.id);
    expect((await purgeUnreadableContent(db,principalId,"sandbox")).eventsPurged).toBe(0);
    expect(await exists(shared)).toBe(true);
    expect((await request("DELETE",`/api/devices/self/links/brw_${browserId}`,undefined,mine.credential)).status).toBe(204);
    expect(await exists(shared)).toBe(false);
  });
});
