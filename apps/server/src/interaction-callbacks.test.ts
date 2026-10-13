import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { hashToken } from "./auth.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { createWebhookService } from "./services.js";
import { respondToInteraction } from "./interactions/commands.js";
import { CALLBACK_MAX_ATTEMPTS,dispatchDueInteractionCallbacks } from "./interaction-callbacks.js";
import { createTransportTokenEncryption } from "./token-encryption.js";
import { isAllowedDestinationUrl } from "./url-policy.js";

test("tap destinations allow web, app, and Shortcuts links and refuse executable schemes", () => {
  for (const url of ["https://ci.example.com/builds/48","your-app://incidents/INC-42",
    "shortcuts://run-shortcut?name=Deploy%20Follow-up&input=text&text=done"]) {
    expect(isAllowedDestinationUrl(url),url).toBe(true);
  }
  for (const url of ["http://ci.example.com","javascript:alert(1)","data:text/html,hi","file:///etc/passwd",
    "blob:https://x","about:blank","https://user:pw@example.com","not a url","https://"]) {
    expect(isAllowedDestinationUrl(url),url).toBe(false);
  }
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Interaction answer callbacks",() => {
  let db: Database,principalId: string,deviceId: string;
  let service: Awaited<ReturnType<typeof createWebhookService>>;
  const owner = "callback_owner_abcdefghijklmnopqrstuvwxyz0123",secret = "callback-secret-with-at-least-32-characters";
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
      VALUES ($1,$2,$3,'Callback','com.example.fixture','1','1','27','sandbox','authorized','fixture-token') RETURNING id`,
    [principalId,randomUUID(),randomUUID()])).rows[0]!.id;
    service = await createWebhookService(db,principalId,"Deploybot","http://127.0.0.1:8180");
  });
  const app = () => createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: secret });

  async function ask(body: Record<string,unknown>,path = "/api/interactions") {
    const response = await app().request(path,{ method: "POST",
      headers: { authorization: `Bearer ${owner}`,"content-type": "application/json","idempotency-key": randomUUID() },
      body: JSON.stringify(body) });
    expect(response.status,await response.clone().text()).toBe(201);
    const { eventId } = await response.json() as { eventId: string };
    return (await db.query<{ id: string; notification_event_id: string }>(
      "SELECT id,notification_event_id FROM interaction_requests WHERE notification_event_id=$1",[eventId.slice(4)])).rows[0]!;
  }
  const answer = (request: { id: string; notification_event_id: string },kind: "yes" | "approve" | "answer",value = {}) =>
    respondToInteraction(db,{ kind: "device",principalId,deviceId },
      { eventId: request.notification_event_id,interactionId: request.id,kind,value,idempotencyKey: randomUUID() },{ apnsMode: "disabled" });

  test("an answered prompt POSTs once with the bearer token and never stores the token in plaintext",async () => {
    const request = await ask({ title: "Deploy",prompt: "Ship it?",type: "yes_no",context: identity,correlationId: "deploy-184",
      callback: { url: "https://ci.example.com/relo",token: "private-callback-token-0123" } });
    const stored = (await db.query("SELECT token_ciphertext,state FROM interaction_callbacks")).rows[0];
    expect(stored.state).toBe("waiting");
    expect(stored.token_ciphertext).not.toContain("private-callback-token");
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = (async (url: string,init: RequestInit) => { calls.push({ url,init }); return new Response(null,{ status: 204 }); }) as any;
    expect(await dispatchDueInteractionCallbacks(db,{ encryption,fetchImpl,resolve: publicResolve })).toBe(0);
    expect((await answer(request,"yes")).kind).toBe("accepted");
    expect(await dispatchDueInteractionCallbacks(db,{ encryption,fetchImpl,resolve: publicResolve })).toBe(1);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.init.headers as Record<string,string>).authorization).toBe("Bearer private-callback-token-0123");
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(JSON.parse(String(calls[0]!.init.body))).toMatchObject({
      type: "notification.response",eventId: `ntf_${request.notification_event_id}`,interactionId: `int_${request.id}`,
      correlationId: "deploy-184",kind: "yes_no",status: "yes",action: "yes",text: null,
    });
    expect(await dispatchDueInteractionCallbacks(db,{ encryption,fetchImpl,resolve: publicResolve })).toBe(0);
    const read = await app().request(`/api/interactions/int_${request.id}`,{ headers: { authorization: `Bearer ${owner}` } });
    expect((await read.json() as any).interaction.callback).toMatchObject({ state: "delivered",attempts: 1,lastStatus: 204 });
  });

  test("failures retry on the published schedule and stop after five attempts",async () => {
    const request = await ask({ title: "Deploy",prompt: "Ship it?",type: "yes_no",context: identity,
      callback: { url: "https://ci.example.com/relo",token: "private-callback-token-0123" } });
    await answer(request,"yes");
    const fetchImpl = (async () => new Response("no",{ status: 500 })) as any;
    for (let attempt = 1; attempt <= CALLBACK_MAX_ATTEMPTS; attempt += 1) {
      await db.query("UPDATE interaction_callbacks SET next_attempt_at=now()-interval '1 second' WHERE state='pending'");
      expect(await dispatchDueInteractionCallbacks(db,{ encryption,fetchImpl,resolve: publicResolve })).toBe(1);
      const row = (await db.query("SELECT state,attempts,last_status,next_attempt_at-now() AS wait FROM interaction_callbacks")).rows[0];
      expect(row.attempts).toBe(attempt);
      expect(row.last_status).toBe(500);
      expect(row.state).toBe(attempt === CALLBACK_MAX_ATTEMPTS ? "failed" : "pending");
    }
  });

  test("expired prompts never call back and private hosts are refused",async () => {
    const expired = await ask({ title: "Deploy",prompt: "Ship it?",type: "yes_no",context: identity,
      callback: { url: "https://ci.example.com/relo",token: "private-callback-token-0123" } });
    await db.query("UPDATE interaction_requests SET state='expired' WHERE id=$1",[expired.id]);
    const fetchImpl = (async () => { throw new Error("must not call"); }) as any;
    await dispatchDueInteractionCallbacks(db,{ encryption,fetchImpl,resolve: publicResolve });
    expect((await db.query("SELECT state FROM interaction_callbacks WHERE interaction_request_id=$1",[expired.id])).rows[0].state)
      .toBe("not_answered");

    const rebound = await ask({ title: "Deploy",prompt: "Ship it?",type: "yes_no",context: identity,
      callback: { url: "https://ci.example.com/relo",token: "private-callback-token-0123" } });
    await answer(rebound,"yes");
    const privateResolve = (async () => [{ address: "10.0.0.5",family: 4 }]) as any;
    await dispatchDueInteractionCallbacks(db,{ encryption,fetchImpl,resolve: privateResolve });
    expect((await db.query("SELECT last_error FROM interaction_callbacks WHERE interaction_request_id=$1",[rebound.id])).rows[0].last_error)
      .toBe("callback_host_not_public");
  });

  test("webhook prompts accept a callback and report its state on the event route",async () => {
    const path = new URL(service.webhookUrl).pathname;
    const request = await ask({ body: "Deploy commit 8e7fc2a?",context: identity,
      response: { type: "approval",correlationId: "deploy-184",
        callback: { url: "https://ci.example.com/relo",token: "private-callback-token-0123" } } },path);
    await answer(request,"approve");
    const fetchImpl = (async () => new Response(null,{ status: 200 })) as any;
    await dispatchDueInteractionCallbacks(db,{ encryption,fetchImpl,resolve: publicResolve });
    const event = await app().request(`${path}/events/ntf_${request.notification_event_id}`);
    const body = await event.json() as any;
    expect(body.event.response).toMatchObject({ status: "approved",correlationId: "deploy-184",
      callback: { state: "delivered",attempts: 1 } });
  });

  test("callbacks must target a public HTTPS endpoint",async () => {
    const response = await app().request("/api/interactions",{ method: "POST",
      headers: { authorization: `Bearer ${owner}`,"content-type": "application/json" },
      body: JSON.stringify({ title: "Deploy",prompt: "Ship it?",type: "yes_no",context: identity,
        callback: { url: "https://localhost/relo",token: "private-callback-token-0123" } }) });
    expect(response.status).toBe(400);
  });
});
