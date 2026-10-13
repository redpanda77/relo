import { createHash, generateKeyPairSync,randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PostgresApnsRecipientResolver } from "./apns-recipient-resolver.js";
import { createDatabase, type Database } from "./db.js";
import { migrate } from "./migrate.js";
import { createTransportTokenEncryption, type TransportTokenEncryption } from "./token-encryption.js";
import { ApnsProviderCleanroom,type ApnsConnection,type TransportResult } from "./apns-provider-cleanroom.js";

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
    if (/^(UPDATE devices SET|UPDATE delivery_jobs SET|DELETE FROM live_activity_update_tokens)/.test(text)) {
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

  test("commits authorization and releases the connection before returning a token snapshot", async () => {
    const ciphertext = "device.apns_token:leased-token";
    const fake = fakeDatabase(ciphertext);
    const resolver = new PostgresApnsRecipientResolver(options(fake.db));
    const lease = await resolver.acquire();
    expect(lease).not.toBeNull();
    expect(lease).toMatchObject({ token: "leased-token" });
    expect(fake.clients[0]!.released).toBe(true);
    await lease!.invalidate({ environment: "sandbox", invalidatedAtMs: 1_800_000_000_123 });
    await lease!.release(true);
    const client = fake.clients[0]!;
    expect(client.statements.map(({ text }) => text.trim().split(/\s+/).slice(0, 3).join(" "))).toEqual([
      "BEGIN",
      "SET LOCAL lock_timeout='250ms'",
      "SET LOCAL statement_timeout='2s'",
      "SELECT d.apns_token AS",
      "UPDATE delivery_jobs SET",
      "COMMIT",
    ]);
    expect(client.statements[3]!.text).toMatch(/FOR UPDATE OF j,e,d/);
    expect(client.statements[4]!.values).toEqual(["job-id","claim-token",lease!.generation]);
    expect(fake.clients[1]!.statements[3]!.values).toEqual(["device-id", ciphertext]);
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
      "SET LOCAL lock_timeout='250ms'",
      "SET LOCAL statement_timeout='2s'",
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
    expect(fake.clients[0]!.statements[3]!.text).toMatch(/FOR UPDATE OF j,e,d,activity,update_token/);
    expect(fake.clients[0]!.statements[3]!.text).toMatch(/update_token\.generation=activity\.generation/);
    expect(fake.clients[0]!.statements[3]!.text).toMatch(/activity\.generation=\$7/);
    expect(fake.clients[0]!.statements[3]!.text).toMatch(/liveActivity,generation/);
    expect(fake.clients[0]!.statements[3]!.values).toEqual([
      "job-id","claim-token","event-id","device-id","principal-id","activity-id",7,"sandbox",
    ]);
    expect(fake.clients[1]!.statements[3]).toMatchObject({
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

postgresSuite("PostgreSQL APNs short dispatch authorization", () => {
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

  beforeEach(async () => {
    await db.query("UPDATE devices SET revoked_at=NULL,apns_token=$2 WHERE id=$1",
      [deviceId,tokenEncryption.encrypt("initial-token","device.apns_token")]);
    await db.query("UPDATE delivery_jobs SET recipient_authorized_at=NULL,recipient_generation=NULL WHERE id=$1",[deliveryJobId]);
  });

  test("a suspended 15-second provider response retains no database connection or lock", async () => {
    const resolver = new PostgresApnsRecipientResolver({
      db,encryption: tokenEncryption,kind: "notification",deliveryJobId,claimToken,principalId,deviceId,
      notificationEventId: eventId, environment: "sandbox",
    });
    let opened!: () => void;
    const streamOpened = new Promise<void>(resolve => { opened = resolve; });
    const response = new Promise<TransportResult>(resolve => setTimeout(() => resolve({
      kind: "response",status: 410,body: Buffer.from(JSON.stringify({ reason: "Unregistered",timestamp: Date.now() })),
    }),15_000));
    let usedTokenPath: string | undefined;
    const connection: ApnsConnection = {
      security: { tlsVersion: "TLSv1.3",alpnProtocol: "h2",authorized: true,
        hostnameVerified: true,servername: "api.sandbox.push.apple.com" },
      openStream(request) {
        usedTokenPath = request.path;
        opened();
        return { streamId: 1,result: response,cancel() {} };
      },
      onPeerSettings: () => () => {},onGoaway: () => () => {},close() {},
    };
    const keys = generateKeyPairSync("ec",{ namedCurve: "prime256v1" });
    const provider = new ApnsProviderCleanroom({
      teamId: "TEAM123456",keyId: "KEY1234567",
      privateKeyPem: keys.privateKey.export({ type: "pkcs8",format: "pem" }).toString(),
      keyScope: "team-scoped",keyEnvironment: "sandbox",environment: "sandbox",
      allowedTopics: ["com.example.app","com.example.app.push-type.liveactivity"],
      bundleId: "com.example.app",configurationGeneration: "short-fence-test",
    },{ open: async () => connection });
    const sending = provider.sendAlert({ recipient: resolver,alert: "Short fence" });
    await streamOpened;
    expect(db.totalCount).toBe(db.idleCount);
    const replacement = tokenEncryption.encrypt("replacement-token", "device.apns_token")!;
    const rotation = await db.connect();
    try {
      await rotation.query("SET statement_timeout='1s'");
      await rotation.query("UPDATE devices SET apns_token=$2 WHERE id=$1",[deviceId,replacement]);
      await rotation.query("RESET statement_timeout");
    } finally { rotation.release(); }
    expect(usedTokenPath).toBe("/3/device/initial-token");
    await expect(resolver.resolve()).resolves.toMatchObject({ token: "replacement-token" });
    expect(await sending).toMatchObject({ accepted: false,category: "invalid-recipient" });
    await expect(resolver.resolve()).resolves.toMatchObject({ token: "replacement-token" });
    expect(resolver.invalidations).toEqual([]);
    expect(db.totalCount).toBe(db.idleCount);
    await provider.close();
  },20_000);

  test("revocation before authorization prevents a snapshot; after authorization preserves in-flight evidence", async () => {
    const resolver = new PostgresApnsRecipientResolver({
      db,encryption: tokenEncryption,kind: "notification",deliveryJobId,claimToken,principalId,deviceId,
      notificationEventId: eventId,environment: "sandbox",
    });
    await db.query("UPDATE devices SET revoked_at=now() WHERE id=$1",[deviceId]);
    await expect(resolver.acquire()).resolves.toBeNull();
    expect((await db.query("SELECT recipient_authorized_at FROM delivery_jobs WHERE id=$1",[deliveryJobId])).rows[0].recipient_authorized_at).toBeNull();
    await db.query("UPDATE devices SET revoked_at=NULL WHERE id=$1",[deviceId]);
    const snapshot = await resolver.acquire();
    await db.query("UPDATE devices SET revoked_at=now(),apns_token=NULL WHERE id=$1",[deviceId]);
    expect(snapshot!.token).toBe("initial-token");
    const evidence = (await db.query("SELECT recipient_authorized_at,recipient_generation,state FROM delivery_jobs WHERE id=$1",[deliveryJobId])).rows[0];
    expect(evidence).toMatchObject({ state: "processing",recipient_generation: snapshot!.generation });
    expect(evidence.recipient_authorized_at).toBeInstanceOf(Date);
    await expect(resolver.acquire()).resolves.toBeNull();
    await snapshot!.release(true);
  });

  test("bounds contention and releases a failed authorization connection", async () => {
    const blocker = await db.connect();
    await blocker.query("BEGIN");
    await blocker.query("SELECT id FROM devices WHERE id=$1 FOR UPDATE",[deviceId]);
    try {
      const resolver = new PostgresApnsRecipientResolver({
        db,encryption: tokenEncryption,kind: "notification",deliveryJobId,claimToken,principalId,deviceId,
        notificationEventId: eventId,environment: "sandbox",
      });
      await expect(resolver.acquire()).rejects.toMatchObject({ code: "55P03" });
      expect(db.totalCount-db.idleCount).toBe(1);
    } finally {
      await blocker.query("ROLLBACK");
      blocker.release();
    }
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
