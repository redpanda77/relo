import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase,type Database } from "./db.js";
import { migrate } from "./migrate.js";
import {
  deferMissingActivityToken,finalizeDeliveryClaim,type ClaimedDeliveryJob,
} from "./apns-worker-state.js";
import { reconcileDeliveryJob } from "./delivery-reconciliation.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;

suite("delivery state enum transitions", () => {
  let db: Database;
  let principalId: string;
  let deviceId: string;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
  });

  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    principalId = (await db.query<{ id: string }>(
      "INSERT INTO owner_principals(handle) VALUES ('delivery-state-owner') RETURNING id",
    )).rows[0]!.id;
    deviceId = (await db.query<{ id: string }>(
      `INSERT INTO devices(
         principal_id,stable_device_id,installation_id,name,bundle_identifier,
         app_version,app_build,os_version,apns_environment
       ) VALUES ($1,'delivery-state-device','delivery-state-installation','Test iPhone',
         'com.example.relo.notifications','1','1','26','sandbox') RETURNING id`,
      [principalId],
    )).rows[0]!.id;
  });

  afterAll(async () => db.end());

  async function createEvent(payload: Record<string,unknown>) {
    return (await db.query<{ id: string }>(
      `INSERT INTO notification_events(
         principal_id,source,title,body,idempotency_key,payload
       ) VALUES ($1,'Test','Delivery state','State transition',$2,$3) RETURNING id`,
      [principalId,`delivery-state-${randomUUID()}`,payload],
    )).rows[0]!.id;
  }

  async function createProcessingJob(eventId: string): Promise<ClaimedDeliveryJob> {
    const claimToken = randomUUID();
    const id = (await db.query<{ id: string }>(
      `INSERT INTO delivery_jobs(
         notification_event_id,device_id,state,transport,attempt_count,claim_token,
         claim_started_at,claim_phase,lease_expires_at
       ) VALUES ($1,$2,'processing','live_activity_update',1,$3,now(),
         'dispatch_started',now()+interval '1 minute') RETURNING id`,
      [eventId,deviceId,claimToken],
    )).rows[0]!.id;
    return {
      id,claim_token: claimToken,principal_id: principalId,device_id: deviceId,
      transport: "live_activity_update",live_activity_id: null,event_id: eventId,
      title: "Delivery state",body: "State transition",source: "Test",service_id: null,
      requester_credential_id: null,service_image_url: null,image_url: null,deep_link: null,
      expires_at: new Date(Date.now()+60_000),payload: { liveActivity: { operation: "update" } },
      interaction_kind: null,interaction_id: null,interaction_state: null,
      interaction_expires_at: null,credential_version: 1,attempt_count: 1,
      provider_attempts_used: 0,provider_retry_started_at: null,provider_status: null,
      provider_retry_attempt_cap: null,provider_retry_horizon_at: null,
      provider_next_attempt_not_before: null,apns_priority: 5,first_claimed_at: new Date(),
      last_claimed_at: new Date(),last_dispatch_started_at: new Date(),created_at: new Date(),
    };
  }

  test("defers a missing ActivityKit token without enum/text inference failure", async () => {
    const eventId = await createEvent({ liveActivity: { operation: "update" } });
    const claimed = await createProcessingJob(eventId);
    await deferMissingActivityToken(db,claimed,true);
    expect((await db.query(
      "SELECT state,last_error_code,claim_token FROM delivery_jobs WHERE id=$1",
      [claimed.id],
    )).rows[0]).toMatchObject({ state: "retry",last_error_code: "activity_token_pending",claim_token: null });
  });

  test("persists the general retry transition with the delivery-state enum", async () => {
    const eventId = await createEvent({});
    const claimed = await createProcessingJob(eventId);
    await finalizeDeliveryClaim(db,claimed,{ kind: "retry",code: "temporary",message: "Temporary" });
    expect((await db.query(
      "SELECT state,last_error_code FROM delivery_jobs WHERE id=$1",
      [claimed.id],
    )).rows[0]).toMatchObject({ state: "retry",last_error_code: "temporary" });
  });

  test("retries a real live_activity_update reconciliation idempotently", async () => {
    const eventId = await createEvent({ liveActivity: { operation: "update" } });
    const jobId = (await db.query<{ id: string }>(
      `INSERT INTO delivery_jobs(
         notification_event_id,device_id,state,transport,last_error_code
       ) VALUES ($1,$2,'reconciliation_required','live_activity_update',
         'provider_dispatch_persistence_failed') RETURNING id`,
      [eventId,deviceId],
    )).rows[0]!.id;
    const input = {
      principalId,deliveryJobId: jobId,action: "retry" as const,actor: { kind: "dashboard" as const },
    };
    await expect(reconcileDeliveryJob(db,input)).resolves.toMatchObject({
      action: "retry",state: "retry",replayed: false,
    });
    await expect(reconcileDeliveryJob(db,input)).resolves.toMatchObject({
      action: "retry",state: "retry",replayed: true,
    });
  });
});
