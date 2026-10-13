import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.js";
import { hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase, type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { claimDeliveryJobs } from "../apns-worker-state.js";
import { cancelUndeliverableDeliveryJobs } from "../delivery-lifecycle.js";
import { PostgresApnsRecipientResolver } from "../apns-recipient-resolver.js";
import { createTransportTokenEncryption } from "../token-encryption.js";

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Ordinary notice canonical admission and dispatch", () => {
  let db: Database, principalId: string, credentialId: string, deviceId: string;
  const owner = "notice_admission_owner_abcdefghijklmnopqrstuvwxyz";
  const other = "notice_admission_other_abcdefghijklmnopqrstuvwxyz";
  const secret = "notice-admission-test-secret-at-least-32-characters";
  const encryption = createTransportTokenEncryption(secret);
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    await bootstrapOwner(db,"notice-owner",owner);
    const key = (await db.query("SELECT id,principal_id FROM principal_api_keys WHERE token_hash=$1",[hashToken(owner)])).rows[0];
    credentialId = key.id; principalId = key.principal_id;
    await db.query(`INSERT INTO principal_api_keys(principal_id,label,token_hash,token_prefix,scopes)
      VALUES ($1,'other',$2,'other',ARRAY['notifications:send'])`,[principalId,hashToken(other)]);
    deviceId = (await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token)
      VALUES ($1,$2,$3,'Notice phone','com.example.relo.notifications','1','1','26','sandbox','authorized',$4) RETURNING id`,
      [principalId,randomUUID(),randomUUID(),encryption.encrypt("notice-token","device.apns_token")])).rows[0].id;
  });
  const command = (revision = 1,generation = 1,ageSeconds = 0) => ({
    subjectKey: "work:release",generation,revision,operation: revision === 1 ? "replace" : "update",
    occurredAt: new Date(Date.now()-ageSeconds*1_000).toISOString(),policy: { kind: "notice" },
  });
  async function send(relevance?: unknown,key = randomUUID(),token = owner) {
    const response = await createApp(db,{ apnsMode: "disabled",credentialDerivationSecret: secret }).request("/api/notifications",{
      method: "POST",headers: { authorization: `Bearer ${token}`,"content-type": "application/json","idempotency-key": key },
      body: JSON.stringify({ sourceName: "Same display name",title: "Current work",body: "Useful text",
        ...(relevance ? { relevance } : {}) }),
    });
    return { status: response.status,body: await response.json() as any };
  }
  const raw = (id: string) => id.slice(4);
  function resolver(eventId: string,jobId: string,claimToken: string) {
    return new PostgresApnsRecipientResolver({ db,encryption,kind: "notification",deliveryJobId: jobId,
      claimToken,principalId,deviceId,notificationEventId: eventId,environment: "sandbox" });
  }
  test("default admission persists separate immutable relevance and delivery deadlines, including replay",async () => {
    const key = randomUUID(); const first = await send(undefined,key);
    expect(first.status).toBe(201); expect(first.body.queued).toBe(1);
    const deadlines = first.body.relevance.deadlines;
    expect(Date.parse(deadlines.relevantUntil)-Date.parse(deadlines.occurredAt)).toBe(900_000);
    expect(Date.parse(deadlines.deliverUntil)-Date.parse(deadlines.occurredAt)).toBe(60_000);
    const replay = await send(undefined,key);
    expect(replay.status).toBe(200); expect(replay.body.relevance).toEqual(first.body.relevance);
    const jobs = await claimDeliveryJobs(db,10,new Date(0));
    expect(jobs).toHaveLength(1); expect(jobs[0]!.expires_at?.toISOString()).toBe(deadlines.deliverUntil);
    expect((await db.query("SELECT expires_at FROM notification_events WHERE id=$1",[raw(first.body.eventId)])).rows[0].expires_at.toISOString()).toBe(deadlines.relevantUntil);
  });
  test("a delayed notice remains history/current evidence but never queues or dispatches a late alert",async () => {
    const first = await send(command(1,1,61));
    expect(first.status).toBe(201); expect(first.body.queued).toBe(0);
    const eventId = raw(first.body.eventId);
    // Recover a pre-existing unsent attempt: every worker boundary still enforces the deadline.
    const jobId = (await db.query("INSERT INTO delivery_jobs(notification_event_id,device_id) VALUES ($1,$2) RETURNING id",[eventId,deviceId])).rows[0].id;
    expect(await claimDeliveryJobs(db,10,new Date(0))).toEqual([]);
    expect(await cancelUndeliverableDeliveryJobs(db)).toBe(1);
    expect((await db.query("SELECT state,last_error_code FROM delivery_jobs WHERE id=$1",[jobId])).rows[0])
      .toMatchObject({ state: "canceled",last_error_code: "relevance_delivery_closed" });
    const claimToken = randomUUID();
    await db.query(`UPDATE delivery_jobs SET state='processing',claim_phase='dispatch_started',claim_token=$2,
      claim_started_at=now(),lease_expires_at=now()+interval '2 minutes' WHERE id=$1`,[jobId,claimToken]);
    await expect(resolver(eventId,jobId,claimToken).acquire()).resolves.toBeNull();
    expect((await db.query("SELECT state FROM notification_events WHERE id=$1",[eventId])).rows[0].state).toBe("active");
  });
  test("replacement cancels only unstarted work; fenced evidence stays immutable and loses authorization",async () => {
    const first = await send(command());
    const [job] = await claimDeliveryJobs(db,10,new Date(0));
    const hash = "a".repeat(64);
    await db.query(`UPDATE delivery_jobs SET claim_phase='dispatch_started',canonical_intent_sha256=$2,
      device_projection_sha256=$2 WHERE id=$1`,[job!.id,hash]);
    const replacement = await send(command(1,2));
    expect(replacement.status).toBe(201);
    const old = (await db.query("SELECT state,canonical_intent_sha256,device_projection_sha256 FROM delivery_jobs WHERE id=$1",[job!.id])).rows[0];
    expect(old).toEqual({ state: "processing",canonical_intent_sha256: hash,device_projection_sha256: hash });
    await expect(resolver(raw(first.body.eventId),job!.id,job!.claim_token).acquire()).resolves.toBeNull();
    expect((await claimDeliveryJobs(db,10,new Date(0))).map(value => value.event_id)).toEqual([raw(replacement.body.eventId)]);
    expect((await send(command(2,1))).body.error).toBe("stale");
  });
  test("same-version replay under a different key returns the original receipt without a second event or job",async () => {
    const input = command(); const first = await send(input); const duplicate = await send(input);
    expect(duplicate.status).toBe(200); expect(duplicate.body.eventId).toBe(first.body.eventId);
    expect(duplicate.body.relevance).toEqual(first.body.relevance);
    expect((await db.query("SELECT count(*)::int AS count FROM notification_events")).rows[0].count).toBe(1);
    expect((await send({ ...input,policy: { kind: "notice",relevanceSeconds: 1800 } })).body.error).toBe("version_conflict");
  });
  test("authenticated sources stay separate; client authority, future occurrence, and non-notice policies are rejected",async () => {
    const input = command();
    const first = await send(input); const independent = await send(input,randomUUID(),other);
    expect(independent.status).toBe(201); expect(independent.body.relevance.identity.sourceId).not.toBe(first.body.relevance.identity.sourceId);
    expect(first.body.relevance.identity.sourceId).toBe(`credential:${credentialId}`);
    expect((await send({ ...command(),accountId: `acc_${principalId}` })).status).toBe(400);
    expect((await send({ ...command(),sourceId: "spoof" })).status).toBe(400);
    expect((await send({ ...command(),subjectKey: "future",occurredAt: new Date(Date.now()+60_000).toISOString() })).body.error).toBe("invalid_relevance");
    expect((await send({ ...command(),policy: { kind: "decision" } })).status).toBe(400);
  });
  test("pruning a legacy-shaped producer receipt cannot reopen its independent subject",async () => {
    const key = randomUUID(); const first = await send(undefined,key);
    await db.query("DELETE FROM notification_events WHERE id=$1",[raw(first.body.eventId)]);
    const retry = await send(undefined,key);
    expect(retry.status).toBe(409); expect(retry.body.error).toBe("retired_replay");
    expect((await db.query("SELECT count(*)::int AS count FROM notification_events")).rows[0].count).toBe(0);
  });
});
