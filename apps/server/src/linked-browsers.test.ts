import { randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,describe,expect,test } from "vitest";
// @ts-expect-error The CLI's crypto module is plain JavaScript; the test uses it as the reference.
import { b64u,generateKeyPair,prekeySigningInput,signBytes } from "../../../packages/cli/src/crypto/e2ee.mjs";
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
const secret = "test-only-linked-browsers-secret-0123456789abcdef";

type Keys = { privateKey: Buffer; publicKey: Buffer };

/** A browser as the Dashboard makes it: its own id, identity and a prekey signed for that id. */
function browser(identity: Keys = generateKeyPair(),browserId = `brw_${randomUUID()}`) {
  const prekey: Keys = generateKeyPair();
  const createdAt = new Date().toISOString();
  return { browserId,identity,body: { browserId,name: "Chrome on macOS",identityKey: b64u(identity.publicKey),
    prekey: { prekeyId: "pk_1",publicKey: b64u(prekey.publicKey),createdAt,
      signature: b64u(signBytes(identity.privateKey,prekeySigningInput({ deviceId: browserId,prekeyId: "pk_1",publicKey: prekey.publicKey,createdAt }))) } } };
}

suite("linked browsers (docs/ENCRYPTION-PROTOCOL.md, Linked browsers)",() => {
  let db: Database,authDb: Database,app: ReturnType<typeof createApp>;
  let session: string,apiKey: string,phoneCredential: string,phoneId: string,principalId: string;

  beforeAll(async () => {
    resetAuthAttempts();
    db = createDatabase(databaseUrl!);
    authDb = createAuthDatabase(databaseUrl!);
    await migrate(db);
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await db.query("TRUNCATE auth.sessions, auth.accounts, auth.verifications, auth.users CASCADE");
    await db.query("UPDATE server_settings SET registration_mode='closed'");
    app = createApp(db,{ accountAuth: createAccountAuth(authDb,appUrl,secret),bootstrapOwnerHandle: "owner",
      credentialDerivationSecret: secret,appUrl,apnsMode: "sandbox" });
    apiKey = "linked_browser_owner_abcdefghijklmnopqrstuvwxyz_0123456789";
    await bootstrapOwner(db,"owner",apiKey);
    const email = "owner@browsers.example",password = "browsers-owner-password-123";
    const signup = await app.request("/api/auth/sign-up/email",{ method: "POST",headers: { "content-type": "application/json",origin: appUrl },
      body: JSON.stringify({ name: "Owner",email,password }) });
    expect(signup.status,await signup.clone().text()).toBe(200);
    const signin = await app.request("/api/auth/sign-in/email",{ method: "POST",headers: { "content-type": "application/json",origin: appUrl },
      body: JSON.stringify({ email,password,rememberMe: true }) });
    session = signin.headers.get("set-auth-token")!;
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    phoneId = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment) VALUES ($1,$2,$3,'Owner iPhone','com.example.relo.notifications','1','1','26','sandbox')
      RETURNING id`,[principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    phoneCredential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [phoneId,hashToken(phoneCredential)]);
  });
  afterAll(async () => { await Promise.all([db.end(),authDb.end()]); });

  async function call(token: string,method: string,path: string,body?: unknown,headers: Record<string,string> = {}) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json",
      origin: appUrl,"idempotency-key": randomUUID(),...headers },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }

  test("register, link from the phone, read envelopes, unlink",async () => {
    const mine = browser();
    expect((await call(session,"POST","/api/dashboard/browser",mine.body)).body).toEqual({ browserId: mine.browserId,linked: false });
    expect((await call(session,"POST","/api/dashboard/browser",mine.body)).status).toBe(200);
    expect((await call(session,"POST","/api/dashboard/browser",browser(undefined,mine.browserId).body)).status).toBe(409);
    const unsigned = browser();
    expect((await call(session,"POST","/api/dashboard/browser",{ ...unsigned.body,browserId: `brw_${randomUUID()}` })).status).toBe(400);
    expect((await call(apiKey,"POST","/api/dashboard/browser",browser().body)).status).not.toBe(200);

    // An agent session with a sealed names envelope to read back.
    const bytes = (n: number) => randomBytes(n).toString("base64url");
    const names = { v: "relo.e2e.v1",kind: "names",context: "ses:abc",sender: `k_${bytes(16)}`,
      recipients: [{ device: mine.browserId,prekey: "pk_1",enc: bytes(65),key: bytes(48) }],nonce: bytes(12),ct: bytes(272),sig: bytes(64) };
    const hooks = (await call(apiKey,"POST","/api/harness-credentials",{ name: "Test computer hooks" })).body.token as string;
    const observedAt = new Date().toISOString();
    expect((await call(hooks,"POST","/api/agent-sessions/observed",{ session: "b".repeat(64),harness: "claude-code",phase: "open",
      phaseSince: observedAt,lastSeenAt: observedAt,openToolSince: null,seq: 1,sealedNames: names })).status).toBe(200);
    const sessionId = (await call(apiKey,"GET","/api/agent-sessions")).body.sessions[0].id;

    const sealedPath = `/api/dashboard/sealed?id=${sessionId}&id=ntf_${randomUUID()}`;
    expect((await call(session,"GET",sealedPath,undefined,{ "x-relo-browser": mine.browserId })).status).toBe(403);

    const signedAt = new Date().toISOString();
    const link = { browserId: mine.browserId,identityKey: mine.body.identityKey,signedAt,signature: bytes(64) };
    expect((await call(phoneCredential,"POST","/api/devices/self/links",{ ...link,identityKey: b64u(generateKeyPair().publicKey) })).status).toBe(409);
    expect((await call(phoneCredential,"POST","/api/devices/self/links",{ ...link,browserId: `brw_${randomUUID()}` })).status).toBe(404);
    const linked = await call(phoneCredential,"POST","/api/devices/self/links",link);
    expect(linked.status).toBe(200);
    expect(linked.body).toMatchObject({ browserId: mine.browserId,name: "Chrome on macOS" });
    expect((await call(session,"GET",`/api/dashboard/browser/${mine.browserId}`)).body).toEqual({ linked: true,linkedBy: "Owner iPhone" });

    // The CLI sees the browser with the phone's signature, and decides trust itself.
    const directory = (await call(apiKey,"GET","/api/devices/keys")).body.devices;
    expect(directory.find((device: any) => device.deviceId === mine.browserId)).toMatchObject({
      kind: "browser",identityKey: { publicKey: mine.body.identityKey },prekey: { prekeyId: "pk_1" },
      link: { deviceId: `dev_${phoneId}`,signedAt,signature: link.signature },
    });

    const read = await call(session,"GET",sealedPath,undefined,{ "x-relo-browser": mine.browserId });
    expect(read.status).toBe(200);
    expect(read.body).toEqual({ envelopes: { [sessionId]: names } });
    expect((await call(session,"GET",sealedPath,undefined,{ "x-relo-browser": browser().browserId })).status).toBe(403);
    expect((await call(phoneCredential,"GET","/api/devices/self/links")).body.browsers).toHaveLength(1);

    expect((await call(phoneCredential,"DELETE",`/api/devices/self/links/${mine.browserId}`)).status).toBe(204);
    expect((await call(session,"GET",sealedPath,undefined,{ "x-relo-browser": mine.browserId })).status).toBe(403);
    expect((await call(apiKey,"GET","/api/devices/keys")).body.devices.some((device: any) => device.deviceId === mine.browserId)).toBe(false);

    // Signing out: a browser revokes its own record; another browser of the account is untouched.
    const second = browser();
    expect((await call(session,"POST","/api/dashboard/browser",second.body)).status).toBe(200);
    expect((await call(session,"DELETE",`/api/dashboard/browser/${second.browserId}`)).status).toBe(204);
    expect((await call(session,"GET",`/api/dashboard/browser/${second.browserId}`)).status).toBe(404);
    expect((await call(session,"DELETE",`/api/dashboard/browser/brw_${randomUUID()}`)).status).toBe(404);
  });
  test("approval on the iPhone: request, list, decline, link; too soon, already linked, no phone, trusted phones only",async () => {
    const request = (id: string) => call(session,"POST",`/api/dashboard/browser/${id}/link-request`);
    const mine = browser();
    expect((await call(session,"POST","/api/dashboard/browser",mine.body)).status).toBe(200);
    expect((await request(`brw_${randomUUID()}`)).status).toBe(404);

    // No phone can show it yet (notifications not allowed, no keys): 409, and a retry is not held back.
    expect((await request(mine.browserId))).toMatchObject({ status: 409,body: { error: "no_phone" } });
    expect((await call(phoneCredential,"GET","/api/devices/self/link-requests")).body).toEqual({ browsers: [] });

    await db.query("UPDATE devices SET notification_authorization='authorized' WHERE id=$1",[phoneId]);
    await db.query("INSERT INTO device_identity_keys(device_id,principal_id,key_id,public_key) VALUES ($1,$2,$3,$4)",
      [phoneId,principalId,`k_${randomBytes(16).toString("base64url")}`,randomBytes(65).toString("base64url")]);
    // A newer phone nobody approved yet is not trusted: it gets no notice.
    const newer = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token,registered_at) VALUES ($1,$2,$3,'Unapproved iPhone',
      'com.example.relo.notifications','1','1','26','sandbox','authorized','fixture-alert',now()+interval '1 minute') RETURNING id`,
    [principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    await db.query("INSERT INTO device_identity_keys(device_id,principal_id,key_id,public_key) VALUES ($1,$2,$3,$4)",
      [newer,principalId,`k_${randomBytes(16).toString("base64url")}`,randomBytes(65).toString("base64url")]);

    const first = await request(mine.browserId);
    expect(first).toMatchObject({ status: 200,body: { requested: true,phones: 1 } });
    expect((await request(mine.browserId)).status).toBe(429);

    const notice = (await db.query<any>(
      `SELECT e.title,e.deep_link,e.payload,array_agg(t.device_id) AS devices FROM notification_events e
       JOIN notification_event_targets t ON t.notification_event_id=e.id WHERE e.principal_id=$1 AND e.idempotency_key LIKE 'browser-link:%'
       GROUP BY e.id`,[principalId])).rows;
    expect(notice).toHaveLength(1);
    expect(notice[0]).toMatchObject({ title: "Chrome on macOS wants to read your Relo cards",
      deep_link: `relo://security/request/${mine.browserId}`,devices: [phoneId] });
    expect(notice[0].payload.browserLink).toEqual({ browserId: mine.browserId });

    const listed = (await call(phoneCredential,"GET","/api/devices/self/link-requests")).body.browsers;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ browserId: mine.browserId,name: "Chrome on macOS",identityKey: mine.body.identityKey });
    expect(typeof listed[0].keyId).toBe("string");
    expect(Number.isNaN(Date.parse(listed[0].requestedAt))).toBe(false);

    // Declining clears it; asking again waits out the 30 seconds unless the clock is moved.
    expect((await call(phoneCredential,"POST",`/api/devices/self/link-requests/${mine.browserId}/decline`)).status).toBe(204);
    expect((await call(phoneCredential,"POST",`/api/devices/self/link-requests/${mine.browserId}/decline`)).status).toBe(404);
    expect((await call(phoneCredential,"GET","/api/devices/self/link-requests")).body.browsers).toEqual([]);

    await db.query("UPDATE linked_browsers SET link_requested_at=now()-interval '1 minute' WHERE id=$1",[mine.browserId.slice(4)]);
    expect((await request(mine.browserId)).body).toMatchObject({ requested: true });
    // An old request is no longer listed.
    await db.query("UPDATE linked_browsers SET link_requested_at=now()-interval '16 minutes' WHERE id=$1",[mine.browserId.slice(4)]);
    expect((await call(phoneCredential,"GET","/api/devices/self/link-requests")).body.browsers).toEqual([]);
    await db.query("UPDATE linked_browsers SET link_requested_at=now()-interval '1 minute' WHERE id=$1",[mine.browserId.slice(4)]);
    expect((await call(phoneCredential,"GET","/api/devices/self/link-requests")).body.browsers).toHaveLength(1);

    // Linking clears the request, and a linked browser cannot ask again.
    const link = { browserId: mine.browserId,identityKey: mine.body.identityKey,signedAt: new Date().toISOString(),
      signature: randomBytes(64).toString("base64url") };
    expect((await call(phoneCredential,"POST","/api/devices/self/links",link)).status).toBe(200);
    expect((await call(phoneCredential,"GET","/api/devices/self/link-requests")).body.browsers).toEqual([]);
    expect((await request(mine.browserId))).toMatchObject({ status: 409,body: { error: "already_linked" } });
  });
});
