import { randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { requestAllPendingApprovals } from "./device-approvals.js";
import { migrate } from "./migrate.js";
import { createNotificationContentCipher } from "./notification-content.js";

const b64 = (length: number) => randomBytes(length).toString("base64url");
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

suite("new devices are approved on a trusted phone",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>;
  const owner = "device_approvals_owner_abcdefghijklmnopqrstuvw";

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: "device-approvals-secret-with-32-characters" });
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function call(token: string,method: string,path: string,body?: unknown) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json",
      "idempotency-key": randomUUID() },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  /** A phone with keys, registered `minutesAgo` minutes ago. */
  async function phone(name: string,minutesAgo: number) {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token,registered_at) VALUES ($1,$2,$3,$4,
      'com.example.relo.notifications','1','1','26','sandbox','authorized','fixture-alert',now()-make_interval(mins => $5)) RETURNING id`,
    [principalId,randomUUID(),randomUUID(),name,minutesAgo])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [id,hashToken(credential)]);
    const identityKey = b64(65);
    await db.query("INSERT INTO device_identity_keys(device_id,principal_id,key_id,public_key) VALUES ($1,$2,$3,$4)",
      [id,principalId,`k_${b64(16)}`,identityKey]);
    return { id,publicId: `dev_${id}`,credential,identityKey,name };
  }

  test("the trusted phone sees the newer device, approves it, and computers get the signature",async () => {
    const trusted = await phone("iPhone",60);
    const ipad = await phone("iPad",5);
    // Already waiting before this existed: the worker's pass sends one notice, to the older phone only.
    // A failed send is retried by the next pass instead of being lost.
    expect(await requestAllPendingApprovals(db,"sandbox",null)).toBe(0);
    const cipher = createNotificationContentCipher("device-approvals-secret-with-32-characters");
    expect(await requestAllPendingApprovals(db,"sandbox",cipher)).toBe(1);
    expect(await requestAllPendingApprovals(db,"sandbox",cipher)).toBe(0);
    const notice = (await db.query(`SELECT e.title,e.deep_link,array_agg(t.device_id) AS targets FROM notification_events e
      JOIN notification_event_targets t ON t.notification_event_id=e.id WHERE e.principal_id=$1 GROUP BY e.id`,[principalId])).rows;
    expect(notice).toEqual([{ title: "New device wants access",deep_link: "relo://settings/security",targets: [trusted.id] }]);

    const listed = await call(trusted.credential,"GET","/api/devices/self/pending-devices");
    expect(listed.body.devices.map((device: any) => [device.deviceId,device.name,device.identityKey])).toEqual([[ipad.publicId,"iPad",ipad.identityKey]]);
    // The new device never sees (or can decline) the phone that is already there.
    expect((await call(ipad.credential,"GET","/api/devices/self/pending-devices")).body.devices).toEqual([]);
    expect((await call(ipad.credential,"POST",`/api/devices/self/approvals/${trusted.publicId}/decline`)).status).toBe(404);

    const approval = { deviceId: ipad.publicId,identityKey: ipad.identityKey,signedAt: new Date().toISOString(),signature: b64(64) };
    expect((await call(trusted.credential,"POST","/api/devices/self/approvals",{ ...approval,identityKey: b64(65) })).status).toBe(409);
    expect((await call(trusted.credential,"POST","/api/devices/self/approvals",{ ...approval,deviceId: `dev_${randomUUID()}` })).status).toBe(404);
    expect((await call(trusted.credential,"POST","/api/devices/self/approvals",approval)).status).toBe(200);
    expect((await call(trusted.credential,"GET","/api/devices/self/pending-devices")).body.devices).toEqual([]);

    const cli = generateToken();
    await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes) VALUES ($1,'Mac',$2,ARRAY['devices:read'])",
      [principalId,hashToken(cli)]);
    const directory = (await call(cli,"GET","/api/devices/keys")).body.devices;
    expect(directory.find((device: any) => device.deviceId === ipad.publicId).approval)
      .toEqual({ deviceId: trusted.publicId,signedAt: approval.signedAt,signature: approval.signature });
    expect(directory.find((device: any) => device.deviceId === trusted.publicId).approval).toBeNull();
    // A new identity on the iPad needs a new approval.
    await db.query("UPDATE device_identity_keys SET public_key=$2 WHERE device_id=$1",[ipad.id,b64(65)]);
    expect((await call(cli,"GET","/api/devices/keys")).body.devices.find((device: any) => device.deviceId === ipad.publicId).approval).toBeNull();
  });

  test("declining signs the newer device out",async () => {
    const trusted = await phone("iPhone",60);
    const stranger = await phone("Unknown iPhone",2);
    expect((await call(trusted.credential,"POST",`/api/devices/self/approvals/${stranger.publicId}/decline`)).status).toBe(204);
    expect((await db.query("SELECT revoked_at IS NOT NULL AS revoked FROM devices WHERE id=$1",[stranger.id])).rows[0].revoked).toBe(true);
    expect((await call(stranger.credential,"GET","/api/devices/self/pending-devices")).status).toBe(401);
  });
});
