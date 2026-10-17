import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { contentPolicy } from "./content-policy.js";
import { createDatabase, type Database } from "./db.js";
import { setEndToEndRequired } from "./end-to-end-policy.js";
import { migrate } from "./migrate.js";
import { readDoctorSnapshot,recordWorkerHeartbeat } from "./runtime-health.js";
import { createWebhookService } from "./webhooks/admin.js";

/** Plan 10 M7 and A3: one readable-content decision, the same for every producer type. */
const SOURCE = fileURLToPath(new URL(".", import.meta.url));
const sources = (directory: string): string[] => readdirSync(directory,{ withFileTypes: true }).flatMap((entry) => {
  const path = join(directory,entry.name);
  if (entry.isDirectory()) return entry.name === "test-support" ? [] : sources(path);
  return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts") ? [path] : [];
});

describe("content policy boundary", () => {
  test("no route decides on readable content itself", () => {
    // These read or set the account's choice itself (the settings routes), never a producer's content.
    const SETTING = new Set(["content-policy.ts","end-to-end-policy.ts","api/device-routes.ts","web/browser-routes.ts"]);
    const offenders = sources(SOURCE).filter((path) => !SETTING.has(relative(SOURCE,path)))
      .filter((path) => /\b(?:END_TO_END_REQUIRED|endToEndPolicy)\b/u.test(readFileSync(path,"utf8")))
      .map((path) => relative(SOURCE,path));
    expect(offenders).toEqual([]);
  });
});

const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("readable content from a webhook service", () => {
  let db: Database;
  let principalId: string;
  let service: Awaited<ReturnType<typeof createWebhookService>>;
  let app: ReturnType<typeof createApp>;
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); app = createApp(db,{ apnsMode: "disabled" }); });
  afterAll(async () => db.end());
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    principalId = (await db.query<{ id: string }>("INSERT INTO owner_principals(handle) VALUES ('content-owner') RETURNING id")).rows[0]!.id;
    service = await createWebhookService(db,principalId,"Shop","http://127.0.0.1:8180");
  });

  const send = (method: string,path: string,body: unknown) => app.request(path,{ method,body: JSON.stringify(body),
    headers: { authorization: `Bearer ${service.secret}`,"content-type": "application/json","idempotency-key": randomUUID() } });
  const writes: Array<[string,string,unknown]> = [
    ["POST","/hooks",{ title: "Order paid",body: "Order 42 is paid" }],
    ["POST","/hooks/live-activities",{ key: "order-42",title: "Order 42",status: "Packing" }],
    ["POST","/hooks/works",{ producerKey: "order-42",goal: "Ship order 42" }],
  ];

  test("on an account that requires encryption, a service without the owner's leave is refused on every write", async () => {
    await setEndToEndRequired(db,principalId,true);
    for (const [method,path,body] of writes) {
      const response = await send(method,path,body);
      expect(response.status,`${method} ${path}`).toBe(409);
      const answer = await response.json() as { error: string; message: string };
      expect(answer.error).toBe("end_to_end_required");
      expect(answer.message).toContain("relo services edit --readable");
    }
  });

  test("the owner's leave for this service, or an account that does not require encryption, lets it send", async () => {
    await setEndToEndRequired(db,principalId,true);
    await db.query("UPDATE webhook_services SET readable_allowed=true WHERE id=$1",[service.row.id]);
    for (const [method,path,body] of writes) expect((await send(method,path,body)).status,`${method} ${path}`).not.toBe(409);
    await db.query("TRUNCATE notification_events, live_activities, works CASCADE");
    await db.query("UPDATE webhook_services SET readable_allowed=false WHERE id=$1",[service.row.id]);
    await setEndToEndRequired(db,principalId,false);
    for (const [method,path,body] of writes) expect((await send(method,path,body)).status,`${method} ${path}`).not.toBe(409);
  });

  test("the policy reports the retention window the worker runs with", async () => {
    await db.query("DELETE FROM runtime_components");
    expect((await contentPolicy(db,principalId)).retentionKnown).toBe(false);
    await recordWorkerHeartbeat(db,{ mode: "disabled",configured: false,pollMs: 1000,retentionHours: 10 });
    expect(await contentPolicy(db,principalId)).toMatchObject({ retentionHours: 10,retentionKnown: true });
    await db.query("DELETE FROM runtime_components");
    await recordWorkerHeartbeat(db,{ mode: "disabled",configured: false,pollMs: 1000,retentionHours: null });
    expect(await contentPolicy(db,principalId)).toMatchObject({ retentionHours: null,retentionKnown: true });
  });

  test("doctor shows the privacy promise and lists a service nobody used for a month", async () => {
    await db.query("DELETE FROM runtime_components");
    await recordWorkerHeartbeat(db,{ mode: "disabled",configured: false,pollMs: 1000,retentionHours: 10 });
    await setEndToEndRequired(db,principalId,true);
    await db.query("UPDATE webhook_services SET created_at=now()-interval '40 days',last_used_at=NULL WHERE id=$1",[service.row.id]);
    const snapshot = await readDoctorSnapshot(db,{ principalId,apnsMode: "disabled" });
    expect(snapshot.content).toMatchObject({ encryptionRequired: true,retentionHours: 10 });
    expect(snapshot.unusedCredentials).toEqual([{ kind: "service",name: "Shop",lastUsedAt: null }]);
    await send("POST","/hooks/live-activities/resolve",{});
    expect((await readDoctorSnapshot(db,{ principalId,apnsMode: "disabled" })).unusedCredentials).toEqual([]);
  });
});
