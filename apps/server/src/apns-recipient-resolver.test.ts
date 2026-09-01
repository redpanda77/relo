import { createHash, randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { PostgresApnsRecipientResolver } from "./apns-recipient-resolver.js";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { createTransportTokenEncryption, type TransportTokenEncryption } from "./token-encryption.js";

const encryption: TransportTokenEncryption = {
  encrypt: (token, purpose) => token === null ? null : `${purpose}:${token}`,
  decrypt: (value, purpose) => value === null ? null : value.replace(`${purpose}:`, ""),
};

type Result = { rowCount: number; rows: unknown[] };

class FakeClient {
  readonly statements: Array<{ text: string; values?: unknown[] }> = [];
  released = false;
  constructor(
    private readonly ciphertext: string | null,
    private readonly environment = "sandbox",
    private readonly targeted = true,
  ) {}
  async query(text: string, values?: unknown[]): Promise<Result> {
    this.statements.push({ text, ...(values === undefined ? {} : { values }) });
    if (/^SELECT d\.apns_token/m.test(text) || /^SELECT d\.live_activity_push_to_start_token/m.test(text)
      || /^SELECT update_token\.token/m.test(text)) {
      const binding = ["job-id","claim-token","event-id","device-id","principal-id"];
      const bound = binding.every((value,index) => values?.[index] === value);
      return this.ciphertext === null || !this.targeted || !bound
        ? { rowCount: 0, rows: [] }
        : { rowCount: 1, rows: [{ ciphertext: this.ciphertext, environment: this.environment }] };
    }
    if (/^(UPDATE devices SET|DELETE FROM live_activity_update_tokens)/.test(text)) {
      return { rowCount: 1, rows: [] };
    }
    return { rowCount: 0, rows: [] };
  }
  release(): void { this.released = true; }
}

function fakeDatabase(ciphertext: string | null, environment = "sandbox", targeted = true) {
  const poolQueries: Array<{ text: string; values?: unknown[] }> = [];
  const clients: FakeClient[] = [];
  return {
    db: {
      async query(text: string, values?: unknown[]) {
        poolQueries.push({ text, ...(values === undefined ? {} : { values }) });
        const client = new FakeClient(ciphertext,environment,targeted);
        return await client.query(text, values);
      },
      async connect() {
        const client = new FakeClient(ciphertext,environment,targeted);
        clients.push(client);
        return client;
      },
    },
    clients,
    poolQueries,
  };
}

function options(db: unknown, kind = "notification" as const) {
  return {
    db: db as never,
    encryption,
    kind,
    deliveryJobId: "job-id",
    claimToken: "claim-token",
    principalId: "principal-id",
    deviceId: "device-id",
    notificationEventId: "event-id",
    environment: "sandbox" as const,
  };
}

describe("durable PostgreSQL APNs recipient resolver", () => {
  test("resolves only a current deliverable encrypted token with an opaque generation", async () => {
    const ciphertext = "device.apns_token:plain-token";
    const fake = fakeDatabase(ciphertext);
    const resolver = new PostgresApnsRecipientResolver(options(fake.db));
    await expect(resolver.resolve()).resolves.toEqual({
      token: "plain-token",
      generation: createHash("sha256").update(ciphertext).digest("hex"),
    });
    expect(fake.poolQueries[0]!.text).toMatch(/revoked_at IS NULL/);
    expect(fake.poolQueries[0]!.text).toMatch(/notification_authorization IN/);
    expect(fake.poolQueries[0]!.text).toMatch(/JOIN notification_events e/);
    expect(fake.poolQueries[0]!.text).toMatch(/j\.claim_token=\$2 AND j\.state='processing'/);
    expect(fake.poolQueries[0]!.text).toMatch(/j\.claim_phase='dispatch_started'/);
    expect(fake.poolQueries[0]!.text).toMatch(/d\.principal_id=e\.principal_id/);
    expect(fake.poolQueries[0]!.text).toMatch(/target\.device_id=d\.id/);
    expect(fake.poolQueries[0]!.text).not.toMatch(/FOR UPDATE/);
  });

  test("holds a row lock through invalidation and commits the exact leased ciphertext", async () => {
    const ciphertext = "device.apns_token:leased-token";
    const fake = fakeDatabase(ciphertext);
    const resolver = new PostgresApnsRecipientResolver(options(fake.db));
    const lease = await resolver.acquire();
    expect(lease).not.toBeNull();
    expect(lease).toMatchObject({ token: "leased-token" });
    await lease!.invalidate({ environment: "sandbox", invalidatedAtMs: 1_800_000_000_123 });
    await lease!.release(true);
    const client = fake.clients[0]!;
    expect(client.statements.map(({ text }) => text.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      "SELECT d.apns_token AS",
      "UPDATE devices SET",
      "COMMIT",
    ]);
    expect(client.statements[1]!.text).toMatch(/FOR UPDATE OF j,e,d/);
    expect(client.statements[2]!.values).toEqual(["device-id", ciphertext]);
    expect(client.released).toBe(true);
    expect(resolver.invalidations).toEqual([{
      generation: createHash("sha256").update(ciphertext).digest("hex"),
      invalidatedAtMs: 1_800_000_000_123,
    }]);
  });

  test("rolls back and releases an empty lease without exposing a token", async () => {
    const fake = fakeDatabase(null);
    const resolver = new PostgresApnsRecipientResolver(options(fake.db));
    await expect(resolver.acquire()).resolves.toBeNull();
    expect(fake.clients[0]!.statements.map(({ text }) => text)).toEqual([
      "BEGIN",
      expect.stringMatching(/FOR UPDATE OF j,e,d/),
      "ROLLBACK",
    ]);
    expect(fake.clients[0]!.released).toBe(true);
  });

  test("locks and deletes only the selected Live Activity update-token generation", async () => {
    const ciphertext = "live_activity_update_token.token:update-token";
    const fake = fakeDatabase(ciphertext);
    const resolver = new PostgresApnsRecipientResolver({
      ...options(fake.db, "live_activity_update"),
      liveActivityId: "activity-id",
      liveActivityGeneration: 7,
    });
    const lease = await resolver.acquire();
    expect(lease).toMatchObject({ token: "update-token" });
    await lease!.invalidate({ environment: "sandbox" });
    await lease!.release(true);
    expect(fake.clients[0]!.statements[1]!.text).toMatch(/FOR UPDATE OF j,e,d,activity,update_token/);
    expect(fake.clients[0]!.statements[1]!.text).toMatch(/update_token\.generation=activity\.generation/);
    expect(fake.clients[0]!.statements[1]!.text).toMatch(/activity\.generation=\$7/);
    expect(fake.clients[0]!.statements[1]!.text).toMatch(/liveActivity,generation/);
    expect(fake.clients[0]!.statements[1]!.values).toEqual([
      "job-id","claim-token","event-id","device-id","principal-id","activity-id",7,"sandbox",
    ]);
    expect(fake.clients[0]!.statements[2]).toMatchObject({
      text: expect.stringMatching(/^DELETE FROM live_activity_update_tokens/),
      values: ["activity-id", "device-id", 7, ciphertext],
    });
  });

  test("requires a positive generation for ActivityKit update-token resolution", () => {
    const fake = fakeDatabase("live_activity_update_token.token:update-token");
    for (const liveActivityGeneration of [undefined,0,-1,1.5]) {
      expect(() => new PostgresApnsRecipientResolver({
        ...options(fake.db,"live_activity_update"), liveActivityId: "activity-id", liveActivityGeneration,
      })).toThrow("liveActivityGeneration");
    }
  });

  test("fails closed on provider/environment mismatch and rolls back the lease", async () => {
    const fake = fakeDatabase("device.apns_token:token", "production");
    const resolver = new PostgresApnsRecipientResolver(options(fake.db));
    await expect(resolver.acquire()).rejects.toThrow("environment");
    expect(fake.clients[0]!.statements.at(-1)!.text).toBe("ROLLBACK");
    expect(fake.clients[0]!.released).toBe(true);
  });

  test("rejects foreign-account, untargeted, stale-claim, and misbound-job recipients", async () => {
    const ciphertext = "device.apns_token:token";
    for (const override of [
      { principalId: "foreign-principal" },
      { deliveryJobId: "other-job" },
      { claimToken: "stale-claim" },
      { notificationEventId: "other-event" },
      { deviceId: "other-device" },
    ]) {
      const fake = fakeDatabase(ciphertext);
      const resolver = new PostgresApnsRecipientResolver({ ...options(fake.db), ...override });
      await expect(resolver.resolve()).resolves.toBeNull();
    }
    const untargeted = fakeDatabase(ciphertext,"sandbox",false);
    await expect(new PostgresApnsRecipientResolver(options(untargeted.db)).resolve()).resolves.toBeNull();
  });
});

const databaseUrl = process.env.TEST_DATABASE_URL;
const postgresSuite = databaseUrl ? describe : describe.skip;

postgresSuite("PostgreSQL APNs dispatch lease integration", () => {
  let db: Database;
  let principalId: string;
  let deviceId: string;
  let eventId: string;
  let deliveryJobId: string;
  const claimToken = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const secret = "resolver-integration-secret-at-least-thirty-two-characters";
  const tokenEncryption = createTransportTokenEncryption(secret);

  beforeAll(async () => {
    db = createDatabase(databaseUrl!);
    await migrate(db);
    principalId = (await db.query<{ id: string }>(
      "INSERT INTO owner_principals(handle) VALUES ($1) RETURNING id",
      [`resolver-${randomUUID()}`],
    )).rows[0]!.id;
    deviceId = (await db.query<{ id: string }>(
      `INSERT INTO devices(
         principal_id,stable_device_id,installation_id,name,bundle_identifier,
         app_version,app_build,os_version,apns_environment,apns_token,notification_authorization
       ) VALUES ($1,$2,$3,'Resolver phone','com.example.app','1','1','18','sandbox',$4,'authorized')
       RETURNING id`,
      [principalId, randomUUID(), randomUUID(), tokenEncryption.encrypt("initial-token", "device.apns_token")],
    )).rows[0]!.id;
    eventId = (await db.query<{ id: string }>(
      `INSERT INTO notification_events(principal_id,source,title,body,idempotency_key,target_mode)
       VALUES ($1,'Resolver','Atomic lease','Body',$2,'explicit') RETURNING id`,
      [principalId, randomUUID()],
    )).rows[0]!.id;
    await db.query(
      "INSERT INTO notification_event_targets(notification_event_id,device_id) VALUES ($1,$2)",
      [eventId,deviceId],
    );
    deliveryJobId = (await db.query<{ id: string }>(
      `INSERT INTO delivery_jobs(
         notification_event_id,device_id,state,claim_token,claim_phase,lease_expires_at
       ) VALUES ($1,$2,'processing',$3,'dispatch_started',now()+interval '2 minutes') RETURNING id`,
      [eventId,deviceId,claimToken],
    )).rows[0]!.id;
  });

  afterAll(async () => {
    if (db && principalId) await db.query("DELETE FROM owner_principals WHERE id=$1", [principalId]);
    if (db) await db.end();
  });

  test("serializes token rotation until dispatch inspection releases the row", async () => {
    const resolver = new PostgresApnsRecipientResolver({
      db,encryption: tokenEncryption,kind: "notification",deliveryJobId,claimToken,principalId,deviceId,
      notificationEventId: eventId, environment: "sandbox",
    });
    const lease = await resolver.acquire();
    expect(lease).toMatchObject({ token: "initial-token" });
    let rotated = false;
    const replacement = tokenEncryption.encrypt("replacement-token", "device.apns_token")!;
    const rotation = db.query("UPDATE devices SET apns_token=$2 WHERE id=$1", [deviceId,replacement])
      .then(() => { rotated = true; });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(rotated).toBe(false);
    await lease!.release(true);
    await rotation;
    expect(rotated).toBe(true);
    await expect(resolver.resolve()).resolves.toMatchObject({ token: "replacement-token" });
  });

  test("commits status-authoritative invalidation against only the leased generation", async () => {
    const resolver = new PostgresApnsRecipientResolver({
      db,encryption: tokenEncryption,kind: "notification",deliveryJobId,claimToken,principalId,deviceId,
      notificationEventId: eventId, environment: "sandbox",
    });
    const lease = await resolver.acquire();
    await lease!.invalidate({ environment: "sandbox", invalidatedAtMs: 1_800_000_000_123 });
    await lease!.release(true);
    expect((await db.query<{ apns_token: string | null }>(
      "SELECT apns_token FROM devices WHERE id=$1",
      [deviceId],
    )).rows[0]!.apns_token).toBeNull();
    expect(resolver.invalidations[0]!.invalidatedAtMs).toBe(1_800_000_000_123);
  });
});
