import { afterAll,beforeAll,beforeEach,describe,expect,test } from "vitest";
import { createApp } from "../app.js";
import { bootstrapOwner } from "../bootstrap.js";
import { rotateCredential } from "../credentials/registry.js";
import { createDatabase,type Database } from "../db.js";
import { migrate } from "../migrate.js";

/** Plan 10 M1.2: rotating a CI token or a harness credential; logins and phones are refused. */
const suite = process.env.TEST_DATABASE_URL ? describe : describe.skip;
suite("credential rotation",() => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  const owner = "rotate_owner_abcdefghijklmnopqrstuvwxyz0123456789";
  beforeAll(async () => { db = createDatabase(process.env.TEST_DATABASE_URL!); await migrate(db); app = createApp(db,{ apnsMode: "disabled" }); });
  afterAll(async () => db.end());
  beforeEach(async () => { await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE"); await bootstrapOwner(db,"owner",owner); });

  const call = async (token: string,method: string,path: string,body?: unknown) => {
    const response = await app.request(path,{ method,headers: { authorization: `Bearer ${token}`,"content-type": "application/json","idempotency-key": crypto.randomUUID() },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status,body: await response.json().catch(() => null) as any };
  };

  test("a CI token rotates in place: old token dead at once, new one works, same id, name, scopes and expiry",async () => {
    const made = (await call(owner,"POST","/api/credentials",{ name: "Deploy",scopes: ["notifications:send"],expiresInDays: 7 })).body;
    const rotated = await call(owner,"POST",`/api/credentials/${made.credential.id}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.token).not.toBe(made.token);
    expect(rotated.body.credential).toMatchObject({ id: made.credential.id,name: "Deploy",scopes: ["notifications:send"],expiresAt: made.credential.expiresAt });
    expect((await call(made.token,"GET","/api/clients/self")).status).toBe(401);
    expect((await call(rotated.body.token,"GET","/api/clients/self")).status).toBe(200);
    expect((await call(owner,"GET","/api/credentials")).body.tokens).toHaveLength(1);
  });

  test("a revoked CI token cannot be rotated; a login is not a CI token; a CI token rotates only itself",async () => {
    const a = (await call(owner,"POST","/api/credentials",{ name: "A",scopes: ["services:write"] })).body;
    const b = (await call(owner,"POST","/api/credentials",{ name: "B" })).body;
    expect((await call(a.token,"POST",`/api/credentials/${b.credential.id}/rotate`)).body.error).toBe("ci_token_cannot_rotate_another");
    expect((await call(a.token,"POST",`/api/credentials/${a.credential.id}/rotate`)).status).toBe(200);
    await call(owner,"DELETE",`/api/credentials/${b.credential.id}`);
    expect((await call(owner,"POST",`/api/credentials/${b.credential.id}/rotate`)).status).toBe(404);
    const login = (await db.query("SELECT id FROM principal_api_keys WHERE label='bootstrap-owner'")).rows[0].id;
    expect((await call(owner,"POST",`/api/credentials/key_${login}/rotate`)).status).toBe(404);
    expect((await call(owner,"GET","/api/clients/self")).status).toBe(200);
  });

  test("a harness credential rotates in place and a revoked one cannot",async () => {
    const made = (await call(owner,"POST","/api/harness-credentials",{ name: "laptop" })).body;
    const rotated = await call(owner,"POST",`/api/harness-credentials/${made.id}/rotate`);
    expect(rotated.status).toBe(200);
    expect(rotated.body.id).toBe(made.id);
    expect(rotated.body.token).not.toBe(made.token);
    expect((await call(made.token,"GET","/api/clients/self")).status).toBe(401);
    expect((await call(rotated.body.token,"GET","/api/clients/self")).status).toBeLessThan(500);
    expect((await call(rotated.body.token,"GET","/api/clients/self")).status).not.toBe(401);
    await call(owner,"DELETE",`/api/harness-credentials/${made.id}`);
    expect((await call(owner,"POST",`/api/harness-credentials/${made.id}/rotate`)).status).toBe(404);
    const ci = (await call(owner,"POST","/api/credentials",{ name: "CI" })).body.token;
    expect((await call(ci,"POST",`/api/harness-credentials/${made.id}/rotate`)).status).toBe(403);
  });

  test("the registry refuses logins and phones and reaches services",async () => {
    expect(await rotateCredential(db,"login",crypto.randomUUID(),crypto.randomUUID())).toBe("not_rotatable");
    expect(await rotateCredential(db,"device",crypto.randomUUID(),crypto.randomUUID())).toBe("not_rotatable");
    expect(await rotateCredential(db,"service",crypto.randomUUID(),crypto.randomUUID())).toBe("not_found");
  });
});
