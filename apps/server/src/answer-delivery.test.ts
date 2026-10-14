import { createHmac,randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { hashToken } from "./auth.js";
import { standardWebhookSignature } from "./callback-destinations.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { respondToInteraction } from "./interactions/commands.js";
import { answerSignature,CALLBACK_GIVE_UP_SECONDS,CALLBACK_MAX_ATTEMPTS,CALLBACK_RETRY_DELAYS_SECONDS,
  dispatchDueInteractionCallbacks,redeliverInteractionCallback } from "./interaction-callbacks.js";
import { createTransportTokenEncryption } from "./token-encryption.js";

// 2.12 / 2.19 (plan/03-slice2-server.md): answer channels carry the phone's signature, Standard
// Webhooks headers, ~3 days of retries, owner redelivery, and private http:// callbacks when allowed.

test("retries span about three days in ten attempts",() => {
  expect(CALLBACK_MAX_ATTEMPTS).toBe(10);
  const lastAttemptSeconds = CALLBACK_RETRY_DELAYS_SECONDS.reduce((sum,delay) => sum + delay,0);
  expect(lastAttemptSeconds / 3_600).toBeGreaterThan(70);
  expect(lastAttemptSeconds).toBeLessThanOrEqual(CALLBACK_GIVE_UP_SECONDS);
});

test("the Standard Webhooks signature is base64 HMAC over id.timestamp.body; whsec_ keys are decoded",() => {
  const body = "{\"a\":1}";
  expect(standardWebhookSignature("plain-token","cbk_1",1700000000,body))
    .toBe(`v1,${createHmac("sha256","plain-token").update(`cbk_1.1700000000.${body}`).digest("base64")}`);
  const key = Buffer.from("0123456789abcdef0123456789abcdef");
  expect(standardWebhookSignature(`whsec_${key.toString("base64")}`,"cbk_1",1700000000,body))
    .toBe(`v1,${createHmac("sha256",key).update(`cbk_1.1700000000.${body}`).digest("base64")}`);
});

test("the phone's signature passes through unchanged; the server never invents one",() => {
  const signed = answerSignature("2a2a2a2a-0000-4000-8000-000000000000",{
    e2eeKeyId: "k_Q1w",e2eeSignedAt: "2026-10-14T10:52:03.000Z",e2eeSignature: "c2ln" });
  expect(signed).toEqual({
    device: { id: "dev_2a2a2a2a-0000-4000-8000-000000000000",keyId: "k_Q1w" },
    signature: { v: "relo.e2e.v1",kind: "answer",keyId: "k_Q1w",signedAt: "2026-10-14T10:52:03.000Z",sig: "c2ln",
      question: null,questionSig: null },
  });
  expect(answerSignature(null,{}).signature).toBeNull();
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Answer delivery (2.12, 2.19)",() => {
  let db: Database,principalId: string,deviceId: string;
  const owner = "delivery_owner_abcdefghijklmnopqrstuvwxyz0123",secret = "callback-secret-with-at-least-32-characters";
  const encryption = createTransportTokenEncryption(secret);
  const identity = { providerName: "Codex",project: "Relo",threadName: "Release" };
  const publicResolve = (async () => [{ address: "93.184.216.34",family: 4 }]) as any;
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE"); await bootstrapOwner(db,"owner",owner);
    principalId = (await db.query<{ principal_id: string }>("SELECT principal_id FROM principal_api_keys WHERE token_hash=$1",
      [hashToken(owner)])).rows[0]!.principal_id;
    deviceId = (await db.query<{ id: string }>(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token)
      VALUES ($1,$2,$3,'Delivery','com.example.fixture','1','1','27','sandbox','authorized','fixture-token') RETURNING id`,
    [principalId,randomUUID(),randomUUID()])).rows[0]!.id;
  });
  const app = () => createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret });
  async function ask(url: string) {
    const response = await app().request("/api/interactions",{ method: "POST",
      headers: { authorization: `Bearer ${owner}`,"content-type": "application/json","idempotency-key": randomUUID() },
      body: JSON.stringify({ title: "Deploy",prompt: "Ship it?",type: "yes_no",context: identity,
        callback: { url,token: "private-callback-token-0123" } }) });
    expect(response.status,await response.clone().text()).toBe(201);
    const { eventId } = await response.json() as { eventId: string };
    return (await db.query<{ id: string; notification_event_id: string }>(
      "SELECT id,notification_event_id FROM interaction_requests WHERE notification_event_id=$1",[eventId.slice(4)])).rows[0]!;
  }
  const answerYes = (request: { id: string; notification_event_id: string }) =>
    respondToInteraction(db,{ kind: "device",principalId,deviceId },
      { eventId: request.notification_event_id,interactionId: request.id,kind: "yes",value: {},idempotencyKey: randomUUID() },
      { apnsMode: "disabled" });

  test("a callback carries Standard Webhooks headers and the answering device",async () => {
    const request = await ask("https://ci.example.com/relo");
    await answerYes(request);
    const calls: any[] = [];
    await dispatchDueInteractionCallbacks(db,{ encryption,resolve: publicResolve,now: () => 1_700_000_000_000,
      send: (async (input: any) => { calls.push(input); return 204; }) as any });
    const { headers,body } = calls[0];
    expect(headers["webhook-id"]).toBe(headers["relo-delivery-id"]);
    expect(headers["webhook-timestamp"]).toBe("1700000000");
    expect(headers["webhook-signature"]).toBe(standardWebhookSignature("private-callback-token-0123",headers["webhook-id"],1700000000,body));
    expect(JSON.parse(body).device).toEqual({ id: `dev_${deviceId}`,keyId: null });
    const row = (await db.query("SELECT extract(epoch FROM give_up_at - now())::int AS seconds FROM interaction_callbacks")).rows[0];
    expect(row.seconds).toBeGreaterThan(71 * 3_600);
  });

  test("410 Gone stops retrying; the asker may redeliver with the same webhook-id, at most ten times a day",async () => {
    const request = await ask("https://ci.example.com/relo");
    await answerYes(request);
    const ids: string[] = [];
    let status = 410;
    const send = (async (input: any) => { ids.push(input.headers["webhook-id"]); return status; }) as any;
    await dispatchDueInteractionCallbacks(db,{ encryption,send,resolve: publicResolve });
    expect((await db.query("SELECT state,last_error FROM interaction_callbacks")).rows[0]).toMatchObject({ state: "failed",last_error: "gone" });
    expect(await redeliverInteractionCallback(db,randomUUID(),request.id)).toBe("not_found");
    expect(await redeliverInteractionCallback(db,principalId,request.id)).toBe("redelivered");
    expect(await redeliverInteractionCallback(db,principalId,request.id)).toBe("not_redeliverable");
    status = 204;
    await dispatchDueInteractionCallbacks(db,{ encryption,send,resolve: publicResolve });
    expect(ids).toHaveLength(2);
    expect(ids[1]).toBe(ids[0]);
    expect((await db.query("SELECT state,attempts,redelivered_count FROM interaction_callbacks")).rows[0])
      .toMatchObject({ state: "delivered",attempts: 1,redelivered_count: 1 });
    await db.query("UPDATE interaction_callbacks SET redelivered_today=10");
    expect(await redeliverInteractionCallback(db,principalId,request.id)).toBe("redeliver_rate_limited");
  });

  test("2.19: an http:// callback to a private host is stored and delivered when the admin allows it",async () => {
    await db.query("UPDATE server_settings SET private_callbacks='admin'");
    const request = await ask("http://10.0.0.7:8080/relo");
    expect((await db.query("SELECT url FROM interaction_callbacks")).rows[0].url).toBe("http://10.0.0.7:8080/relo");
    await answerYes(request);
    const calls: any[] = [];
    await dispatchDueInteractionCallbacks(db,{ encryption,send: (async (input: any) => { calls.push(input); return 204; }) as any });
    expect(calls[0]?.target.address).toBe("10.0.0.7");
  });

  test("2.19: with private callbacks off, the private http:// callback is refused at delivery",async () => {
    await db.query("UPDATE server_settings SET private_callbacks='none'");
    const request = await ask("http://10.0.0.7:8080/relo");
    await answerYes(request);
    const calls: any[] = [];
    await dispatchDueInteractionCallbacks(db,{ encryption,send: (async (input: any) => { calls.push(input); return 204; }) as any });
    expect(calls).toHaveLength(0);
    expect((await db.query("SELECT last_error FROM interaction_callbacks")).rows[0].last_error).toBe("callback_host_private");
  });
});
