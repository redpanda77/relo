import { randomUUID } from "node:crypto";
import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { currentTestPresentationRecord } from "./test-current-presentation.js";
import { createActivityCommands } from "./activities.js";
import { prepareLatestActivityFrame } from "./activity-delivery-frame.js";
import { claimDeliveryJobs,finalizeDeliveryClaim,markDeliveryClaimForReconciliation,type ClaimedDeliveryJob } from "./apns-worker-state.js";
import { deliveryProjection,deliverySerializationEvidence } from "./delivery-serialization.js";
import type { ApnsRuntimeJob } from "./apns-runtime.js";
import { settleInteractiveLiveActivity } from "./interactive-activity-lifecycle.js";
import { deleteFixtureOwner } from "./test-support/delete-fixture-owner.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("durable current ActivityKit frames", () => {
  let db: Database,principalId: string,deviceId: string,activityId: string;
  let now: number;

  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!);await migrate(db); });
  beforeEach(async () => {
    if (principalId) await deleteFixtureOwner(db,principalId);
    now = Math.floor(Date.now()/1_000)*1_000+100;
    principalId = (await db.query("INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",[`frames-${randomUUID()}`])).rows[0].id;
    deviceId = (await db.query(
      `INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
         app_version,app_build,os_version,apns_environment,live_activity_authorization,live_activity_push_to_start_token)
       VALUES ($1,$2,$3,'Frames','com.example.frames','1','1','27','sandbox','authorized','test-start') RETURNING id`,
      [principalId,randomUUID(),randomUUID()],
    )).rows[0].id;
    const p = currentTestPresentationRecord();
    activityId = (await db.query(
      `INSERT INTO live_activities(producer_type,principal_id,activity_key,title,status,start_idempotency_key,
         target_device_ids,generation,presentation,presentation_sha256,presentation_policy,
         presentation_policy_source,presentation_preset_id,presentation_preset_revision)
       VALUES ('script',$1,$2,'Frames','Working',$3,$4,1,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [principalId,randomUUID(),randomUUID(),[deviceId],p.presentation,p.presentationHash,p.presentationPolicy,
        p.presentationPolicySource,p.presentationPresetId,p.presentationPresetRevision],
    )).rows[0].id;
  });
  afterAll(async () => {
    if (principalId) await deleteFixtureOwner(db,principalId);
    await db.end();
  });

  async function revision(sequence: number,operation: "start" | "update" | "end" = "update",generation = 1) {
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      const activity = (await tx.query(
        `UPDATE live_activities SET sequence=$2,generation=$3,updated_at=clock_timestamp(),
           state=CASE WHEN $4='end' THEN 'ended'::live_activity_state ELSE 'active'::live_activity_state END
         WHERE id=$1 RETURNING *`,[activityId,sequence,generation,operation],
      )).rows[0];
      await createActivityCommands(tx,{ principalId,sourceName: "Frames",activity,operation,apnsMode: "sandbox" });
      await tx.query("COMMIT");
    } catch (error) { await tx.query("ROLLBACK");throw error; } finally { tx.release(); }
  }
  async function claim() {
    await db.query("UPDATE delivery_jobs SET available_at=now() WHERE live_activity_id=$1 AND state='retry'",[activityId]);
    const jobs = await claimDeliveryJobs(db,100,new Date(0));
    const job = jobs.find(j => j.live_activity_id === activityId);
    expect(job).toBeDefined();
    return job!;
  }
  async function token(generation = 1) {
    await db.query(
      `INSERT INTO live_activity_update_tokens(live_activity_id,device_id,generation,token,environment,native_activity_id)
       VALUES ($1,$2,$3,'test-update','sandbox','native-test') ON CONFLICT (live_activity_id,device_id)
       DO UPDATE SET generation=EXCLUDED.generation,token=EXCLUDED.token`,[activityId,deviceId,generation],
    );
  }
  const projections: unknown[] = [];
  async function prepare(job: ClaimedDeliveryJob) {
    const command = job.payload.liveActivity as Record<string,unknown>;
    return prepareLatestActivityFrame(db,job,command,10,(timestamp,transport) => {
      const runtime: ApnsRuntimeJob = {
        id: job.id,claimToken: job.claim_token,attemptCount: job.attempt_count,providerAttemptsUsed: 0,
        providerRetryStartedAt: null,providerRetryAttemptCap: null,providerRetryHorizonAt: null,
        providerNextAttemptNotBefore: null,providerStatus: null,transport,createdAt: job.created_at,
        expiresAt: job.expires_at,title: job.title,body: job.body,sourceName: job.source,conversationId: null,
        avatarUrl: null,imageUrl: null,deepLink: null,notificationId: `ntf_${job.event_id}`,accountId: `acc_${principalId}`,
        interactionKind: job.interaction_kind,interactionId: job.interaction_id,badge: 0,payload: job.payload,
        activityCommand: { ...command,providerTimestamp: timestamp,...(transport === "live_activity_start" ? { alertOwner: "apns" } : {}) },
      };
      projections.push(deliveryProjection(runtime));
      return deliverySerializationEvidence(runtime);
    },() => now);
  }

  test("thirty revisions keep one unsent latest start and preserve all historical commands", async () => {
    await revision(0,"start");
    for (let n=1;n<30;n++) await revision(n);
    expect((await db.query("SELECT count(*)::int AS n FROM delivery_jobs WHERE live_activity_id=$1 AND state='pending'",[activityId])).rows[0].n).toBe(1);
    expect((await db.query("SELECT count(*)::int AS n FROM notification_events WHERE principal_id=$1",[principalId])).rows[0].n).toBe(30);
    const job = await claim();
    expect(job.payload.liveActivity).toMatchObject({ sequence: 29,operation: "update" });
    expect(await prepare(job)).toEqual({ kind: "ready",timestamp: Math.floor(now/1_000),transport: "live_activity_start" });
    expect(projections.at(-1)).toMatchObject({ operation: "start",contentState: { sequence: 29 } });
    expect((await db.query("SELECT payload FROM notification_events WHERE id=$1",[job.event_id])).rows[0].payload.liveActivity.operation).toBe("update");
  });

  test("a replacement start at a new generation is sent as push-to-start while the old generation's update token exists", async () => {
    await revision(0,"start");
    const first = await claim();
    await prepare(first);
    await finalizeDeliveryClaim(db,first,{ kind: "accepted" });
    await token(1);
    await revision(1,"start",2);
    const job = await claim();
    expect(await prepare(job)).toMatchObject({ kind: "ready",transport: "live_activity_start" });
    expect(projections.at(-1)).toMatchObject({ operation: "start" });
  });

  test("terminal burst replaces progress, waits only for the next real second, and never starts an ended activity", async () => {
    await revision(0,"start");
    const started = await claim();
    await prepare(started);
    await finalizeDeliveryClaim(db,started,{ kind: "accepted" });
    await token();
    for (let n=1;n<30;n++) await revision(n);
    await revision(30,"end");
    let end = await claim();
    expect(await prepare(end)).toEqual({ kind: "deferred",reason: "next_second" });
    now = Math.floor(now/1_000)*1_000+1_000;
    end = await claim();
    expect(await prepare(end)).toEqual({ kind: "ready",timestamp: now/1_000,transport: "live_activity_update" });
    expect(projections.at(-1)).toMatchObject({ operation: "end",contentState: { sequence: 30 } });
    expect((await db.query("SELECT count(*)::int AS n FROM delivery_jobs WHERE live_activity_id=$1 AND state IN ('pending','retry')",[activityId])).rows[0].n).toBe(0);
  });

  test("missing token does not reserve transport time; registration releases only a current frame", async () => {
    await revision(0,"start");const start = await claim();await prepare(start);
    await finalizeDeliveryClaim(db,start,{ kind: "accepted" });
    await revision(1);const waiting = await claim();
    expect(await prepare(waiting)).toEqual({ kind: "deferred",reason: "activity_token_pending" });
    expect((await db.query("SELECT activity_provider_timestamp FROM delivery_jobs WHERE id=$1",[waiting.id])).rows[0].activity_provider_timestamp).toBeNull();
    await token();now += 5_000;
    expect(await prepare(await claim())).toMatchObject({ kind: "ready",timestamp: Math.floor(now/1_000) });
  });

  test("a durable retry and process restart reuse identical pinned timestamp and bytes", async () => {
    await revision(0,"start");const first = await claim();await prepare(first);
    const body = projections.at(-1);
    await db.query("UPDATE delivery_jobs SET state='retry',claim_token=NULL,claim_phase=NULL WHERE id=$1",[first.id]);
    now += 60_000;
    const next = await claim();expect(next.claim_token).not.toBe(first.claim_token);
    expect(await prepare(next)).toMatchObject({ kind: "ready",timestamp: Math.floor((now-60_000)/1_000) });
    expect(projections.at(-1)).toEqual(body);
  });

  test("clock rollback keeps just the latest pending state without changing the durable head", async () => {
    await revision(0,"start");await prepare(await claim());await token();
    const fenced = Math.floor(now/1_000);now -= 10_000;
    for (let n=1;n<30;n++) await revision(n);
    expect(await prepare(await claim())).toEqual({ kind: "deferred",reason: "clock_rollback" });
    expect((await db.query("SELECT last_provider_timestamp FROM activity_delivery_heads WHERE live_activity_id=$1",[activityId])).rows[0].last_provider_timestamp).toBe(String(fenced));
    expect((await db.query("SELECT count(*)::int AS n FROM delivery_jobs WHERE live_activity_id=$1 AND state='retry'",[activityId])).rows[0].n).toBe(1);
  });

  test("new generation cancels unstarted old work while preserving ambiguous dispatch evidence", async () => {
    await revision(0,"start");const old = await claim();await prepare(old);
    await markDeliveryClaimForReconciliation(db,old,"injected_ambiguity","Test response lost");
    await revision(1);const stale = await claim();
    await revision(2,"start",2);
    await expect(prepare(stale)).rejects.toThrow("ownership was lost");
    expect((await db.query("SELECT state FROM delivery_jobs WHERE id=$1",[old.id])).rows[0].state).toBe("reconciliation_required");
    expect(await prepare(await claim())).toMatchObject({ kind: "ready",transport: "live_activity_start" });
  });

  test("a preparation failure atomically rolls back time, hashes and dispatch fence", async () => {
    await revision(0,"start");const job = await claim();
    await expect(prepareLatestActivityFrame(db,job,job.payload.liveActivity as Record<string,unknown>,10,
      () => { throw new Error("injected serialization failure"); },() => now)).rejects.toThrow("injected");
    expect((await db.query("SELECT activity_provider_timestamp,canonical_intent_sha256,claim_phase FROM delivery_jobs WHERE id=$1",[job.id])).rows[0]).toEqual({ activity_provider_timestamp: null,canonical_intent_sha256: null,claim_phase: "preparing" });
    expect((await db.query("SELECT * FROM activity_delivery_heads WHERE live_activity_id=$1",[activityId])).rowCount).toBe(0);
  });

  test("expired interaction cleanup retains an independent hour and waits for a late token without restarting", async () => {
    await revision(0,"start");
    const event = (await db.query("SELECT id FROM notification_events WHERE principal_id=$1",[principalId])).rows[0];
    await db.query("UPDATE notification_events SET state='expired',expires_at=now()-interval '1 second' WHERE id=$1",[event.id]);
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      await settleInteractiveLiveActivity(tx,{ principalId,notificationEventId: event.id,responseState: "expired",apnsMode: "sandbox" });
      await tx.query("COMMIT");
    } catch (error) { await tx.query("ROLLBACK");throw error; } finally { tx.release(); }
    const cleanup = await claim();
    expect(cleanup.payload.liveActivity).toMatchObject({ operation: "end",sequence: 1 });
    expect(cleanup.expires_at!.getTime()-Date.now()).toBeGreaterThan(3_598_000);
    expect(await prepare(cleanup)).toEqual({ kind: "deferred",reason: "activity_token_pending" });
    await token();
    expect(await prepare(await claim())).toMatchObject({ kind: "ready",transport: "live_activity_update" });
    expect(projections.at(-1)).toMatchObject({ operation: "end" });
  });

  test("runtime can advance frame heads but cannot delete replay fences", async () => {
    const grants = (await db.query(`SELECT
      has_table_privilege('relo_runtime','activity_delivery_heads','SELECT,INSERT,UPDATE') AS writable,
      has_table_privilege('relo_runtime','activity_delivery_heads','DELETE') AS deletable`)).rows[0];
    expect(grants).toEqual({ writable: true,deletable: false });
  });
});
