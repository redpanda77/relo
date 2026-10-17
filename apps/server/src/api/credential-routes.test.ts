import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { createDatabase, type Database } from "../db.js";
import { migrate } from "../migrate.js";

/** Plan 10 A1: CI tokens are logins the owner makes for a pipeline, bounded by their maker. */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("CI tokens", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  const owner = "ci_token_owner_abcdefghijklmnopqrstuvwxyz0123456789";
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); app = createApp(db,{ apnsMode: "disabled" }); });
  afterAll(async () => db.end());
  beforeEach(async () => { await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db,"owner",owner); });

  const call = async (token: string,method: string,path: string,body?: unknown) => {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json","idempotency-key": crypto.randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  };

  test("the owner makes one, it works, it expires, it is listed without its secret and revoked at once", async () => {
    const made = await call(owner,"POST","/api/credentials",{ name: "Deploy pipeline",scopes: ["notifications:send"],expiresInDays: 7 });
    expect(made.status).toBe(201);
    expect(made.body.token).toMatch(/^relo_[A-Za-z0-9_-]{43}$/);
    expect(made.body.credential).toMatchObject({ name: "Deploy pipeline",scopes: ["notifications:send"] });
    const days = (Date.parse(made.body.credential.expiresAt) - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(6.9);
    expect(days).toBeLessThan(7.1);
    const listed = await call(owner,"GET","/api/credentials");
    expect(listed.body.tokens).toHaveLength(1);
    expect(JSON.stringify(listed.body)).not.toContain(made.body.token);
    expect((await call(made.body.token,"GET","/api/clients/self")).status).toBe(200);
    expect((await call(made.body.token,"POST","/api/interactions",{ prompt: "Deploy?" })).status).toBe(403);
    expect((await call(owner,"DELETE",`/api/credentials/${made.body.credential.id}`)).status).toBe(200);
    expect((await call(made.body.token,"GET","/api/clients/self")).status).toBe(401);
  });

  test("a CI token cannot make another, change the encryption policy or set up hooks", async () => {
    const ci = (await call(owner,"POST","/api/credentials",{ name: "CI" })).body.token as string;
    expect((await call(ci,"POST","/api/credentials",{ name: "Nested" })).body.error).toBe("ci_token_cannot_mint");
    expect((await call(ci,"PUT","/api/end-to-end/policy",{ required: true })).status).toBe(403);
    expect((await call(ci,"POST","/api/harness-credentials",{ name: "laptop" })).status).toBe(403);
  });

  test("it holds only its maker's scopes, lives at most the maximum, and never replaces a login of the same name", async () => {
    await db.query("UPDATE principal_api_keys SET scopes=ARRAY['services:write','services:read','notifications:send'] WHERE label='bootstrap-owner'");
    expect((await call(owner,"POST","/api/credentials",{ name: "Wide",scopes: ["interactions:create"] })).body.error).toBe("scope_not_held");
    expect((await call(owner,"POST","/api/credentials",{ name: "Long",expiresInDays: 365 })).status).toBe(400);
    expect((await call(owner,"POST","/api/credentials",{ name: "bootstrap-owner" })).body.error).toBe("name_taken");
    const defaulted = await call(owner,"POST","/api/credentials",{ name: "Default" });
    expect(defaulted.body.credential.scopes).toEqual(["notifications:send","services:read","services:write"]);
  });
});
