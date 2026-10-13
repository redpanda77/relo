import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { createApp } from "./app.js";
import { hashToken } from "./auth.js";
import { bootstrapOwner } from "./bootstrap.js";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";

/** A refused credential says why: account off, login revoked or expired; an unknown token says nothing more. */
const databaseUrl = process.env.TEST_DATABASE_URL;
const suite = databaseUrl ? describe : describe.skip;
const secret = "test-only-auth-refusal-secret-0123456789abcdef";
const token = "owner_refusal_abcdefghijklmnopqrstuvwxyz_0123456789";
const key = `refusal_${"k".repeat(40)}`;

suite("auth refusal reasons", () => {
  let db: Database;
  let app: ReturnType<typeof createApp>;
  let principalId: string;

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
    app = createApp(db,{ apnsMode: "disabled",credentialDerivationSecret: secret });
  });
  beforeEach(async () => {
    await db.query("TRUNCATE owner_principals, request_rate_limits CASCADE");
    await bootstrapOwner(db,"refusal-owner",token);
    principalId = (await db.query("SELECT id FROM owner_principals WHERE handle='refusal-owner'")).rows[0].id;
    await db.query("INSERT INTO principal_api_keys(principal_id,label,token_hash) VALUES ($1,'app',$2)",[principalId,hashToken(key)]);
  });
  afterAll(async () => { await db.end(); });

  const refused = async (as: string) => {
    const response = await app.request("/api/devices",{ headers: { authorization: `Bearer ${as}` } });
    expect(response.status).toBe(401);
    return (await response.json() as { error: string }).error;
  };

  test("each reason is named", async () => {
    expect((await app.request("/api/devices",{ headers: { authorization: `Bearer ${key}` } })).status).toBe(200);
    expect(await refused(`unknown_${"u".repeat(40)}`)).toBe("unauthorized");
    await db.query("UPDATE principal_api_keys SET expires_at=now()-interval '1 minute' WHERE token_hash=$1",[hashToken(key)]);
    expect(await refused(key)).toBe("login_expired");
    await db.query("UPDATE principal_api_keys SET revoked_at=now() WHERE token_hash=$1",[hashToken(key)]);
    expect(await refused(key)).toBe("credential_revoked");
    await db.query("UPDATE owner_principals SET disabled_at=now() WHERE id=$1",[principalId]);
    expect(await refused(key)).toBe("account_disabled");
  });
});
