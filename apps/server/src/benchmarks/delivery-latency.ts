import { randomUUID } from "node:crypto";
import { createDatabase } from "../db.js";
import { claimDeliveryJobs, type ClaimedDeliveryJob } from "../apns-worker-state.js";
import { DeliveryDispatcher } from "../delivery-dispatcher.js";
import { DeliveryJobWakeup } from "../delivery-wakeup.js";

// Uses the real claim SQL and LISTEN channel, with an injected provider boundary.
// Run only against a disposable local database. Never sends APNs or truncates shared tables.
const databaseURL = new URL(process.env.TEST_DATABASE_URL ?? "");
if (!["localhost", "127.0.0.1", "[::1]"].includes(databaseURL.hostname) || !databaseURL.pathname.endsWith("_test")) {
  throw new Error("A local disposable database ending in _test is required");
}
const sourceCommit = process.env.RELO_BENCHMARK_SOURCE_COMMIT ?? "";
if (!/^[a-f0-9]{40,64}$/.test(sourceCommit)) throw new Error("RELO_BENCHMARK_SOURCE_COMMIT must identify the clean measured source");
const db = createDatabase(databaseURL.toString());
const principal = (await db.query("INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",[`latency-${randomUUID()}`])).rows[0].id as string;
const stop = new AbortController();
const wakeup = await DeliveryJobWakeup.listen(db);
let releaseBlocked!: () => void;
const blocked = new Promise<void>(resolve => { releaseBlocked = resolve; });
let blockedStarted!: () => void;
const firstStarted = new Promise<void>(resolve => { blockedStarted = resolve; });
const samples = new Map<string, { startNs: bigint; finish: () => void }>();
let run: Promise<void> | undefined;
try {
  const device = (await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
    app_version,app_build,os_version,apns_environment)
    VALUES ($1,$2,$3,'Fixture','com.example.relo.notifications','1','1','27','sandbox') RETURNING id`,[principal,randomUUID(),randomUUID()])).rows[0].id as string;
  async function enqueue(measure: boolean): Promise<{ id: string; completed: Promise<void> }> {
    const tx = await db.connect();
    let finish!: () => void;
    const completed = new Promise<void>(resolve => { finish = resolve; });
    try {
      await tx.query("BEGIN");
      const event = (await tx.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key)
        VALUES ($1,'Fixture','Fixture','Fixture',$2) RETURNING id`,[principal,randomUUID()])).rows[0].id;
      if (measure) await tx.query(`INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
        VALUES ($1,$2,'approval','Fixture',$3,now()+interval '15 minutes')`,[principal,event,randomUUID()]);
      const id = (await tx.query("INSERT INTO delivery_jobs(notification_event_id,device_id) VALUES ($1,$2) RETURNING id",[event,device])).rows[0].id as string;
      // Anchor just before COMMIT: includes commit work and provides a conservative local interval.
      if (measure) samples.set(id,{ startNs: process.hrtime.bigint(),finish });
      await tx.query("COMMIT");
      return { id,completed };
    } catch (error) { await tx.query("ROLLBACK"); throw error; }
    finally { tx.release(); }
  }
  const first = await enqueue(false);
  const dispatcher = new DeliveryDispatcher<ClaimedDeliveryJob>({
    concurrency: 2,reservedUrgent: 0,
    claim: (limit,lane) => claimDeliveryJobs(db,limit,new Date("2020-01-01T00:00:00Z"),lane),
    wait: async signal => { await wakeup.wait(2_000,signal); },
    dispatch: async job => {
      if (job.id === first.id) { blockedStarted(); await blocked; }
      const sample = samples.get(job.id);
      if (sample) {
        const endNs = process.hrtime.bigint();
        process.stdout.write(JSON.stringify({ stage: "commit_to_dispatch",scenario: "postgres_commit_to_injected_dispatch_one_old_send_blocked",sourceCommit,
          process: "dispatcher-benchmark",clock: "monotonic",outcome: "ok",startNs: sample.startNs.toString(),endNs: endNs.toString() })+"\n");
      }
      await db.query("UPDATE delivery_jobs SET state='accepted',claim_token=NULL,claim_phase=NULL,lease_expires_at=NULL WHERE id=$1 AND claim_token=$2",[job.id,job.claim_token]);
      sample?.finish();
    },
  });
  run = dispatcher.run(stop.signal);
  const timeout = AbortSignal.timeout(30_000);
  const timedOut = new Promise<never>((_,reject) => timeout.addEventListener("abort",() => reject(new Error("benchmark stalled")),{ once: true }));
  await Promise.race([firstStarted,run,timedOut]);
  for (let sample = 0; sample < 100; sample += 1) {
    const next = await enqueue(true);
    await Promise.race([next.completed,run,timedOut]);
  }
} finally {
  stop.abort();
  releaseBlocked();
  try { await run; }
  finally {
    try {
      await wakeup.close();
      // Benchmark fixtures never reach a phone, so their active cards may be removed directly.
      const cleanup = await db.connect();
      try {
        await cleanup.query("BEGIN");
        await cleanup.query("SET LOCAL relo.allow_active_activity_delete = 'on'");
        await cleanup.query("DELETE FROM owner_principals WHERE id=$1",[principal]);
        await cleanup.query("COMMIT");
      } catch (error) { await cleanup.query("ROLLBACK"); throw error; } finally { cleanup.release(); }
    } finally { await db.end(); }
  }
}
