import { randomUUID } from "node:crypto";
import { appendFileSync, writeFileSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.js";
import { hashToken } from "../auth.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase, type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { claimDeliveryJobs } from "../apns-worker-state.js";
import { pendingInteractionBadgeCount } from "../badge.js";
import { admitOrdinaryEvent } from "../relevance/ordinary-admission.js";
import { admitFixtureNotices } from "../test-support/admit-notices.js";

// The fixture is intentionally a local disposable database, never a deployed server.
// APNs is disabled. The same functional assertions run without measurement enabled.
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("Integrated freshness and bounded reads", () => {
  let db: Database, app: ReturnType<typeof createApp>, principal: string, device: string;
  const owner = "integrated-owner-abcdefghijklmnopqrstuvwxyz";
  const phone = "integrated-phone-abcdefghijklmnopqrstuvwxyz";
  const sourceCommit = process.env.RELO_BENCHMARK_SOURCE_COMMIT;
  const output = process.env.RELO_INTEGRATED_BENCHMARK_OUTPUT;
  const measured = Boolean(output && sourceCommit);
  const samples: {scenario: string; durationMs: number; bytes: number}[] = [];
  beforeAll(async () => {
    const url = new URL(process.env.TEST_DATABASE_URL!);
    if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) || !url.pathname.endsWith("_test")) {
      throw new Error("Use a disposable localhost database ending in _test");
    }
    if (measured && !/^[a-f0-9]{40,64}$/.test(sourceCommit!)) throw new Error("Missing immutable source identity");
    db = createDatabase(url.toString()); await migrate(db);
  });
  afterAll(async () => {
    if (measured) writeFileSync(`${output}.shape.json`, JSON.stringify({
      sourceCommit, fixture: "integrated-v1", node: process.version,
      retainedEvents: 10000, recentMaximumBodies: 250, bodyBytes: 65536, validPending: 101,
      producerClients: 2, requestsPerProducer: 50, productionRateLimitsEnabled: true,
      samples, peakProcessRSSBytes: process.resourceUsage().maxRSS * 1024,
      memoryBoundary: "Vitest process including Hono and fixture; excludes PostgreSQL",
    }, null, 2) + "\n");
    await db?.end();
  });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    await bootstrapOwner(db, "integrated", owner);
    principal = (await db.query("SELECT principal_id FROM principal_api_keys WHERE token_hash=$1", [hashToken(owner)])).rows[0].principal_id;
    device = (await db.query(`INSERT INTO devices(principal_id,stable_device_id,installation_id,name,bundle_identifier,
      app_version,app_build,os_version,apns_environment,notification_authorization,apns_token)
      VALUES ($1,$2,$3,'Fixture','com.example.relo.notifications','1','1','27','sandbox','authorized','fixture-only') RETURNING id`,
    [principal, randomUUID(), randomUUID()])).rows[0].id;
    await db.query("INSERT INTO device_credentials(device_id,token_hash,scopes) VALUES ($1,$2,ARRAY['inbox:read','interactions:respond'])", [device, hashToken(phone)]);
    app = createApp(db, {apnsMode: "disabled"});
  });
  async function read(path: string, scenario?: string) {
    const start = performance.now();
    const response = await app.request(path, {headers: {authorization: `Bearer ${phone}`}});
    const text = await response.text();
    if (scenario) samples.push({scenario, durationMs: performance.now() - start, bytes: Buffer.byteLength(text)});
    expect(response.status, text.slice(0, 200)).toBe(200);
    return JSON.parse(text) as any;
  }
  async function post(path: string, body: unknown, token = owner) {
    const response = await app.request(path, {method: "POST", headers: {
      authorization: `Bearer ${token}`, "content-type": "application/json", "idempotency-key": randomUUID(),
    }, body: JSON.stringify(body)});
    return {status: response.status, body: await response.json() as any};
  }
  function span(scenario: string, startNs: bigint, endNs: bigint, ok: boolean) {
    if (measured) appendFileSync(output!, JSON.stringify({stage: "api_to_ack", scenario, sourceCommit,
      process: "hono-postgres-integrated", clock: "monotonic", outcome: ok ? "ok" : "failed",
      startNs: startNs.toString(), endNs: endNs.toString()}) + "\n");
  }
  async function ask(key: string, generation = 1, age = 0, actionSeconds = 300) {
    const result = await post("/api/interactions", {type: "yes_no", title: "Exact decision", prompt: "Continue?",
      expiresInSeconds: actionSeconds, relevance: {subjectKey: key, generation, revision: 1, operation: "replace",
        occurredAt: new Date(Date.now() - age * 1000).toISOString(), policy: {kind: "decision", actionSeconds}}});
    expect(result.status).toBe(201); return result.body;
  }
  const answer = (decision: any) => post(`/api/notifications/${decision.eventId}/interactions`, {
    kind: "yes", idempotencyKey: randomUUID(), expectedInteractionId: decision.interaction.id,
    expectedSubject: decision.relevance.identity,
  }, phone);

  test("large bodies and retained history never truncate the valid decision inventory", async () => {
    await db.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key,created_at)
      SELECT $1,'Fixture','Retained','History',gen_random_uuid()::text,now()-interval '1 day'
      FROM generate_series(1,10000)`, [principal]);
    // Current work is admitted like production notifications; the day-old rows above are history only.
    const decisionEvents = (await db.query(`INSERT INTO notification_events(principal_id,source,kind,title,body,idempotency_key)
      SELECT $1,'Fixture','question','Still valid',repeat('p',65536),gen_random_uuid()::text FROM generate_series(1,101)
      RETURNING id,created_at,idempotency_key`, [principal])).rows;
    const decisions: { id: string }[] = [];
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      for (const event of decisionEvents) {
        const admission = await admitOrdinaryEvent(tx, { principalId: principal, sourceId: `account:${principal}` }, {
          kind: "decision", apnsMode: "disabled", eventId: event.id, createdAt: event.created_at,
          idempotencyKey: event.idempotency_key, intentHash: "f".repeat(64),
          interaction: { kind: "yes_no", prompt: "p".repeat(65536), actionSeconds: 900 },
        });
        if (admission.kind === "duplicate" || !admission.request) throw new Error("fixture decision was not admitted");
        decisions.push({ id: admission.request.id });
      }
      await tx.query("COMMIT");
    } catch (error) { await tx.query("ROLLBACK"); throw error; } finally { tx.release(); }
    await admitFixtureNotices(db, principal, (await db.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key)
      SELECT $1,'Fixture','Recent maximum body',repeat('x',65536),gen_random_uuid()::text FROM generate_series(1,250) RETURNING id`, [principal])).rows);
    const current = await read("/api/inbox/current", "current_first_read");
    expect(current.items).toHaveLength(50); expect(current.counts.actionable).toBe(101);
    expect(current.total).toBe(351); expect(Buffer.byteLength(JSON.stringify(current))).toBeLessThan(70000);
    expect(current.items.every((item: any) => item.body === undefined && item.payload === undefined)).toBe(true);
    const found = new Set<string>(); let cursor: string | null = null; let requests = 0;
    do {
      const page = await read(`/api/inbox/pending?limit=50${cursor ? `&after=${cursor}` : ""}`, "pending_page");
      expect(page.total).toBe(101); expect(page.items.length).toBeLessThanOrEqual(50);
      for (const item of page.items) found.add(item.interaction.id);
      cursor = page.cursor; requests++;
    } while (cursor && requests < 4);
    expect(requests).toBe(3); expect(found).toEqual(new Set(decisions.map(row => `int_${row.id}`)));
    expect(await pendingInteractionBadgeCount(db, device)).toBe(101);
    const history = await read("/api/inbox/snapshot", "history_summary");
    expect(history.items).toHaveLength(250); expect(history.total).toBe(10351);
    expect(history.items.every((item: any) => item.contentSummary.byteLength === 65536)).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(history))).toBeLessThan(400000);
    expect(JSON.stringify(history)).not.toContain("x".repeat(241));
    // No timing threshold in correctness tests. The opt-in report applies the agreed budgets.
    for (let i = 0; i < (measured ? 100 : 1); i++) await read("/api/inbox/current", "current_warm");
    const secondProducer = `fixture-${randomUUID()}`;
    await db.query(`INSERT INTO principal_api_keys(principal_id,label,token_hash,token_prefix,scopes)
      VALUES ($1,'benchmark-second-producer',$2,'fixture',ARRAY['notifications:send'])`, [principal, hashToken(secondProducer)]);
    for (let i = 0; i < (measured ? 100 : 1); i++) {
      const start = process.hrtime.bigint();
      const result = await post("/api/notifications", {sourceName: "Fixture", title: "Immediate", body: "Fixture"}, i < 50 ? owner : secondProducer);
      const end = process.hrtime.bigint(); span("warm_notice_with_retained_history", start, end, result.status === 201);
      expect(result.status).toBe(201);
      const durable = (await db.query("SELECT count(*)::int AS count FROM delivery_jobs WHERE notification_event_id=$1", [result.body.eventId.slice(4)])).rows[0];
      expect(durable.count).toBe(1);
    }
  }, 60000);

  test("ten-minute recovery coalesces old work and keeps an independent valid decision", async () => {
    // Model the disconnection with immutable original occurrence times; no ten-minute sleep
    // and no client clock override can accidentally bypass PostgreSQL's actual deadline checks.
    // Questions wait at most five minutes, so only those asked late in the outage remain valid.
    const expired = await ask("expires-offline", 1, 600, 300);
    const valid = await ask("independent-valid", 1, 200, 300);
    const old = await ask("replaced-offline", 1, 200, 300);
    const replacement = await ask("replaced-offline", 2, 0, 300);
    const events: string[] = [];
    for (let revision = 1; revision <= 30; revision++) {
      const result = await post("/api/notifications", {sourceName: "Fixture", title: `Progress ${revision}`, body: "Fixture",
        relevance: {subjectKey: "progress-during-offline", generation: 1, revision,
          operation: revision === 1 ? "replace" : "update", occurredAt: new Date(Date.now() - (601-revision)*1000).toISOString(),
          policy: {kind: "notice"}}});
      expect(result.status).toBe(201); expect(result.body.queued).toBe(0); events.push(result.body.eventId);
    }
    const latest = await post("/api/notifications", {sourceName: "Fixture", title: "Completed", body: "Fixture",
      relevance: {subjectKey: "progress-during-offline", generation: 1, revision: 31, operation: "update",
        occurredAt: new Date().toISOString(), policy: {kind: "notice"}}});
    expect(latest.status).toBe(201);
    const [current, pending, history] = await Promise.all([
      read("/api/inbox/current", "reconnect_current"), read("/api/inbox/pending"), read("/api/inbox/snapshot"),
    ]);
    expect(current.counts.actionable).toBe(2); expect(current.total).toBe(3);
    expect(current.items.map((item: any) => item.notificationId).sort()).toEqual([valid.eventId, replacement.eventId, latest.body.eventId].sort());
    expect(pending.items.map((item: any) => item.interaction.id).sort()).toEqual([valid.interaction.id, replacement.interaction.id].sort());
    expect(history.items.length).toBe(35); // Evidence remains available independently of attention.
    const jobs = await claimDeliveryJobs(db, 100, new Date(0));
    expect(jobs.map(job => `ntf_${job.event_id}`).sort()).toEqual([valid.eventId, replacement.eventId, latest.body.eventId].sort());
    expect(jobs.some(job => events.includes(`ntf_${job.event_id}`))).toBe(false);
    expect((await answer(expired)).status).toBe(409); expect((await answer(old)).status).toBe(409);
    expect((await answer(valid)).status).toBe(201);
    expect((await read("/api/inbox/pending")).total).toBe(1);
    // An independent late transaction cannot partially leak an event/outbox or be lost by repair.
    const tx = await db.connect();
    try {
      await tx.query("BEGIN");
      const event = (await tx.query(`INSERT INTO notification_events(principal_id,source,title,body,idempotency_key)
        VALUES ($1,'Fixture','Late','Fixture',$2) RETURNING id`, [principal, randomUUID()])).rows[0].id;
      await tx.query("INSERT INTO delivery_jobs(notification_event_id,device_id) VALUES ($1,$2)", [event, device]);
      const before = await read("/api/inbox/snapshot");
      expect(before.items.some((item: any) => item.id === `ntf_${event}`)).toBe(false);
      expect((await db.query("SELECT id FROM delivery_jobs WHERE notification_event_id=$1", [event])).rows).toHaveLength(0);
      await tx.query("COMMIT");
      expect((await read("/api/inbox/snapshot")).items.some((item: any) => item.id === `ntf_${event}`)).toBe(true);
      expect((await db.query("SELECT id FROM delivery_jobs WHERE notification_event_id=$1", [event])).rows).toHaveLength(1);
    } finally { await tx.query("ROLLBACK"); tx.release(); }
  }, 60000);
});
