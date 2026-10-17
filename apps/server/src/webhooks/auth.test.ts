import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.js";
import { createDatabase, type Database } from "../db.js";
import { migrate } from "../migrate.js";
import { listRoutes } from "../test-support/routes.js";
import { createWebhookService } from "./admin.js";
import { WEBHOOK_ROUTE_SCOPES } from "./auth.js";

/**
 * Plan 10 M3/F1: the webhook middleware resolves the service once, and every /hooks route gives the same answer
 * to a secret that cannot send: unknown, malformed, rotated, revoked, or an account the admin turned off.
 */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
const ROUTES: Array<[string,string]> = [
  ["POST","/hooks"],
  ["GET","/hooks/events/ntf_00000000-0000-4000-8000-000000000000"],
  ["POST","/hooks/events/ntf_00000000-0000-4000-8000-000000000000/withdraw"],
  ["POST","/hooks/events/ntf_00000000-0000-4000-8000-000000000000/cancel"],
  ["POST","/hooks/live-activities"],
  ["POST","/hooks/live-activities/resolve"],
  ["GET","/hooks/live-activities/build-7"],
  ["PATCH","/hooks/live-activities/build-7"],
  ["POST","/hooks/live-activities/build-7/end"],
  ["POST","/hooks/works"],
  ["GET","/hooks/works"],
];

suite("webhook sign-in", () => {
  let db: Database;
  let principalId: string;
  let service: Awaited<ReturnType<typeof createWebhookService>>;
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    principalId = (await db.query<{ id: string }>("INSERT INTO owner_principals(handle) VALUES ('hook-owner') RETURNING id")).rows[0]!.id;
    service = await createWebhookService(db,principalId,"Builds","http://127.0.0.1:8180");
  });
  afterAll(async () => db.end());

  async function refusedEverywhere(secret: string) {
    const app = createApp(db,{ apnsMode: "disabled" });
    for (const [method,path] of ROUTES) {
      const response = await app.request(path,{ method,body: method === "GET" ? undefined : "{}",
        headers: { "content-type": "application/json",authorization: `Bearer ${secret}` } });
      expect(response.status,`${method} ${path}`).toBe(404);
      expect((await response.json() as { error: string }).error,`${method} ${path}`).toBe("unknown_webhook");
    }
  }

  test("an unknown or malformed secret is unknown_webhook on every route", async () => {
    await refusedEverywhere(`hook_${"x".repeat(43)}`);
    await refusedEverywhere("not-a-secret");
  });

  test("a disabled account's service cannot send or read, its events included", async () => {
    await db.query("UPDATE owner_principals SET disabled_at=now() WHERE id=$1",[principalId]);
    await refusedEverywhere(service.secret);
  });

  test("a rotated secret stops at once and a revoked service stays out", async () => {
    const app = createApp(db,{ apnsMode: "disabled" });
    const login = { authorization: `Bearer ${service.secret}`,"content-type": "application/json" };
    expect((await app.request("/hooks/live-activities/resolve",{ method: "POST",headers: login,body: "{}" })).status).not.toBe(404);
    const { rotateWebhookService } = await import("./admin.js");
    const rotated = await rotateWebhookService(db,principalId,service.row.id,"http://127.0.0.1:8180");
    await refusedEverywhere(service.secret);
    await db.query("UPDATE webhook_services SET revoked_at=now() WHERE id=$1",[service.row.id]);
    await refusedEverywhere(rotated!.secret);
  });
});

describe("webhook route scopes", () => {
  test("every /hooks route needs exactly one service scope, and the table names only routes that exist", () => {
    const routes = listRoutes(/^\/hooks(\/|$)/u);
    expect(routes.filter((route) => !WEBHOOK_ROUTE_SCOPES[route])).toEqual([]);
    expect(Object.keys(WEBHOOK_ROUTE_SCOPES).filter((route) => !routes.includes(route))).toEqual([]);
  });
});

suite("a service limited to some scopes", () => {
  let db: Database;
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); });
  afterAll(async () => db.end());

  test("is refused 403 with the missing scope outside them, and served inside them", async () => {
    await db.query("TRUNCATE owner_principals CASCADE");
    const principalId = (await db.query<{ id: string }>("INSERT INTO owner_principals(handle) VALUES ('scoped-owner') RETURNING id")).rows[0]!.id;
    const service = await createWebhookService(db,principalId,"Notices only","http://127.0.0.1:8180",{ scopes: ["hooks:notify"] });
    const app = createApp(db,{ apnsMode: "disabled" });
    const headers = { authorization: `Bearer ${service.secret}`,"content-type": "application/json","idempotency-key": "scoped-1" };
    const work = await app.request("/hooks/works",{ method: "POST",headers,body: JSON.stringify({ producerKey: "job",goal: "Job" }) });
    expect(work.status).toBe(403);
    expect(await work.json()).toMatchObject({ error: "forbidden",scope: "hooks:works" });
    expect((await app.request("/hooks",{ method: "POST",headers,body: JSON.stringify({ title: "Hi",body: "There" }) })).status).toBe(201);
  });
});
