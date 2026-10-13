import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { claimDeliveryJobs, finalizeDeliveryClaim, type ClaimedDeliveryJob } from "./apns-worker-state.js";
import { DeliveryDispatcher } from "./delivery-dispatcher.js";
import { DeliveryJobWakeup } from "./delivery-wakeup.js";
import { nextDeliveryWakeDelay } from "./delivery-scheduling.js";
import { pinOrdinaryDeliveryInputs } from "./delivery-inputs.js";

const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
suite("continuous PostgreSQL delivery scheduling", () => {
  let db: Database;
  let principal: string;
  let device: string;
  const cutover = new Date("2020-01-01T00:00:00Z");
  beforeAll(async () => { db = createDatabase(databaseUrl!); await migrate(db); });
  afterAll(async () => { await db.end(); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    principal = (await db.query("INSERT INTO owner_principals(handle) VALUES ('dispatcher-test') RETURNING id")).rows[0].id;
    device = (await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment)
      VALUES ($1,'dispatcher-device','dispatcher-install','Test iPhone','com.example.relo.notifications','1','1','27','sandbox') RETURNING id`, [principal])).rows[0].id;
  });

  async function enqueue(kind: "normal" | "decision" | "end" | "expired" = "normal"): Promise<string> {
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      const event = (await tx.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key,payload)
        VALUES ($1,'Test','Scheduling','No provider send',$2,$3) RETURNING id`,
      [principal, randomUUID(), kind === "end" ? { liveActivity: { operation: "end" } } : {}])).rows[0].id;
      if (kind === "decision" || kind === "expired") {
        await tx.query(`INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
          VALUES ($1,$2,'approval','Test',$3,now()+($4*interval '1 minute'))`, [principal,event,randomUUID(),kind === "expired" ? -1 : 15]);
      }
      const job = (await tx.query(`INSERT INTO delivery_jobs(notification_event_id,device_id) VALUES ($1,$2) RETURNING id`, [event,device])).rows[0].id;
      await tx.query("COMMIT");
      return job;
    } catch (error) { await tx.query("ROLLBACK"); throw error; }
    finally { tx.release(); }
  }

  test("urgent claims exclude routine and expired decisions while keeping independent FIFO work", async () => {
    const normal = await enqueue();
    const expired = await enqueue("expired");
    const decision = await enqueue("decision");
    const end = await enqueue("end");
    const laterNormal = await enqueue();
    expect((await claimDeliveryJobs(db,10,cutover,"urgent")).map(job => job.id).sort()).toEqual([decision,end].sort());
    expect((await claimDeliveryJobs(db,1,cutover,"normal")).map(job => job.id)).toEqual([normal]);
    expect((await claimDeliveryJobs(db,1,cutover,"normal")).map(job => job.id)).toEqual([laterNormal]);
    expect(await claimDeliveryJobs(db,1,cutover,"normal")).toEqual([]);
    expect((await db.query("SELECT attempt_count FROM delivery_jobs WHERE id=$1",[expired])).rows[0].attempt_count).toBe(0);
  });

  test("durable provider schedule releases the claim and survives a new pool without extending its budget", async () => {
    const id = await enqueue();
    const job = (await claimDeliveryJobs(db,1,cutover))[0]!;
    // The wake delay is computed on the database clock; anchor the schedule to it, not this process.
    const databaseNow = (await db.query<{ now: Date }>("SELECT clock_timestamp() AS now")).rows[0]!.now.getTime();
    const retryAt = new Date(databaseNow+750);
    const horizon = new Date(databaseNow+300_000);
    await db.query(`UPDATE delivery_jobs SET claim_phase='dispatch_started',provider_attempts_used=1,
      provider_retry_started_at=now(),provider_retry_attempt_cap=4,provider_retry_horizon_at=$2,
      provider_next_attempt_not_before=$3,apns_payload_sha256=$4 WHERE id=$1`, [id,horizon,retryAt,"a".repeat(64)]);
    await finalizeDeliveryClaim(db,job,{ kind: "retry_scheduled",notBefore: retryAt,code: "retry-scheduled",message: "retry-scheduled" });
    expect((await db.query("SELECT state,claim_token,available_at,provider_retry_horizon_at,apns_payload_sha256 FROM delivery_jobs WHERE id=$1",[id])).rows[0])
      .toMatchObject({ state: "retry",claim_token: null,available_at: retryAt,provider_retry_horizon_at: horizon,apns_payload_sha256: "a".repeat(64) });
    const restarted = createDatabase(databaseUrl!);
    try {
      expect(await claimDeliveryJobs(restarted,1,cutover)).toEqual([]);
      const delay = await nextDeliveryWakeDelay(restarted,2_000,cutover);
      expect(delay).toBeGreaterThan(0);
      expect(delay).toBeLessThanOrEqual(750);
      // Advance the durable fixture boundary without sleeping through provider backoff.
      await db.query("UPDATE delivery_jobs SET available_at=now(),provider_next_attempt_not_before=now() WHERE id=$1",[id]);
      expect((await claimDeliveryJobs(restarted,1,cutover))[0]).toMatchObject({
        id,provider_attempts_used: 1,provider_retry_attempt_cap: 4,provider_retry_horizon_at: horizon,
      });
    } finally { await restarted.end(); }
  });

  test("newly committed decision starts while an older provider send remains suspended", async () => {
    const first = await enqueue();
    const second = await enqueue();
    const wakeup = await DeliveryJobWakeup.listen(db);
    const stop = new AbortController();
    const started: string[] = [];
    const releases = new Map<string, () => void>();
    const dispatcher = new DeliveryDispatcher<ClaimedDeliveryJob>({
      concurrency: 2,reservedUrgent: 0,
      claim: (limit,lane) => claimDeliveryJobs(db,limit,cutover,lane),
      wait: async signal => { await wakeup.wait(2_000,signal); },
      dispatch: async job => {
        started.push(job.id);
        await new Promise<void>(resolve => releases.set(job.id,resolve));
        await db.query("UPDATE delivery_jobs SET state='accepted',claim_token=NULL,claim_phase=NULL,lease_expires_at=NULL WHERE id=$1 AND claim_token=$2",[job.id,job.claim_token]);
      },
    });
    const task = dispatcher.run(stop.signal);
    try {
      await until(() => started.length === 2);
      const decision = await enqueue("decision");
      releases.get(second)!();
      await until(() => started.includes(decision));
      expect((await db.query("SELECT state FROM delivery_jobs WHERE id=$1",[first])).rows[0].state).toBe("processing");
    } finally {
      stop.abort();
      for (const release of releases.values()) release();
      await task;
      await wakeup.close();
    }
  });

  test("a new claim reuses the first ordinary presentation inputs instead of rebasing its badge", async () => {
    const id = await enqueue();
    const first = (await claimDeliveryJobs(db,1,cutover))[0]!;
    const original = { badge: 3,avatarUrl: "https://example.com/original.png" };
    expect(await pinOrdinaryDeliveryInputs(db,first,async () => original)).toEqual(original);
    await db.query(`UPDATE delivery_jobs SET state='retry',claim_token=NULL,claim_phase=NULL,lease_expires_at=NULL,
      device_projection_sha256=$2,apns_payload_sha256=$3 WHERE id=$1`,[id,"a".repeat(64),"b".repeat(64)]);
    const retry = (await claimDeliveryJobs(db,1,cutover))[0]!;
    expect(await pinOrdinaryDeliveryInputs(db,retry,async () => { throw new Error("must not rebuild from changed badge/avatar"); })).toEqual(original);
    expect((await db.query("SELECT device_projection_sha256,apns_payload_sha256 FROM delivery_jobs WHERE id=$1",[id])).rows[0])
      .toEqual({ device_projection_sha256: "a".repeat(64),apns_payload_sha256: "b".repeat(64) });
  });
});

async function until(check: () => boolean) {
  const deadline = performance.now()+2_000;
  while (performance.now() < deadline) {
    if (check()) return;
    await new Promise<void>(resolve => setImmediate(resolve));
  }
  throw new Error("delivery did not progress");
}
