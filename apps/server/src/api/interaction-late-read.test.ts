import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { randomUUID } from "node:crypto";
import { interactionResultResponseSchema } from "@relo/notification-contracts";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase, type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { createTransportTokenEncryption } from "../token-encryption.js";

/** 1.10: GET /api/interactions/:id and /wait carry `late`; a late answer never reads as approval. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const secret = "test-only-late-read-secret-0123456789abcdef";
const token = "owner_late_read_abcdefghijklmnopqrstuvwxyz_0123456789";

suite("late answers on question reads",() => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
    app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret });
  });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await bootstrapOwner(db,"late-owner",token);
    const principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='late-owner'")).rows[0].id;
    const deviceId = randomUUID();
    const encryption = createTransportTokenEncryption(secret);
    await db.query(
      `INSERT INTO devices (id,principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,model,apns_environment,apns_token,live_activity_push_to_start_token,notification_authorization,
         live_activity_authorization,credential_version)
       VALUES ($1,$2,$3,$4,'Phone','com.example.relo.notifications','1','1','18','iPhone','sandbox',$5,$6,
         'authorized','authorized',1)`,
      [deviceId,principalId,`stable-${deviceId}`,randomUUID(),encryption.encrypt("a".repeat(64),"device.apns_token"),
        encryption.encrypt("b".repeat(64),"device.live_activity_push_to_start_token")]);
  });
  afterAll(async () => db.end());

  const call = (method: string,path: string,body?: unknown) => app.request(path,{
    method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json","idempotency-key": randomUUID() },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  async function question(): Promise<string> {
    const started = await call("POST","/api/live-activities",{ key: `work-${randomUUID()}`,title: "Release",status: "Working" });
    expect(started.status).toBe(201);
    const card = (await started.json() as any).activity.id;
    const asked = await call("POST",`/api/live-activities/${card}/wait`,{ type: "approval",prompt: "Deploy now?",expiresInSeconds: 120 });
    expect(asked.status,await asked.clone().text()).toBe(201);
    const body = await asked.json() as any;
    return body.interaction?.id ?? body.interactionId ?? body.id;
  }

  test("a pending question reads late: null",async () => {
    const id = await question();
    const read = await call("GET",`/api/interactions/${id}`);
    expect(read.status).toBe(200);
    const body = interactionResultResponseSchema.parse(await read.json());
    expect(body.interaction.late).toBeNull();
  });

  test("an expired question answered late reads state expired with the late answer, on get and on wait",async () => {
    const id = await question();
    await db.query(`UPDATE interaction_requests SET state='expired',expires_at=now()-interval '1 minute',
      late_response='{"state":"approved"}'::jsonb,late_responded_at=now() WHERE id=$1`,[id.replace(/^int_/,"")]);
    for (const path of [`/api/interactions/${id}`,`/api/interactions/${id}/wait?timeoutSeconds=0`]) {
      const read = await call("GET",path);
      expect(read.status).toBe(200);
      const body = interactionResultResponseSchema.parse(await read.json());
      expect(body.interaction.state).toBe("expired");
      expect(body.interaction.late).toMatchObject({ state: "approved",response: null });
      expect(typeof body.interaction.late?.respondedAt).toBe("string");
    }
  });
});
