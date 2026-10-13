import { randomBytes,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { generateToken,hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { answerSignatureSchema } from "./sealed-content.js";

/** E4.2: a phone's answer signature is stored with the answer and returned to the CLI unchanged. */
const signature = () => ({
  e2eeKeyId: `k_${randomBytes(16).toString("base64url")}`,
  e2eeSignedAt: "2026-10-13T17:00:00.000Z",
  e2eeSignature: randomBytes(64).toString("base64url"),
});

describe("answer signature shape",() => {
  test("accepts exactly the three signed fields",() => {
    expect(answerSignatureSchema.safeParse(signature()).success).toBe(true);
    expect(answerSignatureSchema.safeParse({ ...signature(),extra: "x" }).success).toBe(false);
    expect(answerSignatureSchema.safeParse({ ...signature(),e2eeSignature: "short" }).success).toBe(false);
  });
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("signed answers through the API (E4.2)",() => {
  let db: Database,principalId: string,app: ReturnType<typeof createApp>;
  const owner = "answer_signature_owner_abcdefghijklmnopqrstuvw";
  const secret = "answer-signatures-secret-with-at-least-32-chars";

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

  test("an approval's signature reaches the CLI exactly as the phone sent it",async () => {
    const id = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token) VALUES ($1,$2,$3,'Phone',
      'com.example.relo.notifications','1','1','26','sandbox','authorized','fixture-alert') RETURNING id`,
    [principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    const credential = generateToken();
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['device:self','inbox:read','interactions:respond'])",
      [id,hashToken(credential)]);

    const asked = await request("POST","/api/interactions",{ title: "Deploy",prompt: "Deploy to production?",type: "approval",
      deviceIds: [`dev_${id}`] },owner);
    expect(asked.status).toBe(201);
    const signed = signature();
    const answered = await request("POST",`/api/notifications/${asked.body.eventId}/interactions`,{
      kind: "approve",value: signed,idempotencyKey: "ios:answer-signature-1",expectedInteractionId: asked.body.interaction.id,
    },credential);
    expect(answered.status).toBe(201);
    const read = await request("GET",`/api/interactions/${asked.body.interaction.id}`,undefined,owner);
    const interaction = read.body.interaction ?? read.body;
    expect(interaction.state).toBe("approved");
    expect(interaction.response).toMatchObject(signed);
    expect(interaction.respondingDevice.id).toBe(`dev_${id}`);
    expect(interaction.eventId).toBe(asked.body.eventId);
  });
});
