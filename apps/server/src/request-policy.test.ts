import { describe, expect, test } from "vitest";
import { FAMILIES, OUTSIDE_POLICY, REQUEST_POLICY, outsidePolicy } from "./request-policy.js";
import { listRoutes } from "./test-support/routes.js";

/** Plan 10 M4: every write route is counted by the one table, or says why it is not. */
describe("request policy", () => {
  const writes = listRoutes().filter((route) => !route.startsWith("GET "));

  test("every write route is in the table or outside it with a reason", () => {
    const uncovered = writes.filter((route) => !REQUEST_POLICY[route] && !outsidePolicy(route));
    expect(uncovered,"add the route to REQUEST_POLICY (or OUTSIDE_POLICY with the reason)").toEqual([]);
  });

  test("the table names only routes that exist, and no route is both counted and outside", () => {
    expect(Object.keys(REQUEST_POLICY).filter((route) => !writes.includes(route))).toEqual([]);
    expect(Object.keys(REQUEST_POLICY).filter(outsidePolicy)).toEqual([]);
    for (const { reason } of OUTSIDE_POLICY) expect(reason.length).toBeGreaterThan(20);
  });
});

const databaseSuite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
databaseSuite("work writes are counted in their own family", () => {
  test("a service past its work limit gets 429 with when to retry; reads and other families are not charged", async () => {
    const { createDatabase } = await import("./db.js");
    const { migrate } = await import("./migrate.js");
    const { createApp } = await import("./app.js");
    const { createWebhookService } = await import("./webhooks/admin.js");
    const db = createDatabase(process.env.TEST_DATABASE_URL!);
    try {
      await migrate(db);
      await db.query("TRUNCATE owner_principals CASCADE");
      const principalId = (await db.query<{ id: string }>("INSERT INTO owner_principals(handle) VALUES ('policy-owner') RETURNING id")).rows[0]!.id;
      const service = await createWebhookService(db,principalId,"Nightly","http://127.0.0.1:8180");
      const app = createApp(db,{ apnsMode: "disabled" });
      const headers = { authorization: `Bearer ${service.secret}`,"content-type": "application/json" };
      await db.query(
        `INSERT INTO request_rate_limits(scope_kind,scope_id,family,window_started_at,request_count)
         VALUES ('service',$1,'work-writes',date_trunc('minute',now()),$2)`,[service.row.id,FAMILIES["work-writes"].service]);
      const limited = await app.request("/hooks/works",{ method: "POST",headers: { ...headers,"idempotency-key": "policy-1" },
        body: JSON.stringify({ producerKey: "nightly",goal: "Nightly backup" }) });
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({ error: "rate_limited",scope: "service",retryAfterSeconds: expect.any(Number) });
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
      expect((await app.request("/hooks/works?producerKey=nightly",{ headers })).status).not.toBe(429);
      const mutations = await db.query<{ count: number }>(
        "SELECT COALESCE(sum(request_count),0)::int AS count FROM request_rate_limits WHERE family='authenticated-mutations' AND scope_id=$1",[service.row.id]);
      expect(mutations.rows[0]!.count).toBe(0);
    } finally {
      await db.end();
    }
  });
});
