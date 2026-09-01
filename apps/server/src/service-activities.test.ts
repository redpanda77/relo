import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { createDatabase, type Database } from "./db.js";
import { publicId } from "./ids.js";
import { migrate } from "./migrate.js";
import { createWebhookService } from "./services.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("secret-bound service Live Activities", () => {
  let db: Database;
  let principalId: string;
  let deviceId: string;
  let devicePublicId: string;
  let serviceA: Awaited<ReturnType<typeof createWebhookService>>;
  let serviceB: Awaited<ReturnType<typeof createWebhookService>>;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
  });

  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    principalId = (await db.query<{ id: string }>(
      "INSERT INTO owner_principals(handle,display_name) VALUES ('service-owner','Service Owner') RETURNING id",
    )).rows[0]!.id;
    deviceId = (await db.query<{ id: string }>(
      `INSERT INTO devices(
         principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,model,apns_environment,apns_token,live_activity_push_to_start_token,
         notification_authorization,live_activity_authorization
       ) VALUES ($1,'service-stable','service-install','Service iPhone','com.example.relo.notifications','1','1',
         '18','iPhone','sandbox',$2,$3,'authorized','authorized') RETURNING id`,
      [principalId,"a".repeat(64),"b".repeat(64)],
    )).rows[0]!.id;
    devicePublicId = publicId("dev",deviceId);
    serviceA = await createWebhookService(db,principalId,"Build Service","http://127.0.0.1:8180");
    serviceB = await createWebhookService(db,principalId,"Deploy Service","http://127.0.0.1:8180");
  });

  afterAll(async () => db.end());

  function hookPath(service: typeof serviceA, suffix: string): string {
    return `${new URL(service.webhookUrl).pathname}${suffix}`;
  }

  function request(service: typeof serviceA, suffix: string, init?: RequestInit): Promise<Response> {
    return createApp(db,{ apnsMode: "sandbox" }).request(hookPath(service,suffix), {
      ...init,
      headers: { "content-type": "application/json", ...init?.headers },
    });
  }

  test("ordinary webhook withdrawal is service-scoped and idempotent", async () => {
    const sent = await request(serviceA,"",{
      method: "POST",
      headers: { "idempotency-key": "service-ordinary-withdraw" },
      body: JSON.stringify({ title: "Obsolete build",body: "This notice is obsolete" }),
    });
    expect(sent.status).toBe(201);
    const eventId = (await sent.json() as any).eventId as string;

    const foreign = await request(serviceB,`/events/${eventId}/withdraw`,{
      method: "POST",headers: { "idempotency-key": "foreign-withdraw" },body: "{}",
    });
    expect(foreign.status).toBe(404);

    const first = await request(serviceA,`/events/${eventId}/withdraw`,{
      method: "POST",headers: { "idempotency-key": "owner-withdraw" },body: "{}",
    });
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ state: "withdrawn",idempotent: false });
    const replay = await request(serviceA,`/events/${eventId}/withdraw`,{
      method: "POST",headers: { "idempotency-key": "owner-withdraw" },body: "{}",
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ state: "withdrawn",idempotent: true });
  });

  test("namespaces start idempotency, propagates APNs mode, and prevents cross-service disclosure", async () => {
    const body = JSON.stringify({
      key: "build-release", title: "Build release", status: "Compiling", progress: 0.2,
      style: "terminal", symbol: "build", accentColor: "#12ABEF", deviceIds: [devicePublicId],
    });
    const headers = { "idempotency-key": "service-start-1" };
    const first = await request(serviceA,"/live-activities",{ method: "POST", headers, body });
    expect(first.status).toBe(201);
    const firstBody = await first.json() as any;
    expect(firstBody).toMatchObject({
      ok: true, replayed: false,
      delivery: { eligibleDevices: 1, durableCommands: 1, apnsJobs: 1 },
      activity: { key: "build-release", style: "terminal", symbol: "build", accentColor: "#12ABEF" },
    });
    expect(JSON.stringify(firstBody)).not.toContain("hook_");

    const replay = await request(serviceA,"/live-activities",{ method: "POST", headers, body });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ ok: true, replayed: true, activity: firstBody.activity });
    const conflict = await request(serviceA,"/live-activities",{
      method: "POST", headers, body: JSON.stringify({ ...JSON.parse(body), title: "Changed" }),
    });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toEqual({ ok: false, error: "idempotency_conflict" });

    const byId = await request(serviceA,`/live-activities/${firstBody.activity.id}`);
    const byKey = await request(serviceA,"/live-activities/build-release");
    expect((await byId.json() as any).activity.id).toBe(firstBody.activity.id);
    expect((await byKey.json() as any).activity.id).toBe(firstBody.activity.id);
    for (const suffix of [
      `/live-activities/${firstBody.activity.id}`,
      "/live-activities/build-release",
    ]) expect((await request(serviceB,suffix)).status).toBe(404);
    expect((await request(serviceB,`/live-activities/${firstBody.activity.id}`,{
      method: "PATCH", body: JSON.stringify({ progress: 0.4 }),
    })).status).toBe(404);
    expect((await request(serviceB,`/live-activities/${firstBody.activity.id}/end`,{
      method: "POST", body: "{}",
    })).status).toBe(404);

    const stored = await db.query<any>(
      `SELECT a.requester_service_id,
         (SELECT count(*)::int FROM notification_events e
          WHERE e.payload#>>'{liveActivity,activityId}'=$2 AND e.service_id=$1) AS service_events,
         (SELECT count(*)::int FROM delivery_jobs j
          WHERE j.live_activity_id=a.id AND j.transport='live_activity_start') AS start_jobs
       FROM live_activities a WHERE a.id=$3`,
      [serviceA.row.id,firstBody.activity.id,firstBody.activity.id.slice("act_".length)],
    );
    expect(stored.rows[0]).toEqual({ requester_service_id: serviceA.row.id, service_events: 1, start_jobs: 1 });

    await db.query("UPDATE webhook_services SET revoked_at=now() WHERE id=$1",[serviceA.row.id]);
    expect((await request(serviceA,`/live-activities/${firstBody.activity.id}`)).status).toBe(404);
    expect((await request(serviceA,"/live-activities",{ method: "POST", headers: {
      "idempotency-key": "revoked-start",
    }, body })).status).toBe(404);
  });

  test("resolves and snapshots a service policy when appearance is omitted",async () => {
    const accountPolicy = {
      preset: "steps",theme: "system",symbol: "automatic",
      colorStrategy: "fixed",accentColor: "#F2A65A",
    };
    const servicePolicy = {
      preset: "terminal",theme: "dark",symbol: "build",
      colorStrategy: "fixed",accentColor: "#63B3FF",
    };
    await db.query("UPDATE owner_principals SET live_activity_policy=$2::jsonb WHERE id=$1",[
      principalId,accountPolicy,
    ]);
    await db.query("UPDATE webhook_services SET live_activity_policy=$2::jsonb WHERE id=$1",[
      serviceA.row.id,servicePolicy,
    ]);
    const response = await request(serviceA,"/live-activities",{
      method: "POST",
      headers: { "idempotency-key": "service-policy-start" },
      body: JSON.stringify({
        key: "policy-run",title: "Policy run",status: "Working",progress: 0.4,
        deviceIds: [devicePublicId],
      }),
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toMatchObject({
      activity: { style: "terminal",symbol: "build",accentColor: "#63B3FF" },
    });
    const stored = (await db.query<any>(
      "SELECT presentation_policy,presentation_policy_source FROM live_activities WHERE start_idempotency_key=$1",
      ["service-policy-start"],
    )).rows[0];
    expect(stored).toMatchObject({
      presentation_policy_source: "service",
      presentation_policy: { policy: servicePolicy,source: "service",explicit: [] },
    });
  });

  test("rejects legacy private activity input now that the public contract is standard-only",async () => {
    const legacyPrivateStart = {
      key: "private-run",title: "Sensitive build",status: "Working",
      privacyMode: "private",deviceIds: [devicePublicId],
    };
    const response = await request(serviceA,"/live-activities",{
      method: "POST",headers: { "idempotency-key": "private-disabled-start" },
      body: JSON.stringify(legacyPrivateStart),
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: "invalid_request" });
  });

  test("persists and resolves exact provider runs within one service boundary", async () => {
    const origin = {
      sourceInstance: "service-installation",project: "Relo",
      thread: "service-thread",channel: "task-progress",
    };
    const lifecycle = { provider: "acp",runId: "acp-run-0123456789" };
    const body = {
      title: "Agent task",status: "Planning",deviceIds: [devicePublicId],origin,lifecycle,
    };
    const started = await request(serviceA,"/live-activities",{
      method: "POST",body: JSON.stringify(body),
    });
    expect(started.status).toBe(201);
    const activity = (await started.json() as any).activity;

    const replay = await request(serviceA,"/live-activities",{
      method: "POST",body: JSON.stringify(body),
    });
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      ok: true,replayed: true,activity: { id: activity.id,generation: 1 },
    });

    for (const resolver of [{ lifecycle },{ origin }]) {
      const resolved = await request(serviceA,"/live-activities/resolve",{
        method: "POST",body: JSON.stringify(resolver),
      });
      expect(resolved.status).toBe(200);
      expect(await resolved.json()).toMatchObject({
        ok: true,found: true,activity: { id: activity.id,generation: 1 },
      });
    }
    const current = await request(serviceA,"/live-activities/resolve",{
      method: "POST",body: JSON.stringify({ current: true }),
    });
    expect(current.status).toBe(200);
    expect(await current.json()).toMatchObject({
      ok: true,found: true,activity: { id: activity.id,generation: 1 },
    });
    expect(await (await request(serviceB,"/live-activities/resolve",{
      method: "POST",body: JSON.stringify({ lifecycle }),
    })).json()).toEqual({ ok: true,found: false,activity: null });

    const changed = await request(serviceA,"/live-activities",{
      method: "POST",body: JSON.stringify({ ...body,status: "Changed" }),
    });
    expect(changed.status).toBe(409);
    expect(await changed.json()).toEqual({
      ok: false,error: "lifecycle_run_conflict",code: "LIFECYCLE_RUN_CONFLICT",
    });

    const stored = await db.query<any>(
      "SELECT lifecycle_provider,lifecycle_run_id FROM live_activities WHERE id=$1",
      [activity.id.slice("act_".length)],
    );
    expect(stored.rows[0]).toEqual({
      lifecycle_provider: lifecycle.provider,lifecycle_run_id: lifecycle.runId,
    });
  });

  test("replays update/end exactly, supports replace and reusable keys, and isolates service conflicts", async () => {
    const startBody = {
      key: "release", title: "Release", status: "Starting", progress: 0,
      deviceIds: [devicePublicId],
    };
    const start = await request(serviceA,"/live-activities",{
      method: "POST", headers: { "idempotency-key": "release-start-1" }, body: JSON.stringify(startBody),
    });
    const activity = (await start.json() as any).activity;

    const updateHeaders = { "idempotency-key": "release-update-1" };
    const updateBody = JSON.stringify({
      progress: 0.5,status: "Halfway",ifSequence: 0,deliveryPriority: 10,
    });
    const update = await request(serviceA,"/live-activities/release",{ method: "PATCH", headers: updateHeaders, body: updateBody });
    expect(update.status).toBe(200);
    const updateResult = await update.json() as any;
    expect(updateResult).toMatchObject({ ok: true, replayed: false, activity: { id: activity.id, sequence: 1, progress: 0.5 } });
    const updatePriority = await db.query<{ priority: number }>(
      `SELECT (e.payload#>>'{liveActivity,priority}')::int AS priority
       FROM notification_events e
       WHERE e.payload#>>'{liveActivity,activityId}'=$1
         AND e.payload#>>'{liveActivity,operation}'='update'`,
      [activity.id],
    );
    expect(updatePriority.rows).toEqual([{ priority: 10 }]);
    expect(await (await request(serviceA,"/live-activities/release",{
      method: "PATCH", headers: updateHeaders, body: updateBody,
    })).json()).toMatchObject({ ok: true, replayed: true, activity: updateResult.activity });
    expect((await request(serviceA,"/live-activities/release",{
      method: "PATCH", headers: updateHeaders, body: JSON.stringify({ progress: 0.7 }),
    })).status).toBe(409);

    const endHeaders = { "idempotency-key": "release-end-1" };
    const endBody = JSON.stringify({
      status: "Shipped",detail: "Available to customers",progress: 1,accentColor: "#30D158",
      ifSequence: 1,dismissAfterSeconds: 15,
    });
    const ended = await request(serviceA,`/live-activities/${activity.id}/end`,{
      method: "POST", headers: endHeaders, body: endBody,
    });
    expect(ended.status).toBe(200);
    const endResult = await ended.json() as any;
    expect(endResult).toMatchObject({ ok: true, replayed: false, dismissAfterSeconds: 15,
      activity: { id: activity.id,state: "ended",sequence: 2,detail: "Available to customers",
        progress: 1,accentColor: "#30D158" } });
    expect(await (await request(serviceA,`/live-activities/${activity.id}/end`,{
      method: "POST", headers: endHeaders, body: endBody,
    })).json()).toMatchObject({ ok: true, replayed: true, activity: endResult.activity });
    expect((await request(serviceA,`/live-activities/${activity.id}/end`,{
      method: "POST", headers: endHeaders, body: JSON.stringify({ status: "Changed" }),
    })).status).toBe(409);
    expect((await request(serviceA,`/live-activities/${activity.id}`,{
      method: "PATCH", body: JSON.stringify({ progress: 0.8 }),
    })).status).toBe(409);

    const replacementBody = JSON.stringify({ ...startBody, replace: true, title: "Release again" });
    const reused = await request(serviceA,"/live-activities",{
      method: "POST", headers: { "idempotency-key": "release-start-2" }, body: replacementBody,
    });
    expect(reused.status).toBe(201);
    const reusedActivity = (await reused.json() as any).activity;
    expect(reusedActivity.id).not.toBe(activity.id);
    const replacement = await request(serviceA,"/live-activities",{
      method: "POST", headers: { "idempotency-key": "release-start-3" },
      body: JSON.stringify({ ...startBody, replace: true, title: "Release replacement" }),
    });
    expect(replacement.status).toBe(201);
    const replacementResult = await replacement.json() as any;
    expect(replacementResult).toMatchObject({ ok: true, replayed: false, replaced: 1 });
    expect((await db.query<any>("SELECT state FROM live_activities WHERE id=$1",[
      reusedActivity.id.slice("act_".length),
    ])).rows[0].state).toBe("replaced");

    const crossService = await request(serviceB,"/live-activities",{
      method: "POST", headers: { "idempotency-key": "release-start-3" },
      body: JSON.stringify({ ...startBody, title: "Other service" }),
    });
    expect(crossService.status).toBe(409);
    expect(await crossService.json()).toEqual({
      ok: false, error: "active_activity_conflict", code: "ACTIVE_ACTIVITY_CONFLICT",
    });

    const namespaced = await request(serviceB,"/live-activities",{
      method: "POST", headers: { "idempotency-key": "release-start-3" },
      body: JSON.stringify({ ...startBody, replace: true, title: "Other service" }),
    });
    expect(namespaced.status).toBe(201);
    const namespacedResult = await namespaced.json() as any;
    expect(namespacedResult).toMatchObject({ ok: true, replaced: 1 });
    expect(namespacedResult.activity.id).not.toBe(replacementResult.activity.id);
    const replacedOwner = await db.query<any>(
      `SELECT a.state,o.requester_service_id,o.requester_credential_id
       FROM live_activities a JOIN live_activity_operations o ON o.live_activity_id=a.id
       WHERE a.id=$1 AND o.operation='end' ORDER BY o.created_at DESC LIMIT 1`,
      [replacementResult.activity.id.slice("act_".length)],
    );
    expect(replacedOwner.rows[0]).toEqual({
      state: "replaced", requester_service_id: serviceA.row.id, requester_credential_id: null,
    });
    expect((await request(serviceA,"/live-activities/release")).status).toBe(200);
    expect((await request(serviceB,"/live-activities/release")).status).toBe(200);
  });

  test("enforces shared service and account mutation limits without charging reads", async () => {
    const started = await request(serviceA,"/live-activities",{
      method: "POST",
      headers: { "idempotency-key": "rate-activity-start" },
      body: JSON.stringify({ key: "rate-read", title: "Rate read", status: "Starting", deviceIds: [devicePublicId] }),
    });
    const activityId = (await started.json() as any).activity.id;
    const beforeReads = await db.query<any>(
      `SELECT scope_kind,request_count FROM request_rate_limits
       WHERE family='authenticated-mutations' AND scope_id=ANY($1::uuid[]) ORDER BY scope_kind`,
      [[principalId,serviceA.row.id]],
    );
    expect(beforeReads.rows).toEqual([
      { scope_kind: "account", request_count: 1 },
      { scope_kind: "service", request_count: 1 },
    ]);
    for (let index = 0; index < 3; index += 1) {
      expect((await request(serviceA,`/live-activities/${activityId}`)).status).toBe(200);
    }
    expect((await db.query<any>(
      "SELECT sum(request_count)::int AS count FROM request_rate_limits WHERE family='authenticated-mutations' AND scope_id=ANY($1::uuid[])",
      [[principalId,serviceA.row.id]],
    )).rows[0].count).toBe(2);

    await db.query(
      `INSERT INTO request_rate_limits(scope_kind,scope_id,family,window_started_at,request_count)
       VALUES ('service',$1,'authenticated-mutations',date_trunc('minute',now()),59),
              ('account',$2,'authenticated-mutations',date_trunc('minute',now()),299)
       ON CONFLICT (scope_kind,scope_id,family) DO UPDATE SET
         window_started_at=EXCLUDED.window_started_at,request_count=EXCLUDED.request_count,updated_at=now()`,
      [serviceA.row.id,principalId],
    );
    const ordinary = JSON.stringify({ body: "Mutation at the limit" });
    expect((await request(serviceA,"",{
      method: "POST", headers: { "idempotency-key": "rate-ordinary-1" }, body: ordinary,
    })).status).toBe(201);
    const limited = await request(serviceA,"",{
      method: "POST", headers: { "idempotency-key": "rate-ordinary-2" }, body: ordinary,
    });
    expect(limited.status).toBe(429);
    expect(await limited.json()).toEqual({ ok: false, error: "rate_limited" });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);

    const accountLimited = await request(serviceB,"",{
      method: "POST", headers: { "idempotency-key": "rate-other-service" }, body: ordinary,
    });
    expect(accountLimited.status).toBe(429);
    expect(await accountLimited.json()).toEqual({ ok: false, error: "rate_limited" });
  });
});
