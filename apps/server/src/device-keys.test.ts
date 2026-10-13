import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { e2eeKeyId,prekeySigningInput,verifyPrekeySignature } from "./device-keys.js";
import { migrate } from "./migrate.js";

const fixture = JSON.parse(readFileSync(
  new URL("../../../packages/contracts/fixtures/e2ee-v1.json",import.meta.url),"utf8",
));

/** A P-256 key as the phone holds it: private KeyObject plus X9.63 public bytes (base64url). */
function p256() {
  const { privateKey,publicKey } = generateKeyPairSync("ec",{ namedCurve: "P-256" });
  const jwk = publicKey.export({ format: "jwk" });
  const x963 = Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,"base64url"),Buffer.from(jwk.y!,"base64url")]);
  return { privateKey,publicKey: x963.toString("base64url") };
}

function signedPrekey(identity: { privateKey: KeyObject },deviceId: string,prekeyId: string,createdAt = new Date().toISOString()) {
  const publicKey = p256().publicKey;
  const signature = sign("sha256",prekeySigningInput({ deviceId,prekeyId,publicKey,createdAt }),
    { key: identity.privateKey,dsaEncoding: "ieee-p1363" }).toString("base64url");
  return { prekeyId,publicKey,createdAt,signature };
}

describe("device key directory primitives",() => {
  test("key ids and prekey signatures match the CLI and CryptoKit vectors",() => {
    for (const key of Object.values<any>(fixture.keys)) {
      expect(e2eeKeyId(Buffer.from(key.publicKey,"base64url"))).toBe(key.keyId);
    }
    const prekey = fixture.node.prekey;
    expect(verifyPrekeySignature(fixture.keys.deviceIdentity.publicKey,prekey.deviceId,prekey)).toBe(true);
    expect(verifyPrekeySignature(fixture.keys.cliIdentity.publicKey,prekey.deviceId,prekey)).toBe(false);
    expect(verifyPrekeySignature(fixture.keys.deviceIdentity.publicKey,"dev_other",prekey)).toBe(false);
    expect(verifyPrekeySignature("not-a-key",prekey.deviceId,prekey)).toBe(false);
  });
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("device key directory (E2.2)",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>;
  const owner = "device_keys_owner_abcdefghijklmnopqrstuvwxyz0123";
  const secret = "device-keys-secret-with-at-least-32-characters";

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
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }
  async function phone(principal = principalId) {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment) VALUES ($1,$2,$3,'Phone','com.example.relo.notifications','1','1','26','sandbox')
      RETURNING id`,[principal,randomUUID(),randomUUID()])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [id,hashToken(credential)]);
    return { id,publicId: `dev_${id}`,credential,identity: p256() };
  }
  async function cliKey(scopes = ["devices:read"]) {
    const token = generateToken();
    await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes) VALUES ($1,$2,$3,$4)",
      [principalId,`k-${randomUUID()}`,hashToken(token),scopes]);
    return token;
  }

  test("a phone publishes signed keys and the CLI reads only public halves",async () => {
    const device = await phone();
    const prekey = signedPrekey(device.identity,device.publicId,"pk_1");
    const published = await request("PUT","/api/devices/self/keys",{ identityKey: device.identity.publicKey,prekey },device.credential);
    expect(published).toEqual({ status: 200,body: { keyId: e2eeKeyId(Buffer.from(device.identity.publicKey,"base64url")),identityChanged: false } });
    expect((await request("PUT","/api/devices/self/keys",{ identityKey: device.identity.publicKey,prekey },device.credential)).status).toBe(200);

    const listed = await request("GET","/api/devices/keys",undefined,await cliKey());
    expect(listed.status).toBe(200);
    expect(listed.body.devices).toEqual([{
      deviceId: device.publicId,kind: "phone",name: "Phone",
      identityKey: { keyId: published.body.keyId,publicKey: device.identity.publicKey,changedAt: expect.any(String) },
      prekey: { ...prekey,stale: false },
      approval: null,
    }]);
    expect(JSON.stringify(listed.body)).not.toMatch(/privateKey|"d":/);
  });

  test("rejects unsigned, foreign-signed, conflicting and skewed prekeys",async () => {
    const device = await phone();
    const put = (body: unknown) => request("PUT","/api/devices/self/keys",body,device.credential);
    const other = p256();
    expect((await put({ identityKey: device.identity.publicKey,prekey: signedPrekey(other,device.publicId,"pk_1") })).body)
      .toEqual({ error: "invalid_prekey_signature" });
    expect((await put({ identityKey: device.identity.publicKey,prekey: signedPrekey(device.identity,"dev_someone_else","pk_1") })).body)
      .toEqual({ error: "invalid_prekey_signature" });
    expect((await put({ identityKey: device.identity.publicKey,
      prekey: signedPrekey(device.identity,device.publicId,"pk_1",new Date(Date.now()+3_600_000).toISOString()) })).body)
      .toEqual({ error: "prekey_clock_skew" });
    expect((await put({ identityKey: "AAAA",prekey: signedPrekey(device.identity,device.publicId,"pk_1") })).status).toBe(400);
    expect((await put({ identityKey: device.identity.publicKey,prekey: signedPrekey(device.identity,device.publicId,"pk_1"),extra: 1 })).status).toBe(400);
    expect((await put({ identityKey: device.identity.publicKey,prekey: signedPrekey(device.identity,device.publicId,"pk_1") })).status).toBe(200);
    expect((await put({ identityKey: device.identity.publicKey,prekey: signedPrekey(device.identity,device.publicId,"pk_1") })))
      .toEqual({ status: 409,body: { error: "prekey_conflict" } });
    expect((await request("PUT","/api/devices/self/keys",{},await cliKey(["devices:read"]))).status).toBe(403);
  });

  test("rotation keeps the newest four prekeys and a new identity drops the old ones",async () => {
    const device = await phone();
    for (let index = 1; index <= 6; index += 1) {
      const prekey = signedPrekey(device.identity,device.publicId,`pk_${index}`);
      expect((await request("PUT","/api/devices/self/keys",{ identityKey: device.identity.publicKey,prekey },device.credential)).status).toBe(200);
    }
    const kept = (await db.query("SELECT prekey_id FROM device_prekeys WHERE device_id=$1 ORDER BY prekey_id",[device.id])).rows.map(r => r.prekey_id);
    expect(kept).toEqual(["pk_3","pk_4","pk_5","pk_6"]);
    expect((await request("GET","/api/devices/keys",undefined,await cliKey())).body.devices[0].prekey.prekeyId).toBe("pk_6");

    const reinstalled = p256();
    const changed = await request("PUT","/api/devices/self/keys",
      { identityKey: reinstalled.publicKey,prekey: signedPrekey(reinstalled,device.publicId,"pk_new") },device.credential);
    expect(changed.body.identityChanged).toBe(true);
    expect((await db.query("SELECT prekey_id FROM device_prekeys WHERE device_id=$1",[device.id])).rows).toEqual([{ prekey_id: "pk_new" }]);
  });

  test("revoked phones and other accounts never appear; stale prekeys are flagged",async () => {
    const device = await phone();
    const revoked = await phone();
    for (const target of [device,revoked]) {
      await request("PUT","/api/devices/self/keys",{ identityKey: target.identity.publicKey,
        prekey: signedPrekey(target.identity,target.publicId,"pk_1") },target.credential);
    }
    await db.query("UPDATE devices SET revoked_at=now() WHERE id=$1",[revoked.id]);
    await db.query("UPDATE device_prekeys SET received_at=now()-interval '8 days' WHERE device_id=$1",[device.id]);
    const otherOwner = (await db.query<{ id: string }>("INSERT INTO owner_principals(handle) VALUES ('device-keys-other') RETURNING id")).rows[0]!.id;
    const foreign = await phone(otherOwner);
    await request("PUT","/api/devices/self/keys",{ identityKey: foreign.identity.publicKey,
      prekey: signedPrekey(foreign.identity,foreign.publicId,"pk_1") },foreign.credential);

    const devices = (await request("GET","/api/devices/keys",undefined,await cliKey())).body.devices;
    expect(devices.map((entry: any) => entry.deviceId)).toEqual([device.publicId]);
    expect(devices[0].prekey.stale).toBe(true);
    expect((await request("GET","/api/devices/keys",undefined,await cliKey(["notifications:write"]))).status).toBe(403);
  });

  test("each CLI publishes its identity key; phones of the same account read them",async () => {
    const cli = await cliKey(["notifications:send"]);
    const identity = p256();
    const first = await request("PUT","/api/clients/self/keys",{ identityKey: identity.publicKey },cli);
    expect(first).toEqual({ status: 200,body: { keyId: e2eeKeyId(Buffer.from(identity.publicKey,"base64url")),changed: false } });
    expect((await request("PUT","/api/clients/self/keys",{ identityKey: identity.publicKey },cli)).body.changed).toBe(false);
    const rotated = p256();
    expect((await request("PUT","/api/clients/self/keys",{ identityKey: rotated.publicKey },cli)).body.changed).toBe(true);
    expect((await request("PUT","/api/clients/self/keys",{ identityKey: "AAAA" },cli)).status).toBe(400);

    const device = await phone();
    expect((await request("PUT","/api/clients/self/keys",{ identityKey: identity.publicKey },device.credential)))
      .toEqual({ status: 403,body: { error: "cli_credential_required" } });
    const listed = await request("GET","/api/clients/keys",undefined,device.credential);
    expect(listed.status).toBe(200);
    expect(listed.body.clients).toEqual([expect.objectContaining({
      keyId: e2eeKeyId(Buffer.from(rotated.publicKey,"base64url")),publicKey: rotated.publicKey,clientId: expect.stringMatching(/^key_/),
    })]);

    await db.query("UPDATE principal_api_keys SET revoked_at=now() WHERE token_hash=$1",[hashToken(cli)]);
    expect((await request("GET","/api/clients/keys",undefined,device.credential)).body.clients).toEqual([]);
    const otherOwner = (await db.query<{ id: string }>("INSERT INTO owner_principals(handle) VALUES ('client-keys-other') RETURNING id")).rows[0]!.id;
    const foreignPhone = await phone(otherOwner);
    const second = await cliKey(["notifications:send"]);
    await request("PUT","/api/clients/self/keys",{ identityKey: identity.publicKey },second);
    expect((await request("GET","/api/clients/keys",undefined,foreignPhone.credential)).body.clients).toEqual([]);
  });
});
