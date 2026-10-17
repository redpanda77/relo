import { generateKeyPairSync,randomBytes,randomUUID,sign,type KeyObject } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { approveComputerSigningInput } from "./computer-approvals.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";

const b64 = (length: number) => randomBytes(length).toString("base64url");
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/** A P-256 identity: its b64u X9.63 public key and a raw r||s signer, like a phone's or a browser's. */
function identity() {
  const { publicKey,privateKey } = generateKeyPairSync("ec",{ namedCurve: "prime256v1" });
  const jwk = publicKey.export({ format: "jwk" });
  const x963 = Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,"base64url"),Buffer.from(jwk.y!,"base64url")]).toString("base64url");
  return { publicKey: x963,sign: (message: Buffer) => sign("sha256",message,{ key: privateKey as KeyObject,dsaEncoding: "ieee-p1363" }).toString("base64url") };
}

// Computers are approved once, on any trusted device (docs/ENCRYPTION-PROTOCOL.md): a phone or the Mac app signs a
// computer's current key, the server checks and lists the signature, and every device decides from it.
suite("computer approvals",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>;

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: "computer-approvals-secret-with-32-characters" });
  });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await bootstrapOwner(db,"owner","computer_approvals_owner_abcdefghijklmnopqrst");
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
  });

  async function call(token: string,method: string,path: string,body?: unknown) {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json",
      "idempotency-key": randomUUID() },body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  }

  async function device(name: string,{ simulator = false,mac = false } = {}) {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,is_simulator,capabilities) VALUES ($1,$2,$3,$4,'com.example.relo.notifications','1','1','26',
      'sandbox',$5,$6) RETURNING id`,[principalId,randomUUID(),randomUUID(),name,simulator,mac ? ["owner_overview"] : []])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [id,hashToken(credential)]);
    const keys = identity();
    await db.query("INSERT INTO device_identity_keys(device_id,principal_id,key_id,public_key) VALUES ($1,$2,$3,$4)",
      [id,principalId,`k_${b64(16)}`,keys.publicKey]);
    return { id,publicId: `dev_${id}`,credential,...keys };
  }

  async function computer(label: string) {
    const token = generateToken();
    const id = (await db.query<{ id: string }>(`INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes)
      VALUES ($1,$2,$3,ARRAY['devices:read']) RETURNING id`,[principalId,label,hashToken(token)])).rows[0]!.id;
    const publicKey = identity().publicKey;
    await db.query("INSERT INTO client_identity_keys(api_key_id,principal_id,key_id,public_key) VALUES ($1,$2,$3,$4)",
      [id,principalId,`k_${b64(16)}`,publicKey]);
    return { id,clientId: `key_${id}`,publicKey };
  }

  const approval = (approver: { publicId: string; sign: (message: Buffer) => string },target: { clientId: string; publicKey: string },signedAt = new Date().toISOString()) => ({
    clientId: target.clientId,identityKey: target.publicKey,signedAt,
    signature: approver.sign(approveComputerSigningInput({ clientId: target.clientId,identityKey: target.publicKey,approverId: approver.publicId,signedAt })),
  });

  test("a phone and the Mac app approve a computer; every device reads the approvals with its key and who can approve",async () => {
    const phone = await device("iPhone");
    const mac = await device("MacBook Pro",{ mac: true });
    const buildBox = await computer("Build box");
    expect((await call(phone.credential,"POST","/api/devices/self/computer-approvals",approval(phone,buildBox))).status).toBe(200);
    // Approving again replaces this approver's earlier signature; the Mac app's is kept beside it.
    const again = approval(phone,buildBox);
    expect((await call(phone.credential,"POST","/api/devices/self/computer-approvals",again)).status).toBe(200);
    expect((await call(mac.credential,"POST","/api/devices/self/computer-approvals",approval(mac,buildBox))).status).toBe(200);
    const keys = (await call(mac.credential,"GET","/api/clients/keys")).body.clients;
    const listed = keys.find((client: any) => client.clientId === buildBox.clientId);
    expect(listed.approvals.map((entry: any) => entry.approverId).sort()).toEqual([mac.publicId,phone.publicId].sort());
    expect(listed.approvals.find((entry: any) => entry.approverId === phone.publicId).signature).toBe(again.signature);
    const approvers = (await call(phone.credential,"GET","/api/devices/self/approvers")).body.approvers;
    expect(approvers.map((entry: any) => [entry.id,entry.kind,entry.identityKey])).toEqual([
      [phone.publicId,"phone",phone.publicKey],[mac.publicId,"mac",mac.publicKey],
    ]);
  });

  test("refusals: another key, an unknown computer, a forged or stale signature, a simulator; a new key drops old approvals",async () => {
    const phone = await device("iPhone");
    const simulator = await device("Simulator",{ simulator: true });
    const buildBox = await computer("Build box");
    const post = (token: string,body: unknown) => call(token,"POST","/api/devices/self/computer-approvals",body);
    expect((await post(phone.credential,{ ...approval(phone,buildBox),identityKey: identity().publicKey })).status).toBe(409);
    expect((await post(phone.credential,approval(phone,{ ...buildBox,clientId: `key_${randomUUID()}` }))).status).toBe(404);
    expect((await post(phone.credential,{ ...approval(phone,buildBox),signature: b64(64) })).body.error).toBe("invalid_signature");
    expect((await post(phone.credential,approval(phone,buildBox,new Date(Date.now() - 3_600_000).toISOString()))).body.error).toBe("invalid_signature");
    expect((await post(simulator.credential,approval(simulator,buildBox))).status).toBe(403);
    expect((await call(phone.credential,"GET","/api/devices/self/approvers")).body.approvers.map((entry: any) => entry.id)).toEqual([phone.publicId]);
    expect((await post(phone.credential,approval(phone,buildBox))).status).toBe(200);
    await db.query("UPDATE client_identity_keys SET public_key=$2 WHERE api_key_id=$1",[buildBox.id,identity().publicKey]);
    const keys = (await call(phone.credential,"GET","/api/clients/keys")).body.clients;
    expect(keys.find((client: any) => client.clientId === buildBox.clientId).approvals).toEqual([]);
  });

  test("a phone signs a computer out; a pending phone, an unknown computer and a second try are refused",async () => {
    const phone = await device("iPhone");
    const buildBox = await computer("Build box");
    await db.query("INSERT INTO computers(principal_id,login_key_id) VALUES ($1,$2)",[principalId,buildBox.id]);
    const revoke = (token: string,clientId: string) => call(token,"POST",`/api/devices/self/computers/${clientId}/revoke`);
    expect((await revoke(phone.credential,`key_${randomUUID()}`)).status).toBe(404);
    expect((await revoke(phone.credential,buildBox.clientId)).status).toBe(204);
    expect((await db.query("SELECT revoked_at FROM principal_api_keys WHERE id=$1",[buildBox.id])).rows[0].revoked_at).not.toBeNull();
    expect((await revoke(phone.credential,buildBox.clientId)).body.error).toBe("computer_not_found");
  });
});
