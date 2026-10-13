import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import {
  executeNotificationRetentionBatch,
  executeContextResourceRetention,
  previewContextResourceRetention,
  previewNotificationRetention,
  runScheduledContentRetention,
  type NotificationRetentionPolicy,
} from "./notification-retention.js";
import { currentTestPresentationRecord } from "./test-current-presentation.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

describe("context resource retention adapter",() => {
  test("previews and executes only through the schema-owner lifecycle function",async () => {
    const queries: Array<{ sql:string;params:unknown[] }> = [];
    const db = { query: async (sql:string,params:unknown[] = []) => {
      queries.push({ sql,params });
      return sql.includes("run_context_resource_gc")
        ? { rows:[{ run_id:"run-id",aliases_pruned:2,projects_pruned:1 }] }
        : { rows:[{ eligible_projects:1 }] };
    } } as any;
    const policy = { cutoff:new Date("2026-08-01T00:00:00.000Z"),batchSize:50,releaseIdentity:"0.7.13-test" };
    expect(await previewContextResourceRetention(db,policy)).toEqual({ eligibleProjects:1 });
    expect(await executeContextResourceRetention(db,policy)).toEqual({ runId:"run-id",aliasesPruned:2,projectsPruned:1 });
    expect(queries[1]!.sql).toContain("run_context_resource_gc");
    expect(queries[1]!.params).toEqual([policy.cutoff,50,"0.7.13-test"]);
  });
});

suite("bounded notification retention", () => {
  let db: Database;

  const policy = (overrides: Partial<NotificationRetentionPolicy> = {}): NotificationRetentionPolicy => ({
    cutoff: new Date("2026-07-01T00:00:00.000Z"),
    maximumEventsPerPrincipal: 250,
    batchSize: 500,
    tombstoneDays: 90,
    releaseIdentity: "retention-test",
    ...overrides,
  });

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
  });

  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    await db.query("TRUNCATE notification_retention_runs,notification_idempotency_tombstones");
  });

  afterAll(async () => db.end());

  test("prunes terminal history while preserving pending responses and active activities", async () => {
    const principal = (await db.query<{ id: string }>(
      "INSERT INTO owner_principals(handle) VALUES ('retention-owner') RETURNING id",
    )).rows[0]!.id;
    const device = (await db.query<{ id: string }>(
      `INSERT INTO devices(
         principal_id,stable_device_id,installation_id,name,bundle_identifier,
         app_version,app_build,os_version,apns_environment
       ) VALUES ($1,'retention-stable','retention-install','Retention iPhone',
         'com.example.relo.notifications','1','1','18','sandbox') RETURNING id`,
      [principal],
    )).rows[0]!.id;
    const terminal = (await db.query<{ id: string }>(
      `INSERT INTO notification_events(
         principal_id,source,title,body,idempotency_key,request_hash,created_at,updated_at
       ) VALUES ($1,'Retention','Terminal','Disposable','retention-terminal','terminal-hash',
         '2026-06-01','2026-06-01') RETURNING id`,
      [principal],
    )).rows[0]!.id;
    const job = (await db.query<{ id: string }>(
      `INSERT INTO delivery_jobs(notification_event_id,device_id,state)
       VALUES ($1,$2,'canceled') RETURNING id`,
      [terminal,device],
    )).rows[0]!.id;
    await db.query(
      `INSERT INTO delivery_attempts(
         delivery_job_id,claim_token,job_attempt,provider_attempts,outcome_category
       ) VALUES ($1,$2,1,0,'validation')`,
      [job,randomUUID()],
    );

    const pending = (await db.query<{ id: string }>(
      `INSERT INTO notification_events(
         principal_id,source,title,body,idempotency_key,created_at,updated_at
       ) VALUES ($1,'Retention','Pending','Durable','retention-pending','2026-06-01','2026-06-01')
       RETURNING id`,
      [principal],
    )).rows[0]!.id;
    await db.query(
      `INSERT INTO interaction_requests(
         principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at
       ) VALUES ($1,$2,'approval','Keep me',$3,'2027-01-01')`,
      [principal,pending,"a".repeat(64)],
    );

    const presentation = currentTestPresentationRecord("Active","Running");
    const activity = (await db.query<{ id: string }>(
      `INSERT INTO live_activities(
         principal_id,activity_key,title,status,target_device_ids,start_idempotency_key,expires_at,
         presentation,presentation_sha256,presentation_policy,presentation_policy_source,
         presentation_preset_id,presentation_preset_revision
       ) VALUES ($1,'retention-active','Active','Running',ARRAY[$2::uuid],
         'retention-active-start','2027-01-01',$3::jsonb,$4,$5::jsonb,$6,$7,$8) RETURNING id`,
      [principal,device,presentation.presentation,presentation.presentationHash,
        presentation.presentationPolicy,presentation.presentationPolicySource,
        presentation.presentationPresetId,presentation.presentationPresetRevision],
    )).rows[0]!.id;
    const activeEvent = (await db.query<{ id: string }>(
      `INSERT INTO notification_events(
         principal_id,source,kind,title,body,payload,idempotency_key,created_at,updated_at
       ) VALUES ($1,'Retention','live_activity','Active','Durable',$2,
         'retention-active-event','2026-06-01','2026-06-01') RETURNING id`,
      [principal,{ liveActivity: { activityId: `act_${activity}` } }],
    )).rows[0]!.id;

    expect(await previewNotificationRetention(db,policy())).toEqual({
      eligibleEvents: 1,
      protectedPendingEvents: 1,
      protectedActiveActivityEvents: 1,
      expiredTombstones: 0,
    });
    const result = await executeNotificationRetentionBatch(db,policy());
    expect(result.eventsPruned).toBe(1);
    expect((await db.query("SELECT 1 FROM notification_events WHERE id=$1",[terminal])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM delivery_attempts WHERE delivery_job_id=$1",[job])).rowCount).toBe(0);
    expect((await db.query("SELECT 1 FROM notification_events WHERE id=ANY($1::uuid[])",[
      [pending,activeEvent],
    ])).rowCount).toBe(2);
    expect((await db.query("SELECT count(*)::int AS count FROM notification_retention_runs")).rows[0].count).toBe(1);

    const replay = await db.query(
      `INSERT INTO notification_events(
         principal_id,source,title,body,idempotency_key,request_hash
       ) VALUES ($1,'Retention','Replay','Blocked','retention-terminal','terminal-hash')
       RETURNING id`,
      [principal],
    );
    expect(replay.rowCount).toBe(0);
  });

  test("enforces the per-account cap in bounded batches and denies runtime retention authority", async () => {
    const principal = (await db.query<{ id: string }>(
      "INSERT INTO owner_principals(handle) VALUES ('cap-owner') RETURNING id",
    )).rows[0]!.id;
    await db.query(
      `INSERT INTO notification_events(
         principal_id,source,title,body,idempotency_key,created_at,updated_at
       ) SELECT $1,'Retention',concat('Event ',series),'Body',concat('cap-event-',series),
         '2026-08-01'::timestamptz+series*interval '1 second',
         '2026-08-01'::timestamptz+series*interval '1 second'
       FROM generate_series(1,253) series`,
      [principal],
    );
    const capPolicy = policy({ cutoff: new Date("2026-01-01T00:00:00.000Z"),batchSize: 2 });
    expect((await previewNotificationRetention(db,capPolicy)).eligibleEvents).toBe(3);
    expect((await executeNotificationRetentionBatch(db,capPolicy)).eventsPruned).toBe(2);
    expect((await executeNotificationRetentionBatch(db,capPolicy)).eventsPruned).toBe(1);
    expect((await db.query("SELECT count(*)::int AS count FROM notification_events")).rows[0].count).toBe(250);
    expect((await db.query(
      "SELECT count(*)::int AS count FROM notification_idempotency_tombstones",
    )).rows[0].count).toBe(3);

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE relo_runtime");
      await expect(client.query(
        "SELECT * FROM run_notification_retention(now(),250,10,interval '90 days','runtime')",
      )).rejects.toMatchObject({ code: "42501" });
      await client.query("ROLLBACK");
    } finally {
      client.release();
    }
  });

  test("lets the runtime role delete content past the configured window and nothing newer", async () => {
    const principal = (await db.query<{ id: string }>(
      "INSERT INTO owner_principals(handle) VALUES ('window-owner') RETURNING id",
    )).rows[0]!.id;
    const insertEvent = async (key: string,ageHours: number) => (await db.query<{ id: string }>(
      `INSERT INTO notification_events(
         principal_id,source,title,body,idempotency_key,created_at,updated_at
       ) VALUES ($1,'Retention',$2,'Private words',$2,
         now()-make_interval(hours => $3),now()-make_interval(hours => $3)) RETURNING id`,
      [principal,key,ageHours],
    )).rows[0]!.id;
    const expired = await insertEvent("window-expired",11);
    const recent = await insertEvent("window-recent",9);
    const pendingExpired = await insertEvent("window-pending",30);
    await db.query(
      `INSERT INTO interaction_requests(
         principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at
       ) VALUES ($1,$2,'approval','Still waiting',$3,now()+interval '1 day')`,
      [principal,pendingExpired,"b".repeat(64)],
    );

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE relo_runtime");
      const result = await runScheduledContentRetention(client as any,{
        retentionHours: 10,releaseIdentity: "worker-test",
      });
      expect(result).toEqual({ batches: 1,eventsPruned: 1,tombstonesExpired: 0,cardsPruned: 0 });
      await expect(client.query("SELECT * FROM run_scheduled_content_retention(0,'worker-test')"))
        .rejects.toThrow("invalid content retention window");
      await client.query("ROLLBACK");
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE relo_runtime");
      await runScheduledContentRetention(client as any,{ retentionHours: 10,releaseIdentity: "worker-test" });
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const remaining = (await db.query<{ id: string }>(
      "SELECT id FROM notification_events WHERE principal_id=$1",[principal],
    )).rows.map(row => row.id).sort();
    expect(remaining).toEqual([recent,pendingExpired].sort());
    expect(remaining).not.toContain(expired);
    await expect(runScheduledContentRetention(db,{ retentionHours: 0,releaseIdentity: "worker-test" }))
      .rejects.toThrow("invalid_scheduled_content_retention");
  });

  test("removes ended cards past the window once their events are gone, never active ones (E1.2)", async () => {
    const principal = (await db.query<{ id: string }>(
      "INSERT INTO owner_principals(handle) VALUES ('card-window-owner') RETURNING id",
    )).rows[0]!.id;
    const device = (await db.query<{ id: string }>(
      `INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,app_version,app_build,
         os_version,apns_environment) VALUES ($1,'card-stable','card-install','Card iPhone','com.example.relo.notifications',
         '1','1','18','sandbox') RETURNING id`,[principal],
    )).rows[0]!.id;
    const presentation = currentTestPresentationRecord("Secret card","Secret status");
    const card = async (key: string,state: "active" | "ended",endedHoursAgo: number) => (await db.query<{ id: string }>(
      `INSERT INTO live_activities(
         principal_id,activity_key,title,status,target_device_ids,start_idempotency_key,expires_at,state,ended_at,updated_at,
         presentation,presentation_sha256,presentation_policy,presentation_policy_source,presentation_preset_id,
         presentation_preset_revision
       ) VALUES ($1,$2,'Secret card','Secret status',ARRAY[$3::uuid],$2,now()+interval '1 day',$4::live_activity_state,
         CASE WHEN $4='ended' THEN now()-make_interval(hours => $5) END,now()-make_interval(hours => $5),
         $6::jsonb,$7,$8::jsonb,$9,$10,$11) RETURNING id`,
      [principal,key,device,state,endedHoursAgo,presentation.presentation,presentation.presentationHash,
        presentation.presentationPolicy,presentation.presentationPolicySource,presentation.presentationPresetId,
        presentation.presentationPresetRevision],
    )).rows[0]!.id;
    const oldEnded = await card("old-ended","ended",30);
    const recentEnded = await card("recent-ended","ended",2);
    const oldActive = await card("old-active","active",30);

    const client = await db.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL ROLE relo_runtime");
      const result = await runScheduledContentRetention(client as any,{ retentionHours: 10,releaseIdentity: "worker-test" });
      expect(result.cardsPruned).toBe(1);
      await client.query("COMMIT");
    } finally {
      client.release();
    }
    const remaining = (await db.query<{ id: string }>("SELECT id FROM live_activities WHERE principal_id=$1",[principal]))
      .rows.map(row => row.id).sort();
    expect(remaining).toEqual([recentEnded,oldActive].sort());
    expect(remaining).not.toContain(oldEnded);
  });
});
