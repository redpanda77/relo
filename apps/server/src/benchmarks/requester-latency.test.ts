import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { test, expect, vi } from "vitest";
import { createDatabase } from "../db.js";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { hashToken } from "../auth.js";
import { ChangeSubscription, InteractionChangeHub } from "../interaction-change-hub.js";

// Opt-in measurement, never a production load generator or a shared-table reset.
test.skipIf(!process.env.RELO_BENCHMARK_SOURCE_COMMIT)("committed decision to authenticated requester result", async () => {
  const sourceCommit = process.env.RELO_BENCHMARK_SOURCE_COMMIT!;
  const output = process.env.RELO_BENCHMARK_OUTPUT!;
  const url = new URL(process.env.TEST_DATABASE_URL ?? "");
  expect(["localhost", "127.0.0.1", "[::1]"]).toContain(url.hostname);
  expect(url.pathname.endsWith("_test")).toBe(true);
  expect(sourceCommit).toMatch(/^[a-f0-9]{40,64}$/);
  expect(output).toBeTruthy();
  const db = createDatabase(url.toString());
  const token = randomUUID() + randomUUID();
  let principalId: string | undefined;
  let hub: InteractionChangeHub | undefined;
  try {
    await bootstrapOwner(db, `latency-${randomUUID()}`, token);
    const owner = (await db.query("SELECT id,principal_id FROM principal_api_keys WHERE token_hash=$1", [hashToken(token)])).rows[0];
    principalId = owner.principal_id;
    hub = await InteractionChangeHub.listen(db);
    const app = createApp(db, { apnsMode: "disabled", interactionChanges: hub });
    for (let index = 0; index < 100; index++) {
      const eventId = (await db.query(`INSERT INTO notification_events(principal_id,requester_credential_id,source,title,body,idempotency_key)
        VALUES ($1,$2,'Fixture','Fixture','Fixture',$3) RETURNING id`, [principalId, owner.id, randomUUID()])).rows[0].id;
      const interactionId = (await db.query(`INSERT INTO interaction_requests(principal_id,notification_event_id,kind,prompt,response_token_hash,expires_at)
        VALUES ($1,$2,'approval','Fixture',$3,clock_timestamp()+interval '15 minutes') RETURNING id`, [principalId, eventId, hashToken(randomUUID())])).rows[0].id;
      let entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const original = ChangeSubscription.prototype.wait;
      const spy = vi.spyOn(ChangeSubscription.prototype, "wait").mockImplementation(function (this: ChangeSubscription, ...args) {
        const waiting = original.apply(this, args); entered(); return waiting;
      });
      const controller = new AbortController();
      const watchdog = setTimeout(() => controller.abort(), 2_000);
      const tx = await db.connect();
      let startNs: bigint | undefined;
      try {
        const waiting = app.request(`/api/interactions/int_${interactionId}/wait?timeoutSeconds=30`, {
          headers: { authorization: `Bearer ${token}` }, signal: controller.signal,
        });
        // A returned/error response must also break the readiness wait; no silent hanging collector.
        await Promise.race([ready, waiting.then(() => { throw new Error("Wait endpoint returned before subscribing"); })]);
        await tx.query("BEGIN");
        await tx.query("UPDATE interaction_requests SET state='approved',responded_at=clock_timestamp() WHERE id=$1", [interactionId]);
        // Conservative bound includes COMMIT round trip; both endpoints use this process's clock.
        startNs = process.hrtime.bigint();
        await tx.query("COMMIT");
        const response = await waiting;
        const body = await response.json() as { interaction?: { state?: string } };
        const endNs = process.hrtime.bigint();
        const ok = response.status === 200 && body.interaction?.state === "approved";
        appendFileSync(output, JSON.stringify({ stage: "decision_commit_to_wakeup",
          scenario: "postgres_commit_to_authenticated_wait_result", sourceCommit, process: "requester-benchmark",
          clock: "monotonic", outcome: ok ? "ok" : "failed", startNs: startNs.toString(), endNs: endNs.toString() }) + "\n");
        expect(ok).toBe(true);
      } finally {
        controller.abort(); clearTimeout(watchdog); spy.mockRestore();
        await tx.query("ROLLBACK"); tx.release();
      }
    }
  } finally {
    await hub?.close();
    if (principalId) await db.query("DELETE FROM owner_principals WHERE id=$1", [principalId]);
    await db.end();
  }
}, 30_000);
