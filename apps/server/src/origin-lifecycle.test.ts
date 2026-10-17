import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "./app.js";
import { bootstrapOwner } from "./bootstrap.js";
import { hashToken } from "./auth.js";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { canonicalOriginHash,type OriginDescriptor } from "./origin-slots.js";
import { createWebhookService } from "./webhooks/admin.js";
import { currentTestPresentationRecord } from "./test-current-presentation.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("origin-slot lifecycle", () => {
  const token = "origin_owner_abcdefghijklmnopqrstuvwxyz_0123456789";
  const transportSecret = "origin-test-transport-secret-with-at-least-32-characters";
  let db: Database;
  let principalId: string;
  let credentialId: string;
  let deviceId: string;

  const origin: OriginDescriptor = {
    sourceInstance: "codex:mac-studio",
    project: "Relo notifications",
    thread: "thread-42",
    channel: "task-progress",
  };

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
  });

  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    await bootstrapOwner(db,"origin-owner",token);
    const owner = await db.query<{ principal_id: string; credential_id: string }>(
      `SELECT p.id AS principal_id,k.id AS credential_id
       FROM owner_principals p JOIN principal_api_keys k ON k.principal_id=p.id
       WHERE p.handle='origin-owner' AND k.label='bootstrap-owner' AND k.revoked_at IS NULL`,
    );
    principalId = owner.rows[0]!.principal_id;
    credentialId = owner.rows[0]!.credential_id;
    const device = await db.query<{ id: string }>(
      `INSERT INTO devices(
         principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,model,apns_environment,apns_token,live_activity_push_to_start_token,
         notification_authorization,live_activity_authorization
       ) VALUES ($1,'origin-device','origin-install','Origin iPhone','com.example.relo.notifications','1','1',
         '18','iPhone','sandbox',$2,$3,'authorized','authorized') RETURNING id`,
      [principalId,"a".repeat(64),"b".repeat(64)],
    );
    deviceId = `dev_${device.rows[0]!.id}`;
  });

  afterAll(async () => db.end());

  const app = () => createApp(db,{ apnsMode: "disabled",credentialDerivationSecret: transportSecret });
  const request = (path: string,body: unknown,key: string,method = "POST") => app().request(path,{
    method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json","idempotency-key": key },
    body: JSON.stringify(body),
  });
  const startBody = (slot: OriginDescriptor,progress = 0) => ({
    title: "Build release",status: `${Math.round(progress*100)}%`,progress,
    deviceIds: [deviceId],origin: slot,
  });

  test("reuses one active ID per origin and separates source, project, thread, and channel", async () => {
    const first = await request("/api/live-activities",startBody(origin),"origin-start-1");
    expect(first.status).toBe(201);
    const firstBody = await first.json() as any;
    expect(firstBody).toMatchObject({ reused: false,resumed: false,
      activity: { generation: 1,sequence: 0 } });

    const progress = await request("/api/live-activities",startBody(origin,0.5),"origin-progress-1");
    expect(progress.status).toBe(200);
    expect(await progress.json()).toMatchObject({
      reused: true,replayed: false,
      resumed: false,activity: { id: firstBody.activity.id,generation: 1,sequence: 1,progress: 0.5 },
    });
    const retry = await request("/api/live-activities",startBody(origin,0.5),"origin-progress-1");
    expect(retry.status).toBe(200);
    expect(await retry.json()).toMatchObject({
      reused: true,replayed: true,
      resumed: false,activity: { id: firstBody.activity.id,generation: 1,sequence: 1,progress: 0.5 },
    });

    const variants: OriginDescriptor[] = [
      { ...origin,sourceInstance: "codex:macbook" },
      { ...origin,project: "Other project" },
      { ...origin,thread: "thread-43" },
      { ...origin,channel: "approval" },
    ];
    const ids = new Set([firstBody.activity.id]);
    expect((await request(
      `/api/live-activities/${firstBody.activity.id}/end`,{},"origin-first-end",
    )).status).toBe(200);
    for (const [index,slot] of variants.entries()) {
      const response = await request("/api/live-activities",startBody(slot),`origin-variant-${index}`);
      expect(response.status).toBe(201);
      const activityId = (await response.json() as any).activity.id;
      ids.add(activityId);
      expect((await request(
        `/api/live-activities/${activityId}/end`,{},`origin-variant-end-${index}`,
      )).status).toBe(200);
    }
    expect(ids.size).toBe(5);
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM live_activities WHERE principal_id=$1 AND state='active'",
      [principalId],
    )).rows[0]!.count).toBe(0);
  });

  test("snapshots the client policy at start, and the open card follows a later policy change on ensure",async () => {
    const clientPolicy = {
      colorStrategy: "fixed",accentColor: "#63B3FF",
    };
    await db.query("UPDATE principal_api_keys SET live_activity_policy=$2::jsonb WHERE id=$1",[
      credentialId,clientPolicy,
    ]);
    const lifecycle = { provider: "codex",runId: "codex-policy-run-0123456789" };
    const first = await request("/api/live-activities",{
      ...startBody({ ...origin,thread: "policy-thread" }),lifecycle,
    },"client-policy-start");
    expect(first.status).toBe(201);
    const firstBody = await first.json() as any;
    expect(firstBody.activity).toMatchObject({
      style: "standard",symbol: "build",accentColor: "#63B3FF",
    });
    await db.query("UPDATE principal_api_keys SET live_activity_policy=$2::jsonb WHERE id=$1",[
      credentialId,{
        ...clientPolicy,accentColor: "#FF7A90",
      },
    ]);
    const ensured = await request("/api/live-activities",{
      ...startBody({ ...origin,thread: "policy-thread" },0.5),lifecycle,
    },"client-policy-ensure");
    expect(ensured.status).toBe(200);
    expect(await ensured.json()).toMatchObject({
      reused: true,
      activity: {
        id: firstBody.activity.id,progress: 0.5,
        // The policy now says #FF7A90: an open card takes the policy's color on its next write.
        style: "standard",symbol: "build",accentColor: "#FF7A90",
      },
    });
    expect((await db.query<any>(
      `SELECT presentation_policy_source,presentation_policy,
         presentation_preset_id,presentation_preset_revision
       FROM live_activities WHERE start_idempotency_key=$1`,
      ["client-policy-start"],
    )).rows[0]).toMatchObject({
      presentation_policy_source: "client",
      presentation_policy: { policy: clientPolicy,source: "client",explicit: [] },
      presentation_preset_id: "system.agent.measured",
      presentation_preset_revision: 1,
    });
  });

  test("keeps different origins independently active on one target device", async () => {
    const leftOrigin = { ...origin,thread: "device-slot-left" };
    const rightOrigin = { ...origin,thread: "device-slot-right" };
    const raced = await Promise.all([
      request("/api/live-activities",startBody(leftOrigin),"device-slot-left-start"),
      request("/api/live-activities",startBody(rightOrigin),"device-slot-right-start"),
    ]);
    expect(raced.map((response) => response.status)).toEqual([201,201]);
    const [left,right] = await Promise.all(raced.map(async (response) => await response.json())) as any[];
    expect(left.activity.id).toMatch(/^act_/u);
    expect(right.activity.id).toMatch(/^act_/u);
    expect(left.activity.id).not.toBe(right.activity.id);
    expect(left.activity.originThreadId).not.toBe(right.activity.originThreadId);
    expect((await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM live_activities
       WHERE principal_id=$1 AND state='active' AND target_device_ids && ARRAY[$2::uuid]`,
      [principalId,deviceId.slice("dev_".length)],
    )).rows[0]!.count).toBe(2);
  });

  test("resolves the latest owned generation without exposing the origin", async () => {
    const missing = await request("/api/live-activities/resolve",{ origin },"resolve-missing");
    expect(missing.status).toBe(200);
    expect(await missing.json()).toEqual({ found: false,activity: null });

    const started = await request("/api/live-activities",startBody(origin),"resolve-start");
    const startedBody = await started.json() as any;
    const active = await request("/api/live-activities/resolve",{ origin },"resolve-active");
    expect(active.status).toBe(200);
    const activeBody = await active.json() as any;
    expect(activeBody).toMatchObject({
      found: true,activity: { id: startedBody.activity.id,generation: 1,state: "active" },
    });
    expect(JSON.stringify(activeBody)).not.toContain("sourceInstance");

    await request(`/api/live-activities/${startedBody.activity.id}/end`,{},"resolve-end");
    const terminal = await request("/api/live-activities/resolve",{ origin },"resolve-terminal");
    expect(await terminal.json()).toMatchObject({
      found: true,activity: { id: startedBody.activity.id,generation: 1,state: "ended" },
    });
  });

  test("binds each agent run to one exact generation and rejects active run aliasing", async () => {
    const runOrigin = { ...origin,thread: "exact-run-thread" };
    const firstLifecycle = { provider: "codex",runId: "codex-run-first-0123456789" };
    const secondLifecycle = { provider: "codex",runId: "codex-run-second-0123456789" };
    const first = await request("/api/live-activities",{
      ...startBody(runOrigin),lifecycle: firstLifecycle,
    },"exact-run-first");
    expect(first.status).toBe(201);
    const firstBody = await first.json() as any;

    const firstResolved = await request(
      "/api/live-activities/resolve",{ lifecycle: firstLifecycle },"resolve-exact-first",
    );
    expect(firstResolved.status).toBe(200);
    expect(await firstResolved.json()).toMatchObject({
      found: true,activity: { id: firstBody.activity.id,generation: 1,state: "active" },
    });

    const aliased = await request("/api/live-activities",{
      ...startBody(runOrigin,0.5),lifecycle: secondLifecycle,
    },"exact-run-alias");
    expect(aliased.status).toBe(409);
    expect(await aliased.json()).toMatchObject({
      error: "active_origin_run_conflict",code: "ACTIVE_ORIGIN_RUN_CONFLICT",
      activityId: firstBody.activity.id,
    });

    expect((await request(
      `/api/live-activities/${firstBody.activity.id}/end`,{ lifecycle: firstLifecycle },"exact-run-first-end",
    )).status).toBe(200);
    const second = await request("/api/live-activities",{
      ...startBody(runOrigin),lifecycle: secondLifecycle,
    },"exact-run-second");
    expect(second.status).toBe(201);
    const secondBody = await second.json() as any;
    expect(secondBody).toMatchObject({
      reused: false,resumed: true,activity: { generation: 2,state: "active" },
    });
    expect(secondBody.activity.id).not.toBe(firstBody.activity.id);

    const runEvents = await db.query<{ operation: string; generation: number }>(
      `SELECT payload#>>'{liveActivity,operation}' AS operation,
         (payload#>>'{liveActivity,generation}')::int AS generation
       FROM notification_events
       WHERE principal_id=$1 AND origin_hash=$2
       ORDER BY created_at,id`,
      [principalId,canonicalOriginHash(principalId,runOrigin)],
    );
    expect(runEvents.rows).toEqual([
      { operation: "start",generation: 1 },
      { operation: "end",generation: 1 },
      { operation: "start",generation: 2 },
    ]);

    const [oldRun,newRun] = await Promise.all([
      request("/api/live-activities/resolve",{ lifecycle: firstLifecycle },"resolve-exact-old"),
      request("/api/live-activities/resolve",{ lifecycle: secondLifecycle },"resolve-exact-new"),
    ]);
    expect(await oldRun.json()).toMatchObject({
      found: true,activity: { id: firstBody.activity.id,generation: 1,state: "ended" },
    });
    expect(await newRun.json()).toMatchObject({
      found: true,activity: { id: secondBody.activity.id,generation: 2,state: "active" },
    });
  });

  test("allows same-credential manual mutations while rejecting a contradictory lifecycle identity", async () => {
    const guardedOrigin = { ...origin,thread: "guarded-provider-run" };
    const lifecycle = { provider: "codex",runId: "codex-run-guarded-0123456789" };
    const wrongLifecycle = { provider: "codex",runId: "codex-run-wrong-0123456789" };
    const started = await request("/api/live-activities",{
      ...startBody(guardedOrigin),lifecycle,
    },"guarded-provider-start");
    expect(started.status).toBe(201);
    const startedBody = await started.json() as any;
    expect(startedBody).toMatchObject({
      disposition: "created",activity: { ownerKind: "provider_run",sequence: 0 },
    });

    const blocked = await request(`/api/live-activities/${startedBody.activity.id}`,{
      lifecycle: wrongLifecycle,status: "Unauthorized",
    },"guarded-update-wrong","PATCH");
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({
      error: "activity_owner_conflict",code: "ACTIVITY_OWNER_CONFLICT",disposition: "blocked",
    });
    const updated = await request("/api/live-activities/current",{
      status: "Working",progress: 0.5,
    },"guarded-update-current","PATCH");
    expect(updated.status).toBe(200);
    expect(await updated.json()).toMatchObject({ activity: { sequence: 1,status: "Working",progress: 0.5 } });

    const ended = await request("/api/live-activities/current/end",{
      status: "Complete",progress: 1,
    },"guarded-end-current");
    expect(ended.status).toBe(200);

    const commands = await db.query<{ operation: string;priority: number }>(
      `SELECT payload#>>'{liveActivity,operation}' AS operation,
         (payload#>>'{liveActivity,priority}')::int AS priority
       FROM notification_events WHERE principal_id=$1 AND origin_hash=$2 ORDER BY created_at,id`,
      [principalId,canonicalOriginHash(principalId,guardedOrigin)],
    );
    expect(commands.rows).toEqual([
      { operation: "start",priority: 10 },
      { operation: "update",priority: 10 },
      { operation: "end",priority: 10 },
    ]);
  });

  test("an ensure start with an active key returns that card unchanged (ADR 0007)", async () => {
    const manualBody = {
      acquireMode: "ensure",key: "manual-release",title: "Manual release",status: "Starting",
      progress: 0.1,deviceIds: [deviceId],
    };
    const started = await request("/api/live-activities",manualBody,"manual-ensure-start");
    expect(started.status).toBe(201);
    const startedBody = await started.json() as any;
    expect(startedBody).toMatchObject({
      disposition: "created",activity: { ownerKind: "manual_key",sequence: 0 },
    });
    const ensured = await request("/api/live-activities",{
      ...manualBody,status: "Halfway",progress: 0.5,
    },"manual-ensure-update");
    expect(ensured.status).toBe(200);
    expect(await ensured.json()).toMatchObject({
      disposition: "existing",reused: true,queued: 0,
      activity: { id: startedBody.activity.id,ownerKind: "manual_key",sequence: 0,progress: 0.1,status: "Starting" },
    });
    expect((await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM live_activities
       WHERE principal_id=$1 AND requester_credential_id=$2 AND activity_key='manual-release' AND state='active'`,
      [principalId,credentialId],
    )).rows[0]!.count).toBe(1);
  });

  // New rule: a selector-free start creates its own card; only a provider run reuses its own card.
  test("manual-first, hook, and selector-free CLI starts each own a card; current is ambiguous across them", async () => {
    const manual = await request("/api/live-activities",{
      acquireMode: "ensure",title: "Shared task",status: "Manual start",progress: 0.1,deviceIds: [deviceId],
    },"converged-manual-start");
    expect(manual.status).toBe(201);
    const manualBody = await manual.json() as any;
    expect(manualBody.activity).toMatchObject({ ownerKind: "credential_session",sequence: 0 });

    const lifecycle = { provider: "codex",runId: "codex-converged-run-0123456789" };
    const hook = await request("/api/live-activities",{
      ...startBody({ ...origin,thread: "converged-thread" },0.25),acquireMode: "ensure",lifecycle,
    },"converged-hook-ensure");
    expect(hook.status).toBe(201);
    const hookBody = await hook.json() as any;
    expect(hookBody).toMatchObject({ reused: false,activity: { ownerKind: "provider_run",sequence: 0 } });
    expect(hookBody.activity.id).not.toBe(manualBody.activity.id);

    const selectorFree = await request("/api/live-activities",{
      acquireMode: "ensure",title: "Shared task",status: "Updated manually",progress: 0.4,deviceIds: [deviceId],
    },"converged-selector-free-ensure");
    expect(selectorFree.status).toBe(201);
    const selectorFreeBody = await selectorFree.json() as any;
    expect(selectorFreeBody).toMatchObject({ reused: false,activity: { ownerKind: "credential_session",sequence: 0 } });
    expect([manualBody.activity.id,hookBody.activity.id]).not.toContain(selectorFreeBody.activity.id);

    const resolved = await request("/api/live-activities/resolve",{ current: true },"converged-current");
    expect(resolved.status).toBe(409);
    expect(await resolved.json()).toMatchObject({ error: "activity_selection_ambiguous" });
    const ambiguousUpdate = await request("/api/live-activities/current",{ status: "Manual progress",progress: 0.8 },
      "converged-manual-update","PATCH");
    expect(ambiguousUpdate.status).toBe(409);

    const hookAgain = await request("/api/live-activities",{
      ...startBody({ ...origin,thread: "converged-thread" },0.5),acquireMode: "ensure",lifecycle,
    },"converged-hook-stale-progress");
    expect(hookAgain.status).toBe(200);
    expect(await hookAgain.json()).toMatchObject({ reused: true,activity: { id: hookBody.activity.id,sequence: 1 } });

    expect((await request("/api/live-activities/current/end",{ status: "Complete",dismissAfterSeconds: 30 },
      "converged-manual-end")).status).toBe(409);
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM live_activities WHERE principal_id=$1",[principalId],
    )).rows[0]!.count).toBe(3);
  });

  test("keeps an explicit manual name separate from an active provider run", async () => {
    const provider = await request("/api/live-activities",{
      ...startBody({ ...origin,thread: "provider-and-manual-thread" },0.25),
      acquireMode: "ensure",
      lifecycle: { provider: "codex",runId: "codex-provider-manual-0123456789" },
    },"provider-before-named-manual");
    expect(provider.status).toBe(201);
    const providerBody = await provider.json() as any;
    expect(providerBody.activity).toMatchObject({ ownerKind: "provider_run",sequence: 0 });

    const manual = await request("/api/live-activities",{
      acquireMode: "ensure",key: "separate-manual-task",title: "Separate manual task",
      status: "Starting",progress: 0.1,deviceIds: [deviceId],
    },"named-manual-beside-provider");
    expect(manual.status).toBe(201);
    const manualBody = await manual.json() as any;
    expect(manualBody).toMatchObject({
      disposition: "created",
      activity: { key: "separate-manual-task",ownerKind: "manual_key",sequence: 0 },
    });
    expect(manualBody.activity.id).not.toBe(providerBody.activity.id);

    const manualUpdate = await request("/api/live-activities",{
      acquireMode: "ensure",key: "separate-manual-task",title: "Separate manual task",
      status: "Halfway",progress: 0.5,deviceIds: [deviceId],
    },"named-manual-exact-update");
    expect(manualUpdate.status).toBe(200);
    expect(await manualUpdate.json()).toMatchObject({
      disposition: "existing",
      activity: { id: manualBody.activity.id,ownerKind: "manual_key",sequence: 0,progress: 0.1 },
    });

    expect((await db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM live_activities
       WHERE principal_id=$1 AND requester_credential_id=$2 AND state='active'`,
      [principalId,credentialId],
    )).rows[0]!.count).toBe(2);

    expect((await request(
      `/api/live-activities/${manualBody.activity.id}/end`,{},"named-manual-separate-end",
    )).status).toBe(200);
    expect((await request(
      `/api/live-activities/${providerBody.activity.id}/end`,{},"provider-separate-end",
    )).status).toBe(200);

    const manualFirst = await request("/api/live-activities",{
      acquireMode: "ensure",key: "manual-before-provider",title: "Manual before provider",
      status: "Starting",deviceIds: [deviceId],
    },"named-manual-before-provider");
    expect(manualFirst.status).toBe(201);
    const manualFirstBody = await manualFirst.json() as any;

    const providerSecond = await request("/api/live-activities",{
      ...startBody({ ...origin,thread: "manual-then-provider-thread" }),
      acquireMode: "ensure",
      lifecycle: { provider: "codex",runId: "codex-manual-provider-0123456789" },
    },"provider-after-named-manual");
    expect(providerSecond.status).toBe(201);
    const providerSecondBody = await providerSecond.json() as any;
    expect(providerSecondBody.activity).toMatchObject({ ownerKind: "provider_run",sequence: 0 });
    expect(providerSecondBody.activity.id).not.toBe(manualFirstBody.activity.id);

    expect((await request(
      `/api/live-activities/${manualFirstBody.activity.id}/end`,{},"manual-first-separate-end",
    )).status).toBe(200);
    expect((await request(
      `/api/live-activities/${providerSecondBody.activity.id}/end`,{},"provider-second-separate-end",
    )).status).toBe(200);
  });

  test("renews provider leases without a visible update; a lapsed lease never ends the card",async () => {
    const lifecycle = { provider: "codex",runId: "codex-lease-run-0123456789" };
    const started = await request("/api/live-activities",{
      acquireMode: "ensure",title: "Codex · Relo",status: "Planning",
      deviceIds: [deviceId],origin: { ...origin,thread: "lease-thread" },lifecycle,
      staleAfterSeconds: 3_600,
    },"lease-start");
    expect(started.status).toBe(201);
    const initial = (await started.json() as any).activity;
    expect(initial).toMatchObject({ sequence: 0,progress: null,
      presentation: { components: [],behavior: { type: "informational" } } });
    const eventsBefore = (await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM notification_events WHERE principal_id=$1",[principalId],
    )).rows[0]!.count;

    const renewed = await request(`/api/live-activities/${initial.id}/heartbeat`,{
      lifecycle,leaseAfterSeconds: 7_200,
    },"lease-heartbeat");
    expect(renewed.status).toBe(200);
    expect(await renewed.json()).toMatchObject({ renewed: true,activity: {
      id: initial.id,sequence: 0,progress: null,state: "active",
    } });
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM notification_events WHERE principal_id=$1",[principalId],
    )).rows[0]!.count).toBe(eventsBefore);

    // A lapsed provider lease is evidence for derive(), never an end: the declared card stays active.
    await db.query("UPDATE live_activities SET stale_at=now()-interval '1 second' WHERE id=$1",[
      initial.id.slice("act_".length),
    ]);
    expect((await db.query<{ state: string }>("SELECT state FROM live_activities WHERE id=$1",[
      initial.id.slice("act_".length),
    ])).rows[0]!.state).toBe("active");
  });

  test("fails closed when current selection is ambiguous or belongs to another credential",async () => {
    const secondDevice = await db.query<{ id: string }>(
      `INSERT INTO devices(
         principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,model,apns_environment,notification_authorization,live_activity_authorization
       ) VALUES ($1,'current-device-2','current-install-2','Second iPhone','com.example.relo.notifications',
         '1','1','18','iPhone','sandbox','authorized','authorized') RETURNING id`,
      [principalId],
    );
    const secondDeviceId = `dev_${secondDevice.rows[0]!.id}`;
    for (const [name,target] of [["first-current",deviceId],["second-current",secondDeviceId]]) {
      const started = await request("/api/live-activities",{
        acquireMode: "ensure",key: name,title: name,status: "Starting",deviceIds: [target],
      },`${name}-start`);
      expect(started.status).toBe(201);
    }

    for (const [path,body,method] of [
      ["/api/live-activities/resolve",{ current: true },"POST"],
      ["/api/live-activities/current",{ status: "Wrong guess" },"PATCH"],
      ["/api/live-activities/current/end",{},"POST"],
    ] as const) {
      const response = await request(path,body,`ambiguous-${method}-${path.length}`,method);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: "activity_selection_ambiguous",code: "ACTIVITY_SELECTION_AMBIGUOUS",
      });
    }

    const otherToken = "origin_other_current_abcdefghijklmnopqrstuvwxyz";
    await db.query(
      `INSERT INTO principal_api_keys(principal_id,label,token_hash)
       VALUES ($1,'other-current-client',$2)`,
      [principalId,hashToken(otherToken)],
    );
    const foreign = await app().request("/api/live-activities/resolve",{
      method: "POST",headers: { authorization: `Bearer ${otherToken}`,
        "content-type": "application/json","idempotency-key": "foreign-current-resolve" },
      body: JSON.stringify({ current: true }),
    });
    expect(foreign.status).toBe(200);
    expect(await foreign.json()).toEqual({ found: false,activity: null });
  });

  test("serializes concurrent starts and resumes with one later active generation", async () => {
    const concurrentOrigin = { ...origin,thread: "concurrent-thread" };
    const [left,right] = await Promise.all([
      request("/api/live-activities",startBody(concurrentOrigin,0.1),"concurrent-left"),
      request("/api/live-activities",startBody(concurrentOrigin,0.2),"concurrent-right"),
    ]);
    expect([left.status,right.status].sort()).toEqual([200,201]);
    const [leftBody,rightBody] = await Promise.all([left.json(),right.json()]) as any[];
    expect(leftBody.activity.id).toBe(rightBody.activity.id);
    expect(leftBody.activity.generation).toBe(1);
    expect(rightBody.activity.generation).toBe(1);
    expect(new Set([leftBody.activity.sequence,rightBody.activity.sequence])).toEqual(new Set([0,1]));
    const originHash = canonicalOriginHash(principalId,concurrentOrigin);
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM live_activities WHERE principal_id=$1 AND origin_hash=$2 AND state='active'",
      [principalId,originHash],
    )).rows[0]!.count).toBe(1);

    const activityId = leftBody.activity.id;
    const endBody = { status: "Complete",progress: 1 };
    const ended = await request(`/api/live-activities/${activityId}/end`,endBody,"origin-end-1");
    expect(ended.status).toBe(200);
    const endedBody = await ended.json() as any;
    const replay = await request(`/api/live-activities/${activityId}/end`,endBody,"origin-end-1");
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true,activity: endedBody.activity });
    const late = await request(`/api/live-activities/${activityId}`,{ progress: 0.9 },"origin-late", "PATCH");
    expect(late.status).toBe(409);
    expect(await late.json()).toMatchObject({ error: "activity_terminal",activity: { id: activityId,state: "ended" } });

    const resumeInputs = [
      { key: "origin-resume-left",progress: 0.1 },
      { key: "origin-resume-right",progress: 0.2 },
    ];
    const resumed = await Promise.all(resumeInputs.map(({ key,progress }) =>
      request("/api/live-activities",startBody(concurrentOrigin,progress),key)));
    expect(resumed.map((response) => response.status).sort()).toEqual([200,201]);
    const resumedBodies = await Promise.all(resumed.map((response) => response.json())) as any[];
    expect(resumedBodies[0].activity.id).toBe(resumedBodies[1].activity.id);
    expect(resumedBodies[0].activity.id).not.toBe(activityId);
    expect(resumedBodies.map((body) => body.activity.generation)).toEqual([2,2]);
    expect(new Set(resumedBodies.map((body) => body.activity.sequence))).toEqual(new Set([0,1]));
    const createdIndex = resumed.findIndex((response) => response.status === 201);
    const createdBody = resumedBodies[createdIndex]!;
    expect(createdBody).toMatchObject({ reused: false,resumed: true,replayed: false,
      activity: { generation: 2,sequence: 0 } });
    const resumeReplay = await request(
      "/api/live-activities",
      startBody(concurrentOrigin,resumeInputs[createdIndex]!.progress),
      resumeInputs[createdIndex]!.key,
    );
    expect(resumeReplay.status).toBe(200);
    expect(await resumeReplay.json()).toMatchObject({ reused: false,resumed: true,replayed: true,
      activity: createdBody.activity });

    const newerId = resumedBodies[0].activity.id;
    const newerBefore = await app().request(`/api/live-activities/${newerId}`,{
      headers: { authorization: `Bearer ${token}` },
    });
    expect(newerBefore.status).toBe(200);
    const newerSnapshot = (await newerBefore.json() as any).activity;
    const staleUpdate = await request(
      `/api/live-activities/${activityId}`,
      { status: "Late update",progress: 0.9 },
      "origin-stale-update",
      "PATCH",
    );
    expect(staleUpdate.status).toBe(409);
    expect(await staleUpdate.json()).toMatchObject({ error: "activity_terminal",
      activity: { id: activityId,generation: 1,state: "ended" } });
    const staleEnd = await request(`/api/live-activities/${activityId}/end`,{},"origin-stale-end");
    expect(staleEnd.status).toBe(409);
    expect(await staleEnd.json()).toMatchObject({ error: "activity_terminal",
      activity: { id: activityId,generation: 1,state: "ended" } });
    const newerAfter = await app().request(`/api/live-activities/${newerId}`,{
      headers: { authorization: `Bearer ${token}` },
    });
    expect(await newerAfter.json()).toMatchObject({ activity: newerSnapshot });
    expect((await db.query<{ state: string }>(
      "SELECT state FROM live_activities WHERE id=$1",
      [activityId.slice(4)],
    )).rows[0]!.state).toBe("ended");
    expect((await db.query<{ generation: number;state: string }>(
      `SELECT generation,state FROM live_activities
       WHERE principal_id=$1 AND origin_hash=$2 ORDER BY generation`,
      [principalId,originHash],
    )).rows).toEqual([
      { generation: 1,state: "ended" },
      { generation: 2,state: "active" },
    ]);
  });

  test("keeps ordinary events immutable while sharing one collapse identity", async () => {
    const body = { sourceName: "Codex",title: "Task complete",body: "Done",deviceIds: [deviceId],origin };
    const first = await request("/api/notifications",body,"origin-notification-1");
    const second = await request("/api/notifications",{ ...body,body: "Done again" },"origin-notification-2");
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    const eventIds = [(await first.json() as any).eventId,(await second.json() as any).eventId];
    expect(new Set(eventIds).size).toBe(2);
    const rows = await db.query<{ origin_hash: string; count: number; jobs: number }>(
      `SELECT origin_hash,count(*)::int AS count,
         (SELECT count(*)::int FROM delivery_jobs j
          JOIN notification_events n ON n.id=j.notification_event_id
          WHERE n.origin_hash=e.origin_hash) AS jobs
       FROM notification_events e WHERE principal_id=$1 AND origin_hash IS NOT NULL
       GROUP BY origin_hash`,
      [principalId],
    );
    expect(rows.rows).toEqual([{
      origin_hash: canonicalOriginHash(principalId,origin),count: 2,jobs: 2,
    }]);
  });

  test("preserves explicit active-target and cross-generation requester conflicts", async () => {
    const conflictOrigin = { ...origin,thread: "conflict-thread" };
    const first = await request("/api/live-activities",startBody(conflictOrigin),"conflict-start");
    expect(first.status).toBe(201);
    const firstBody = await first.json() as any;
    const otherDevice = await db.query<{ id: string }>(
      `INSERT INTO devices(
         principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,model,apns_environment,notification_authorization,live_activity_authorization
       ) VALUES ($1,'origin-device-2','origin-install-2','Other iPhone','com.example.relo.notifications',
         '1','1','18','iPhone','sandbox','authorized','authorized') RETURNING id`,
      [principalId],
    );
    const targetConflict = await request("/api/live-activities",{
      ...startBody(conflictOrigin),deviceIds: [`dev_${otherDevice.rows[0]!.id}`],
    },"conflict-target");
    expect(targetConflict.status).toBe(409);
    expect(await targetConflict.json()).toMatchObject({
      error: "origin_target_conflict",code: "ORIGIN_TARGET_CONFLICT",activityId: firstBody.activity.id,
    });

    const ended = await request(
      `/api/live-activities/${firstBody.activity.id}/end`,{},"conflict-end",
    );
    expect(ended.status).toBe(200);
    const secondToken = "origin_second_credential_abcdefghijklmnopqrstuvwxyz";
    await db.query(
      `INSERT INTO principal_api_keys(principal_id,label,token_hash)
       VALUES ($1,'second-origin-client',$2)`,
      [principalId,hashToken(secondToken)],
    );
    const requesterConflict = await app().request("/api/live-activities",{
      method: "POST",headers: { authorization: `Bearer ${secondToken}`,
        "content-type": "application/json","idempotency-key": "conflict-requester" },
      body: JSON.stringify(startBody(conflictOrigin)),
    });
    expect(requesterConflict.status).toBe(409);
    expect(await requesterConflict.json()).toEqual({
      error: "active_origin_conflict",code: "ACTIVE_ORIGIN_CONFLICT",
    });
  });

  test("applies the same durable slot and terminal contract to service webhooks", async () => {
    const service = await createWebhookService(db,principalId,"Origin Service","http://127.0.0.1:8180");
    const path = "/hooks/live-activities";
    const auth = { authorization: `Bearer ${service.secret}` };
    const send = (body: unknown,key: string) => app().request(path,{
      method: "POST",headers: { "content-type": "application/json","idempotency-key": key,...auth },
      body: JSON.stringify(body),
    });
    const serviceOrigin = { ...origin,sourceInstance: "build-service",thread: "release-7" };
    const body = { title: "Release",status: "Building",progress: 0.2,deviceIds: [deviceId],origin: serviceOrigin };
    const first = await send(body,"service-origin-start");
    expect(first.status).toBe(201);
    const firstBody = await first.json() as any;
    const progress = await send({ ...body,status: "Shipping",progress: 0.8 },"service-origin-progress");
    expect(progress.status).toBe(200);
    expect(await progress.json()).toMatchObject({
      ok: true,reused: true,replayed: false,
      resumed: false,activity: { id: firstBody.activity.id,generation: 1,sequence: 1,progress: 0.8 },
    });
    const ended = await app().request(`${path}/${firstBody.activity.id}/end`,{
      method: "POST",headers: { "content-type": "application/json","idempotency-key": "service-origin-end",...auth },
      body: JSON.stringify({ status: "Done",progress: 1 }),
    });
    expect(ended.status).toBe(200);
    const next = await send(body,"service-origin-next-start");
    expect(next.status).toBe(201);
    expect(await next.json()).toMatchObject({
      ok: true,reused: false,resumed: true,replayed: false,
      activity: { generation: 2,state: "active" },
    });
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM notification_events WHERE origin_hash=$1",
      [canonicalOriginHash(principalId,serviceOrigin)],
    )).rows[0]!.count).toBe(4);
  });

  test("enforces one active generation while retaining terminal history, events, and operations", async () => {
    const originHash = canonicalOriginHash(principalId,{ ...origin,thread: "retention-thread" });
    const endedPresentation = currentTestPresentationRecord("Only generation","Ended",1);
    const activePresentation = currentTestPresentationRecord("Resurrection","Starting");
    await db.query(
      `INSERT INTO notification_events(
         principal_id,requester_credential_id,source,kind,title,body,idempotency_key,state,origin_hash
       ) SELECT $1,$2,'Retention','notification','Event',g::text,'retention-event-'||g,'active',$3
         FROM generate_series(1,35) g`,
      [principalId,credentialId,originHash],
    );
    const activity = await db.query<{ id: string }>(
      `INSERT INTO live_activities(
         producer_type,principal_id,requester_credential_id,title,status,style,privacy,state,sequence,
         target_device_ids,start_idempotency_key,expires_at,ended_at,origin_hash,generation,
         presentation,presentation_sha256,presentation_policy,presentation_policy_source,
         presentation_preset_id,presentation_preset_revision
       ) VALUES ('script',$1,$2,'Only generation','Ended','standard','standard','ended',1,
         ARRAY[$3::uuid],'retention-activity-1',now()+interval '1 hour',now(),$4,1,
         $5::jsonb,$6,$7::jsonb,$8,$9,$10) RETURNING id`,
      [principalId,credentialId,deviceId.slice(4),originHash,endedPresentation.presentation,
        endedPresentation.presentationHash,endedPresentation.presentationPolicy,
        endedPresentation.presentationPolicySource,endedPresentation.presentationPresetId,
        endedPresentation.presentationPresetRevision],
    );
    await db.query(
      `INSERT INTO live_activity_operations(
         live_activity_id,principal_id,requester_credential_id,idempotency_key,operation,
         resulting_sequence,request_hash,activity_snapshot,presentation_snapshot,presentation_snapshot_sha256
       ) VALUES ($1,$2,$3,'retention-end','end',1,'hash','{}'::jsonb,$4::jsonb,$5)`,
      [activity.rows[0]!.id,principalId,credentialId,endedPresentation.presentation,
        endedPresentation.presentationHash],
    );
    await db.query(
      `INSERT INTO live_activities(
         producer_type,principal_id,requester_credential_id,title,status,style,privacy,state,
         target_device_ids,start_idempotency_key,expires_at,origin_hash,generation,
         presentation,presentation_sha256,presentation_policy,presentation_policy_source,
         presentation_preset_id,presentation_preset_revision
       ) VALUES ('script',$1,$2,'Resurrection','Starting','standard','standard','active',
         ARRAY[$3::uuid],'retention-activity-2',now()+interval '1 hour',$4,2,
         $5::jsonb,$6,$7::jsonb,$8,$9,$10)`,
      [principalId,credentialId,deviceId.slice(4),originHash,activePresentation.presentation,
        activePresentation.presentationHash,activePresentation.presentationPolicy,
        activePresentation.presentationPolicySource,activePresentation.presentationPresetId,
        activePresentation.presentationPresetRevision],
    );
    await expect(db.query(
      `INSERT INTO live_activities(
         producer_type,principal_id,requester_credential_id,title,status,style,privacy,state,
         target_device_ids,start_idempotency_key,expires_at,origin_hash,generation,
         presentation,presentation_sha256,presentation_policy,presentation_policy_source,
         presentation_preset_id,presentation_preset_revision
       ) VALUES ('script',$1,$2,'Duplicate active','Starting','standard','standard','active',
         ARRAY[$3::uuid],'retention-activity-3',now()+interval '1 hour',$4,3,
         $5::jsonb,$6,$7::jsonb,$8,$9,$10)`,
      [principalId,credentialId,deviceId.slice(4),originHash,activePresentation.presentation,
        activePresentation.presentationHash,activePresentation.presentationPolicy,
        activePresentation.presentationPolicySource,activePresentation.presentationPresetId,
        activePresentation.presentationPresetRevision],
    )).rejects.toMatchObject({ code: "23505" });
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM live_activities WHERE origin_hash=$1",
      [originHash],
    )).rows[0]!.count).toBe(2);
    expect((await db.query<{ generation: number;state: string }>(
      "SELECT generation,state FROM live_activities WHERE origin_hash=$1 ORDER BY generation",
      [originHash],
    )).rows).toEqual([{ generation: 1,state: "ended" },{ generation: 2,state: "active" }]);
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM notification_events WHERE origin_hash=$1",
      [originHash],
    )).rows[0]!.count).toBe(35);
    expect((await db.query<{ count: number }>(
      "SELECT count(*)::int AS count FROM live_activity_operations WHERE live_activity_id=$1",
      [activity.rows[0]!.id],
    )).rows[0]!.count).toBe(1);
  });
});
