import { createECDH,randomUUID } from "node:crypto";
import { afterAll,beforeAll,describe,expect,test } from "vitest";
import { createAccountAuth } from "./account-auth.js";
import { createApp } from "./app.js";
import { resetAuthAttempts } from "./auth-throttle.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createAuthDatabase,createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const appUrl = "http://127.0.0.1:8180";
const secret = "test-only-phone-sign-in-secret-0123456789abcdef";

// `relo auth login` (RFC 8628) approved from the owner's iPhone after it scans the CLI's QR code: the phone's own
// credential decides for its own account, like the web page does for a signed-in browser.
suite("a computer's sign-in approved on the phone",() => {
  let db: Database,authDb: Database,app: ReturnType<typeof createApp>;
  let principalId: string,apiKey: string;

  async function phone(name: string,{ registeredAt }: { registeredAt?: string } = {}) {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,registered_at) VALUES ($1,$2,$3,$4,'com.example.relo.notifications','1','1','26','sandbox',
      COALESCE($5::timestamptz,now())) RETURNING id`,[principalId,randomUUID(),randomUUID(),name,registeredAt ?? null])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [id,hashToken(credential)]);
    return { id,credential };
  }

  async function call(token: string,method: string,path: string) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}` } });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }

  async function start(clientName = "Build server",identityKey?: string) {
    const response = await app.request("/api/device-authorizations/start",{ method: "POST",headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName,scopes: ["notifications:send","interactions:read"],expiresInSeconds: 86_400,
        ...(identityKey ? { identityKey } : {}) }) });
    expect(response.status).toBe(201);
    return await response.json() as { deviceCode: string; userCode: string };
  }
  const key = (_label: number) => { const ecdh = createECDH("prime256v1"); ecdh.generateKeys(); return ecdh.getPublicKey().toString("base64url"); };

  const poll = (deviceCode: string) => app.request("/api/device-authorizations/token",{ method: "POST",
    headers: { "content-type": "application/json" },body: JSON.stringify({ deviceCode }) });

  beforeAll(async () => {
    resetAuthAttempts();
    db = createDatabase(databaseUrl!);
    authDb = createAuthDatabase(databaseUrl!);
    await migrate(db);
    await db.query("TRUNCATE owner_principals, request_rate_limits, device_authorizations CASCADE");
    await db.query("TRUNCATE auth.sessions, auth.accounts, auth.verifications, auth.users CASCADE");
    app = createApp(db,{ accountAuth: createAccountAuth(authDb,appUrl,secret),bootstrapOwnerHandle: "owner",
      credentialDerivationSecret: secret,appUrl,apnsMode: "sandbox" });
    apiKey = "phone_sign_in_owner_abcdefghijklmnopqrstuvwxyz_0123456789";
    await bootstrapOwner(db,"owner",apiKey);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });
  afterAll(async () => { await Promise.all([db.end(),authDb.end()]); });

  test("the phone sees the request, approves it, and the computer receives its own login",async () => {
    const owner = await phone("Owner iPhone");
    const grant = await start();
    const seen = await call(owner.credential,"GET",`/api/devices/self/sign-ins/${grant.userCode}`);
    expect(seen.status).toBe(200);
    expect(seen.body.request).toMatchObject({ clientName: "Build server",status: "pending",userCode: grant.userCode,
      scopes: ["interactions:read","notifications:send"] });
    const approved = await call(owner.credential,"POST",`/api/devices/self/sign-ins/${grant.userCode}/approve`);
    expect(approved).toEqual({ status: 200,body: { status: "approved",userCode: grant.userCode } });
    expect((await call(owner.credential,"POST",`/api/devices/self/sign-ins/${grant.userCode}/approve`)).status).toBe(409);
    const issued = await poll(grant.deviceCode);
    expect(issued.status).toBe(200);
    const login = await issued.json() as any;
    expect(login.accessToken).toMatch(/^relo_/);
    expect((await db.query("SELECT principal_id FROM principal_api_keys WHERE label='Build server'")).rows[0].principal_id).toBe(principalId);
  });

  test("deny ends it; an unknown code is not found; a CLI login cannot use the phone's route",async () => {
    const owner = await phone("Owner iPhone 2");
    const grant = await start("Studio");
    expect((await call(apiKey,"POST",`/api/devices/self/sign-ins/${grant.userCode}/approve`)).status).toBe(403);
    expect(await call(owner.credential,"POST",`/api/devices/self/sign-ins/${grant.userCode}/deny`))
      .toEqual({ status: 200,body: { status: "denied",userCode: grant.userCode } });
    expect(await (await poll(grant.deviceCode)).json()).toEqual({ error: "access_denied" });
    expect((await call(owner.credential,"GET","/api/devices/self/sign-ins/ZZZZ-ZZZZ")).status).toBe(404);
  });

  test("a live CI token keeps its name from a sign-in; once revoked, a sign-in may take the name",async () => {
    const owner = await phone("Owner iPhone 3");
    const ci = await db.query<{ id: string }>(`INSERT INTO principal_api_keys(principal_id,label,token_hash,token_prefix,scopes,expires_at,kind)
      VALUES ($1,'Runner',$2,'relo_ci',ARRAY['notifications:send'],now()+interval '1 day','ci-token') RETURNING id`,
    [principalId,hashToken(generateToken())]);
    const first = await start("Runner");
    await call(owner.credential,"POST",`/api/devices/self/sign-ins/${first.userCode}/approve`);
    expect((await (await poll(first.deviceCode)).json() as any).error).toBe("client_name_taken");
    await db.query("UPDATE principal_api_keys SET revoked_at=now() WHERE id=$1",[ci.rows[0]!.id]);
    const second = await start("Runner");
    await call(owner.credential,"POST",`/api/devices/self/sign-ins/${second.userCode}/approve`);
    const issued = await poll(second.deviceCode);
    expect(issued.status).toBe(200);
    expect((await db.query("SELECT kind,revoked_at FROM principal_api_keys WHERE id=$1",[ci.rows[0]!.id])).rows[0])
      .toEqual({ kind: "login",revoked_at: null });
  });

  test("the request relays the identity key, and reports the issued login and whether it published that key",async () => {
    const owner = await phone("Owner iPhone 4");
    const identityKey = key(7);
    const grant = await start("Mac Studio",identityKey);
    const seen = await call(owner.credential,"GET",`/api/devices/self/sign-ins/${grant.userCode}`);
    expect(seen.body.request).toMatchObject({ identityKey,clientId: null,keyPublished: false });
    await call(owner.credential,"POST",`/api/devices/self/sign-ins/${grant.userCode}/approve`);
    const login = await (await poll(grant.deviceCode)).json() as any;
    const issued = await call(owner.credential,"GET",`/api/devices/self/sign-ins/${grant.userCode}`);
    expect(issued.body.request).toMatchObject({ identityKey,clientId: login.credential.id,keyPublished: false });
    const published = await app.request("/api/clients/self/keys",{ method: "PUT",headers: { authorization: `Bearer ${login.accessToken}`,"content-type": "application/json" },
      body: JSON.stringify({ identityKey }) });
    expect(published.status).toBeLessThan(300);
    expect((await call(owner.credential,"GET",`/api/devices/self/sign-ins/${grant.userCode}`)).body.request.keyPublished).toBe(true);
    await app.request("/api/clients/self/keys",{ method: "PUT",headers: { authorization: `Bearer ${login.accessToken}`,"content-type": "application/json" },
      body: JSON.stringify({ identityKey: key(9) }) });
    expect((await call(owner.credential,"GET",`/api/devices/self/sign-ins/${grant.userCode}`)).body.request.keyPublished).toBe(false);
  });

  test("a start without a key still works, and a malformed key is refused; start returns no request details",async () => {
    const grant = await start("No key");
    const owner = await phone("Owner iPhone 5");
    expect((await call(owner.credential,"GET",`/api/devices/self/sign-ins/${grant.userCode}`)).body.request)
      .toMatchObject({ identityKey: null,clientId: null,keyPublished: false });
    const bad = await app.request("/api/device-authorizations/start",{ method: "POST",headers: { "content-type": "application/json" },
      body: JSON.stringify({ clientName: "Bad",scopes: ["notifications:send"],expiresInSeconds: 86_400,identityKey: "AAAA" }) });
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const echoed = key(3);
    expect(JSON.stringify(await start("Echo",echoed))).not.toContain(echoed);
  });
});
