import { execFile } from "node:child_process";
import { createECDH,createHash,generateKeyPairSync,randomUUID,sign } from "node:crypto";
import { mkdtempSync,rmSync,writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { serve,type ServerType } from "@hono/node-server";
import { afterAll,beforeAll,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { prekeySigningInput } from "./device-keys.js";
import { migrate } from "./migrate.js";

/**
 * The end-to-end promise, end to end (docs/END-TO-END-ENCRYPTION.md, E6.4): the real `relo` CLI
 * talks to a real server for a phone this computer verified. Afterwards nothing the agent wrote —
 * notice title, summary and body, card title, status and steps, question prompt — exists anywhere
 * in the database, which is everything a compromised server, its backups or its operator hold.
 */
const run = promisify(execFile);
const cli = new URL("../../../packages/cli/bin/relo.mjs",import.meta.url).pathname;
const MARK = "ZZSECRET";
const b64u = (bytes: Buffer) => bytes.toString("base64url");

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("a compromised server holds no readable content (E6.4)",() => {
  let db: Database;
  let server: ServerType;
  let apiUrl: string;
  let folder: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    db = createDatabase(process.env.TEST_DATABASE_URL!);
    await migrate(db);
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await bootstrapOwner(db,"owner","compromised_server_owner_abcdefghijklmnopqrstu");
    const principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner'")).rows[0].id;
    const app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: "compromised-server-secret-with-32-characters" });
    server = await new Promise<ServerType>((resolve) => {
      const started = serve({ fetch: app.fetch,port: 0,hostname: "127.0.0.1" },() => resolve(started));
    });
    const address = server.address();
    apiUrl = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;

    // The phone: Live Activities on, an identity key and a signed prekey published to the directory.
    const deviceId = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,
      bundle_identifier,app_version,app_build,os_version,apns_environment,notification_authorization,live_activity_authorization,
      apns_token,live_activity_push_to_start_token) VALUES ($1,$2,$3,'Owner iPhone','com.example.relo.notifications','1','1','26',
      'sandbox','authorized','authorized','fixture-alert','fixture-start') RETURNING id`,[principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    const phoneToken = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read'])",
      [deviceId,hashToken(phoneToken)]);
    const identity = generateKeyPairSync("ec",{ namedCurve: "P-256" });
    const jwk = identity.publicKey.export({ format: "jwk" });
    const identityPublic = Buffer.concat([Buffer.from([4]),Buffer.from(jwk.x!,"base64url"),Buffer.from(jwk.y!,"base64url")]);
    const prekey = createECDH("prime256v1");
    prekey.generateKeys();
    const createdAt = new Date().toISOString();
    const prekeyPublic = b64u(prekey.getPublicKey(null,"uncompressed"));
    const signature = sign("sha256",prekeySigningInput({ deviceId: `dev_${deviceId}`,prekeyId: "pk_1",publicKey: prekeyPublic,createdAt }),
      { key: identity.privateKey,dsaEncoding: "ieee-p1363" });
    const published = await fetch(`${apiUrl}/api/devices/self/keys`,{ method: "PUT",
      headers: { authorization: `Bearer ${phoneToken}`,"content-type": "application/json" },
      body: JSON.stringify({ identityKey: b64u(identityPublic),prekey: { prekeyId: "pk_1",publicKey: prekeyPublic,createdAt,
        signature: b64u(signature) } }) });
    expect(published.status).toBe(200);

    // This computer: a CLI key and a key store that trusts exactly that phone identity.
    const cliToken = generateToken();
    await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash,scopes) VALUES ($1,'Proof Mac',$2,$3)",
      [principalId,hashToken(cliToken),["notifications:send","interactions:create","interactions:read","activities:write",
        "activities:read","devices:read"]]);
    const cliKey = createECDH("prime256v1");
    cliKey.generateKeys();
    const cliPublic = cliKey.getPublicKey(null,"uncompressed");
    const cliPrivate = cliKey.getPrivateKey();
    folder = mkdtempSync(join(tmpdir(),"relo-proof-"));
    writeFileSync(join(folder,"e2ee.json"),JSON.stringify({ version: 1,
      identity: { privateKey: b64u(Buffer.concat([Buffer.alloc(32 - cliPrivate.length),cliPrivate])),publicKey: b64u(cliPublic),
        keyId: `k_${b64u(createHash("sha256").update(cliPublic).digest().subarray(0,16))}`,createdAt },
      trusted: { [`${apiUrl}|dev_${deviceId}`]: { deviceId: `dev_${deviceId}`,publicKey: b64u(identityPublic) } } }),{ mode: 0o600 });
    env = { PATH: process.env.PATH,HOME: folder,RELO_API_URL: apiUrl,RELO_TOKEN: cliToken,RELO_NO_UPDATE_CHECK: "1",
      RELO_CONFIG_PATH: join(folder,"config.json"),RELO_KEY_STORE_PATH: join(folder,"e2ee.json"),
      RELO_SEALED_CARD_DIR: join(folder,"cards"),XDG_STATE_HOME: join(folder,"state"),
      RELO_SOURCE: "Proof",RELO_PROJECT: "compromised-relo-project",RELO_COMPUTER: "proof-mac",RELO_ACCOUNT: "proof" };
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
    rmSync(folder,{ recursive: true,force: true });
    await db.end();
  });

  const relo = async (...args: string[]) => JSON.parse((await run(process.execPath,[cli,...args,"--json"],{ env })).stdout.trim());

  test("notices, cards and questions reach the server sealed, and no table holds the agent's words",async () => {
    const notice = await relo("notify",`${MARK} body: the database password rotated`,"--title",`${MARK} title`,
      "--summary",`${MARK} summary`,"--topic","Release notes");
    expect(notice.ok).toBe(true);
    const card = await relo("activity","start","--title",`${MARK} card`,"--status",`${MARK} status`,
      "--steps",`${MARK} build,${MARK} ship`,"--topic","Release card");
    expect(card.ok).toBe(true);
    expect((await relo("activity","update","--status",`${MARK} shipping`,"--next-step","--topic","Release card")).ok).toBe(true);
    const asked = await relo("ask",`${MARK} deploy to production?`,"--approval","--no-wait","--topic","Release card");
    expect(asked.ok).toBe(true);

    expect(await tableLeaks(MARK)).toEqual([]);
    // Project, computer and account names travel as handles too (E2.5).
    expect(await tableLeaks("proof-mac")).toEqual([]);
    expect(await tableLeaks("compromised-relo-project")).toEqual([]);
    const sealedEvents = await db.query("SELECT count(*)::int AS count FROM notification_events WHERE payload ? 'sealed'");
    expect(sealedEvents.rows[0].count).toBeGreaterThan(0);
  },60_000);

  test("control: readable text that does reach the server is found by the scan",async () => {
    const plain = "ZZPLAINCONTROL";
    const call = (method: string,path: string,body: unknown) => fetch(`${apiUrl}${path}`,{ method,
      headers: { authorization: `Bearer ${env.RELO_TOKEN}`,"content-type": "application/json" },body: JSON.stringify(body) });
    // With a phone that has keys, readable content is refused by default; the owner can turn that off.
    expect((await call("POST","/api/notifications",{ sourceName: "Control",title: `${plain} title`,body: `${plain} body`,
      context: { project: "relo",threadName: "Control" } })).status).toBe(409);
    expect((await call("PUT","/api/end-to-end/policy",{ required: false })).status).toBe(200);
    expect((await call("POST","/api/notifications",{ sourceName: "Control",title: `${plain} title`,body: `${plain} body`,
      context: { project: "relo",threadName: "Control" } })).status).toBe(201);
    expect((await tableLeaks(plain)).length).toBeGreaterThan(0);
    await call("PUT","/api/end-to-end/policy",{ required: null });
  },60_000);

  /** Every row of every table, as text, that contains `marker`. */
  async function tableLeaks(marker: string): Promise<string[]> {
    const tables = (await db.query<{ schemaname: string; tablename: string }>(
      "SELECT schemaname,tablename FROM pg_tables WHERE schemaname IN ('public','auth')",
    )).rows;
    const leaks: string[] = [];
    for (const { schemaname,tablename } of tables) {
      const rows = await db.query<{ row: string }>(`SELECT t::text AS row FROM "${schemaname}"."${tablename}" t`);
      for (const { row } of rows.rows) if (row.includes(marker)) leaks.push(`${schemaname}.${tablename}: ${row.slice(0,160)}`);
    }
    return leaks;
  }
});
