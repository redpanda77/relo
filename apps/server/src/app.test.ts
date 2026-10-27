import { afterAll, beforeAll, beforeEach, describe, expect, test,vi } from "vitest";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { generateToken, hashToken } from "./auth.js";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { loadOwnerStateInputs } from "./derive/load.js";
import { deriveOwnerState } from "./derive/owner-state.js";
import { OWNER_STATE_TIMING } from "@relo/notification-contracts";
import { expireDueInteractiveActivities } from "./interactive-activity-lifecycle.js";
import { cancelUndeliverableDeliveryJobs } from "./delivery-lifecycle.js";
import { currentTestPresentationRecord } from "./test-current-presentation.js";
import { createTransportTokenEncryption } from "./token-encryption.js";
import { ChangeSubscription,InteractionChangeHub } from "./interaction-change-hub.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("Relo API persistence boundaries", () => {
  let db: Database;
  const ownerOneToken = "owner_one_abcdefghijklmnopqrstuvwxyz_0123456789";
  const ownerTwoToken = "owner_two_abcdefghijklmnopqrstuvwxyz_0123456789";
  const transportSecret = "test-transport-token-secret-with-at-least-32-characters";

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
  });

  beforeEach(async () => {
    await db.query("TRUNCATE interactions, delivery_jobs, notification_events, device_credentials, devices, principal_api_keys, owner_principals CASCADE");
    await bootstrapOwner(db, "owner-one", ownerOneToken);
    await bootstrapOwner(db, "owner-two", ownerTwoToken);
  });

  afterAll(async () => db.end());

  async function request(
    path: string,
    token: string,
    init?: RequestInit,
    apnsMode: "disabled" | "production" | "sandbox" = "sandbox",
  ): Promise<Response> {
    return createApp(db,{ apnsMode, credentialDerivationSecret: transportSecret }).request(path, {
      ...init,
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...init?.headers },
    });
  }

  async function pair(ownerToken: string, installationId: string, withPush = true): Promise<{ credential: string; deviceId: string }> {
    const principal = await db.query<{ principal_id: string }>(
      "SELECT principal_id FROM principal_api_keys WHERE token_hash=$1",
      [hashToken(ownerToken)],
    );
    const deviceId = randomUUID();
    const encryption = createTransportTokenEncryption(transportSecret);
    await db.query(
      `INSERT INTO devices (
         id,principal_id,stable_device_id,installation_id,name,bundle_identifier,
         app_version,app_build,os_version,model,apns_environment,apns_token,
         live_activity_push_to_start_token,notification_authorization,
         live_activity_authorization,credential_version
       ) VALUES ($1,$2,$3,$4,'Test iPhone','com.example.relo.notifications',
         '1.0.0','1','18.0','iPhone','sandbox',$5,$6,'authorized','authorized',1)`,
      [
        deviceId,principal.rows[0]!.principal_id,`stable-${installationId}`,installationId,
        withPush ? encryption.encrypt("a".repeat(64),"device.apns_token") : null,
        withPush ? encryption.encrypt("b".repeat(64),"device.live_activity_push_to_start_token") : null,
      ],
    );
    const credential = generateToken();
    await db.query(
      "INSERT INTO device_credentials(device_id,token_hash) VALUES ($1,$2)",
      [deviceId,hashToken(credential)],
    );
    return { credential, deviceId: `dev_${deviceId}` };
  }

  test("late exact-generation tokens wake only matching cleanup jobs and preserve provider backoff", async () => {
    const first = await pair(ownerOneToken,randomUUID());
    const second = await pair(ownerOneToken,randomUUID());
    const started = await request("/api/live-activities",ownerOneToken,{
      method: "POST",headers: { "idempotency-key": "late-token-start-12345678" },
      body: JSON.stringify({ key: "late-token",title: "Late token",status: "Starting",
        deviceIds: [first.deviceId,second.deviceId] }),
    });
    const { activity } = await started.json() as any;
    expect(started.status).toBe(201);
    const ended = await request(`/api/live-activities/${activity.id}/end`,ownerOneToken,{
      method: "POST",headers: { "idempotency-key": "late-token-end-12345678" },
      body: JSON.stringify({ status: "Done",dismissAfterSeconds: 5 }),
    });
    expect(ended.status).toBe(200);
    const activityId = activity.id.slice(4);
    await db.query(`UPDATE delivery_jobs SET state='retry',available_at=now()+interval '60 seconds',
      last_error_code='activity_token_pending' WHERE live_activity_id=$1 AND state='pending'`,[activityId]);
    const register = (phone: typeof first,generation = activity.generation) => request(
      `/api/devices/self/live-activities/${activity.id}/token`,phone.credential,{
        method: "PUT",body: JSON.stringify({ generation,nativeActivityId: "native-late",
          environment: "sandbox",token: "c".repeat(64) }),
      });
    expect((await register(first,activity.generation+1)).status).toBe(409);
    expect((await register(first)).status).toBe(200);
    let jobs = (await db.query(`SELECT device_id,available_at<=clock_timestamp() AS ready,last_error_code
      FROM delivery_jobs WHERE live_activity_id=$1 AND state='retry' ORDER BY device_id`,[activityId])).rows;
    expect(jobs.find(j => j.device_id === first.deviceId.slice(4)).ready).toBe(true);
    expect(jobs.find(j => j.device_id === second.deviceId.slice(4)).ready).toBe(false);
    await db.query("UPDATE delivery_jobs SET last_error_code='provider_retry_scheduled' WHERE live_activity_id=$1 AND device_id=$2 AND state='retry'",[activityId,second.deviceId.slice(4)]);
    expect((await register(second)).status).toBe(200);
    jobs = (await db.query("SELECT available_at>clock_timestamp() AS waiting FROM delivery_jobs WHERE live_activity_id=$1 AND device_id=$2 AND state='retry'",[activityId,second.deviceId.slice(4)])).rows;
    expect(jobs[0].waiting).toBe(true);
    await db.query("UPDATE notification_events SET expires_at=now()-interval '1 second' WHERE payload#>>'{liveActivity,activityId}'=$1",[activity.id]);
    expect((await register(first)).status).toBe(404);
    expect((await db.query("SELECT generation FROM live_activity_update_tokens WHERE live_activity_id=$1 AND device_id=$2",[activityId,first.deviceId.slice(4)])).rows[0].generation).toBe(activity.generation);
  });

  test("committed decisions bypass the wait fallback and saturated producer rate buckets",async () => {
    const phone = await pair(ownerOneToken,randomUUID());
    const created = await request("/api/interactions",ownerOneToken,{ method: "POST",
      body: JSON.stringify({ title: "Wake",prompt: "Continue?",type: "approval" }) });
    const body = await created.json() as any;
    const hub = await InteractionChangeHub.listen(db);
    const app = createApp(db,{ apnsMode: "sandbox",credentialDerivationSecret: transportSecret,interactionChanges: hub });
    let entered!: () => void;
    const waitingForChange = new Promise<void>(resolve => { entered = resolve; });
    const original = ChangeSubscription.prototype.wait;
    const spy = vi.spyOn(ChangeSubscription.prototype,"wait").mockImplementation(function(this: ChangeSubscription,...args) {
      const result = original.apply(this,args);entered();return result;
    });
    try {
      const waiting = app.request(`/api/interactions/${body.interaction.id}/wait?timeoutSeconds=60`,{
        headers: { authorization: `Bearer ${ownerOneToken}` },signal: AbortSignal.timeout(1_500),
      });
      await waitingForChange;
      await db.query("UPDATE request_rate_limits SET request_count=1000 WHERE family='authenticated-mutations'");
      const replied = await request(`/api/notifications/${body.eventId}/interactions`,phone.credential,{
        method: "POST",body: JSON.stringify({ kind: "approve",value: {},idempotencyKey: "immediate-wake-response" }),
      });
      expect(replied.status).toBe(201);
      const result = await waiting;
      expect(result.status).toBe(200);
      expect(await result.json()).toMatchObject({ interaction: { state: "approved" } });
      expect((await db.query(`SELECT count(*)::int AS n FROM request_rate_limits WHERE family='decision-responses'
        AND scope_id IN (SELECT id FROM devices WHERE id=$1 UNION SELECT principal_id FROM devices WHERE id=$1)`,
      [phone.deviceId.slice(4)])).rows[0].n).toBe(2);
    } finally { spy.mockRestore();await hub.close(); }
  });

  test("current generation can replace an older token without granting stale registrations authority",async () => {
    const phone = await pair(ownerOneToken,randomUUID());
    const started = await request("/api/live-activities",ownerOneToken,{ method: "POST",
      headers: { "idempotency-key": "token-generation-start-12345678" },
      body: JSON.stringify({ key: "token-generation",title: "Generation",status: "Starting",deviceIds: [phone.deviceId] }) });
    const { activity } = await started.json() as any;
    const register = (generation: number) => request(`/api/devices/self/live-activities/${activity.id}/token`,phone.credential,{
      method: "PUT",body: JSON.stringify({ generation,nativeActivityId: `native-${generation}`,environment: "sandbox",token: String(generation).repeat(64) }),
    });
    expect((await register(activity.generation)).status).toBe(200);
    await db.query("UPDATE live_activities SET generation=generation+1 WHERE id=$1",[activity.id.slice(4)]);
    expect((await register(activity.generation+1)).status).toBe(200);
    expect((await register(activity.generation)).status).toBe(409);
    expect((await db.query("SELECT generation,native_activity_id FROM live_activity_update_tokens WHERE live_activity_id=$1",[activity.id.slice(4)])).rows[0])
      .toEqual({ generation: activity.generation+1,native_activity_id: `native-${activity.generation+1}` });
  });

  test("the ring style draws progress as a gauge until a later update changes layout",async () => {
    const phone = await pair(ownerOneToken,randomUUID());
    const started = await request("/api/live-activities",ownerOneToken,{ method: "POST",
      body: JSON.stringify({ key: "ring",title: "Deploy #184",status: "Building",progress: 0.1,style: "ring",
        deviceIds: [phone.deviceId] }) });
    expect(started.status).toBe(201);
    const { activity } = await started.json() as any;
    const stored = async () => (await db.query(
      "SELECT style,privacy,presentation FROM live_activities WHERE id=$1",[activity.id.slice(4)])).rows[0];
    expect(await stored()).toMatchObject({ style: "ring",privacy: "standard",
      presentation: { appearance: { progressDisplay: "ring" } } });
    const patch = (body: object) => request(`/api/live-activities/${activity.id}`,ownerOneToken,{
      method: "PATCH",body: JSON.stringify(body) });
    expect((await patch({ status: "Testing",progress: 0.6 })).status).toBe(200);
    expect((await stored()).style).toBe("ring");
    expect((await patch({ style: "standard",status: "Packaging" })).status).toBe(200);
    expect((await stored()).style).toBe("standard");
    expect((await stored()).presentation.appearance.progressDisplay).toBeUndefined();
  });

  test("private activities never store or send their content, even across updates",async () => {
    const phone = await pair(ownerOneToken,randomUUID());
    const started = await request("/api/live-activities",ownerOneToken,{ method: "POST",
      body: JSON.stringify({ key: "private",title: "Rotate prod keys",status: "Running",progress: 0.2,
        privacy: "private",deviceIds: [phone.deviceId] }) });
    expect(started.status).toBe(201);
    const { activity } = await started.json() as any;
    const stored = async () => (await db.query(
      "SELECT title,status,privacy FROM live_activities WHERE id=$1",[activity.id.slice(4)])).rows[0];
    expect(await stored()).toEqual({ title: "Private activity",status: "Open Relo to view",privacy: "private" });
    for (const body of [{ status: "Rotating",progress: 0.6 },{ style: "hero",status: "Rotated" }]) {
      expect((await request(`/api/live-activities/${activity.id}`,ownerOneToken,{
        method: "PATCH",body: JSON.stringify(body) })).status).toBe(200);
      expect(await stored()).toEqual({ title: "Private activity",status: "Open Relo to view",privacy: "private" });
    }
    const payloads = (await db.query(`SELECT e.payload FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
      WHERE j.live_activity_id=$1`,[activity.id.slice(4)])).rows.map(row => JSON.stringify(row.payload));
    expect(payloads.length).toBeGreaterThan(0);
    for (const payload of payloads) expect(payload).not.toMatch(/Rotate prod keys|Rotating|Rotated/);
  });

  test("aborted waits release their subscription and malformed query bounds fail immediately",async () => {
    const phone = await pair(ownerOneToken,randomUUID());
    const created = await request("/api/interactions",ownerOneToken,{ method: "POST",
      body: JSON.stringify({ title: "Abort",prompt: "Continue?",type: "approval" }) });
    const body = await created.json() as any;
    for (const value of ["NaN","Infinity","-1","1.5","301",""]) {
      expect((await request(`/api/interactions/${body.interaction.id}/wait?timeoutSeconds=${value}`,ownerOneToken)).status).toBe(400);
    }
    for (const value of ["NaN","Infinity","0","1.5","101",""]) {
      expect((await request(`/api/inbox/history?limit=${value}`,phone.credential)).status).toBe(400);
    }
    const hub = await InteractionChangeHub.listen(db);
    const app = createApp(db,{ interactionChanges: hub });
    let entered!: () => void;
    const ready = new Promise<void>(resolve => { entered = resolve; });
    const original = ChangeSubscription.prototype.wait;
    const spy = vi.spyOn(ChangeSubscription.prototype,"wait").mockImplementation(function(this: ChangeSubscription,...args) {
      const result = original.apply(this,args);entered();return result;
    });
    try {
      const cancel = new AbortController();
      const waiting = app.request(`/api/interactions/${body.interaction.id}/wait?timeoutSeconds=300`,{
        headers: { authorization: `Bearer ${ownerOneToken}` },signal: cancel.signal,
      });
      await ready;cancel.abort();
      expect((await waiting).status).toBe(499);
      expect(spy).toHaveBeenCalledTimes(1);
    } finally { spy.mockRestore();await hub.close(); }
  });

  test("rejects malformed public interaction identifiers before PostgreSQL casts", async () => {
    for (const [method, suffix] of [
      ["GET", ""],
      ["GET", "/wait?timeoutSeconds=0"],
      ["POST", "/cancel"],
    ] as const) {
      const response = await request(`/api/interactions/int_not-a-uuid${suffix}`, ownerOneToken, {
        method,
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "not_found" });
    }
  });

  test("API notifications, decisions, and activity starts require a project and topic", async () => {
    const headers = { "x-relo-test-raw-identity": "1" };
    for (const [path,body] of [
      ["/api/notifications",{ sourceName: "Codex",title: "Done",body: "Task complete",context: { project: "Relo" } }],
      ["/api/interactions",{ type: "approval",title: "Ship?",prompt: "Ship the release?" }],
      ["/api/live-activities",{ key: "identity-missing",title: "Build",status: "Running" }],
    ] as const) {
      const response = await request(path,ownerOneToken,{ method: "POST",headers,body: JSON.stringify(body) });
      expect(response.status,path).toBe(422);
      expect(await response.json()).toMatchObject({ error: "work_identity_required" });
    }
  });

  test("notification creation is idempotent and creates one durable outbox job per device", async () => {
    const phone = await pair(ownerOneToken, "11111111-1111-4111-8111-111111111111");
    const body = JSON.stringify({
      sourceName: "Codex", title: "Done", body: "Task complete",
      context: { computer: "MacBook", project: "Relo", threadName: "Lifecycle", taskTitle: "Lifecycle verification" },
    });
    const headers = { "idempotency-key": "x" };
    const first = await request("/api/notifications", ownerOneToken, { method: "POST", headers, body });
    const replay = await request("/api/notifications", ownerOneToken, { method: "POST", headers, body });
    const changed = await request("/api/notifications", ownerOneToken, {
      headers,
      method: "POST", body: JSON.stringify({
        sourceName: "Codex", title: "Changed", body: "Task complete",
      }),
    });
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect((await first.json() as any).queued).toBe(1);
    const replayBody = await replay.json() as any;
    expect(replayBody.replayed).toBe(true);
    expect(replayBody.delivery).toMatchObject({ eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 });
    expect(changed.status).toBe(409);
    expect((await db.query("SELECT count(*)::int AS count FROM notification_events")).rows[0].count).toBe(1);
    expect((await db.query("SELECT count(*)::int AS count FROM delivery_jobs")).rows[0].count).toBe(1);
    expect((await db.query(
      "SELECT source,title,body FROM notification_events WHERE idempotency_key=$1",
      ["x"],
    )).rows[0]).toEqual({ source: "Codex", title: "Done", body: "Task complete" });
    const inbox = await (await request("/api/inbox/history?limit=100", phone.credential)).json() as any;
    expect(inbox.items[0].sourceName).toBe("Codex");
    expect(inbox.items[0].title).toBe("Done");
    expect(inbox.items[0].detail).toBe("Task complete");
    expect(inbox.items[0].context).toEqual({
      computer: "MacBook", project: "Relo", threadName: "Lifecycle", taskTitle: "Lifecycle verification",
      providerThreadId: expect.stringMatching(/^topic:[0-9a-f]{64}$/),
    });
  });

  test("rejects an oversized ordinary APNs envelope before enqueue", async () => {
    const phone = await pair(ownerOneToken,"18181818-1818-4818-8818-181818181818");
    const longPath = "x".repeat(2_000);
    const response = await request("/api/notifications",ownerOneToken,{
      method: "POST", body: JSON.stringify({
        sourceName: "Codex", title: "Large envelope", body: "b".repeat(2_000),
        imageUrl: `https://images.example.test/${longPath}`,
        destinationUrl: `https://example.test/${longPath}`,
        context: { computer: "c".repeat(120), project: "p".repeat(120), taskTitle: "t".repeat(160) },
        deviceIds: [phone.deviceId],
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "apns_payload_too_large", maximumBytes: 4096 });
    expect((await db.query("SELECT count(*)::int AS count FROM notification_events")).rows[0].count).toBe(0);
    expect((await db.query("SELECT count(*)::int AS count FROM delivery_jobs")).rows[0].count).toBe(0);
  });

  test("cancels expired and terminal jobs before the worker can claim them", async () => {
    const phone = await pair(ownerOneToken,"19191919-1919-4919-8919-191919191919");
    for (const [key,state,expires] of [
      ["expired-before-claim","active","now()-interval '1 second'"],
      ["terminal-before-claim","responded","now()+interval '10 minutes'"],
    ] as const) {
      const event = await db.query<{ id: string }>(
        `INSERT INTO notification_events(
           principal_id,requester_credential_id,source,title,body,idempotency_key,state,expires_at
         ) SELECT principal_id,id,'Test','Test','Test',$2,$3::notification_state,${expires}
           FROM principal_api_keys WHERE token_hash=$1 RETURNING id`,
        [hashToken(ownerOneToken),key,state],
      );
      await db.query(
        "INSERT INTO delivery_jobs(notification_event_id,device_id) VALUES ($1,$2)",
        [event.rows[0]!.id,phone.deviceId.slice("dev_".length)],
      );
    }
    expect(await cancelUndeliverableDeliveryJobs(db)).toBe(2);
    const jobs = await db.query<{ state: string; last_error_code: string }>(
      "SELECT state,last_error_code FROM delivery_jobs ORDER BY last_error_code",
    );
    expect(jobs.rows).toEqual([
      { state: "canceled", last_error_code: "event_expired" },
      { state: "canceled", last_error_code: "event_terminal" },
    ]);
  });

  test("heartbeat persists current authorization state", async () => {
    const phone = await pair(ownerOneToken,"14141414-1414-4414-8414-141414141414");
    const heartbeat = await request(`/api/devices/${phone.deviceId}`,phone.credential,{
      method: "PUT",
      body: JSON.stringify({
        notificationAuthorization: "provisional",
        liveActivityAuthorization: "denied",
      }),
    });
    expect(heartbeat.status).toBe(200);
    const stored = await db.query<{
      notification_authorization: string; live_activity_authorization: string;
    }>(
      `SELECT notification_authorization,live_activity_authorization FROM devices WHERE id=$1`,
      [phone.deviceId.slice("dev_".length)],
    );
    expect(stored.rows[0]).toEqual({
      notification_authorization: "provisional",
      live_activity_authorization: "denied",
    });
  });

  test("device inventory keyset-paginates stable account-scoped pages", async () => {
    const emptyOwnerToken = "owner_empty_abcdefghijklmnopqrstuvwxyz_0123456789";
    await bootstrapOwner(db,"owner-empty",emptyOwnerToken);
    expect(await (await request("/api/devices",emptyOwnerToken)).json()).toEqual({
      devices: [], cursor: null, hasMore: false,
    });
    expect(await (await request("/api/devices?limit=1",emptyOwnerToken)).json()).toEqual({
      devices: [], cursor: null, hasMore: false,
    });

    const foreign = await pair(ownerTwoToken,"29999999-9999-4999-8999-999999999999",false);
    const phones = await Promise.all([
      pair(ownerOneToken,"29000000-0000-4000-8000-000000000001",false),
      pair(ownerOneToken,"29000000-0000-4000-8000-000000000002",false),
      pair(ownerOneToken,"29000000-0000-4000-8000-000000000003",false),
      pair(ownerOneToken,"29000000-0000-4000-8000-000000000004",false),
      pair(ownerOneToken,"29000000-0000-4000-8000-000000000005",false),
    ]);
    const registeredAt = [
      "2026-08-07T00:00:01.000000Z",
      "2026-08-07T00:00:02.000000Z",
      "2026-08-07T00:00:03.000000Z",
      "2026-08-07T00:00:04.000000Z",
      "2026-08-07T00:00:04.000000Z",
    ];
    for (const [index,phone] of phones.entries()) {
      await db.query(
        `UPDATE devices SET registered_at=$2::timestamptz,last_seen_at=$2::timestamptz,
           name=$3 WHERE id=$1`,
        [phone.deviceId.slice("dev_".length),registeredAt[index],`Phone ${index + 1}`],
      );
    }
    await db.query(
      "UPDATE devices SET apns_token=$2,live_activity_push_to_start_token=$3 WHERE id=$1",
      [phones[0]!.deviceId.slice("dev_".length),"secret-apns-token","secret-live-activity-token"],
    );
    const expectedIds = phones.map((phone,index) => ({ id: phone.deviceId,registeredAt: registeredAt[index]! }))
      .sort((left,right) => right.registeredAt.localeCompare(left.registeredAt)
        || right.id.localeCompare(left.id))
      .map(({ id }) => id);

    const completeResponse = await request("/api/devices",ownerOneToken);
    expect(completeResponse.status).toBe(200);
    const complete = await completeResponse.json() as any;
    expect(complete).toMatchObject({ cursor: null,hasMore: false });
    expect(complete.devices.map((device: any) => device.deviceId)).toEqual(expectedIds);
    expect(complete.devices.some((device: any) => device.deviceId === foreign.deviceId)).toBe(false);
    expect(Object.keys(complete.devices[0]).sort()).toEqual([
      "apnsEnvironment","appBuild","appVersion","bundleIdentifier","deviceId","installationId","isSimulator",
      "lastSeenAt","liveActivityAuthorization","model","modelName","name","notificationAuthorization",
      "osVersion","registeredAt",
    ].sort());
    const serialized = JSON.stringify(complete);
    expect(serialized).not.toContain("secret-apns-token");
    expect(serialized).not.toContain("secret-live-activity-token");
    expect(serialized).not.toContain(phones[0]!.credential);

    const firstResponse = await request("/api/devices?limit=2",ownerOneToken);
    expect(firstResponse.status).toBe(200);
    const first = await firstResponse.json() as any;
    expect(first.devices.map((device: any) => device.deviceId)).toEqual(expectedIds.slice(0,2));
    expect(first).toMatchObject({ hasMore: true, cursor: expect.any(String) });
    const decoded = JSON.parse(Buffer.from(first.cursor,"base64url").toString("utf8"));
    expect(decoded).toEqual(["devices-v1",expect.any(String),expectedIds[1]!.slice("dev_".length)]);
    expect(JSON.stringify(decoded)).not.toContain(ownerOneToken);

    const concurrent = await pair(ownerOneToken,"29000000-0000-4000-8000-000000000006",false);
    await db.query(
      "UPDATE devices SET registered_at='2026-08-07T00:00:05.000000Z' WHERE id=$1",
      [concurrent.deviceId.slice("dev_".length)],
    );
    const second = await (await request(
      `/api/devices?limit=2&cursor=${encodeURIComponent(first.cursor)}`,ownerOneToken,
    )).json() as any;
    expect(second.devices.map((device: any) => device.deviceId)).toEqual(expectedIds.slice(2,4));
    expect(second).toMatchObject({ hasMore: true, cursor: expect.any(String) });
    const third = await (await request(
      `/api/devices?limit=2&cursor=${encodeURIComponent(second.cursor)}`,ownerOneToken,
    )).json() as any;
    expect(third.devices.map((device: any) => device.deviceId)).toEqual(expectedIds.slice(4));
    expect(third).toMatchObject({ hasMore: false, cursor: null });
    const traversed = [...first.devices,...second.devices,...third.devices].map((device: any) => device.deviceId);
    expect(traversed).toEqual(expectedIds);
    expect(new Set(traversed).size).toBe(expectedIds.length);
    expect(traversed).not.toContain(concurrent.deviceId);
  });

  test("device inventory expires malformed, foreign, revoked, and cross-domain cursors", async () => {
    const first = await pair(ownerOneToken,"29111111-1111-4111-8111-111111111111",false);
    await pair(ownerOneToken,"29222222-2222-4222-8222-222222222222",false);
    await pair(ownerTwoToken,"29333333-3333-4333-8333-333333333333",false);
    await db.query(
      "UPDATE devices SET registered_at='2026-08-07T00:00:02.000000Z' WHERE id=$1",
      [first.deviceId.slice("dev_".length)],
    );
    const firstPage = await (await request("/api/devices?limit=1",ownerOneToken)).json() as any;
    expect(firstPage.cursor).toBeTypeOf("string");

    for (const path of [
      "/api/devices?cursor=",
      "/api/devices?cursor=not-a-cursor",
      "/api/devices?cursor=one&cursor=two",
      `/api/devices?cursor=${encodeURIComponent(Buffer.from(JSON.stringify([
        "inbox-history-v1","2026-08-07T00:00:02.000000Z",first.deviceId.slice("dev_".length),
      ])).toString("base64url"))}`,
      `/api/devices?cursor=${encodeURIComponent(Buffer.from(JSON.stringify([
        "devices-v1","2026-08-07T00:00:02.000000Z","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      ])).toString("base64url"))}`,
    ]) {
      const response = await request(path,ownerOneToken);
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error: "cursor_expired" });
    }
    const foreign = await request(
      `/api/devices?cursor=${encodeURIComponent(firstPage.cursor)}`,ownerTwoToken,
    );
    expect(foreign.status).toBe(410);
    expect(await foreign.json()).toEqual({ error: "cursor_expired" });

    const decoded = JSON.parse(Buffer.from(firstPage.cursor,"base64url").toString("utf8"));
    await db.query("UPDATE devices SET revoked_at=now() WHERE id=$1",[decoded[2]]);
    const revoked = await request(
      `/api/devices?cursor=${encodeURIComponent(firstPage.cursor)}`,ownerOneToken,
    );
    expect(revoked.status).toBe(410);
    expect(await revoked.json()).toEqual({ error: "cursor_expired" });

    for (const limit of ["0","101","1.5","x",""]) {
      const response = await request(`/api/devices?limit=${limit}`,ownerOneToken);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_limit" });
    }
    const duplicateLimit = await request("/api/devices?limit=1&limit=2",ownerOneToken);
    expect(duplicateLimit.status).toBe(400);
    expect(await duplicateLimit.json()).toEqual({ error: "invalid_limit" });
  });

  test("device inventory uses a 100-item default when cursor alone activates pagination", async () => {
    await db.query(
      `INSERT INTO devices(
         principal_id,stable_device_id,installation_id,name,bundle_identifier,
         app_version,app_build,os_version,model,apns_environment,registered_at,last_seen_at
       )
       SELECT api_key.principal_id,'bulk-stable-'||item,'bulk-install-'||item,'Bulk '||item,
         'com.example.relo.notifications','1.0.0','1','18.0','iPhone','sandbox',
         '2026-08-07T00:00:00Z'::timestamptz + item * interval '1 second',
         '2026-08-07T00:00:00Z'::timestamptz + item * interval '1 second'
       FROM principal_api_keys api_key CROSS JOIN generate_series(1,102) item
       WHERE api_key.token_hash=$1`,
      [hashToken(ownerOneToken)],
    );
    const first = await (await request("/api/devices?limit=1",ownerOneToken)).json() as any;
    expect(first).toMatchObject({ hasMore: true, cursor: expect.any(String) });
    const defaultPage = await (await request(
      `/api/devices?cursor=${encodeURIComponent(first.cursor)}`,ownerOneToken,
    )).json() as any;
    expect(defaultPage.devices).toHaveLength(100);
    expect(defaultPage).toMatchObject({ hasMore: true, cursor: expect.any(String) });
    const final = await (await request(
      `/api/devices?cursor=${encodeURIComponent(defaultPage.cursor)}`,ownerOneToken,
    )).json() as any;
    expect(final.devices).toHaveLength(1);
    expect(final).toMatchObject({ hasMore: false, cursor: null });
  });

  test("delivery observability paginates account jobs and append-only attempts without inferring receipt", async () => {
    const phones = await Promise.all([
      pair(ownerOneToken,"29444444-4444-4444-8444-444444444444"),
      pair(ownerOneToken,"29555555-5555-4555-8555-555555555555"),
      pair(ownerOneToken,"29666666-6666-4666-8666-666666666666"),
    ]);
    await pair(ownerTwoToken,"29777777-7777-4777-8777-777777777777",false);
    const created = await request("/api/notifications",ownerOneToken,{
      method: "POST",headers: { "idempotency-key": "delivery-observability-12345678" },
      body: JSON.stringify({ sourceName: "Observability",title: "Trace",body: "Trace every target" }),
    });
    const eventId = (await created.json() as any).eventId as string;
    const jobs = (await db.query<{ id: string;device_id: string }>(
      `SELECT j.id,j.device_id FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
       WHERE e.id=$1 ORDER BY j.device_id`,[eventId.slice("ntf_".length)],
    )).rows;
    expect(jobs).toHaveLength(3);
    await db.query(
      `UPDATE delivery_jobs SET state='accepted',attempt_count=2,provider_outcome_category='accepted',
         provider_status=200,provider_message_id='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
         accepted_at='2026-08-07T11:00:02Z',provider_attempts_used=2,
         provider_retry_started_at='2026-08-07T11:00:00Z',provider_retry_attempt_cap=3,
         provider_retry_horizon_at='2026-08-07T12:00:00Z',
         provider_next_attempt_not_before='2026-08-07T11:15:00Z',
         last_provider_attempt_at='2026-08-07T11:00:02Z',last_error_message='secret payload must not escape',
         created_at='2026-08-07T11:00:00Z',updated_at='2026-08-07T11:00:02Z'
       WHERE id=$1`,
      [jobs[0]!.id],
    );
    await db.query(
      `UPDATE delivery_jobs SET state='permanently_failed',attempt_count=1,
         provider_outcome_category='invalid-recipient',provider_status=410,
         provider_attempts_used=1,provider_retry_started_at='2026-08-07T11:01:00Z',
         last_provider_attempt_at='2026-08-07T11:01:01Z',last_error_code='BadDeviceToken',
         created_at='2026-08-07T11:01:00Z',updated_at='2026-08-07T11:01:01Z'
       WHERE id=$1`,
      [jobs[1]!.id],
    );
    await db.query(
      `UPDATE delivery_jobs SET state='reconciliation_required',attempt_count=1,
         provider_outcome_category='indeterminate-transport',provider_attempts_used=1,
         provider_retry_started_at='2026-08-07T11:02:00Z',
         last_error_code='provider_dispatch_persistence_failed',
         created_at='2026-08-07T11:02:00Z',updated_at='2026-08-07T11:02:01Z'
       WHERE id=$1`,
      [jobs[2]!.id],
    );
    await db.query(
      `INSERT INTO delivery_attempts(
         delivery_job_id,claim_token,job_attempt,provider_attempts,outcome_category,provider_status,
         provider_reason,provider_message_id,provider_first_attempt_at,created_at
       ) VALUES
         ($1,$2,1,1,'retryable-not-scheduled',500,'InternalServerError',NULL,$4,'2026-08-07T11:00:01Z'),
         ($1,$3,2,1,'accepted',200,'unsafe reason with spaces','aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',$4,'2026-08-07T11:00:02Z')`,
      [jobs[0]!.id,randomUUID(),randomUUID(),new Date("2026-08-07T11:00:00Z")],
    );
    await db.query(
      `INSERT INTO delivery_attempts(
         delivery_job_id,claim_token,job_attempt,provider_attempts,outcome_category,provider_status,
         provider_reason,invalidated_at,provider_first_attempt_at,created_at
       ) VALUES ($1,$2,1,1,'invalid-recipient',410,'BadDeviceToken','2026-08-07T11:01:01Z',
         '2026-08-07T11:01:00Z','2026-08-07T11:01:01Z')`,
      [jobs[1]!.id,randomUUID()],
    );

    const traversed: any[] = [];
    let cursor: string | null = null;
    do {
      const response = await request(
        `/api/deliveries?limit=1&notificationId=${eventId}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
        ownerOneToken,
      );
      expect(response.status).toBe(200);
      const page = await response.json() as any;
      traversed.push(...page.deliveries);
      cursor = page.cursor;
      expect(Boolean(cursor)).toBe(page.hasMore);
    } while (cursor);
    expect(traversed.map((item) => item.status)).toEqual([
      "reconciliation_required","token_invalid","accepted_by_apns",
    ]);
    expect(traversed.find((item) => item.status === "accepted_by_apns")).toMatchObject({
      provider: { acceptedAt: "2026-08-07T11:00:02.000Z",reason: null },
      receipt: { receivedAt: null,openedAt: null },
    });
    expect(traversed.find((item) => item.status === "token_invalid")).toMatchObject({
      errorCode: "BadDeviceToken",tokenInvalidatedAt: "2026-08-07T11:01:01.000Z",
    });
    expect(traversed.find((item) => item.status === "reconciliation_required")).toMatchObject({
      reconciliation: { required: true,code: "provider_dispatch_persistence_failed" },
    });
    expect(JSON.stringify(traversed)).not.toContain("secret payload must not escape");

    const firstAttemptPage = await (await request(
      `/api/deliveries/job_${jobs[0]!.id}/attempts?limit=1`,ownerOneToken,
    )).json() as any;
    expect(firstAttemptPage.attempts[0]).toMatchObject({
      jobAttempt: 2,outcome: "accepted",providerReason: null,
    });
    const finalAttemptPage = await (await request(
      `/api/deliveries/job_${jobs[0]!.id}/attempts?limit=1&cursor=${encodeURIComponent(firstAttemptPage.cursor)}`,
      ownerOneToken,
    )).json() as any;
    expect(finalAttemptPage).toMatchObject({ hasMore: false,cursor: null });
    expect(finalAttemptPage.attempts[0]).toMatchObject({
      jobAttempt: 1,outcome: "retryable-not-scheduled",providerReason: "InternalServerError",
    });
    const foreign = await request(
      `/api/deliveries/job_${jobs[0]!.id}/attempts`,ownerTwoToken,
    );
    expect(foreign.status).toBe(404);
    expect(await (await request("/api/deliveries",ownerTwoToken)).json()).toEqual({
      deliveries: [],cursor: null,hasMore: false,
      apns: {
        mode: "sandbox",remoteEnqueueEnabled: true,providerCredentialActive: null,
        deliverySemantics: "worker_direct_apns",
      },
    });
  });

  test("the frozen canonical notification fixture reaches the route without arbitrary payload injection", async () => {
    const phone = await pair(ownerOneToken,"13131313-1313-4313-8313-131313131313");
    const fixture = JSON.parse(await readFile(
      new URL("../../../packages/contracts/fixtures/current-slice.json",import.meta.url),
      "utf8",
    )) as any;
    const canonical = { ...fixture.notification, deviceIds: [phone.deviceId] };
    const accepted = await request("/api/notifications",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "golden-notification-route-12345678" },
      body: JSON.stringify(canonical),
    });
    expect(accepted.status).toBe(201);
    const stored = (await db.query<{ payload: any }>(
      "SELECT payload FROM notification_events WHERE idempotency_key=$1",
      ["golden-notification-route-12345678"],
    )).rows[0]!.payload;
    expect(stored).toEqual({ privacy: canonical.privacy, context: {
      ...canonical.context, providerThreadId: expect.stringMatching(/^topic:[0-9a-f]{64}$/),
    } });

    const rejected = await request("/api/notifications",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "golden-notification-injection-12345678" },
      body: JSON.stringify({ ...canonical, payload: { command: "never-forward-this" } }),
    });
    expect(rejected.status).toBe(400);
    expect((await db.query(
      "SELECT 1 FROM notification_events WHERE idempotency_key=$1",
      ["golden-notification-injection-12345678"],
    )).rowCount).toBe(0);
  });

  test("notification and interaction mutations generate omitted idempotency keys and report delivery", async () => {
    await pair(ownerOneToken, "12121212-1212-4212-8212-121212121212");
    const notification = await request("/api/notifications",ownerOneToken,{
      method: "POST",
      body: JSON.stringify({ sourceName: "Codex", title: "Generated key", body: "No client key" }),
    });
    expect(notification.status).toBe(201);
    expect((await notification.json() as any).delivery).toMatchObject({ eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 });
    const interaction = await request("/api/interactions",ownerOneToken,{
      method: "POST",
      body: JSON.stringify({ title: "Generated key", prompt: "Continue?", type: "approval" }),
    });
    expect(interaction.status).toBe(201);
    expect((await interaction.json() as any).delivery).toMatchObject({ eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 });
    const keys = (await db.query<{ idempotency_key: string }>(
      "SELECT idempotency_key FROM notification_events ORDER BY created_at",
    )).rows.map((row) => row.idempotency_key);
    expect(keys).toHaveLength(2);
    expect(keys.every((key) => key.startsWith("server:") && key.length > 20)).toBe(true);
    expect(new Set(keys).size).toBe(2);
  });

  test("ordinary and Live Activity asks persist source, project, and topic resources", async () => {
    const phone = await pair(ownerOneToken,"91919191-9191-4191-8191-919191919191");
    const identity = { providerName: "Codex",project: "Relo",threadName: "Release verification",
      providerThreadId: "cli-topic:release-verification" };
    for (const presentation of ["notification","live_activity"] as const) {
      const input = { title: "Review",prompt: "Continue?",type: "approval",presentation,
        deviceIds: [phone.deviceId],context: identity };
      const headers = { "idempotency-key": `grouped-ask-${presentation}` };
      const created = await request("/api/interactions",ownerOneToken,{
        method: "POST",headers,body: JSON.stringify(input),
      });
      expect(created.status).toBe(201);
      const body = await created.json() as any;
      const stored = await db.query<any>(
        `SELECT e.source,e.payload,e.conversation_id,p.display_name AS project,c.display_name AS topic
         FROM notification_events e JOIN resource_projects p ON p.id=e.project_resource_id
         JOIN activity_conversations c ON c.id=e.conversation_id WHERE e.id=$1`,
        [body.eventId.slice(4)],
      );
      expect(stored.rows[0]).toMatchObject({ source: "Codex",project: "Relo",
        topic: "Release verification",payload: { context: identity } });
      if (presentation === "live_activity") {
        const activity = await db.query<any>("SELECT context,conversation_id,presentation FROM live_activities WHERE id=$1",[body.liveActivityId.slice(4)]);
        expect(activity.rows[0].context).toEqual(identity);
        expect(activity.rows[0].conversation_id).toBe(stored.rows[0].conversation_id);
        expect(activity.rows[0].presentation.identity).toMatchObject({ project: { label: "Relo" },thread: { label: "Release verification" },direct: false });
      }
      const replay = await request("/api/interactions",ownerOneToken,{ method: "POST",headers,body: JSON.stringify(input) });
      expect(replay.status).toBe(200);
      const conflict = await request("/api/interactions",ownerOneToken,{ method: "POST",headers,
        body: JSON.stringify({ ...input,context: { ...identity,project: "Other" } }) });
      expect(conflict.status).toBe(409);
    }
  });

  test("interactive Live Activity asks are device-bound, waitable, and preserve presentation fields", async () => {
    const phone = await pair(ownerOneToken,"13131313-1313-4313-8313-131313131313");
    const input = {
      title: "Release decision", prompt: "Deploy the verified candidate?", type: "approval",
      presentation: "live_activity", style: "shell", primaryLabel: "Allow",
      secondaryLabel: "Reject", expiresInSeconds: 300, deviceIds: [phone.deviceId],
    };
    const created = await request("/api/interactions",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "interactive-live-ask-12345678" },
      body: JSON.stringify(input),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    expect(body).toMatchObject({
      interaction: { state: "pending" }, delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 },
      queued: 1, replayed: false,
    });
    expect(body.liveActivityId).toMatch(/^act_/);

    const replay = await request("/api/interactions",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "interactive-live-ask-12345678" },
      body: JSON.stringify(input),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, liveActivityId: body.liveActivityId });

    const inbox = await (await request("/api/inbox/history?limit=100",phone.credential)).json() as any;
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0].liveActivity).toMatchObject({
      activityId: body.liveActivityId, generation: 1, targetDeviceId: phone.deviceId, style: "shell",
      title: "Release decision", subtitle: "Deploy the verified candidate?",
      primaryLabel: "Allow", secondaryLabel: "Reject", alertOwner: "apns",
    });
    const token = await request(
      `/api/devices/self/live-activities/${body.liveActivityId}/token`,phone.credential,{
        method: "PUT", body: JSON.stringify({
          token: "d".repeat(64), nativeActivityId: "native-interactive-ask", environment: "sandbox",
          generation: inbox.items[0].liveActivity.generation,
        }),
      },
    );
    expect(token.status).toBe(200);
    const approved = await request(`/api/notifications/${body.eventId}/interactions`,phone.credential,{
      method: "POST",
      body: JSON.stringify({ kind: "approve", value: {}, idempotencyKey: "interactive-live-approve-12345678" }),
    });
    expect(approved.status).toBe(201);
    const waited = await request(`/api/interactions/${body.interaction.id}/wait?timeoutSeconds=0`,ownerOneToken);
    expect(await waited.json()).toMatchObject({ interaction: { state: "approved" } });

    const stored = await db.query<any>("SELECT * FROM live_activities WHERE id=$1",[
      body.liveActivityId.slice("act_".length),
    ]);
    expect(stored.rows[0]).toMatchObject({ style: "standard", state: "ended", status: "Approved", sequence: "1" });
    expect(stored.rows[0].requester_credential_id).not.toBeNull();
    const terminalInbox = await (await request("/api/inbox/history?limit=100",phone.credential)).json() as any;
    expect(terminalInbox.items
      .map((item: any) => item.liveActivity)
      .sort((left: any,right: any) => left.sequence-right.sequence)
      .map((item: any) => item.operation)).toEqual(["start","end"]);
    const payloads = (await db.query<{ payload: any }>(
      "SELECT payload FROM notification_events WHERE payload ? 'liveActivity' ORDER BY created_at",
    )).rows;
    expect(payloads.every((row) => row.payload.liveActivity.interaction === null)).toBe(true);
    expect(payloads.at(-1)?.payload.liveActivity).toMatchObject({
      operation: "end",status: "Approved",sequence: 1,
      dismissAfterSeconds: 5,alertOwner: "none",interaction: null,
    });
    expect(payloads.at(-1)?.payload.liveActivity).not.toHaveProperty("progress");
    const jobs = await db.query<{ transport: string }>(
      "SELECT transport FROM delivery_jobs ORDER BY created_at",
    );
    expect(jobs.rows.map((row) => row.transport)).toEqual(["live_activity_start","live_activity_update"]);

    const text = await request("/api/interactions",ownerOneToken,{
      method: "POST", body: JSON.stringify({
        title: "Reply", prompt: "Type a reply", type: "text", presentation: "live_activity",
      }),
    });
    expect(text.status).toBe(400);
  });

  test("interactive Live Activity asks fan out to devices and settle exactly once", async () => {
    const first = await pair(ownerOneToken,"15151515-1515-4515-8515-151515151515");
    const second = await pair(ownerOneToken,"16161616-1616-4616-8616-161616161616");
    const created = await request("/api/interactions",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "multi-device-live-ask-12345678" },
      body: JSON.stringify({
        title: "Release decision", prompt: "Ship the candidate?", type: "yes_no",
        presentation: "live_activity", style: "verdict", expiresInSeconds: 300,
        deviceIds: [first.deviceId,second.deviceId],
      }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    expect(body.delivery).toMatchObject({ eligibleDevices: 2, durableCommands: 2, apnsJobs: 2 });
    const [firstInbox,secondInbox] = await Promise.all([
      request("/api/inbox/history?limit=100",first.credential).then((response) => response.json() as Promise<any>),
      request("/api/inbox/history?limit=100",second.credential).then((response) => response.json() as Promise<any>),
    ]);
    expect(firstInbox.items[0].liveActivity.targetDeviceId).toBe(first.deviceId);
    expect(secondInbox.items[0].liveActivity.targetDeviceId).toBe(second.deviceId);
    expect(firstInbox.items[0].interaction.id).toBe(body.interaction.id);
    expect(secondInbox.items[0].interaction.id).toBe(body.interaction.id);

    await Promise.all([first,second].map((phone,index) => request(
      `/api/devices/self/live-activities/${body.liveActivityId}/token`,phone.credential,{
        method: "PUT", body: JSON.stringify({
          token: String(index + 1).repeat(64), nativeActivityId: `native-fanout-${index}`,
          environment: "sandbox", generation: firstInbox.items[0].liveActivity.generation,
        }),
      },
    )));
    const responses = await Promise.all([
      request(`/api/notifications/${body.eventId}/interactions`,first.credential,{
        method: "POST", body: JSON.stringify({ kind: "yes", value: {}, idempotencyKey: "fanout-first-response-12345678" }),
      }),
      request(`/api/notifications/${body.eventId}/interactions`,second.credential,{
        method: "POST", body: JSON.stringify({ kind: "no", value: {}, idempotencyKey: "fanout-second-response-12345678" }),
      }),
    ]);
    expect(responses.map((response) => response.status).sort()).toEqual([201,409]);
    const stored = await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM interactions WHERE interaction_request_id=$1",
      [body.interaction.id.slice("int_".length)],
    );
    expect(stored.rows[0]!.count).toBe(1);
    const terminal = await db.query<any>(
      `SELECT e.delivery_summary,count(t.device_id)::int AS target_count
       FROM notification_events e JOIN notification_event_targets t ON t.notification_event_id=e.id
       WHERE e.payload#>>'{liveActivity,operation}'='end' GROUP BY e.id`,
    );
    expect(terminal.rows).toHaveLength(1);
    expect(terminal.rows[0]).toMatchObject({
      target_count: 2, delivery_summary: { eligibleDevices: 2, durableCommands: 2, apnsJobs: 2 },
    });
  });

  test("ordinary interactions persist appearance fields and Live Activity asks reject them", async () => {
    const phone = await pair(ownerOneToken,"17171717-1717-4717-8717-171717171717");
    const ordinary = await request("/api/interactions",ownerOneToken,{
      method: "POST", body: JSON.stringify({
        title: "Review", prompt: "Open the review?", type: "approval",
        imageUrl: "https://images.example.test/review.png",
        destinationUrl: "https://example.test/reviews/42", deviceIds: [phone.deviceId],
      }),
    });
    expect(ordinary.status).toBe(201);
    const ordinaryBody = await ordinary.json() as any;
    const event = await db.query<any>("SELECT image_url,deep_link FROM notification_events WHERE id=$1",[
      ordinaryBody.eventId.slice("ntf_".length),
    ]);
    expect(event.rows[0]).toEqual({
      image_url: "https://images.example.test/review.png",
      deep_link: "https://example.test/reviews/42",
    });
    const inbox = await (await request("/api/inbox/history?limit=100",phone.credential)).json() as any;
    expect(inbox.items[0]).toMatchObject({
      sourceImageUrl: "https://images.example.test/review.png",
      destinationUrl: "https://example.test/reviews/42",
    });

    for (const field of [
      { imageUrl: "https://images.example.test/review.png" },
      { destinationUrl: "https://example.test/reviews/42" },
    ]) {
      const rejected = await request("/api/interactions",ownerOneToken,{
        method: "POST", body: JSON.stringify({
          title: "Review", prompt: "Continue?", type: "approval", presentation: "live_activity", ...field,
        }),
      });
      expect(rejected.status).toBe(400);
    }
  });

  test("unpolled interactive Live Activities expire through periodic cleanup", async () => {
    const phone = await pair(ownerOneToken,"24242424-2424-4424-8424-242424242424");
    const created = await request("/api/interactions",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "periodic-live-expiry-12345678" },
      body: JSON.stringify({
        title: "Expiring decision", prompt: "Respond in time", type: "yes_no",
        presentation: "live_activity", style: "signal", expiresInSeconds: 30,
        deviceIds: [phone.deviceId],
      }),
    });
    const body = await created.json() as any;
    await db.query(
      `UPDATE interaction_requests SET expires_at=now()-interval '1 second' WHERE id=$1`,
      [body.interaction.id.slice("int_".length)],
    );
    expect(await expireDueInteractiveActivities(db,"sandbox")).toBe(1);
    const interaction = await db.query<{ state: string }>(
      "SELECT state FROM interaction_requests WHERE id=$1",
      [body.interaction.id.slice("int_".length)],
    );
    expect(interaction.rows[0]!.state).toBe("expired");
    const activity = await db.query<{ state: string; status: string }>(
      "SELECT state,status FROM live_activities WHERE id=$1",
      [body.liveActivityId.slice("act_".length)],
    );
    expect(activity.rows[0]).toEqual({ state: "expired", status: "No answer" });
    const terminalInbox = await (await request("/api/inbox/history?limit=100",phone.credential)).json() as any;
    expect(terminalInbox.items
      .map((item: any) => item.liveActivity)
      .sort((left: any,right: any) => left.sequence-right.sequence)
      .map((item: any) => item.operation)).toEqual(["start","end"]);
  });

  test("agent services are owner-scoped and reveal a webhook secret only at creation", async () => {
    const created = await request("/api/services",ownerOneToken,{
      method: "POST",
      body: JSON.stringify({
        title: "Builds",
        imageUrl: "https://example.test/builds.png",
        destinationUrl: "https://example.test/builds",
      }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    expect(body.endpoint).toBe("http://localhost/hooks");
    expect(body.secret).toMatch(/^hook_[A-Za-z0-9_-]{43}$/);
    expect(body.endpoint).not.toContain(body.secret);
    expect(body).not.toHaveProperty("webhookUrl");
    expect(body.service).toMatchObject({
      title: "Builds",
      imageUrl: "https://example.test/builds.png",
      destinationUrl: "https://example.test/builds",
    });
    expect(body.service.prefix).toBe(body.secret.slice(0,13));
    expect(body.service.prefix).not.toBe(body.secret);

    const own = await (await request("/api/services",ownerOneToken)).json() as any;
    const foreign = await (await request("/api/services",ownerTwoToken)).json() as any;
    expect(own.services).toHaveLength(1);
    expect(own.services[0]).not.toHaveProperty("webhookUrl");
    expect(foreign.services).toEqual([]);

    const updated = await request(`/api/services/${body.service.id}`,ownerOneToken,{
      method: "PATCH",
      body: JSON.stringify({ title: "Deploy builds", imageUrl: null }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ service: {
      id: body.service.id, title: "Deploy builds", imageUrl: null,
      destinationUrl: "https://example.test/builds",
    } });
    expect((await request(`/api/services/${body.service.id}`,ownerTwoToken,{
      method: "PATCH", body: JSON.stringify({ title: "Foreign" }),
    })).status).toBe(404);
    const rotated = await request(`/api/services/${body.service.id}/rotate`,ownerOneToken,{
      method: "POST", body: "{}",
    });
    expect(rotated.status).toBe(200);
    const rotatedBody = await rotated.json() as any;
    expect(rotatedBody.endpoint).toBe("http://localhost/hooks");
    expect(rotatedBody.secret).toMatch(/^hook_[A-Za-z0-9_-]{43}$/);
    expect(rotatedBody.secret).not.toBe(body.secret);
    expect((await request(`/api/services/${body.service.id}`,ownerOneToken,{
      method: "DELETE", body: "{}",
    })).status).toBe(200);
    expect((await (await request("/api/services",ownerOneToken)).json() as any).services).toEqual([]);
    // A revoked service stays revoked: rotating it does not bring it back.
    expect((await request(`/api/services/${body.service.id}/rotate`,ownerOneToken,{
      method: "POST", body: "{}",
    })).status).toBe(404);
  });

  test("service webhooks target devices and expose a secret-bound response lifecycle", async () => {
    const phone = await pair(ownerOneToken,"26262626-2626-4262-8262-262626262626");
    const created = await request("/api/services",ownerOneToken,{
      method: "POST",
      body: JSON.stringify({ title: "Deployments" }),
    });
    const service = await created.json() as any;
    const hookPath = "/hooks";
    const secret = service.secret as string;
    const auth = { authorization: `Bearer ${secret}` };
    const requestBody = JSON.stringify({
      title: "Approval needed",
      body: "Continue deployment?",
      url: "https://example.test/deployments/42",
      deviceIds: [phone.deviceId],
      response: { type: "approval", expiresInSeconds: 300, correlationId: "deploy-42" },
    });
    const headers = { "content-type": "application/json", "idempotency-key": "w", ...auth };
    const sent = await createApp(db).request(hookPath,{ method: "POST", headers, body: requestBody });
    expect(sent.status).toBe(201);
    const body = await sent.json() as any;
    expect(body).toMatchObject({
      ok: true,
      queued: 1,
      delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 },
      response: { status: "pending" },
      idempotent: false,
    });
    expect(body).not.toHaveProperty("delivered");

    const replay = await createApp(db).request(hookPath,{ method: "POST", headers, body: requestBody });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, eventId: body.eventId, idempotent: true });
    // The secret may travel in either header; same service, same event.
    const viaHeader = await createApp(db).request("/hooks",{ method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "w", "x-relo-webhook-secret": secret }, body: requestBody });
    expect(viaHeader.status, await viaHeader.clone().text()).toBe(200);
    expect(await viaHeader.json()).toMatchObject({ ok: true, eventId: body.eventId, idempotent: true });
    const wrongHeader = await createApp(db).request("/hooks",{ method: "POST",
      headers: { "content-type": "application/json", "idempotency-key": "w", "x-relo-webhook-secret": `hook_${"A".repeat(43)}` }, body: requestBody });
    expect(wrongHeader.status).toBe(404);
    const conflict = await createApp(db).request(hookPath,{
      method: "POST", headers, body: JSON.stringify({ ...JSON.parse(requestBody), body: "Changed" }),
    });
    expect(conflict.status).toBe(409);

    const resultPath = `${hookPath}/events/${body.eventId}`;
    await db.query(
      "UPDATE delivery_jobs SET state='accepted',accepted_at=now(),updated_at=now() WHERE notification_event_id=$1",
      [body.eventId.slice("ntf_".length)],
    );
    const pending = await createApp(db).request(resultPath,{ headers: auth });
    expect(pending.headers.get("cache-control")).toBe("private, no-store");
    expect(await pending.json()).toMatchObject({ event: {
      delivery: { queued: 0, acceptedByProvider: 1, permanentlyFailed: 0, canceled: 0 },
      response: { status: "pending", correlationId: "deploy-42" },
    } });
    const canceled = await createApp(db).request(`${resultPath}/cancel`,{ method: "POST", headers: auth });
    expect(canceled.status).toBe(200);
    expect(await canceled.json()).toEqual({ ok: true, eventId: body.eventId, status: "canceled" });
    expect(await (await createApp(db).request(resultPath,{ headers: auth })).json()).toMatchObject({
      event: { response: { status: "canceled" } },
    });

    const expiring = await createApp(db).request(hookPath,{
      method: "POST",
      headers: { "content-type": "application/json","idempotency-key": "e", ...auth },
      body: requestBody,
    });
    const expiringBody = await expiring.json() as any;
    await db.query(
      "UPDATE interaction_requests SET expires_at=now()-interval '1 second' WHERE notification_event_id=$1",
      [expiringBody.eventId.slice("ntf_".length)],
    );
    const expired = await createApp(db).request(`${hookPath}/events/${expiringBody.eventId}`,{ headers: auth });
    expect(await expired.json()).toMatchObject({ event: { response: { status: "expired" } } });
  });

  test("interaction lookup is owner-scoped and cancellation is idempotent", async () => {
    const created = await request("/api/interactions",ownerOneToken,{
      method: "POST",
      body: JSON.stringify({ title: "Review", prompt: "Continue?", type: "approval" }),
    });
    const body = await created.json() as any;
    const path = `/api/interactions/${body.interaction.id}`;
    const found = await request(path,ownerOneToken);
    expect(found.status).toBe(200);
    expect(await found.json()).toMatchObject({ interaction: {
      id: body.interaction.id,
      eventId: body.eventId,
      type: "approval",
      prompt: "Continue?",
      state: "pending",
      action: null,
      response: null,
      respondingDevice: null,
    } });
    expect((await request(path,ownerTwoToken)).status).toBe(404);
    const firstCancel = await request(`${path}/cancel`,ownerOneToken,{ method: "POST", body: "{}" });
    const replayCancel = await request(`${path}/cancel`,ownerOneToken,{ method: "POST", body: "{}" });
    expect(firstCancel.status).toBe(200);
    expect(replayCancel.status).toBe(200);
    const canceledBody = await replayCancel.json() as any;
    expect(canceledBody).toMatchObject({ interaction: {
      state: "canceled",action: null,response: null,respondingDevice: null,
    } });
    expect(await (await request(path,ownerOneToken)).json()).toEqual(canceledBody);
    expect(await (await request(`${path}/wait?timeoutSeconds=0`,ownerOneToken)).json()).toEqual(canceledBody);
  });

  test("interaction get and wait return the same canonical winning answer and device; typed replies are refused", async () => {
    const first = await pair(ownerOneToken,"abababab-abab-4bab-8bab-abababababab");
    const second = await pair(ownerOneToken,"cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd");
    await db.query("UPDATE devices SET name='Developer’s iPhone' WHERE id=$1",[
      second.deviceId.slice("dev_".length),
    ]);
    const typed = await request("/api/interactions",ownerOneToken,{
      method: "POST", body: JSON.stringify({ title: "Release notes", prompt: "What changed?", type: "text" }),
    });
    expect(typed.status).toBe(400);
    const created = await request("/api/interactions",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "canonical-yes-no-create-12345678" },
      body: JSON.stringify({
        title: "Release", prompt: "Ship it?", type: "yes_no",
        deviceIds: [first.deviceId,second.deviceId],
      }),
    });
    expect(created.status).toBe(201);
    const body = await created.json() as any;
    const answered = await request(`/api/notifications/${body.eventId}/interactions`,second.credential,{
      method: "POST", body: JSON.stringify({ kind: "yes", idempotencyKey: "canonical-yes-answer-12345678" }),
    });
    expect(answered.status).toBe(201);
    const opposite = await request(`/api/notifications/${body.eventId}/interactions`,first.credential,{
      method: "POST", body: JSON.stringify({ kind: "no", idempotencyKey: "canonical-no-opposite-12345678" }),
    });
    expect(opposite.status).toBe(409);
    const fetched = await request(`/api/interactions/${body.interaction.id}`,ownerOneToken);
    const waited = await request(`/api/interactions/${body.interaction.id}/wait?timeoutSeconds=0`,ownerOneToken);
    expect(fetched.status).toBe(200);
    expect(waited.status).toBe(200);
    const fetchedBody = await fetched.json() as any;
    expect(await waited.json()).toEqual(fetchedBody);
    expect(fetchedBody.interaction).toMatchObject({
      id: body.interaction.id, eventId: body.eventId, type: "yes_no", prompt: "Ship it?",
      state: "yes", action: "yes", respondingDevice: { id: second.deviceId, name: "Developer’s iPhone" },
    });
    expect((await request(`/api/interactions/${body.interaction.id}`,ownerTwoToken)).status).toBe(404);
  });


  test("notifications, interaction reads, cancellation, and idempotency are credential-scoped", async () => {
    await pair(ownerOneToken,"23232323-2323-4323-8323-232323232323");
    const secondToken = "owner_one_interaction_credential_abcdefghijklmnopqrstuvwxyz";
    const owner = await db.query<{ id: string }>(
      "SELECT id FROM owner_principals WHERE handle='owner-one'",
    );
    await db.query(
      `INSERT INTO principal_api_keys(principal_id,label,token_hash)
       VALUES ($1,'interaction-client',$2)`,
      [owner.rows[0]!.id,hashToken(secondToken)],
    );
    const ask = { title: "Credential question", prompt: "Continue?", type: "approval" };
    const headers = { "idempotency-key": "credential-question-12345678" };
    const first = await request("/api/interactions",ownerOneToken,{
      method: "POST",headers,body: JSON.stringify(ask),
    });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as any;
    expect((await request(`/api/interactions/${firstBody.interaction.id}`,secondToken)).status).toBe(404);
    expect((await request(`/api/interactions/${firstBody.interaction.id}/wait?timeoutSeconds=0`,secondToken)).status).toBe(404);
    expect((await request(`/api/interactions/${firstBody.interaction.id}/cancel`,secondToken,{
      method: "POST",body: "{}",
    })).status).toBe(404);

    const second = await request("/api/interactions",secondToken,{
      method: "POST",headers,body: JSON.stringify(ask),
    });
    expect(second.status).toBe(201);
    expect((await second.json() as any).interaction.id).not.toBe(firstBody.interaction.id);
    const replay = await request("/api/interactions",secondToken,{
      method: "POST",headers,body: JSON.stringify(ask),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });

    const notice = { sourceName: "Codex", title: "Credential notice", body: "Complete" };
    const noticeHeaders = { "idempotency-key": "credential-notice-12345678" };
    const firstNotice = await request("/api/notifications",ownerOneToken,{
      method: "POST",headers: noticeHeaders,body: JSON.stringify(notice),
    });
    const secondNotice = await request("/api/notifications",secondToken,{
      method: "POST",headers: noticeHeaders,body: JSON.stringify(notice),
    });
    expect(firstNotice.status).toBe(201);
    expect(secondNotice.status).toBe(201);
    expect((await firstNotice.json() as any).eventId).not.toBe((await secondNotice.json() as any).eventId);
  });

  test("a disconnected phone loses no inbox events and can resynchronize after returning", async () => {
    const phone = await pair(ownerOneToken, "22222222-2222-4222-8222-222222222222", false);
    const sent = await request("/api/notifications", ownerOneToken, {
      method: "POST",
      headers: { "idempotency-key": "offline-12345678" },
      body: JSON.stringify({ sourceName: "Codex", title: "While offline", body: "Persist me" }),
    });
    const sentBody = await sent.json() as any;
    expect(sentBody.queued).toBe(0);
    expect(sentBody.delivery).toMatchObject({ eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 });
    const inbox = await request("/api/inbox/history?limit=100", phone.credential);
    expect(inbox.status).toBe(200);
    const page = await inbox.json() as any;
    expect(page.items).toHaveLength(1);
    expect(page.items[0].title).toBe("While offline");
    expect(page.cursor).toBeNull();
    expect(page.hasMore).toBe(false);
  });

  test("Inbox history retains the newest bounded device-visible window without gaps, duplicates, or tie instability", async () => {
    const first = await pair(ownerOneToken,"20202020-2020-4020-8020-202020202020",false);
    const second = await pair(ownerOneToken,"21212121-2121-4121-8121-212121212121",false);
    const otherAccount = await pair(ownerTwoToken,"23232323-2020-4323-8020-232323232323",false);
    const owner = await db.query<{ principal_id: string }>(
      "SELECT principal_id FROM principal_api_keys WHERE token_hash=$1",
      [hashToken(ownerOneToken)],
    );
    const principalId = owner.rows[0]!.principal_id;
    await db.query(
      `INSERT INTO notification_events(
         principal_id,source,title,body,idempotency_key,created_at,updated_at,target_mode
       )
       SELECT $1,'History',concat('Broadcast ',series),concat('Body ',series),
         concat('history-broadcast-',series),
         timestamptz '2026-01-01T00:00:00Z' + floor((series-1)/3) * interval '1 second',
         timestamptz '2026-01-01T00:00:00Z' + floor((series-1)/3) * interval '1 second',
         'broadcast'
       FROM generate_series(1,2105) AS series`,
      [principalId],
    );
    const addTargeted = async (
      deviceId: string,
      key: string,
      createdAt: string,
      payload: Record<string,unknown> = {},
    ) => {
      const event = await db.query<{ id: string }>(
        `INSERT INTO notification_events(
           principal_id,source,title,body,idempotency_key,payload,created_at,updated_at,target_mode
         ) VALUES ($1,'History',$2,'Targeted',$2,$3,$4,$4,'explicit') RETURNING id`,
        [principalId,key,payload,createdAt],
      );
      await db.query(
        "INSERT INTO notification_event_targets(notification_event_id,device_id) VALUES ($1,$2)",
        [event.rows[0]!.id,deviceId.slice("dev_".length)],
      );
    };
    await addTargeted(first.deviceId,"first-only-1","2026-02-01T00:00:00.000Z",{
      privacy: "private", context: { computer: "Test Mac", project: "History", taskTitle: "Deep page" },
    });
    await addTargeted(first.deviceId,"first-only-2","2026-02-01T00:00:01.000Z");
    await addTargeted(first.deviceId,"first-only-3","2026-02-01T00:00:02.123456Z");
    await addTargeted(first.deviceId,"first-only-4","2026-02-01T00:00:02.123455Z");
    await addTargeted(second.deviceId,"second-only-1","2026-02-02T00:00:00.000Z");
    await addTargeted(second.deviceId,"second-only-2","2026-02-02T00:00:01.000Z");

    const readEveryPage = async (token: string,expectedTotal: number) => {
      const items: any[] = [];
      const cursors = new Set<string>();
      let before: string | undefined;
      for (let pageNumber = 0; pageNumber < 30; pageNumber += 1) {
        const path = `/api/inbox/history?limit=100${before ? `&before=${encodeURIComponent(before)}` : ""}`;
        const response = await request(path,token);
        expect(response.status).toBe(200);
        const page = await response.json() as any;
        expect(page.total).toBe(expectedTotal);
        expect(page.items.length).toBeLessThanOrEqual(100);
        items.push(...page.items);
        if (!page.hasMore) {
          expect(page.cursor).toBeNull();
          break;
        }
        expect(page.cursor).toBeTypeOf("string");
        expect(cursors.has(page.cursor)).toBe(false);
        cursors.add(page.cursor);
        before = page.cursor;
      }
      expect(items).toHaveLength(expectedTotal);
      expect(new Set(items.map((item) => item.id)).size).toBe(expectedTotal);
      for (let index = 1; index < items.length; index += 1) {
        const newer = items[index - 1]!;
        const older = items[index]!;
        const timestampOrder = newer.createdAt.localeCompare(older.createdAt);
        expect(timestampOrder > 0 || (timestampOrder === 0 && newer.id.localeCompare(older.id) > 0)).toBe(true);
      }
      return { items, cursors };
    };

    const firstHistory = await readEveryPage(first.credential,250);
    const secondHistory = await readEveryPage(second.credential,250);
    expect(firstHistory.items.some((item) => item.title === "first-only-1")).toBe(true);
    expect(firstHistory.items.some((item) => item.title === "second-only-1")).toBe(false);
    expect(secondHistory.items.some((item) => item.title === "second-only-1")).toBe(true);
    expect(secondHistory.items.some((item) => item.title === "first-only-1")).toBe(false);
    const emptyOtherAccount = await (await request("/api/inbox/history",otherAccount.credential)).json() as any;
    expect(emptyOtherAccount).toMatchObject({ items: [], total: 0, hasMore: false, cursor: null });
    expect(firstHistory.items.find((item) => item.title === "first-only-1")).toMatchObject({
      privacy: "private",
      context: { computer: "Test Mac", project: "History", taskTitle: "Deep page" },
    });

    const firstPage = await (await request("/api/inbox/history?limit=1",first.credential)).json() as any;
    expect(firstPage.items[0]).toMatchObject({
      title: "first-only-3", createdAt: "2026-02-01T00:00:02.123456Z",
    });
    const decodedCursor = JSON.parse(Buffer.from(firstPage.cursor,"base64url").toString("utf8"));
    expect(decodedCursor).toEqual(["inbox-history-v1",expect.any(String),expect.any(String)]);
    expect(JSON.stringify(decodedCursor)).not.toContain(first.credential);
    expect(JSON.stringify(decodedCursor)).not.toContain(first.deviceId);
    const afterMicrosecondCursor = await request(
      `/api/inbox/history?limit=1&before=${encodeURIComponent(firstPage.cursor)}`,
      first.credential,
    );
    expect(afterMicrosecondCursor.status).toBe(200);
    const adjacentMicrosecond = await afterMicrosecondCursor.json() as any;
    expect(adjacentMicrosecond.items.map((item: any) => item.title)).toEqual(["first-only-4"]);
    expect(adjacentMicrosecond.items[0].createdAt).toBe("2026-02-01T00:00:02.123455Z");
    expect(adjacentMicrosecond.items[0].id).not.toBe(firstPage.items[0].id);
    const afterAdjacentMicrosecond = await request(
      `/api/inbox/history?limit=1&before=${encodeURIComponent(adjacentMicrosecond.cursor)}`,
      first.credential,
    );
    expect(afterAdjacentMicrosecond.status).toBe(200);
    expect((await afterAdjacentMicrosecond.json() as any).items[0].title).toBe("first-only-2");
    const crossDeviceCursor = await request(
      `/api/inbox/history?before=${encodeURIComponent(firstPage.cursor)}`,
      second.credential,
    );
    expect(crossDeviceCursor.status).toBe(410);
    const crossAccountCursor = await request(
      `/api/inbox/history?before=${encodeURIComponent(firstPage.cursor)}`,
      otherAccount.credential,
    );
    expect(crossAccountCursor.status).toBe(410);
  });

  test("Inbox history rejects invalid cursors and limits", async () => {
    const phone = await pair(ownerOneToken,"22222222-2020-4222-8020-222222222222",false);
    const created = await request("/api/notifications",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "history-validation-first" },
      body: JSON.stringify({ sourceName: "History", title: "First", body: "First" }),
    });
    expect(created.status).toBe(201);
    const history = await (await request("/api/inbox/history",phone.credential)).json() as any;
    expect(history.items.map((item: any) => item.title)).toEqual(["First"]);
    const foreignCursor = Buffer.from(JSON.stringify(["2026-08-07T00:00:00.123456Z","bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"]))
      .toString("base64url");
    const fabricated = Buffer.from(JSON.stringify([
      "inbox-history-v1","2026-08-07T00:00:00.000Z","aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    ])).toString("base64url");
    for (const path of [
      "/api/inbox/history?before=not-a-cursor",
      `/api/inbox/history?before=${encodeURIComponent(foreignCursor)}`,
      `/api/inbox/history?before=${encodeURIComponent(fabricated)}`,
    ]) {
      const response = await request(path,phone.credential);
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({ error: "cursor_expired" });
    }
    for (const limit of ["0","101","1.5","x"]) {
      const response = await request(`/api/inbox/history?limit=${limit}`,phone.credential);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "invalid_limit" });
    }
  });

  test("durable targets isolate two device inboxes and let an offline target answer without an APNs job", async () => {
    const offline = await pair(ownerOneToken,"23232323-2323-4232-8232-232323232323",false);
    const other = await pair(ownerOneToken,"24242424-2424-4242-8242-242424242424",true);
    const targeted = await request("/api/notifications",ownerOneToken,{
      method: "POST",
      headers: { "idempotency-key": "offline-target-notification-12345678" },
      body: JSON.stringify({
        sourceName: "Codex", title: "Only offline", body: "Durable target",
        deviceIds: [offline.deviceId],
      }),
    });
    expect((await targeted.json() as any).delivery).toMatchObject({ eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 });
    expect((await (await request("/api/inbox/history?limit=100",offline.credential)).json() as any).items).toHaveLength(1);
    expect((await (await request("/api/inbox/history?limit=100",other.credential)).json() as any).items).toHaveLength(0);

    const broadcast = await request("/api/notifications",ownerOneToken,{
      method: "POST",
      headers: { "idempotency-key": "broadcast-notification-12345678" },
      body: JSON.stringify({
        sourceName: "Codex", title: "Everyone", body: "Broadcast",
      }),
    });
    expect((await broadcast.json() as any).delivery).toMatchObject({ eligibleDevices: 2, durableCommands: 1, apnsJobs: 1 });
    expect((await (await request("/api/inbox/history?limit=100",offline.credential)).json() as any).items).toHaveLength(2);
    expect((await (await request("/api/inbox/history?limit=100",other.credential)).json() as any).items).toHaveLength(1);

    const interaction = await request("/api/interactions",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "offline-target-interaction-12345678" },
      body: JSON.stringify({
        title: "Offline approval", prompt: "Continue?", type: "approval", deviceIds: [offline.deviceId],
      }),
    });
    const interactionBody = await interaction.json() as any;
    expect(interactionBody.delivery).toMatchObject({ eligibleDevices: 1, durableCommands: 1, apnsJobs: 0 });
    const otherInbox = await (await request("/api/inbox/history?limit=100",other.credential)).json() as any;
    expect(otherInbox.items.some((item: any) => item.id === interactionBody.eventId)).toBe(false);
    const answered = await request(`/api/notifications/${interactionBody.eventId}/interactions`,offline.credential,{
      method: "POST",
      body: JSON.stringify({ kind: "approve", value: {}, idempotencyKey: "offline-answer-12345678" }),
    });
    expect(answered.status).toBe(201);
  });

  test("inbox exposes pending interaction details and a device response updates them", async () => {
    const phone = await pair(ownerOneToken, "77777777-7777-4777-8777-777777777777");
    const created = await request("/api/interactions", ownerOneToken, {
      method: "POST",
      headers: { "idempotency-key": "approval-detail-12345678" },
      body: JSON.stringify({ title: "Approval needed", prompt: "Deploy to Relo server?", type: "approval" }),
    });
    expect(created.status).toBe(201);
    const eventId = (await created.json() as any).eventId;

    const pending = await (await request("/api/inbox/history?limit=100", phone.credential)).json() as any;
    expect(pending.items[0].interaction).toMatchObject({
      kind: "approval", prompt: "Deploy to Relo server?", state: "pending",
    });

    const response = await request(`/api/notifications/${eventId}/interactions`, phone.credential, {
      method: "POST",
      body: JSON.stringify({ kind: "approve", value: {}, idempotencyKey: "ios-approval-detail-12345678" }),
    });
    expect(response.status).toBe(201);
    const answered = await (await request("/api/inbox/history?limit=100", phone.credential)).json() as any;
    expect(answered.items[0].interaction.state).toBe("approved");
    expect(answered.items[0].result).toBe("responded");
  });

  test("multiple independent questions retain and return their own authenticated answers", async () => {
    const phone = await pair(ownerOneToken, "88888888-8888-4888-8888-888888888888");
    const created = [];
    for (const [index, prompt] of ["Run tests?", "Create a backup?"].entries()) {
      const response = await request("/api/interactions", ownerOneToken, {
        method: "POST",
        headers: { "idempotency-key": `multi-question-${index}-12345678` },
        body: JSON.stringify({ title: `Question ${index + 1}`, prompt, type: "yes_no" }),
      });
      expect(response.status).toBe(201);
      created.push(await response.json() as any);
    }

    for (const [index, value] of ["yes", "no"].entries()) {
      const answered = await request(
        `/api/notifications/${created[index].eventId}/interactions`,
        phone.credential,
        {
          method: "POST",
          body: JSON.stringify({
            kind: value,
            value: {},
            idempotencyKey: `multi-answer-${index}-12345678`,
          }),
        },
      );
      expect(answered.status).toBe(201);
    }

    const first = await request(`/api/interactions/${created[0].interaction.id}/wait?timeout=0`, ownerOneToken);
    const second = await request(`/api/interactions/${created[1].interaction.id}/wait?timeout=0`, ownerOneToken);
    expect((await first.json() as any).interaction.state).toBe("yes");
    expect((await second.json() as any).interaction.state).toBe("no");
  });

  test("owner and device credentials cannot read another owner's history", async () => {
    const phoneOne = await pair(ownerOneToken, "33333333-3333-4333-8333-333333333333");
    const phoneTwo = await pair(ownerTwoToken, "44444444-4444-4444-8444-444444444444");
    await request("/api/notifications", ownerOneToken, {
      method: "POST",
      headers: { "idempotency-key": "private-12345678" },
      body: JSON.stringify({ sourceName: "Private", title: "Owner one", body: "Secret" }),
    });
    expect((await (await request("/api/inbox/history?limit=100", phoneOne.credential)).json() as any).items).toHaveLength(1);
    expect((await (await request("/api/inbox/history?limit=100", phoneTwo.credential)).json() as any).items).toHaveLength(0);
  });

  test("device credentials cannot send notifications", async () => {
    const phone = await pair(ownerOneToken, "55555555-5555-4555-8555-555555555555");
    const forbidden = await request("/api/notifications", phone.credential, {
      method: "POST",
      headers: { "idempotency-key": "forbid-12345678" },
      body: JSON.stringify({ sourceName: "Phone", title: "No", body: "No" }),
    });
    expect(forbidden.status).toBe(403);
  });

  test("live activity start, update, read, list, and end persist a monotonic lifecycle", async () => {
    const phone = await pair(ownerOneToken, "99999999-9999-4999-8999-999999999999");
    const startBody = JSON.stringify({ key: "build-42", title: "Building", status: "Starting", progress: 0.1,
      context: { computer: "MacBook", account: "work", project: "Relo", threadName: "Build", taskTitle: "Build 42" } });
    const started = await request("/api/live-activities", ownerOneToken, {
      method: "POST", headers: { "idempotency-key": "activity-start-12345678" },
      body: startBody,
    });
    expect(started.status).toBe(201);
    const startedBody = await started.json() as any;
    const activityId = startedBody.activity.id;
    expect(startedBody.queued).toBe(1);
    expect(startedBody.activity.context).toMatchObject({ computer: "MacBook", account: "work" });
    const snapshotBody = await (await request("/api/inbox/snapshot", phone.credential)).json() as any;
    expect(snapshotBody.items.some((item: any) => item.context?.computer === "MacBook" && item.context?.account === "work")).toBe(true);
    expect(startedBody.delivery).toMatchObject({ eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 });
    const startReplay = await request("/api/live-activities", ownerOneToken, {
      method: "POST", headers: { "idempotency-key": "activity-start-12345678" }, body: startBody,
    });
    expect(await startReplay.json()).toMatchObject({ replayed: true, delivery: startedBody.delivery });
    const staleToken = await request(
      `/api/devices/self/live-activities/${activityId}/token`,
      phone.credential,
      {
        method: "PUT",
        body: JSON.stringify({
          token: "b".repeat(64), nativeActivityId: "native-build-42-stale", environment: "sandbox",
          generation: startedBody.activity.generation + 1,
        }),
      },
    );
    expect(staleToken.status).toBe(409);
    expect(await staleToken.json()).toEqual({
      error: "activity_generation_mismatch", code: "ACTIVITY_GENERATION_MISMATCH",
      generation: startedBody.activity.generation,
    });
    expect((await db.query("SELECT 1 FROM live_activity_update_tokens")).rowCount).toBe(0);
    const registeredToken = await request(
      `/api/devices/self/live-activities/${activityId}/token`,
      phone.credential,
      {
        method: "PUT",
        body: JSON.stringify({
          token: "c".repeat(64), nativeActivityId: "native-build-42", environment: "sandbox",
          generation: startedBody.activity.generation,
        }),
      },
    );
    expect(registeredToken.status).toBe(200);
    expect(await registeredToken.json()).toEqual({
      activityId, generation: startedBody.activity.generation, status: "registered",
    });
    const updateBody = JSON.stringify({ status: "Running", progress: 0.5, ifSequence: 0 });
    const updated = await request(`/api/live-activities/${activityId}`, ownerOneToken, {
      method: "PATCH", headers: { "idempotency-key": "activity-update-12345678" },
      body: updateBody,
    });
    const updatedBody = await updated.json() as any;
    expect(updatedBody.activity.sequence).toBe(1);
    expect(updatedBody.delivery).toMatchObject({ eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 });
    const activeRecovery = await request("/api/inbox/live-activities/active", phone.credential);
    expect(activeRecovery.status).toBe(200);
    expect(await activeRecovery.json()).toMatchObject({ activities: [{
      id: activityId,
      generation: startedBody.activity.generation,
      eventId: expect.stringMatching(/^ntf_/),
      createdAt: expect.any(String),
      command: {
        operation: "update",
        activityId,
        generation: startedBody.activity.generation,
        targetDeviceId: phone.deviceId,
        sequence: 1,
      },
    }] });
    const updateReplay = await request(`/api/live-activities/${activityId}`, ownerOneToken, {
      method: "PATCH", headers: { "idempotency-key": "activity-update-12345678" }, body: updateBody,
    });
    expect(await updateReplay.json()).toMatchObject({ replayed: true, activity: { sequence: 1 }, delivery: updatedBody.delivery });
    const changedUpdate = await request(`/api/live-activities/${activityId}`, ownerOneToken, {
      method: "PATCH", headers: { "idempotency-key": "activity-update-12345678" },
      body: JSON.stringify({ status: "Changed", ifSequence: 1 }),
    });
    expect(changedUpdate.status).toBe(409);
    const appearanceUpdate = await request(`/api/live-activities/${activityId}`, ownerOneToken, {
      method: "PATCH", headers: { "idempotency-key": "activity-appearance-update-12345678" },
      body: JSON.stringify({ symbol: "success", ifSequence: 1 }),
    });
    expect(appearanceUpdate.status).toBe(200);
    // A topic owns the activity identity, so a later appearance update keeps the started symbol.
    expect(await appearanceUpdate.json()).toMatchObject({
      activity: {
        sequence: 2,title: "Building",status: "Running",progress: 0.5,symbol: "build",
      },
    });
    const fetched = await request(`/api/live-activities/${activityId}`, ownerOneToken);
    expect((await fetched.json() as any).activity.status).toBe("Running");
    const listed = await request("/api/live-activities", ownerOneToken);
    expect((await listed.json() as any).activities).toHaveLength(1);
    const ended = await request(`/api/live-activities/${activityId}/end`, ownerOneToken, {
      method: "POST", headers: { "idempotency-key": "activity-end-12345678" },
      body: JSON.stringify({ status: "Done" }),
    });
    const endedBody = await ended.json() as any;
    expect(endedBody.activity.state).toBe("ended");
    expect(endedBody.delivery).toMatchObject({ eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 });
    const endReplay = await request(`/api/live-activities/${activityId}/end`, ownerOneToken, {
      method: "POST", headers: { "idempotency-key": "activity-end-12345678" },
      body: JSON.stringify({ status: "Done" }),
    });
    expect(await endReplay.json()).toMatchObject({ replayed: true, activity: { sequence: 3 }, delivery: endedBody.delivery });
    const commands = (await db.query<any>(
      `SELECT payload#>'{liveActivity}' AS command FROM notification_events
       WHERE kind='live_activity' ORDER BY created_at`,
    )).rows.map((row) => row.command);
    expect(commands.map((command) => command.operation)).toEqual(["start", "update", "update", "end"]);
    expect(commands.map((command) => command.sequence)).toEqual([0, 1, 2, 3]);
    expect(new Set(commands.map((command) => command.startedAt)).size).toBe(1);
    expect(Number.isSafeInteger(commands[0].startedAt)).toBe(true);
    expect(commands.map((command) => command.alertOwner)).toEqual(["apns","none","none","none"]);
    expect(new Set(commands.map((command) => command.activityId))).toEqual(new Set([activityId]));
    expect(commands.every((command) => command.targetDeviceId === phone.deviceId)).toBe(true);
    const transports = (await db.query<{ transport: string }>(
      "SELECT transport FROM delivery_jobs ORDER BY created_at",
    )).rows.map((row) => row.transport);
    expect(transports).toEqual([
      "live_activity_start","live_activity_update","live_activity_update","live_activity_update",
    ]);
  });

  test("a device dismissal hides only its presentation and leaves the logical activity active", async () => {
    const phone = await pair(ownerOneToken,"91919191-9191-4191-8191-919191919191",true);
    const foreignPhone = await pair(ownerTwoToken,"92929292-9292-4292-8292-929292929292",true);
    const started = await request("/api/live-activities",ownerOneToken,{
      method: "POST",headers: { "idempotency-key": "dismissed-activity-start-12345678" },
      body: JSON.stringify({ title: "Dismiss me",status: "Running",deviceIds: [phone.deviceId] }),
    });
    const startedBody = await started.json() as any;
    const activityId = startedBody.activity.id;
    const token = await request(`/api/devices/self/live-activities/${activityId}/token`,phone.credential,{
      method: "PUT",
      body: JSON.stringify({
        token: "d".repeat(64),nativeActivityId: "native-dismissed",environment: "sandbox",
        generation: startedBody.activity.generation,
      }),
    });
    expect(token.status).toBe(200);

    const dismissed = await request(
      `/api/devices/self/live-activities/${activityId}/dismissed`,phone.credential,{ method: "POST" },
    );
    expect(dismissed.status).toBe(200);
    expect(await dismissed.json()).toEqual({ activityId,status: "dismissed",changed: true });
    expect((await db.query<any>(
      "SELECT state,ended_at,terminal_reason FROM live_activities WHERE id=$1",
      [activityId.slice("act_".length)],
    )).rows[0]).toMatchObject({ state: "active",ended_at: null,terminal_reason: null });
    expect((await db.query<any>(
      `SELECT state,reason FROM live_activity_presentation_leases
       WHERE live_activity_id=$1 AND device_id=$2`,
      [activityId.slice("act_".length),phone.deviceId.slice("dev_".length)],
    )).rows[0]).toEqual({ state: "not_presented",reason: "device_dismissed" });
    expect((await db.query(
      "SELECT 1 FROM live_activity_update_tokens WHERE live_activity_id=$1",
      [activityId.slice("act_".length)],
    )).rowCount).toBe(0);
    const replay = await request(
      `/api/devices/self/live-activities/${activityId}/dismissed`,phone.credential,{ method: "POST" },
    );
    expect(await replay.json()).toEqual({ activityId,status: "dismissed",changed: false });
    const revived = await request(`/api/live-activities/${activityId}`,ownerOneToken,{
      method: "PATCH",body: JSON.stringify({ status: "Show again" }),
    });
    expect(revived.status).toBe(200);
    expect(await revived.json()).toMatchObject({
      activity: { state: "active",status: "Show again" },
      delivery: { eligibleDevices: 1,durableCommands: 1,apnsJobs: 1 },
    });
    expect((await db.query<{ transport: string }>(
      `SELECT j.transport FROM delivery_jobs j
       JOIN notification_events e ON e.id=j.notification_event_id
       WHERE e.payload#>>'{liveActivity,activityId}'=$1 ORDER BY j.created_at`,
      [activityId],
    )).rows.map((row) => row.transport)).toEqual(["live_activity_start","live_activity_start"]);

    expect((await request(
      `/api/devices/self/live-activities/${activityId}/dismissed`,foreignPhone.credential,{ method: "POST" },
    )).status).toBe(404);
  });

  test("the current presentation persists canonical hashes and emits the flat per-device wire",async () => {
    const phone = await pair(ownerOneToken,"70707070-7070-4070-8070-707070707070");
    const heartbeat = await request(`/api/devices/${phone.deviceId}`,phone.credential,{
      method: "PUT",body: JSON.stringify({
        liveActivityAuthorization: "authorized",
      }),
    });
    expect(heartbeat.status).toBe(200);
    const presentation = {
            content: { header: "Relo",title: "Release",subtitle: "Backend",status: "Building" },
      identity: { project: null,thread: null,direct: true },
      state: { kind: "active",tone: "live",icon: "active" },
      components: [{ id: "progress",type: "progress_bar",colorRole: "state",value: 0.25,label: "25%" }],
      surfaces: { lock_screen: ["progress"],expanded_leading: [],expanded_trailing: ["progress"],
        expanded_bottom: ["progress"],compact_leading: [],compact_trailing: ["progress"],minimal: ["progress"] },
      behavior: { type: "progress" },
      appearance: { theme: "dark",roles: {
        cardIdentity: "state",componentIdentity: "state",statusEmphasis: "state",
      } },
      privacy: "standard",
    };
    const started = await request("/api/live-activities",ownerOneToken,{
      method: "POST",headers: { "idempotency-key": "presentation-current-start-12345678" },
      body: JSON.stringify({ key: "presentation-current",deviceIds: [phone.deviceId],presentation,
        context: { project: "Release",threadName: "Deploys" } }),
    });
    expect(started.status).toBe(201);
    const startBody = await started.json() as any;
    expect(startBody.delivery).toMatchObject({ eligibleDevices: 1,durableCommands: 1,apnsJobs: 1 });
    // Required project/topic context owns the identity; every other supplied field persists as sent.
    const persisted = { ...presentation,identity: expect.objectContaining({ direct: false,
      project: expect.objectContaining({ label: "Release" }),thread: expect.objectContaining({ label: "Deploys" }) }) };
    expect(startBody.activity).toMatchObject({ presentation: persisted,
      presentationHash: expect.stringMatching(/^[a-f0-9]{64}$/) });
    const stored = (await db.query<any>(
      "SELECT presentation,presentation_sha256 FROM live_activities WHERE id=$1",
      [startBody.activity.id.slice(4)],
    )).rows[0];
    expect(stored.presentation).toEqual(persisted);
    expect(stored.presentation_sha256).toBe(startBody.activity.presentationHash);
    const firstPayload = (await db.query<any>(
      `SELECT payload FROM notification_events
       WHERE payload#>>'{liveActivity,activityId}'=$1 ORDER BY created_at,id LIMIT 1`,
      [startBody.activity.id],
    )).rows[0].payload;
    expect(firstPayload).not.toHaveProperty("presentationDelivery");
    expect(firstPayload.liveActivity).toMatchObject({
      title: "Release",behaviorType: "progress",
    });
    expect(firstPayload.liveActivity).not.toHaveProperty("presentation");

    const replacement = {
      ...presentation,
      content: { ...presentation.content,subtitle: "Backend + iOS",status: "Verifying" },
      components: [{ id: "steps",type: "steps",colorRole: "state",items: [
        { id: "build",label: "Build",state: "complete" },
        { id: "verify",label: "Verify",state: "current" },
      ] }],
      surfaces: { ...presentation.surfaces,lock_screen: ["steps"],expanded_trailing: [],
        expanded_bottom: ["steps"],compact_trailing: [],minimal: ["steps"] },
    };
    const updated = await request(`/api/live-activities/${startBody.activity.id}`,ownerOneToken,{
      method: "PATCH",headers: { "idempotency-key": "presentation-current-update-12345678" },
      body: JSON.stringify({ ifSequence: 0,presentation: replacement }),
    });
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({
      activity: { sequence: 1,presentation: replacement,presentationHash: expect.any(String) },
      replayed: false,
    });
    const partial = await request(`/api/live-activities/${startBody.activity.id}`,ownerOneToken,{
      method: "PATCH",body: JSON.stringify({ presentation: {
        content: { title: "Partial" },
      } }),
    });
    expect(partial.status).toBe(400);
    const snapshots = await db.query<any>(
      `SELECT presentation_snapshot,presentation_snapshot_sha256
       FROM live_activity_operations WHERE live_activity_id=$1 ORDER BY created_at`,
      [startBody.activity.id.slice(4)],
    );
    expect(snapshots.rows.at(-1)).toMatchObject({
      presentation_snapshot: replacement,
      presentation_snapshot_sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
  });

  test("credential-owned activity wait attaches idempotent input to one exact parent ID", async () => {
    const phone = await pair(ownerOneToken,"91919191-9191-4919-8919-919191919191",true);
    const started = await request("/api/live-activities",ownerOneToken,{
      method: "POST",headers: { "idempotency-key": "attached-wait-start-12345678" },
      body: JSON.stringify({
        title: "Deploy",status: "Running",deviceIds: [phone.deviceId],
        origin: { sourceInstance: "codex:test",project: "Relo",thread: "wait-origin",channel: "task-progress" },
      }),
    });
    const parentActivityId = (await started.json() as any).activity.id;
    const waitBody = JSON.stringify({ type: "approval",prompt: "Approve production?" });
    const attached = await request(`/api/live-activities/${parentActivityId}/wait`,ownerOneToken,{
      method: "POST",headers: { "idempotency-key": "attached-wait-12345678" },body: waitBody,
    });
    expect(attached.status).toBe(201);
    const attachedBody = await attached.json() as any;
    expect(attachedBody).toMatchObject({
      parentActivityId,companionActivityId: null,
      interaction: { id: expect.stringMatching(/^int_/),eventId: expect.stringMatching(/^ntf_/),
        type: "approval",state: "pending",prompt: "Approve production?" },
      eventId: expect.stringMatching(/^ntf_/),delivery: { eligibleDevices: 1,durableCommands: 1,apnsJobs: 1 },
      queued: 1,deliveryMode: "queued_for_direct_apns",replayed: false,
    });
    const replay = await request(`/api/live-activities/${parentActivityId}/wait`,ownerOneToken,{
      method: "POST",headers: { "idempotency-key": "attached-wait-12345678" },body: waitBody,
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      replayed: true,parentActivityId,companionActivityId: attachedBody.companionActivityId,
      eventId: attachedBody.eventId,interaction: { id: attachedBody.interaction.id },
    });
    const changed = await request(`/api/live-activities/${parentActivityId}/wait`,ownerOneToken,{
      method: "POST",headers: { "idempotency-key": "attached-wait-12345678" },
      body: JSON.stringify({ type: "approval",prompt: "Changed" }),
    });
    expect(changed.status).toBe(409);
    expect((await request(`/api/live-activities/${parentActivityId}/wait`,phone.credential,{
      method: "POST",headers: { "idempotency-key": "device-wait-12345678" },body: waitBody,
    })).status).toBe(403);
    expect((await request(`/api/live-activities/${parentActivityId}/wait`,ownerTwoToken,{
      method: "POST",headers: { "idempotency-key": "foreign-wait-12345678" },body: waitBody,
    })).status).toBe(404);
    expect((await request("/api/live-activities/not-an-id/wait",ownerOneToken,{
      method: "POST",headers: { "idempotency-key": "invalid-wait-12345678" },body: waitBody,
    })).status).toBe(404);

    const typed = await request(`/api/live-activities/${parentActivityId}/wait`,ownerOneToken,{
      method: "POST",headers: { "idempotency-key": "attached-text-wait-12345678" },
      body: JSON.stringify({ type: "text",prompt: "Deployment note?" }),
    });
    expect(typed.status).toBe(400);
    const linkedEvents = await db.query<{ origin_hash: string | null }>(
      "SELECT e.origin_hash FROM notification_events e WHERE e.id=$1",
      [attachedBody.eventId.slice("ntf_".length)],
    );
    const parentOrigin = (await db.query<{ origin_hash: string }>(
      "SELECT origin_hash FROM live_activities WHERE id=$1",
      [parentActivityId.slice("act_".length)],
    )).rows[0]!.origin_hash;
    expect(linkedEvents.rows).toEqual([{ origin_hash: parentOrigin }]);
  });

  test("task activities and idempotency are isolated between credentials for one owner", async () => {
    const phone = await pair(ownerOneToken, "14141414-1414-4414-8414-141414141414");
    const secondToken = "owner_one_second_credential_abcdefghijklmnopqrstuvwxyz";
    const owner = await db.query<{ id: string }>(
      "SELECT id FROM owner_principals WHERE handle='owner-one'",
    );
    await db.query(
      `INSERT INTO principal_api_keys(principal_id,label,token_hash)
       VALUES ($1,'second-client',$2)`,
      [owner.rows[0]!.id,hashToken(secondToken)],
    );

    const body = JSON.stringify({
      key: "credential-isolation", title: "Credential-owned task", status: "Starting", deviceIds: [phone.deviceId],
    });
    const headers = { "idempotency-key": "credential-isolation-start-12345678" };
    const first = await request("/api/live-activities",ownerOneToken,{ method: "POST",headers,body });
    expect(first.status).toBe(201);
    const firstActivityId = (await first.json() as any).activity.id;

    expect((await request("/api/live-activities",secondToken)).status).toBe(200);
    expect((await (await request("/api/live-activities",secondToken)).json() as any).activities).toHaveLength(0);
    expect((await request(`/api/live-activities/${firstActivityId}`,secondToken)).status).toBe(404);
    expect((await request(`/api/live-activities/${firstActivityId}`,secondToken,{
      method: "PATCH", body: JSON.stringify({ status: "Forbidden" }),
    })).status).toBe(404);
    expect((await request(`/api/live-activities/${firstActivityId}/end`,secondToken,{
      method: "POST", body: JSON.stringify({ status: "Forbidden" }),
    })).status).toBe(404);

    const ended = await request(`/api/live-activities/${firstActivityId}/end`,ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "credential-isolation-end-12345678" },
      body: JSON.stringify({ status: "Done" }),
    });
    expect(ended.status).toBe(200);

    const second = await request("/api/live-activities",secondToken,{ method: "POST",headers,body });
    expect(second.status).toBe(201);
    const secondBody = await second.json() as any;
    expect(secondBody.activity.id).not.toBe(firstActivityId);
    const replay = await request("/api/live-activities",secondToken,{ method: "POST",headers,body });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true, activity: { id: secondBody.activity.id } });

    const firstList = await (await request("/api/live-activities",ownerOneToken)).json() as any;
    const secondList = await (await request("/api/live-activities",secondToken)).json() as any;
    expect(firstList.activities.map((activity: any) => activity.id)).toEqual([firstActivityId]);
    expect(secondList.activities.map((activity: any) => activity.id)).toEqual([secondBody.activity.id]);
  });

  test("activity start selects exactly one alert owner from current APNs deliverability", async () => {
    const enabled = await pair(ownerOneToken,"15151515-1515-4515-8515-151515151515",true);
    const disabled = await pair(ownerOneToken,"16161616-1616-4616-8616-161616161616",true);
    const noToken = await pair(ownerOneToken,"17171717-1717-4717-8717-171717171717",false);
    const cases = [
      { key: "enabled-token", deviceId: enabled.deviceId, mode: "sandbox" as const, owner: "apns", jobs: 1 },
      { key: "disabled-token", deviceId: disabled.deviceId, mode: "disabled" as const, owner: "app", jobs: 0 },
      { key: "enabled-no-token", deviceId: noToken.deviceId, mode: "sandbox" as const, owner: "app", jobs: 0 },
    ];
    for (const item of cases) {
      const response = await request("/api/live-activities",ownerOneToken,{
        method: "POST", headers: { "idempotency-key": `alert-owner-${item.key}-12345678` },
        body: JSON.stringify({
          key: `alert-owner-${item.key}`, title: item.key, status: "Starting", deviceIds: [item.deviceId],
        }),
      },item.mode);
      expect(response.status).toBe(201);
      expect((await response.json() as any).delivery.apnsJobs).toBe(item.jobs);
      const event = await db.query<{ owner: string; jobs: number }>(
        `SELECT e.payload#>>'{liveActivity,alertOwner}' AS owner,
           (SELECT count(*)::int FROM delivery_jobs j WHERE j.notification_event_id=e.id) AS jobs
         FROM notification_events e WHERE e.title=$1`,
        [item.key],
      );
      expect(event.rows[0]).toEqual({ owner: item.owner, jobs: item.jobs });
    }
  });

  test("an invalid or unowned activity target is rejected without broadcasting", async () => {
    await pair(ownerOneToken, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    const response = await request("/api/live-activities", ownerOneToken, {
      method: "POST", headers: { "idempotency-key": "activity-invalid-device-12345678" },
      body: JSON.stringify({
        key: "invalid-target", title: "Do not broadcast", status: "Starting",
        deviceIds: ["dev_00000000-0000-4000-8000-000000000000"],
      }),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "invalid_device_selection" });
    expect((await db.query("SELECT count(*)::int AS count FROM live_activities")).rows[0].count).toBe(0);
    expect((await db.query("SELECT count(*)::int AS count FROM notification_events")).rows[0].count).toBe(0);
  });

  test.each(["disabled","sandbox"] as const)(
    "two-device lifecycle preserves durable Inbox commands in %s mode", async (apnsMode) => {
    const expectedApnsJobs = apnsMode === "disabled" ? 0 : 1;
    const online = await pair(ownerOneToken,"abababab-abab-4bab-8bab-abababababab",true);
    const offline = await pair(ownerOneToken,"cdcdcdcd-cdcd-4dcd-8dcd-cdcdcdcdcdcd",false);
    const startBody = JSON.stringify({
      key: "two-device-build", title: "Build", status: "Starting", progress: 0,
      deviceIds: [online.deviceId,offline.deviceId],
    });
    const started = await request("/api/live-activities",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "two-device-start-12345678" }, body: startBody,
    },apnsMode);
    const startedBody = await started.json() as any;
    expect(startedBody.delivery).toMatchObject({ eligibleDevices: 2, durableCommands: 2, apnsJobs: expectedApnsJobs });
    const activityId = startedBody.activity.id;

    await db.query("UPDATE devices SET live_activity_authorization='denied' WHERE id=$1",[
      offline.deviceId.slice("dev_".length),
    ]);
    const updateBody = JSON.stringify({ status: "Running", progress: 0.5, ifSequence: 0 });
    const updated = await request(`/api/live-activities/${activityId}`,ownerOneToken,{
      method: "PATCH", headers: { "idempotency-key": "two-device-update-12345678" }, body: updateBody,
    },apnsMode);
    expect((await updated.json() as any).delivery).toMatchObject({ eligibleDevices: 2, durableCommands: 2, apnsJobs: expectedApnsJobs });
    const endBody = JSON.stringify({ status: "Done", dismissAfterSeconds: 10 });
    const ended = await request(`/api/live-activities/${activityId}/end`,ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "two-device-end-12345678" }, body: endBody,
    },apnsMode);
    expect((await ended.json() as any).delivery).toMatchObject({ eligibleDevices: 2, durableCommands: 2, apnsJobs: expectedApnsJobs });

    const replayedStart = await request("/api/live-activities",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "two-device-start-12345678" }, body: startBody,
    },apnsMode);
    expect(await replayedStart.json()).toMatchObject({ replayed: true, activity: { sequence: 0, state: "active", status: "Starting" } });
    const replayedUpdate = await request(`/api/live-activities/${activityId}`,ownerOneToken,{
      method: "PATCH", headers: { "idempotency-key": "two-device-update-12345678" }, body: updateBody,
    },apnsMode);
    expect(await replayedUpdate.json()).toMatchObject({ replayed: true, activity: { sequence: 1, state: "active", status: "Running" } });
    const replayedEnd = await request(`/api/live-activities/${activityId}/end`,ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "two-device-end-12345678" }, body: endBody,
    },apnsMode);
    expect(await replayedEnd.json()).toMatchObject({ replayed: true, activity: { sequence: 2, state: "ended", status: "Done" } });

    for (const phone of [online,offline]) {
      const inbox = await (await request("/api/inbox/history?limit=20",phone.credential,undefined,apnsMode)).json() as any;
      // History is newest first; the lifecycle reads oldest first.
      const commands = inbox.items.filter((item: any) => item.liveActivity?.activityId === activityId).reverse();
      expect(commands.map((item: any) => item.liveActivity.operation)).toEqual(["start","update","end"]);
      expect(commands.map((item: any) => item.liveActivity.generation)).toEqual([
        startedBody.activity.generation,startedBody.activity.generation,startedBody.activity.generation,
      ]);
      expect(commands.map((item: any) => item.liveActivity.providerTimestamp)).toEqual([
        expect.any(Number),expect.any(Number),expect.any(Number),
      ]);
      expect(commands.every((item: any) => item.liveActivity.targetDeviceId === phone.deviceId)).toBe(true);
    }
    expect((await db.query("SELECT count(*)::int AS count FROM notification_event_targets")).rows[0].count).toBe(6);
    expect((await db.query("SELECT count(*)::int AS count FROM delivery_jobs")).rows[0].count)
      .toBe(apnsMode === "disabled" ? 0 : 3);
  });

  test("task activity starts serialize per target, replace blockers, and allow terminal key reuse", async () => {
    const firstPhone = await pair(ownerOneToken,"18181818-1818-4818-8818-181818181818",true);
    const secondPhone = await pair(ownerOneToken,"19191919-1919-4919-8919-191919191919",true);
    const start = (suffix: string, deviceId: string, extras: Record<string,unknown> = {}) => request(
      "/api/live-activities",ownerOneToken,{
        method: "POST", headers: { "idempotency-key": `serialized-start-${suffix}-12345678` },
        body: JSON.stringify({ key: "deploy", title: "Deploy", status: "Starting", deviceIds: [deviceId], ...extras }),
      },
    );

    const raced = await Promise.all([
      start("race-one",firstPhone.deviceId),
      start("race-two",firstPhone.deviceId),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201,409]);

    const independent = await start("other-device",secondPhone.deviceId,{ key: "other" });
    expect(independent.status).toBe(201);
    const replaced = await start("replace",firstPhone.deviceId,{
      replace: true, symbol: "build", style: "standard",
      accentColor: "#64D2FF", expiresInSeconds: 600, staleAfterSeconds: 120,
    });
    expect(replaced.status).toBe(201);
    const replacedBody = await replaced.json() as any;
    // The project/topic identity supplies the accent; the requested accent does not override it.
    expect(replacedBody).toMatchObject({ replaced: 1, activity: {
      key: "deploy", symbol: "build", style: "standard", privacyMode: "standard", state: "active",
    } });
    expect(new Date(replacedBody.activity.staleAt).getTime()).toBeLessThanOrEqual(
      new Date(replacedBody.activity.expiresAt).getTime(),
    );
    const replay = await start("replace",firstPhone.deviceId,{
      replace: true, symbol: "build", style: "standard",
      accentColor: "#64D2FF", expiresInSeconds: 600, staleAfterSeconds: 120,
    });
    expect(await replay.json()).toMatchObject({ replayed: true, replaced: 1, activity: { sequence: 0 } });

    const byKey = await request("/api/live-activities/deploy",ownerOneToken);
    expect((await byKey.json() as any).activity.id).toBe(replacedBody.activity.id);
    const ended = await request("/api/live-activities/deploy/end",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "serialized-end-key-12345678" },
      body: JSON.stringify({ ifSequence: 0 }),
    });
    expect(ended.status).toBe(200);
    const reused = await request("/api/live-activities",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "serialized-reuse-key-12345678" },
      body: JSON.stringify({ key: "deploy", title: "Deploy again", status: "Starting", deviceIds: [firstPhone.deviceId] }),
    });
    expect(reused.status).toBe(201);
    const oldEndReplay = await request("/api/live-activities/deploy/end",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "serialized-end-key-12345678" },
      body: JSON.stringify({ ifSequence: 0 }),
    });
    expect(await oldEndReplay.json()).toMatchObject({
      replayed: true, activity: { id: replacedBody.activity.id, state: "ended" },
    });
  });

  test("a task card past its old expiry is retired by derived policy only: reads never write; interactive styles fail closed", async () => {
    const phone = await pair(ownerOneToken,"20202020-2020-4020-8020-202020202020",true);
    const rejected = await request("/api/live-activities",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "interactive-task-rejected-12345678" },
      body: JSON.stringify({ title: "Wrong surface", status: "Starting", style: "approval", deviceIds: [phone.deviceId] }),
    });
    expect(rejected.status).toBe(400);

    const started = await request("/api/live-activities",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "expiring-task-start-12345678" },
      body: JSON.stringify({ key: "expiring", title: "Expiring", status: "Starting", deviceIds: [phone.deviceId] }),
    });
    const activityId = (await started.json() as any).activity.id;
    const internal = activityId.slice("act_".length);
    await db.query("UPDATE live_activities SET expires_at=now()-interval '1 second',stale_at=now()-interval '1 second' WHERE id=$1",[internal]);
    const before = (await db.query("SELECT * FROM live_activities WHERE id=$1",[internal])).rows[0];
    const operationsBefore = (await db.query("SELECT count(*)::int AS n FROM live_activity_operations WHERE live_activity_id=$1",[internal])).rows[0].n;
    // Reading never writes: the declared card is unchanged and no cleanup operation is queued by a read.
    const fetched = await request(`/api/live-activities/${activityId}`,ownerOneToken);
    expect(fetched.status).toBe(200);
    expect((await fetched.json() as any).activity).toMatchObject({ state: "active", status: "Starting", sequence: 0 });
    expect((await db.query("SELECT * FROM live_activities WHERE id=$1",[internal])).rows[0]).toEqual(before);
    expect((await db.query("SELECT count(*)::int AS n FROM live_activity_operations WHERE live_activity_id=$1",[internal])).rows[0].n)
      .toBe(operationsBefore);
    // Retirement is derived from the declared write's age (no signal after T_retire), never stored on the card.
    const principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='owner-one'")).rows[0].id;
    const loaded = await loadOwnerStateInputs(db,principalId,[activityId],
      new Date(Date.parse(before.declared_at) + (OWNER_STATE_TIMING.retireSeconds + 60) * 1000));
    expect(deriveOwnerState(loaded[0]!.input).state).toBe("no_signal");
    expect((await db.query("SELECT state::text FROM live_activities WHERE id=$1",[internal])).rows[0].state).toBe("active");
    // The producer may still write: a declared write is never refused because time passed.
    const update = await request(`/api/live-activities/${activityId}`,ownerOneToken,{
      method: "PATCH", body: JSON.stringify({ status: "Still going" }),
    });
    expect(update.status).toBeLessThan(300);
  });

  test("concurrent ordinary responses replay exact reuse and conflict changed reuse without a 500", async () => {
    const phone = await pair(ownerOneToken,"efefefef-efef-4fef-8fef-efefefefefef",true);
    const createQuestion = async (key: string, type: "approval" | "yes_no") => {
      const response = await request("/api/interactions",ownerOneToken,{
        method: "POST", headers: { "idempotency-key": key },
        body: JSON.stringify({ title: "Race", prompt: "Choose", type, deviceIds: [phone.deviceId] }),
      });
      return await response.json() as any;
    };
    const first = await createQuestion("response-race-create-one-12345678","approval");
    const exact = () => request(`/api/notifications/${first.eventId}/interactions`,phone.credential,{
      method: "POST",
      body: JSON.stringify({ kind: "approve", value: {}, idempotencyKey: "response-race-exact-12345678" }),
    });
    const exactResults = await Promise.all([exact(),exact()]);
    expect(exactResults.map((response) => response.status).sort()).toEqual([200,201]);

    const second = await createQuestion("response-race-create-two-12345678","yes_no");
    const third = await createQuestion("response-race-create-three-12345678","yes_no");
    const changedResults = await Promise.all([
      [second.eventId,"yes"],
      [third.eventId,"no"],
    ].map(([eventId,kind]) =>
      request(`/api/notifications/${eventId}/interactions`,phone.credential,{
        method: "POST",
        body: JSON.stringify({ kind, value: {}, idempotencyKey: "response-race-changed-12345678" }),
      }),
    ));
    expect(changedResults.map((response) => response.status).sort()).toEqual([201,409]);
    const terminal = await db.query<{ state: string }>(
      `SELECT r.state FROM interaction_requests r
       JOIN notification_events e ON e.id=r.notification_event_id
       WHERE e.idempotency_key=ANY($1::text[]) ORDER BY e.idempotency_key`,
      [["response-race-create-two-12345678","response-race-create-three-12345678"]],
    );
    expect(terminal.rows.filter((row) => row.state !== "pending")).toHaveLength(1);
    expect(terminal.rows.filter((row) => row.state === "pending")).toHaveLength(1);
  });

  test("expiring a request shows its parent event as expired in the phone inbox", async () => {
    const phone = await pair(ownerOneToken,"45454545-4545-4545-8545-454545454545",true);
    const created = await request("/api/interactions",ownerOneToken,{
      method: "POST", headers: { "idempotency-key": "expiry-cursor-create-12345678" },
      body: JSON.stringify({ title: "Expires", prompt: "Wait", type: "approval", deviceIds: [phone.deviceId] }),
    });
    const createdBody = await created.json() as any;
    await db.query("UPDATE interaction_requests SET expires_at=now()-interval '1 second' WHERE id=$1",[
      createdBody.interaction.id.slice("int_".length),
    ]);
    const waited = await request(`/api/interactions/${createdBody.interaction.id}/wait?timeoutSeconds=0`,ownerOneToken);
    const expiredBody = await waited.json() as any;
    expect(expiredBody).toMatchObject({ interaction: {
      state: "expired",action: null,response: null,respondingDevice: null,
    } });
    expect(await (await request(`/api/interactions/${createdBody.interaction.id}`,ownerOneToken)).json())
      .toEqual(expiredBody);
    const inbox = await (await request("/api/inbox/history?limit=100",phone.credential)).json() as any;
    expect(inbox.items).toHaveLength(1);
    expect(inbox.items[0]).toMatchObject({ id: createdBody.eventId, interaction: { state: "expired" } });
  });
});
