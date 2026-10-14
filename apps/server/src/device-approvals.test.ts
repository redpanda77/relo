import { createECDH,randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { requestAllPendingApprovals } from "./device-approvals.js";
import { migrate } from "./migrate.js";
import { createNotificationContentCipher } from "./notification-content.js";

const b64 = (length: number) => randomBytes(length).toString("base64url");
const p256 = () => { const ecdh = createECDH("prime256v1"); return ecdh.generateKeys().toString("base64url"); };
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
  async function phone(name: string,minutesAgo: number,model: string | null = null,isSimulator = false) {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token,registered_at,model,is_simulator) VALUES ($1,$2,$3,$4,
      'com.example.relo.notifications','1','1','26','sandbox','authorized','fixture-alert',now()-make_interval(mins => $5),$6,$7) RETURNING id`,
    [principalId,randomUUID(),randomUUID(),name,minutesAgo,model,isSimulator])).rows[0]!.id;
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
    await db.query("UPDATE devices SET model='iPhone18,1' WHERE id=$1",[ipad.id]);
    // Already waiting before this existed: the worker's pass sends one notice, to the older phone only.
    // A failed send is retried by the next pass instead of being lost.
    expect(await requestAllPendingApprovals(db,"sandbox",null)).toBe(0);
    const cipher = createNotificationContentCipher("device-approvals-secret-with-32-characters");
    expect(await requestAllPendingApprovals(db,"sandbox",cipher)).toBe(1);
    expect(await requestAllPendingApprovals(db,"sandbox",cipher)).toBe(0);
    const notice = (await db.query(`SELECT e.title,e.deep_link,array_agg(t.device_id) AS targets FROM notification_events e
      JOIN notification_event_targets t ON t.notification_event_id=e.id WHERE e.principal_id=$1 GROUP BY e.id`,[principalId])).rows;
    expect(notice).toEqual([{ title: "iPhone 17 Pro wants to read your Relo cards",deep_link: `relo://security/request/${ipad.publicId}`,targets: [trusted.id] }]);

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

  test("a second computer's first key tells the phones once; the first computer needs no notice",async () => {
    const trusted = await phone("iPhone",60);
    const computer = async (label: string) => {
      const token = generateToken();
      await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes) VALUES ($1,$2,$3,ARRAY['devices:read'])",
        [principalId,label,hashToken(token)]);
      return token;
    };
    const notices = async () => (await db.query(`SELECT e.title,e.deep_link,array_agg(t.device_id) AS targets FROM notification_events e
      JOIN notification_event_targets t ON t.notification_event_id=e.id WHERE e.principal_id=$1 GROUP BY e.id`,[principalId])).rows;
    const studio = await computer("Studio Mac");
    const laptopId = () => db.query<{ id: string }>("SELECT id FROM principal_api_keys WHERE label='Laptop'").then((r) => r.rows[0]!.id);
    expect((await call(studio,"PUT","/api/clients/self/keys",{ identityKey: p256() })).status).toBe(200);
    expect(await notices()).toEqual([]);
    const laptop = await computer("Laptop");
    const identityKey = p256();
    expect((await call(laptop,"PUT","/api/clients/self/keys",{ identityKey })).status).toBe(200);
    expect((await call(laptop,"PUT","/api/clients/self/keys",{ identityKey })).status).toBe(200);
    expect(await notices()).toEqual([{ title: "New computer wants access",deep_link: `relo://security/request/key_${await laptopId()}`,targets: [trusted.id] }]);
    const body = await db.query(`SELECT e.payload FROM notification_events e WHERE e.principal_id=$1`,[principalId]);
    expect(body.rows[0].payload.computerApproval).toEqual({ clientId: `key_${await laptopId()}` });
  });

  test("declining signs the newer device out",async () => {
    const trusted = await phone("iPhone",60);
    const stranger = await phone("Unknown iPhone",2);
    expect((await call(trusted.credential,"POST",`/api/devices/self/approvals/${stranger.publicId}/decline`)).status).toBe(204);
    expect((await db.query("SELECT revoked_at IS NOT NULL AS revoked FROM devices WHERE id=$1",[stranger.id])).rows[0].revoked).toBe(true);
    expect((await call(stranger.credential,"GET","/api/devices/self/pending-devices")).status).toBe(401);
  });

  test("simulators: labelled, never notified, and never the device that vouches for a real phone",async () => {
    const cipher = createNotificationContentCipher("device-approvals-secret-with-32-characters");
    const simulator = await phone("iPhone Air",90,"arm64");
    const flagged = await phone("Test iPhone",80,"iPhone18,4",true);
    const real = await phone("Owner iPhone",30,"iPhone19,7");
    // A real phone behind only simulators is not "pending" behind them, and they get no notice.
    expect(await requestAllPendingApprovals(db,"sandbox",cipher)).toBe(0);
    // A simulator caller sees only simulators (here the newer flagged one), never the real phone.
    expect((await call(simulator.credential,"GET","/api/devices/self/pending-devices")).body.devices.map((device: any) => device.deviceId))
      .toEqual([flagged.publicId]);
    const approval = { deviceId: real.publicId,identityKey: real.identityKey,signedAt: new Date().toISOString(),signature: b64(64) };
    expect((await call(simulator.credential,"POST","/api/devices/self/approvals",approval)).status).toBe(404);
    expect((await call(simulator.credential,"POST",`/api/devices/self/approvals/${real.publicId}/decline`)).status).toBe(404);

    // A simulator that signs in later waits on the real phone, which is told; simulators are not.
    const later = await phone("iPhone Air",2,"arm64");
    expect(await requestAllPendingApprovals(db,"sandbox",cipher)).toBe(1);
    const notices = (await db.query(`SELECT e.title,array_agg(t.device_id) AS targets FROM notification_events e
      JOIN notification_event_targets t ON t.notification_event_id=e.id WHERE e.principal_id=$1 GROUP BY e.id`,[principalId])).rows;
    expect(notices).toEqual([{ title: "Simulator wants to read your Relo cards",targets: [real.id] }]);
    const pending = (await call(real.credential,"GET","/api/devices/self/pending-devices")).body.devices;
    expect(pending).toEqual([expect.objectContaining({ deviceId: later.publicId,modelName: "Simulator",isSimulator: true })]);

    const cli = generateToken();
    await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes) VALUES ($1,'Mac',$2,ARRAY['devices:read'])",
      [principalId,hashToken(cli)]);
    const inventory = (await call(cli,"GET","/api/devices")).body.devices;
    expect(inventory.find((device: any) => device.deviceId === real.publicId)).toMatchObject({ modelName: "iPhone 18 Pro Max",isSimulator: false });
    expect(inventory.find((device: any) => device.deviceId === flagged.publicId)).toMatchObject({ modelName: "Simulator",isSimulator: true });
    const keys = (await call(cli,"GET","/api/devices/keys")).body.devices;
    expect(keys.find((device: any) => device.deviceId === simulator.publicId).simulator).toBe(true);
    expect(keys.find((device: any) => device.deviceId === real.publicId).simulator).toBe(false);

    // The phone says so in its heartbeat; older builds that do not send it keep working.
    expect((await call(real.credential,"PUT",`/api/devices/${real.publicId}`,{ appVersion: "2" })).status).toBe(200);
    expect((await call(real.credential,"PUT",`/api/devices/${real.publicId}`,{ isSimulator: false })).status).toBe(200);
    expect((await db.query("SELECT is_simulator FROM devices WHERE id=$1",[real.id])).rows[0].is_simulator).toBe(false);
  });

  test("a phone lists the account's phones with what the server holds as trusted",async () => {
    const simulator = await phone("iPhone Air",120,"arm64");
    const main = await phone("Owner iPhone",90,"iPhone19,7");
    const ipad = await phone("iPad",30,"iPad16,3");
    const browserApproved = await phone("Work iPhone",20,"iPhone18,1");
    const gone = await phone("Old iPhone",10,"iPhone15,2");
    await db.query("UPDATE devices SET revoked_at=now() WHERE id=$1",[gone.id]);
    const approval = { deviceId: ipad.publicId,identityKey: ipad.identityKey,signedAt: new Date().toISOString(),signature: b64(64) };
    expect((await call(main.credential,"POST","/api/devices/self/approvals",approval)).status).toBe(200);
    const browser = randomUUID();
    await db.query(`INSERT INTO linked_browsers(id,principal_id,name,key_id,identity_key,prekey_id,prekey_public_key,prekey_signature,
      prekey_created_at) VALUES ($1,$2,'Chrome',$3,$4,'pk_1',$5,$6,$7)`,[browser,principalId,`k_${b64(16)}`,b64(65),b64(65),b64(64),new Date().toISOString()]);
    await db.query(`INSERT INTO device_approvals(device_id,principal_id,identity_key,approved_by_browser,signed_at,signature)
      VALUES ($1,$2,$3,$4,$5,$6)`,[browserApproved.id,principalId,browserApproved.identityKey,browser,new Date().toISOString(),b64(64)]);

    const listed = await call(ipad.credential,"GET","/api/devices/self/devices");
    expect(listed.status).toBe(200);
    expect(listed.body.devices.map((device: any) => [device.name,device.model,device.isSimulator,device.isCurrent,device.trusted])).toEqual([
      ["iPhone Air","arm64",true,false,false],
      ["Owner iPhone","iPhone19,7",false,false,true],
      ["iPad","iPad16,3",false,true,true],
      ["Work iPhone","iPhone18,1",false,false,true],
    ]);
    expect(Object.keys(listed.body.devices[0]).sort()).toEqual(["deviceId","isCurrent","isSimulator","lastSeenAt","model","name","registeredAt","trusted"]);
    // A new identity key needs a new approval.
    await db.query("UPDATE device_identity_keys SET public_key=$2 WHERE device_id=$1",[ipad.id,b64(65)]);
    expect((await call(main.credential,"GET","/api/devices/self/devices")).body.devices.find((device: any) => device.deviceId === ipad.publicId))
      .toMatchObject({ trusted: false,isCurrent: false });
    const cli = generateToken();
    await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes) VALUES ($1,'Mac',$2,ARRAY['devices:read'])",
      [principalId,hashToken(cli)]);
    expect((await call(cli,"GET","/api/devices/self/devices")).status).toBe(403);
  });
});
