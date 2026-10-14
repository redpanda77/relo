import { createHmac,randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
// @ts-expect-error The CLI's crypto module is plain JavaScript; the test uses it as the reference signer.
import { approveDeviceSigningInput,b64u,generateKeyPair,prekeySigningInput,signBytes } from "../../../../packages/cli/src/e2ee.mjs";
import { createAccountAuth } from "../account-auth.js";
import { createApp } from "../app.js";
import { resetAuthAttempts } from "../auth-throttle.js";
import { generateToken,hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createAuthDatabase,createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { resetApprovalAttempts } from "./admin-routes.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const appUrl = "http://127.0.0.1:8180";
const secret = "test-only-dashboard-devices-secret-0123456789abcdef";
const b64 = (length: number) => randomBytes(length).toString("base64url");

/** RFC 6238 with the authenticator defaults (SHA-1, 6 digits, 30 seconds). */
function totp(base32: string,at = Date.now()): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  let bits = "";
  for (const char of base32.replace(/=+$/,"").toUpperCase()) bits += alphabet.indexOf(char).toString(2).padStart(5,"0");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((byte) => parseInt(byte,2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 30_000)));
  const digest = createHmac("sha1",key).update(counter).digest();
  const offset = digest[digest.length - 1]! & 0xf;
  return ((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).toString().padStart(6,"0");
}

type Keys = { privateKey: Buffer; publicKey: Buffer };

// Account → Security → Devices, and approving a new phone from a linked browser.
suite("Dashboard devices (docs/END-TO-END-ENCRYPTION.md, Approving from a linked browser)",() => {
  let db: Database,authDb: Database,app: ReturnType<typeof createApp>;
  let session: string,principalId: string;
  const apiKey = "dashboard_devices_owner_abcdefghijklmnopqrstuvwxyz_0123";
  const password = "devices-owner-password-123";

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    authDb = createAuthDatabase(databaseUrl!);
    await migrate(db);
    app = createApp(db,{ accountAuth: createAccountAuth(authDb,appUrl,secret),bootstrapOwnerHandle: "owner",
      credentialDerivationSecret: secret,appUrl,apnsMode: "sandbox" });
  });
  afterAll(async () => { await Promise.all([db.end(),authDb.end()]); });
  beforeEach(async () => {
    resetAuthAttempts();
    resetApprovalAttempts();
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await db.query("TRUNCATE auth.sessions, auth.accounts, auth.verifications, auth.two_factors, auth.users CASCADE");
    await db.query("UPDATE server_settings SET registration_mode='closed'");
    await bootstrapOwner(db,"owner",apiKey);
    const email = "owner@devices.example";
    const signup = await app.request("/api/auth/sign-up/email",{ method: "POST",headers: { "content-type": "application/json",origin: appUrl },
      body: JSON.stringify({ name: "Owner",email,password }) });
    expect(signup.status,await signup.clone().text()).toBe(200);
    const signin = await app.request("/api/auth/sign-in/email",{ method: "POST",headers: { "content-type": "application/json",origin: appUrl },
      body: JSON.stringify({ email,password,rememberMe: true }) });
    session = signin.headers.get("set-auth-token")!;
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function call(token: string,method: string,path: string,body?: unknown) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json",
      origin: appUrl,"idempotency-key": randomUUID() },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any,headers: response.headers };
  }

  /** A phone with an identity key and prekey pk_1, registered `minutesAgo` minutes ago. */
  async function phone(name: string,minutesAgo: number,model: string | null,owner = principalId) {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token,registered_at,model) VALUES ($1,$2,$3,$4,
      'com.example.relo.notifications','1','1','26','sandbox','authorized','fixture-alert',now()-make_interval(mins => $5),$6) RETURNING id`,
    [owner,randomUUID(),randomUUID(),name,minutesAgo,model])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [id,hashToken(credential)]);
    const identityKey = b64u(generateKeyPair().publicKey) as string;
    await db.query("INSERT INTO device_identity_keys(device_id,principal_id,key_id,public_key) VALUES ($1,$2,$3,$4)",
      [id,owner,`k_${b64(16)}`,identityKey]);
    await db.query(`INSERT INTO device_prekeys(device_id,principal_id,prekey_id,public_key,signature,signed_created_at)
      VALUES ($1,$2,'pk_1',$3,$4,$5)`,[id,owner,b64(65),b64(64),new Date().toISOString()]);
    return { id,publicId: `dev_${id}`,credential,identityKey,name };
  }

  /** A browser registered by the Dashboard and, unless `linked` is false, linked from `linker`. */
  async function browser(linker?: { credential: string }) {
    const identity: Keys = generateKeyPair();
    const prekey: Keys = generateKeyPair();
    const browserId = `brw_${randomUUID()}`;
    const createdAt = new Date().toISOString();
    const registered = await call(session,"POST","/api/dashboard/browser",{ browserId,name: "Chrome on macOS",
      identityKey: b64u(identity.publicKey),prekey: { prekeyId: "pk_1",publicKey: b64u(prekey.publicKey),createdAt,
        signature: b64u(signBytes(identity.privateKey,prekeySigningInput({ deviceId: browserId,prekeyId: "pk_1",publicKey: prekey.publicKey,createdAt }))) } });
    expect(registered.status).toBe(200);
    if (linker) {
      expect((await call(linker.credential,"POST","/api/devices/self/links",{ browserId,identityKey: b64u(identity.publicKey),
        signedAt: new Date().toISOString(),signature: b64(64) })).status).toBe(200);
    }
    return { browserId,identity };
  }

  /** The browser's signature over exactly what a phone signs, with the browser as the approver. */
  function approval(approver: { browserId: string; identity: Keys },target: { publicId: string; identityKey: string },signedAt = new Date().toISOString()) {
    const signature = b64u(signBytes(approver.identity.privateKey,approveDeviceSigningInput({
      deviceId: target.publicId,identityKey: target.identityKey,approverDeviceId: approver.browserId,signedAt })));
    return { browserId: approver.browserId,identityKey: target.identityKey,signedAt,signature };
  }

  test("one list of phones, computers and browsers with a plain encryption status",async () => {
    const main = await phone("Owner iPhone",90,"iPhone19,7");
    await phone("iPhone Air",30,"arm64");
    const ipad = await phone("iPad",10,"iPad16,3");
    const fresh = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment) VALUES ($1,$2,$3,'New iPhone','com.example.relo.notifications','1','1','26','sandbox')
      RETURNING id`,[principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    await call(apiKey,"PUT","/api/clients/self/keys",{ identityKey: b64u(generateKeyPair().publicKey) });
    const linked = await browser(main);
    const unlinked = await browser();

    const listed = await call(session,"GET","/api/dashboard/devices");
    expect(listed.status).toBe(200);
    expect(listed.headers.get("cache-control")).toContain("no-store");
    expect(listed.body.twoFactorEnabled).toBe(false);
    const byId = Object.fromEntries(listed.body.devices.map((device: any) => [device.id,device]));
    expect(byId[main.publicId]).toMatchObject({ kind: "phone",model: "iPhone 18 Pro Max",modelId: "iPhone19,7",status: "can_read" });
    expect(listed.body.devices.find((device: any) => device.name === "iPhone Air")).toMatchObject({ model: "Simulator",status: "simulator" });
    expect(byId[ipad.publicId]).toMatchObject({ model: "iPad Pro 11-inch (M4)",status: "pending",identityKey: ipad.identityKey });
    expect(byId[main.publicId].identityKey).toBeUndefined();
    expect(byId[`dev_${fresh}`]).toMatchObject({ status: "no_keys" });
    expect(listed.body.devices.find((device: any) => device.kind === "computer")).toMatchObject({ name: "bootstrap-owner",status: "encrypts" });
    expect(byId[linked.browserId]).toMatchObject({ kind: "browser",status: "can_read",linkedBy: "Owner iPhone" });
    expect(byId[unlinked.browserId]).toMatchObject({ kind: "browser",status: "unlinked",linkedBy: null });
    expect(listed.body.devices.map((device: any) => device.kind)).toEqual(["phone","phone","phone","phone","computer","browser","browser"]);
    expect((await call(apiKey,"GET","/api/dashboard/devices")).status).toBe(401);
  });

  test("a linked browser approves a pending phone; computers see the browser as the approver",async () => {
    const main = await phone("Owner iPhone",90,"iPhone19,7");
    const ipad = await phone("iPad",10,"iPad16,3");
    const linked = await browser(main);
    const body = approval(linked,ipad);

    // Only the owner's session, from the Dashboard's origin.
    expect((await call(apiKey,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,body)).status).toBe(401);
    // A signature that is not this browser's, or over something else, is refused.
    expect((await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,{ ...body,signature: b64(64) })).body)
      .toEqual({ error: "invalid_signature" });
    const other = await browser(main);
    expect((await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,{ ...body,browserId: other.browserId })).body)
      .toEqual({ error: "invalid_signature" });
    expect((await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,
      approval(linked,ipad,new Date(Date.now() - 3_600_000).toISOString()))).body).toEqual({ error: "invalid_signature" });
    expect((await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,{ ...body,identityKey: main.identityKey })).body)
      .toEqual({ error: "identity_mismatch" });

    const approved = await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,body);
    expect(approved.status).toBe(200);
    expect(approved.body).toEqual({ deviceId: ipad.publicId,approved: true });
    const directory = (await call(apiKey,"GET","/api/devices/keys")).body.devices;
    expect(directory.find((device: any) => device.deviceId === ipad.publicId).approval)
      .toEqual({ deviceId: linked.browserId,signedAt: body.signedAt,signature: body.signature });
    expect((await call(session,"GET","/api/dashboard/devices")).body.devices.find((device: any) => device.id === ipad.publicId))
      .toMatchObject({ status: "can_read",approvedBy: "Chrome on macOS" });
    expect((await call(main.credential,"GET","/api/devices/self/pending-devices")).body.devices).toEqual([]);

    // Already approved.
    const again = await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,approval(linked,ipad));
    expect(again).toMatchObject({ status: 409,body: { error: "already_approved" } });
  });

  test("an unlinked, expired or simulator-linked browser cannot approve; another account's phone is not found",async () => {
    const main = await phone("Owner iPhone",90,"iPhone19,7");
    const ipad = await phone("iPad",10,"iPad16,3");
    const unlinked = await browser();
    expect(await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,approval(unlinked,ipad)))
      .toMatchObject({ status: 403,body: { error: "browser_not_linked" } });
    const expired = await browser(main);
    await db.query("UPDATE linked_browsers SET link_signed_at=$2 WHERE id=$1",
      [expired.browserId.slice(4),new Date(Date.now() - 15 * 86_400_000).toISOString()]);
    expect(await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,approval(expired,ipad)))
      .toMatchObject({ status: 403,body: { error: "browser_not_linked" } });
    const revoked = await browser(main);
    expect((await call(main.credential,"DELETE",`/api/devices/self/links/${revoked.browserId}`)).status).toBe(204);
    expect(await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,approval(revoked,ipad)))
      .toMatchObject({ status: 403,body: { error: "browser_not_linked" } });

    const simulator = await phone("iPhone Air",80,"arm64");
    const viaSimulator = await browser(simulator);
    expect(await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,approval(viaSimulator,ipad)))
      .toMatchObject({ status: 403,body: { error: "browser_not_linked" } });

    await bootstrapOwner(db,"someone-else","dashboard_devices_other_abcdefghijklmnopqrstuvwxyz_01");
    const otherAccount = (await db.query("SELECT id FROM owner_principals WHERE handle='someone-else'")).rows[0].id;
    await phone("Their iPhone",120,"iPhone18,1",otherAccount);
    const theirs = await phone("Their iPad",5,"iPad16,3",otherAccount);
    const linked = await browser(main);
    expect(await call(session,"POST",`/api/dashboard/devices/${theirs.publicId}/approve`,approval(linked,theirs)))
      .toMatchObject({ status: 404,body: { error: "device_not_found" } });
    expect((await db.query("SELECT count(*)::int AS n FROM device_approvals")).rows[0].n).toBe(0);
  });

  test("with two-step sign-in, approving needs a fresh code; attempts are limited",async () => {
    const main = await phone("Owner iPhone",90,"iPhone19,7");
    const ipad = await phone("iPad",10,"iPad16,3");
    const linked = await browser(main);
    const enabled = await call(session,"POST","/api/auth/two-factor/enable",{ password });
    const totpSecret = new URL(enabled.body.totpURI).searchParams.get("secret")!;
    const confirmed = await call(session,"POST","/api/auth/two-factor/verify-totp",{ code: totp(totpSecret) });
    expect(confirmed.status).toBe(200);
    session = confirmed.headers.get("set-auth-token") ?? session;
    expect((await call(session,"GET","/api/dashboard/devices")).body.twoFactorEnabled).toBe(true);

    expect(await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,approval(linked,ipad)))
      .toMatchObject({ status: 403,body: { error: "two_factor_code_required" } });
    const wrong = totp(totpSecret) === "000000" ? "111111" : "000000";
    expect(await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,{ ...approval(linked,ipad),code: wrong }))
      .toMatchObject({ status: 403,body: { error: "invalid_two_factor_code" } });
    expect((await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,{ ...approval(linked,ipad),code: totp(totpSecret) })).status)
      .toBe(200);

    for (let attempt = 3; attempt < 10; attempt += 1) {
      expect((await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,{})).status).toBe(400);
    }
    expect((await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/approve`,{})).status).toBe(429);
  });

  test("removing a phone from the Dashboard deletes what only it could open; Decline is the same removal",async () => {
    const main = await phone("Owner iPhone",90,"iPhone19,7");
    const ipad = await phone("iPad",10,"iPad16,3");
    const envelope = (devices: string[],context: string) => ({ v: "relo.e2e.v1",kind: "notice",context,sender: "k_AAAAAAAAAAAAAAAAAAAAAA",
      recipients: devices.map((device) => ({ device,prekey: "pk_1",enc: b64(65),key: b64(48) })),nonce: b64(12),ct: b64(272),sig: b64(64) });
    const notice = async (devices: string[]) => {
      const context = `ntf:${randomUUID()}`;
      const created = await call(apiKey,"POST","/api/notifications",{ sourceName: "Claude Code",
        context: { providerName: "Claude Code",project: "relo",threadName: "Release" },
        sealed: { alerts: devices.map((device) => envelope([device],context)),content: envelope(devices,context) } });
      expect(created.status).toBe(201);
      return created.body.eventId.slice(4) as string;
    };
    const exists = async (eventId: string) => Boolean((await db.query("SELECT 1 FROM notification_events WHERE id=$1",[eventId])).rowCount);
    const onlyIpad = await notice([ipad.publicId]);
    const both = await notice([main.publicId,ipad.publicId]);

    // Decline (the pending iPad) is the Dashboard's removal.
    expect((await call(session,"POST",`/api/dashboard/devices/${ipad.publicId}/revoke`)).body).toEqual({ revoked: true });
    expect(await exists(onlyIpad)).toBe(false);
    expect(await exists(both)).toBe(true);
    expect((await call(ipad.credential,"GET","/api/devices/self/pending-devices")).status).toBe(401);
    expect((await call(session,"GET","/api/dashboard/devices")).body.devices.some((device: any) => device.id === ipad.publicId)).toBe(false);
  });
});
