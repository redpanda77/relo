import { createHash, generateKeyPairSync, verify } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect as tlsConnect, createServer as createTlsServer, type SecureContextOptions } from "node:tls";
import { describe, expect, it } from "vitest";
import {
  ApnsProviderCleanroom,
  type AlertSend,
  type ApnsConnection,
  type ApnsProviderConfig,
  type ApnsTransport,
  type Clock,
  type GoawayEvent,
  type PreparedApnsRequest,
  type RecipientResolver,
  type Scheduler,
  type TransportBinding,
  type TransportResult,
} from "./apns-provider-cleanroom.js";

const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const privateKeyPem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
const UUID = "123e4567-e89b-42d3-a456-426614174000";

class MutableClock implements Clock {
  constructor(public value = 1_800_000_000_000) {}
  nowMs(): number { return this.value; }
}

class ImmediateScheduler implements Scheduler {
  readonly delays: number[] = [];
  constructor(private readonly clock: MutableClock) {}
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (ms === 10_000 || ms === 15_000) {
      return await new Promise<void>((_resolve, reject) => {
        signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        }, { once: true });
      });
    }
    this.delays.push(ms);
    this.clock.value += ms;
  }
}

class ScriptedConnection implements ApnsConnection {
  readonly security = {
    tlsVersion: "TLSv1.3",
    alpnProtocol: "h2",
    authorized: true,
    hostnameVerified: true,
    servername: "api.sandbox.push.apple.com",
  };
  peerMaxConcurrentStreams = 100;
  readonly requests: PreparedApnsRequest[] = [];
  closed = false;
  private nextStreamId = 1;
  private settingsListener: (limit: number) => void = () => undefined;
  private goawayListener: (event: GoawayEvent) => void = () => undefined;

  constructor(private readonly script: TransportResult[]) {}
  openStream(request: PreparedApnsRequest): { streamId: number; result: Promise<TransportResult>; cancel(): void } {
    this.requests.push(request);
    const streamId = this.nextStreamId;
    this.nextStreamId += 2;
    return { streamId, result: Promise.resolve(this.script.shift() ?? response(200)), cancel: () => undefined };
  }
  onPeerSettings(listener: (limit: number) => void): () => void {
    this.settingsListener = listener;
    return () => undefined;
  }
  onGoaway(listener: (event: GoawayEvent) => void): () => void {
    this.goawayListener = listener;
    return () => undefined;
  }
  close(): void { this.closed = true; }
  settings(limit: number): void { this.settingsListener(limit); }
  goaway(reason = "Shutdown", lastStreamId = Number.MAX_SAFE_INTEGER): void {
    this.goawayListener({ lastStreamId, diagnostic: Buffer.from(JSON.stringify({ reason })) });
  }
  goawayEvent(event: GoawayEvent): void { this.goawayListener(event); }
}

class ScriptedTransport implements ApnsTransport {
  readonly bindings: TransportBinding[] = [];
  readonly connections: ScriptedConnection[] = [];
  constructor(private readonly scripts: TransportResult[][]) {}
  async open(binding: TransportBinding): Promise<ApnsConnection> {
    this.bindings.push(binding);
    const connection = new ScriptedConnection(this.scripts.shift() ?? []);
    connection.security.servername = binding.servername;
    this.connections.push(connection);
    return connection;
  }
}

class DeferredConnection implements ApnsConnection {
  readonly security = {
    tlsVersion: "TLSv1.3",
    alpnProtocol: "h2",
    authorized: true,
    hostnameVerified: true,
    servername: "api.sandbox.push.apple.com",
  };
  peerMaxConcurrentStreams = 10;
  readonly requests: PreparedApnsRequest[] = [];
  readonly pending = new Map<number, (result: TransportResult) => void>();
  active = 0;
  maxActive = 0;
  closed = false;
  private nextStreamId = 1;
  private settingsListener: (limit: number) => void = () => undefined;
  private goawayListener: (event: GoawayEvent) => void = () => undefined;

  openStream(request: PreparedApnsRequest): { streamId: number; result: Promise<TransportResult>; cancel(): void } {
    const streamId = this.nextStreamId;
    this.nextStreamId += 2;
    this.requests.push(request);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    let settled = false;
    let resolvePromise: (result: TransportResult) => void = () => undefined;
    const finish = (result: TransportResult) => {
      if (settled) return;
      settled = true;
      this.active -= 1;
      this.pending.delete(streamId);
      resolvePromise(result);
    };
    const result = new Promise<TransportResult>((resolve) => {
      resolvePromise = resolve;
      this.pending.set(streamId, finish);
    });
    return { streamId, result, cancel: () => finish({ kind: "failure", code: "reset" }) };
  }
  onPeerSettings(listener: (limit: number) => void): () => void {
    this.settingsListener = listener;
    return () => undefined;
  }
  onGoaway(listener: (event: GoawayEvent) => void): () => void {
    this.goawayListener = listener;
    return () => undefined;
  }
  close(): void { this.closed = true; }
  complete(streamId: number, result: TransportResult): void { this.pending.get(streamId)?.(result); }
  settings(limit: number): void { this.settingsListener(limit); }
  goaway(lastStreamId: number, reason = "Shutdown"): void {
    this.goawayListener({ lastStreamId, diagnostic: Buffer.from(JSON.stringify({ reason })) });
  }
}

class DirectTransport implements ApnsTransport {
  readonly bindings: TransportBinding[] = [];
  constructor(readonly connection: ApnsConnection) {}
  async open(binding: TransportBinding): Promise<ApnsConnection> {
    this.bindings.push(binding);
    this.connection.security.servername = binding.servername;
    return this.connection;
  }
}

class DeferredTransport implements ApnsTransport {
  readonly bindings: TransportBinding[] = [];
  constructor(private readonly connections: DeferredConnection[]) {}
  async open(binding: TransportBinding): Promise<ApnsConnection> {
    this.bindings.push(binding);
    const connection = this.connections.shift();
    if (!connection) throw new Error("no scripted deferred connection");
    connection.security.servername = binding.servername;
    return connection;
  }
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForRequests(connection: { requests: unknown[] }, count: number): Promise<void> {
  for (let index = 0; index < 100 && connection.requests.length < count; index += 1) await Promise.resolve();
  expect(connection.requests).toHaveLength(count);
}

function response(status: number, reason?: string, extras: Record<string, unknown> = {}): TransportResult {
  const body = reason === undefined && Object.keys(extras).length === 0
    ? Buffer.alloc(0)
    : Buffer.from(JSON.stringify({ ...(reason === undefined ? {} : { reason }), ...extras }));
  return { kind: "response", status, body };
}

function config(overrides: Partial<ApnsProviderConfig> = {}): ApnsProviderConfig {
  return {
    teamId: "TEAM123456",
    keyId: "KEY1234567",
    privateKeyPem,
    keyScope: "team-scoped",
    keyEnvironment: "sandbox",
    allowedTopics: ["com.example.app", "com.example.app.push-type.liveactivity"],
    bundleId: "com.example.app",
    environment: "sandbox",
    configurationGeneration: "generation-1",
    ...overrides,
  };
}

function recipient(initial = "token/with safe encoding"): RecipientResolver & { invalidations: unknown[] } {
  const result = {
    active: { token: initial, generation: "7" } as { token: string; generation: string } | null,
    invalidations: [] as unknown[],
    async resolve() { return this.active; },
    async invalidate(generation: string, details: unknown) {
      this.invalidations.push({ generation, details });
      if (this.active?.generation === generation) this.active = null;
    },
  };
  return result;
}

function provider(
  transport: ApnsTransport,
  clock = new MutableClock(),
  scheduler: Scheduler = new ImmediateScheduler(clock),
  overrides: Partial<ApnsProviderConfig> = {},
): ApnsProviderCleanroom {
  return new ApnsProviderCleanroom(config(overrides), transport, {
    clock,
    scheduler,
    random: { next: () => 0.5 },
    uuid: () => UUID,
  });
}

interface TlsFixture {
  key: Buffer;
  cert: Buffer;
  ca: Buffer;
}

function generateTlsFixtures(): {
  valid: TlsFixture;
  expired: TlsFixture;
  future: TlsFixture;
  wrongHost: TlsFixture;
  incomplete: TlsFixture;
  untrusted: TlsFixture;
  cleanup(): void;
} {
  const directory = mkdtempSync(join(tmpdir(), "relo-apns-tls-"));
  const run = (...args: string[]) => execFileSync("openssl", args, { cwd: directory, stdio: "ignore" });
  const write = (name: string, value: string) => writeFileSync(join(directory, name), value);
  const root = (prefix: string) => {
    run("req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", `${prefix}.key`, "-out", `${prefix}.crt`,
      "-subj", `/CN=${prefix}`, "-days", "36500",
      "-addext", "basicConstraints=critical,CA:TRUE", "-addext", "keyUsage=critical,keyCertSign,cRLSign");
  };
  root("root");
  root("other-root");
  run("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", "intermediate.key", "-out", "intermediate.csr", "-subj", "/CN=intermediate");
  write("intermediate.ext", "basicConstraints=critical,CA:TRUE,pathlen:0\nkeyUsage=critical,keyCertSign,cRLSign\n");
  run("x509", "-req", "-in", "intermediate.csr", "-CA", "root.crt", "-CAkey", "root.key", "-CAcreateserial",
    "-out", "intermediate.crt", "-days", "36500", "-extfile", "intermediate.ext");
  write("index.txt", "");
  write("serial", "1000\n");
  write("ca.cnf", [
    "[ca]", "default_ca=CA_default", "[CA_default]", "database=index.txt", "serial=serial",
    "new_certs_dir=.", "default_md=sha256", "default_days=36500", "policy=policy_any",
    "unique_subject=no", "[policy_any]", "commonName=supplied", "organizationalUnitName=optional", "",
  ].join("\n"));
  const leaf = (prefix: string, hostname: string, notBefore: string, notAfter: string) => {
    run("req", "-new", "-newkey", "rsa:2048", "-nodes", "-keyout", `${prefix}.key`,
      "-out", `${prefix}.csr`, "-subj", `/CN=${hostname}/OU=${prefix}`);
    write(`${prefix}.ext`, `[leaf]\nbasicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:${hostname}\n`);
    run("ca", "-batch", "-notext", "-config", "ca.cnf", "-cert", "intermediate.crt",
      "-keyfile", "intermediate.key", "-in", `${prefix}.csr`, "-out", `${prefix}.crt`,
      "-startdate", notBefore, "-enddate", notAfter, "-extfile", `${prefix}.ext`, "-extensions", "leaf");
  };
  leaf("valid", "api.sandbox.push.apple.com", "20000101000000Z", "20990101000000Z");
  leaf("expired", "api.sandbox.push.apple.com", "20000101000000Z", "20200101000000Z");
  leaf("future", "api.sandbox.push.apple.com", "20980101000000Z", "20990101000000Z");
  leaf("wrong-host", "wrong.example", "20000101000000Z", "20990101000000Z");
  const read = (name: string) => readFileSync(join(directory, name));
  const chain = (prefix: string) => Buffer.concat([read(`${prefix}.crt`), read("intermediate.crt")]);
  const fixture = (prefix: string, ca = "root.crt", includeIntermediate = true): TlsFixture => ({
    key: read(`${prefix}.key`),
    cert: includeIntermediate ? chain(prefix) : read(`${prefix}.crt`),
    ca: read(ca),
  });
  return {
    valid: fixture("valid"),
    expired: fixture("expired"),
    future: fixture("future"),
    wrongHost: fixture("wrong-host"),
    incomplete: fixture("valid", "root.crt", false),
    untrusted: fixture("valid", "other-root.crt"),
    cleanup: () => rmSync(directory, { recursive: true, force: true }),
  };
}

async function probeTls(
  fixture: TlsFixture,
  clientOverrides: SecureContextOptions & { ALPNProtocols?: string[]; rejectUnauthorized?: boolean } = {},
): Promise<{ protocol: string | null; alpn: string | false; authorized: boolean }> {
  const server = createTlsServer({
    key: fixture.key,
    cert: fixture.cert,
    minVersion: "TLSv1.2",
    ALPNProtocols: ["h2"],
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test TLS server has no TCP address");
  try {
    return await new Promise((resolve, reject) => {
      const socket = tlsConnect({
        host: "127.0.0.1",
        port: address.port,
        servername: "api.sandbox.push.apple.com",
        minVersion: "TLSv1.2",
        rejectUnauthorized: true,
        ca: fixture.ca,
        ALPNProtocols: ["h2"],
        ...clientOverrides,
      });
      socket.once("secureConnect", () => {
        const result = { protocol: socket.getProtocol(), alpn: socket.alpnProtocol, authorized: socket.authorized };
        socket.end();
        resolve(result);
      });
      socket.once("error", reject);
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

describe("clean-room APNs provider", () => {
  it("maps environments exactly and validates key authorization and topics", () => {
    const sandbox = provider(new ScriptedTransport([]));
    expect(sandbox.authority).toBe("api.sandbox.push.apple.com:443");
    const production = new ApnsProviderCleanroom(
      config({ environment: "production", keyEnvironment: "production" }),
      new ScriptedTransport([]),
    );
    expect(production.authority).toBe("api.push.apple.com:443");
    expect(() => new ApnsProviderCleanroom(config({ environment: "production" }), new ScriptedTransport([]))).toThrow();
    expect(() => new ApnsProviderCleanroom(config({ keyEnvironment: "both" }), new ScriptedTransport([]))).toThrow();
    expect(() => new ApnsProviderCleanroom(config({
      keyEnvironment: "both",
      dualEnvironmentConfirmed: true,
      keyScope: "topic-specific",
      appleAssociatedTopics: ["com.example.app", "com.example.app.push-type.liveactivity"],
    }), new ScriptedTransport([]))).toThrow();
    expect(() => new ApnsProviderCleanroom(config({ allowedTopics: ["com.example.app"] }), new ScriptedTransport([]))).toThrow();
  });

  it("accepts confirmed dual-environment keys but gives each environment a distinct pool", () => {
    const common = { keyEnvironment: "both" as const, dualEnvironmentConfirmed: true };
    const sandbox = new ApnsProviderCleanroom(config(common), new ScriptedTransport([]));
    const production = new ApnsProviderCleanroom(config({ ...common, environment: "production" }), new ScriptedTransport([]));
    expect(sandbox.poolKey).not.toBe(production.poolKey);
  });

  it("an ordinary alert with interruptionLevel writes aps interruption-level", async () => {
    const transport = new ScriptedTransport([[response(200), response(200)]]);
    const p = provider(transport, new MutableClock());
    await p.sendAlert({ recipient: recipient(), alert: "question", interruptionLevel: "time-sensitive" });
    await p.sendAlert({ recipient: recipient(), alert: "plain" });
    const [first, second] = transport.connections[0]!.requests;
    expect(JSON.parse(Buffer.from(first!.body).toString()).aps["interruption-level"]).toBe("time-sensitive");
    expect(JSON.parse(Buffer.from(second!.body).toString()).aps).not.toHaveProperty("interruption-level");
  });

  it("builds a signed cached ES256 bearer JWT and reuses a healthy connection", async () => {
    const transport = new ScriptedTransport([[response(200), response(200)]]);
    const clock = new MutableClock();
    const p = provider(transport, clock);
    const target = recipient();
    await p.sendAlert({ recipient: target, alert: "one" });
    await p.sendAlert({ recipient: target, alert: "two" });
    expect(transport.connections).toHaveLength(1);
    const requests = transport.connections[0]!.requests;
    expect(requests).toHaveLength(2);
    expect(requests[0]!.headers.authorization).toBe(requests[1]!.headers.authorization);
    const token = requests[0]!.headers["authorization"]!.slice(7);
    const [header, claims, signature] = token.split(".");
    expect(JSON.parse(Buffer.from(header!, "base64url").toString())).toEqual({ alg: "ES256", kid: "KEY1234567" });
    expect(JSON.parse(Buffer.from(claims!, "base64url").toString())).toEqual({ iss: "TEAM123456", iat: 1_800_000_000 });
    expect(verify(
      "sha256",
      Buffer.from(`${header}.${claims}`),
      { key: keys.publicKey, dsaEncoding: "ieee-p1363" },
      Buffer.from(signature!, "base64url"),
    )).toBe(true);
  });

  it("rotates JWT at refresh age and fails safely on clock rollback", async () => {
    const transport = new ScriptedTransport([[response(200), response(200), response(200)]]);
    const clock = new MutableClock();
    const p = provider(transport, clock);
    const target = recipient();
    await p.sendAlert({ recipient: target, alert: "a" });
    const first = transport.connections[0]!.requests[0]!.headers.authorization;
    clock.value += 3_000_000;
    await p.sendAlert({ recipient: target, alert: "b" });
    expect(transport.connections[0]!.requests[1]!.headers.authorization).not.toBe(first);
    clock.value -= 4_000_000;
    const rolledBack = await p.sendAlert({ recipient: target, alert: "c" });
    expect(rolledBack.category).toBe("provider-authentication");
    expect(transport.connections[0]!.requests).toHaveLength(2);
  });

  it("constructs exact alert headers, encoded path, and a single checked body", async () => {
    const transport = new ScriptedTransport([[response(200)]]);
    const p = provider(transport);
    const result = await p.sendAlert({
      recipient: recipient("abc/def?x=1"),
      alert: { title: "Hello", body: "World" },
      priority: 5,
      expiration: 1_900_000_000,
      apnsId: UUID,
      mutableContent: true,
      customData: { order: 3 },
    });
    expect(result.category).toBe("accepted");
    const request = transport.connections[0]!.requests[0]!;
    expect(request.method).toBe("POST");
    expect(request.path).toBe("/3/device/abc%2Fdef%3Fx%3D1");
    expect(request.headers).toMatchObject({
      "apns-topic": "com.example.app",
      "apns-push-type": "alert",
      "apns-priority": "5",
      "apns-expiration": "1900000000",
      "apns-id": UUID,
    });
    expect(JSON.parse(Buffer.from(request.body).toString())).toEqual({
      order: 3,
      aps: { alert: { title: "Hello", body: "World" }, "mutable-content": 1 },
    });
    expect(result.payloadBytes).toBe(request.body.byteLength);
  });

  it("rejects malformed paths, UUIDs, priority, expiration, and oversized payloads before transport", async () => {
    const transport = new ScriptedTransport([]);
    const p = provider(transport);
    expect((await p.sendAlert({ recipient: recipient("bad\nheader"), alert: "x" })).category).toBe("validation");
    expect((await p.sendAlert({ recipient: recipient(), alert: "x", apnsId: "not-uuid" })).category).toBe("validation");
    expect((await p.sendAlert({ recipient: recipient(), alert: "x", priority: 7 as 5 })).category).toBe("validation");
    expect((await p.sendAlert({ recipient: recipient(), alert: "x", expiration: 1.5 })).category).toBe("validation");
    expect((await p.sendAlert({ recipient: recipient(), alert: "😀".repeat(1_100) })).category).toBe("validation");
    expect(transport.connections).toHaveLength(0);
  });

  it("accepts exactly 4096 UTF-8 bytes and rejects 4097 without opening another stream", async () => {
    const envelopeBytes = Buffer.byteLength(JSON.stringify({ aps: { alert: "" } }));
    const transport = new ScriptedTransport([[response(200)]]);
    const p = provider(transport);
    const exact = await p.sendAlert({ recipient: recipient(), alert: "a".repeat(4_096 - envelopeBytes) });
    expect(exact).toMatchObject({ accepted: true, payloadBytes: 4_096 });
    const oversized = await p.sendAlert({ recipient: recipient(), alert: "a".repeat(4_097 - envelopeBytes) });
    expect(oversized.category).toBe("validation");
    expect(transport.connections[0]!.requests).toHaveLength(1);
  });

  it("constructs ActivityKit start, update, and end with clock timestamps and local defaults", async () => {
    const transport = new ScriptedTransport([[response(200), response(200), response(200)]]);
    const p = provider(transport);
    const target = recipient();
    await p.sendActivity({
      recipient: target,
      operation: "start",
      contentState: { value: 1 },
      attributesType: "OrderAttributes",
      attributes: { id: 3 },
      alert: { title: "Started" },
    });
    await p.sendActivity({ recipient: target, operation: "update", contentState: { value: 2 } });
    await p.sendActivity({ recipient: target, operation: "end", contentState: { value: 3 } });
    const requests = transport.connections[0]!.requests;
    expect(requests.map((request) => request.headers["apns-priority"])).toEqual(["10", "5", "10"]);
    for (const request of requests) {
      expect(request.headers["apns-topic"]).toBe("com.example.app.push-type.liveactivity");
      expect(request.headers["apns-push-type"]).toBe("liveactivity");
      const aps = JSON.parse(Buffer.from(request.body).toString()).aps;
      expect(aps.timestamp).toBe(1_800_000_000);
      expect(aps["mutable-content"]).toBeUndefined();
    }
    expect(JSON.parse(Buffer.from(requests[0]!.body).toString()).aps).toMatchObject({
      event: "start",
      "input-push-token": 1,
      "attributes-type": "OrderAttributes",
      attributes: { id: 3 },
    });
    expect(JSON.parse(Buffer.from(requests[1]!.body).toString()).aps["input-push-token"])
      .toBeUndefined();
    expect(JSON.parse(Buffer.from(requests[2]!.body).toString()).aps["input-push-token"])
      .toBeUndefined();
  });

  it("reuses a provider-assigned ActivityKit timestamp and confirms exact payload identity", async () => {
    const transport = new ScriptedTransport([[response(200)]]);
    const clock = new MutableClock();
    const hashes: string[] = [];
    const result = await provider(transport,clock).sendActivity({
      recipient: recipient(),
      operation: "update",
      contentState: { value: "stable" },
      providerTimestamp: Math.floor(clock.value/1_000)-120,
      confirmPayloadSha256: async (hash) => { hashes.push(hash); return true; },
    });
    expect(result.category).toBe("accepted");
    const body = transport.connections[0]!.requests[0]!.body;
    const payload = JSON.parse(Buffer.from(body).toString());
    expect(payload.aps.timestamp).toBe(Math.floor(clock.value/1_000)-120);
    expect(hashes).toEqual([createHash("sha256").update(body).digest("hex")]);
  });

  it("invalidates every 410 with millisecond metadata and never labels acceptance as delivery", async () => {
    const transport = new ScriptedTransport([[response(410, "Unknown", { timestamp: 1_800_000_000_123 })]]);
    const p = provider(transport);
    const target = recipient();
    const result = await p.sendAlert({ recipient: target, alert: "x" });
    expect(result).toMatchObject({
      accepted: false,
      category: "invalid-recipient",
      invalidatedAtMs: 1_800_000_000_123,
    });
    expect(target.invalidations).toEqual([{ generation: "7", details: { environment: "sandbox", invalidatedAtMs: 1_800_000_000_123 } }]);
  });

  it("holds an atomic dispatch lease through response inspection and invalidates inside it", async () => {
    const transport = new ScriptedTransport([[response(410,"Unregistered",{ timestamp: 123_456 })]]);
    const actions: string[] = [];
    const target: RecipientResolver = {
      async resolve() { return { token: "preflight", generation: "preflight" }; },
      async acquire() {
        actions.push("acquire");
        return {
          token: "leased-token",
          generation: "leased-generation",
          async invalidate(details) { actions.push(`invalidate:${details.invalidatedAtMs}`); },
          async release(commit) { actions.push(`release:${commit}`); },
        };
      },
      async invalidate() { throw new Error("non-atomic invalidation must not be used"); },
    };
    const result = await provider(transport).sendAlert({ recipient: target, alert: "leased" });
    expect(result.category).toBe("invalid-recipient");
    expect(actions).toEqual(["acquire","invalidate:123456","release:true"]);
    expect(transport.connections[0]!.requests[0]!.path).toContain("leased-token");
  });

  it("rolls back an acquired dispatch lease when canceled before stream open", async () => {
    const transport = new ScriptedTransport([[response(200)]]);
    const controller = new AbortController();
    const actions: string[] = [];
    const target: RecipientResolver = {
      async resolve() { return { token: "preflight", generation: "preflight" }; },
      async acquire() {
        actions.push("acquire");
        controller.abort();
        return {
          token: "leased-token",
          generation: "leased-generation",
          async invalidate() { actions.push("invalidate"); },
          async release(commit) { actions.push(`release:${commit}`); },
        };
      },
      async invalidate() { throw new Error("unexpected resolver invalidation"); },
    };
    const result = await provider(transport).sendAlert({
      recipient: target,
      alert: "canceled",
      signal: controller.signal,
    });
    expect(result.accepted).toBe(false);
    expect(actions).toEqual(["acquire","release:false"]);
    expect(transport.connections[0]!.requests).toHaveLength(0);
  });

  it("refreshes once for ExpiredProviderToken while preserving body and apns-id", async () => {
    const transport = new ScriptedTransport([[
      response(200),
      response(403, "ExpiredProviderToken"),
      response(200),
    ]]);
    const clock = new MutableClock();
    const p = provider(transport, clock);
    const target = recipient();
    // Establish a token old enough that a corrective refresh cannot become token churn.
    await p.sendAlert({ recipient: target, alert: "prime" });
    clock.value += 1_200_000;
    transport.connections[0]!.requests.length = 0;
    const result = await p.sendAlert({ recipient: target, alert: "logical", apnsId: UUID });
    expect(result.category).toBe("accepted");
    const requests = transport.connections[0]!.requests;
    expect(Buffer.from(requests[0]!.body).equals(Buffer.from(requests[1]!.body))).toBe(true);
    expect(requests[0]!.headers["apns-id"]).toBe(requests[1]!.headers["apns-id"]);
    expect(requests[0]!.headers.authorization).not.toBe(requests[1]!.headers.authorization);
  });

  it("retires a connection once for UnrelatedKeyIdInToken without rotating JWT", async () => {
    const transport = new ScriptedTransport([
      [response(403, "UnrelatedKeyIdInToken")],
      [response(200)],
    ]);
    const p = provider(transport);
    const result = await p.sendAlert({ recipient: recipient(), alert: "x" });
    expect(result.category).toBe("accepted");
    expect(transport.connections).toHaveLength(2);
    expect(transport.connections[0]!.closed).toBe(true);
    expect(transport.connections[0]!.requests[0]!.headers.authorization)
      .toBe(transport.connections[1]!.requests[0]!.headers.authorization);
  });

  it("quarantines ambiguous 403 and 429 responses without automatic replay", async () => {
    const transport403 = new ScriptedTransport([[response(403)]]);
    const p403 = provider(transport403);
    expect((await p403.sendAlert({ recipient: recipient(), alert: "x" })).category).toBe("ambiguous-authorization");
    expect((await p403.sendAlert({ recipient: recipient(), alert: "y" })).category).toBe("pool-quarantined");
    expect(transport403.connections[0]!.requests).toHaveLength(1);

    const transport429 = new ScriptedTransport([[response(429, "UnknownRateLimit")]]);
    const p429 = provider(transport429);
    expect((await p429.sendAlert({ recipient: recipient(), alert: "x" })).category).toBe("ambiguous-rate-limit");
    expect(transport429.connections[0]!.requests).toHaveLength(1);
  });

  it("uses bounded jittered recipient throttling retries", async () => {
    const transport = new ScriptedTransport([[
      response(429, "TooManyRequests"),
      response(429, "TooManyRequests"),
      response(200),
    ]]);
    const clock = new MutableClock();
    const scheduler = new ImmediateScheduler(clock);
    const p = provider(transport, clock, scheduler);
    const result = await p.sendAlert({ recipient: recipient(), alert: "x" });
    expect(result.category).toBe("accepted");
    expect(scheduler.delays.filter((delay) => delay < 100_000)).toEqual([1_000, 2_000]);
  });

  it("exhausts 429 and 5xx at their exact total-attempt budgets", async () => {
    const clock429 = new MutableClock();
    const scheduler429 = new ImmediateScheduler(clock429);
    const transport429 = new ScriptedTransport([[
      response(429, "TooManyRequests"),
      response(429, "TooManyRequests"),
      response(429, "TooManyRequests"),
      response(429, "TooManyRequests"),
    ]]);
    const exhausted429 = await provider(transport429, clock429, scheduler429)
      .sendAlert({ recipient: recipient(), alert: "x" });
    expect(exhausted429).toMatchObject({ category: "retry-exhausted", attempt: 4 });
    expect(scheduler429.delays.filter((delay) => delay < 100_000)).toEqual([1_000, 2_000, 4_000]);
    expect(transport429.connections[0]!.requests).toHaveLength(4);

    const clock5xx = new MutableClock();
    const scheduler5xx = new ImmediateScheduler(clock5xx);
    const transport5xx = new ScriptedTransport([[response(500), response(503), response(500)]]);
    const exhausted5xx = await provider(transport5xx, clock5xx, scheduler5xx)
      .sendAlert({ recipient: recipient(), alert: "x" });
    expect(exhausted5xx).toMatchObject({ category: "retry-exhausted", attempt: 3 });
    expect(scheduler5xx.delays.filter((delay) => delay >= 100_000)).toEqual([900_000, 1_800_000]);
    expect(transport5xx.connections[0]!.requests).toHaveLength(3);
  });

  it("enforces durable prior attempts and the original retry horizon without reset", async () => {
    const clock429 = new MutableClock();
    const first429 = clock429.value-1_000;
    const fourth429 = new ScriptedTransport([[response(429,"TooManyRequests")]]);
    await expect(provider(fourth429,clock429).sendAlert({
      recipient: recipient(),alert: "fourth",
      providerAttemptState: {
        attemptsUsed: 3,firstAttemptAtMs: first429,attemptCap: 4,
        retryHorizonAtMs: first429+300_000,nextAttemptNotBeforeMs: clock429.value,
      },
    })).resolves.toMatchObject({ category: "retry-exhausted",attempt: 1,firstAttemptAtMs: first429 });
    expect(fourth429.connections[0]!.requests).toHaveLength(1);

    const capped429 = new ScriptedTransport([[response(200)]]);
    await expect(provider(capped429,clock429).sendAlert({
      recipient: recipient(),alert: "capped",
      providerAttemptState: {
        attemptsUsed: 4,firstAttemptAtMs: first429,attemptCap: 4,
        retryHorizonAtMs: first429+300_000,nextAttemptNotBeforeMs: clock429.value,
      },
    })).resolves.toMatchObject({ category: "retry-exhausted",attempt: 0,firstAttemptAtMs: first429 });
    expect(capped429.connections).toHaveLength(0);

    const clock5xx = new MutableClock();
    const first5xx = clock5xx.value-1_000;
    const third5xx = new ScriptedTransport([[response(503)]]);
    await expect(provider(third5xx,clock5xx).sendAlert({
      recipient: recipient(),alert: "third",
      providerAttemptState: {
        attemptsUsed: 2,firstAttemptAtMs: first5xx,attemptCap: 3,
        retryHorizonAtMs: first5xx+3_600_000,nextAttemptNotBeforeMs: clock5xx.value,
      },
    })).resolves.toMatchObject({ category: "retry-exhausted",attempt: 1,firstAttemptAtMs: first5xx });
    expect(third5xx.connections[0]!.requests).toHaveLength(1);

    const expiredHorizon = new ScriptedTransport([[response(200)]]);
    const expiredFirst = clock429.value-300_000;
    await expect(provider(expiredHorizon,clock429).sendAlert({
      recipient: recipient(),alert: "expired",
      providerAttemptState: {
        attemptsUsed: 1,firstAttemptAtMs: expiredFirst,attemptCap: 4,
        retryHorizonAtMs: expiredFirst+300_000,nextAttemptNotBeforeMs: expiredFirst+1_000,
      },
    })).resolves.toMatchObject({ category: "retry-exhausted",attempt: 0,firstAttemptAtMs: expiredFirst });
    expect(expiredHorizon.connections).toHaveLength(0);
  });

  it.each([429,503])("durably yields a %s backoff without sleeping or opening an early stream after restart", async (status) => {
    const clock = new MutableClock();
    const scheduler = new ImmediateScheduler(clock);
    const start = clock.value;
    let persisted: Required<NonNullable<AlertSend["providerAttemptState"]>> | undefined;
    const persist: NonNullable<AlertSend["persistProviderRetryState"]> = async value => { persisted = value; return value; };
    const first = new ScriptedTransport([[response(status,status === 429 ? "TooManyRequests" : undefined)]]);
    const result = await provider(first,clock,scheduler).sendAlert({
      recipient: recipient(),alert: "same immutable payload",persistProviderRetryState: persist,
    });
    expect(result).toMatchObject({ category: "retry-scheduled",attempt: 1,nextAttemptNotBeforeMs: persisted!.nextAttemptNotBeforeMs });
    expect(clock.value).toBe(start);
    expect(scheduler.delays).toEqual([]);
    const restart = new ScriptedTransport([[response(200)]]);
    const restarted = provider(restart,clock,scheduler);
    const input: AlertSend = { recipient: recipient(),alert: "same immutable payload",providerAttemptState: persisted!,persistProviderRetryState: persist };
    expect(await restarted.sendAlert(input)).toMatchObject({ category: "retry-scheduled",attempt: 0 });
    expect(restart.connections).toHaveLength(0);
    clock.value = persisted!.nextAttemptNotBeforeMs;
    expect(await restarted.sendAlert(input)).toMatchObject({ category: "accepted",attempt: 1,firstAttemptAtMs: start });
    expect(restart.connections[0]!.requests[0]!.body).toEqual(first.connections[0]!.requests[0]!.body);
  });

  it("persists the exact 5xx not-before before waiting and enforces it before restart resolution", async () => {
    const clock = new MutableClock();
    const firstAttemptAt = clock.value;
    let durableState: {
      attemptsUsed: number;
      firstAttemptAtMs: number;
      attemptCap: number;
      retryHorizonAtMs: number;
      nextAttemptNotBeforeMs: number;
    } | undefined;
    const first = new ScriptedTransport([[response(500)]]);
    const crashAfterCheckpoint: Scheduler = { async sleep() { throw new Error("simulated process loss"); } };
    await provider(first,clock,crashAfterCheckpoint).sendAlert({
      recipient: recipient(),alert: "first claim",
      persistProviderRetryState: async (proposed) => {
        durableState = { ...proposed };
        return proposed;
      },
    });
    expect(durableState).toEqual({
      attemptsUsed: 1,firstAttemptAtMs: firstAttemptAt,attemptCap: 3,
      retryHorizonAtMs: firstAttemptAt+3_600_000,
      nextAttemptNotBeforeMs: firstAttemptAt+900_000,
    });
    expect(first.connections[0]!.requests).toHaveLength(1);

    clock.value = durableState!.nextAttemptNotBeforeMs-1;
    let resolutions = 0;
    const restartedRecipient = recipient();
    const originalResolve = restartedRecipient.resolve.bind(restartedRecipient);
    restartedRecipient.resolve = async () => { resolutions += 1; return await originalResolve(); };
    const restartScheduler: Scheduler = {
      async sleep(ms) {
        expect(ms).toBe(1);
        expect(resolutions).toBe(0);
        clock.value += ms;
      },
    };
    const restarted = new ScriptedTransport([[response(200)]]);
    await expect(provider(restarted,clock,restartScheduler).sendAlert({
      recipient: restartedRecipient,alert: "restarted claim",
      providerAttemptState: durableState,
    })).resolves.toMatchObject({ category: "accepted",attempt: 1,firstAttemptAtMs: firstAttemptAt });
    expect(resolutions).toBeGreaterThan(0);
    expect(restarted.connections[0]!.requests).toHaveLength(1);
  });

  it("persists exact 429 jitter and preserves the stricter prior horizon across a class transition", async () => {
    const clock = new MutableClock();
    const checkpoints: Array<{
      attemptsUsed: number;
      firstAttemptAtMs: number;
      attemptCap: number;
      retryHorizonAtMs: number;
      nextAttemptNotBeforeMs: number;
    }> = [];
    let durable: { attemptCap: number;retryHorizonAtMs: number;nextAttemptNotBeforeMs: number } | undefined;
    const transport = new ScriptedTransport([[
      response(429,"TooManyRequests"),response(500),response(200),
    ]]);
    const sender = provider(transport,clock);
    const input: AlertSend = {
      recipient: recipient(),alert: "class transition",
      persistProviderRetryState: async (proposed) => {
        durable = durable === undefined ? {
          attemptCap: proposed.attemptCap,
          retryHorizonAtMs: proposed.retryHorizonAtMs,
          nextAttemptNotBeforeMs: proposed.nextAttemptNotBeforeMs,
        } : {
          attemptCap: Math.min(durable.attemptCap,proposed.attemptCap),
          retryHorizonAtMs: Math.min(durable.retryHorizonAtMs,proposed.retryHorizonAtMs),
          nextAttemptNotBeforeMs: Math.max(
            durable.nextAttemptNotBeforeMs,proposed.nextAttemptNotBeforeMs,
          ),
        };
        checkpoints.push({ ...proposed,...durable });
        return durable;
      },
    };
    expect(await sender.sendAlert(input)).toMatchObject({ category: "retry-scheduled",attempt: 1 });
    clock.value = checkpoints[0]!.nextAttemptNotBeforeMs;
    const result = await sender.sendAlert({ ...input,providerAttemptState: checkpoints[0]! });
    expect(checkpoints).toEqual([
      {
        attemptsUsed: 1,firstAttemptAtMs: 1_800_000_000_000,attemptCap: 4,
        retryHorizonAtMs: 1_800_000_300_000,nextAttemptNotBeforeMs: 1_800_000_001_000,
      },
      {
        attemptsUsed: 2,firstAttemptAtMs: 1_800_000_000_000,attemptCap: 3,
        retryHorizonAtMs: 1_800_000_300_000,nextAttemptNotBeforeMs: 1_800_001_801_000,
      },
    ]);
    expect(result).toMatchObject({ category: "retry-exhausted",attempt: 1,status: 500 });
    expect(transport.connections[0]!.requests).toHaveLength(2);
  });

  it("persists a second terminal checkpoint for a 5xx to 429 transition without replay", async () => {
    const clock = new MutableClock();
    const checkpoints: Array<{
      attemptsUsed: number;attemptCap: number;retryHorizonAtMs: number;nextAttemptNotBeforeMs: number;
    }> = [];
    let durable: { attemptCap: number;retryHorizonAtMs: number;nextAttemptNotBeforeMs: number } | undefined;
    const transport = new ScriptedTransport([[
      response(500),response(429,"TooManyRequests"),response(200),
    ]]);
    const sender = provider(transport,clock);
    const input: AlertSend = {
      recipient: recipient(),alert: "reverse class transition",
      persistProviderRetryState: async (proposed) => {
        durable = durable === undefined ? {
          attemptCap: proposed.attemptCap,
          retryHorizonAtMs: proposed.retryHorizonAtMs,
          nextAttemptNotBeforeMs: proposed.nextAttemptNotBeforeMs,
        } : {
          attemptCap: Math.min(durable.attemptCap,proposed.attemptCap),
          retryHorizonAtMs: Math.min(durable.retryHorizonAtMs,proposed.retryHorizonAtMs),
          nextAttemptNotBeforeMs: Math.max(
            durable.nextAttemptNotBeforeMs,proposed.nextAttemptNotBeforeMs,
          ),
        };
        checkpoints.push({ attemptsUsed: proposed.attemptsUsed,...durable });
        return durable;
      },
    };
    expect(await sender.sendAlert(input)).toMatchObject({ category: "retry-scheduled",attempt: 1 });
    clock.value = checkpoints[0]!.nextAttemptNotBeforeMs;
    const result = await sender.sendAlert({
      ...input,providerAttemptState: { ...checkpoints[0]!,firstAttemptAtMs: 1_800_000_000_000 },
    });
    expect(checkpoints).toEqual([
      {
        attemptsUsed: 1,attemptCap: 3,retryHorizonAtMs: 1_800_003_600_000,
        nextAttemptNotBeforeMs: 1_800_000_900_000,
      },
      {
        attemptsUsed: 2,attemptCap: 3,retryHorizonAtMs: 1_800_000_300_000,
        nextAttemptNotBeforeMs: 1_800_000_900_000,
      },
    ]);
    expect(result).toMatchObject({ category: "retry-exhausted",attempt: 1,status: 429 });
    expect(transport.connections[0]!.requests).toHaveLength(2);

    const blockedRestart = new ScriptedTransport([[response(200)]]);
    await expect(provider(blockedRestart,clock).sendAlert({
      recipient: recipient(),alert: "must stay terminal",
      providerAttemptState: {
        attemptsUsed: 2,firstAttemptAtMs: 1_800_000_000_000,...durable!,
      },
    })).resolves.toMatchObject({ category: "retry-exhausted",attempt: 0 });
    expect(blockedRestart.connections).toHaveLength(0);
  });

  it("requires internally consistent durable provider attempt state", async () => {
    const clock = new MutableClock();
    for (const providerAttemptState of [
      { attemptsUsed: 1 },
      { attemptsUsed: 0,firstAttemptAtMs: clock.value },
      { attemptsUsed: -1,firstAttemptAtMs: clock.value },
      { attemptsUsed: 1,firstAttemptAtMs: clock.value+1 },
      { attemptsUsed: 1,firstAttemptAtMs: clock.value,attemptCap: 4 },
      { attemptsUsed: 1,firstAttemptAtMs: clock.value,attemptCap: 4,
        retryHorizonAtMs: clock.value+1_000,nextAttemptNotBeforeMs: clock.value-1 },
    ]) {
      const transport = new ScriptedTransport([[response(200)]]);
      await expect(provider(transport,clock).sendAlert({
        recipient: recipient(),alert: "invalid",providerAttemptState: providerAttemptState as never,
      })).resolves.toMatchObject({ category: "validation",attempt: 0 });
      expect(transport.connections).toHaveLength(0);
    }
  });

  it("fails a retry when an injected scheduler oversleeps its horizon", async () => {
    const clock = new MutableClock();
    const oversleeping: Scheduler = {
      async sleep(ms: number, signal?: AbortSignal) {
        if (ms === 10_000 || ms === 15_000) {
          return await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        }
        clock.value += ms + 3_600_000;
      },
    };
    const transport = new ScriptedTransport([[response(500), response(200)]]);
    const result = await provider(transport, clock, oversleeping)
      .sendAlert({ recipient: recipient(), alert: "x" });
    expect(result.category).toBe("retry-exhausted");
    expect(transport.connections[0]!.requests).toHaveLength(1);
  });

  it("rechecks the retry horizon when a delayed retry finally acquires its slot", async () => {
    const clock = new MutableClock();
    const connection = new DeferredConnection();
    connection.peerMaxConcurrentStreams = 1;
    let p: ApnsProviderCleanroom;
    let blocker: Promise<unknown> | undefined;
    const scheduler: Scheduler = {
      async sleep(ms: number, signal?: AbortSignal) {
        if (ms === 10_000 || ms === 15_000) {
          return await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        }
        clock.value += ms;
        blocker = p.sendAlert({ recipient: recipient("blocker-token"), alert: "blocker" });
        await waitForRequests(connection, 3);
      },
    };
    p = provider(new DirectTransport(connection), clock, scheduler);
    const target = recipient();
    const prime = p.sendAlert({ recipient: target, alert: "prime" });
    await waitForRequests(connection, 1);
    connection.complete(1, response(200));
    await prime;
    const retrying = p.sendAlert({ recipient: target, alert: "retrying" });
    await waitForRequests(connection, 2);
    connection.complete(3, response(500));
    await waitForRequests(connection, 3);
    clock.value += 2_700_000;
    connection.complete(5, response(200));
    await blocker;
    expect((await retrying).category).toBe("retry-exhausted");
    expect(connection.requests).toHaveLength(3);
  });

  it("waits 15 then 30 minutes for 5xx and preserves the logical request", async () => {
    const transport = new ScriptedTransport([[response(500), response(503, "Shutdown"), response(200)]]);
    const clock = new MutableClock();
    const scheduler = new ImmediateScheduler(clock);
    const p = provider(transport, clock, scheduler);
    const result = await p.sendActivity({
      recipient: recipient(),
      operation: "update",
      contentState: { message: "distinctive" },
      apnsId: UUID,
    });
    expect(result.category).toBe("accepted");
    expect(scheduler.delays.filter((delay) => delay >= 100_000)).toEqual([900_000, 1_800_000]);
    const requests = transport.connections[0]!.requests;
    expect(requests.map((request) => request.path)).toEqual([requests[0]!.path, requests[0]!.path, requests[0]!.path]);
    expect(requests.every((request) => Buffer.from(request.body).equals(Buffer.from(requests[0]!.body)))).toBe(true);
  });

  it("does not schedule a 5xx retry that reaches validity or expiration", async () => {
    const clock = new MutableClock();
    const validUntilTransport = new ScriptedTransport([[response(500)]]);
    const validUntil = await provider(validUntilTransport, clock).sendAlert({
      recipient: recipient(),
      alert: "x",
      validUntilMs: clock.value + 899_999,
    });
    expect(validUntil.category).toBe("retryable-not-scheduled");
    expect(validUntilTransport.connections[0]!.requests).toHaveLength(1);

    const expirationTransport = new ScriptedTransport([[response(503)]]);
    const expiration = await provider(expirationTransport, clock).sendAlert({
      recipient: recipient(),
      alert: "x",
      expiration: Math.floor(clock.value / 1_000) + 900,
    });
    expect(expiration.category).toBe("retryable-not-scheduled");
    expect(expirationTransport.connections[0]!.requests).toHaveLength(1);
  });

  it("re-resolves a rotated ActivityKit token before retry without changing event bytes", async () => {
    const transport = new ScriptedTransport([[response(500), response(200)]]);
    const clock = new MutableClock();
    const target = recipient("old-token") as ReturnType<typeof recipient> & { active: { token: string; generation: string } | null };
    const scheduler: Scheduler = {
      async sleep(ms: number, signal?: AbortSignal) {
        if (ms === 10_000 || ms === 15_000) {
          return await new Promise<void>((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        }
        clock.value += ms;
        target.active = { token: "new-token", generation: "8" };
      },
    };
    const p = provider(transport, clock, scheduler);
    const result = await p.sendActivity({ recipient: target, operation: "update", contentState: { n: 1 } });
    expect(result.category).toBe("accepted");
    const [first, second] = transport.connections[0]!.requests;
    expect(first!.path).toContain("old-token");
    expect(second!.path).toContain("new-token");
    expect(Buffer.from(first!.body).equals(Buffer.from(second!.body))).toBe(true);
    expect(first!.headers["apns-id"]).toBe(second!.headers["apns-id"]);
  });

  it("fails closed when negotiated TLS, hostname, trust, or ALPN facts are wrong", async () => {
    const mutations: Array<(connection: ScriptedConnection) => void> = [
      (connection) => { connection.security.tlsVersion = "TLSv1.1"; },
      (connection) => { connection.security.alpnProtocol = "http/1.1"; },
      (connection) => { connection.security.authorized = false; },
      (connection) => { connection.security.hostnameVerified = false; },
      (connection) => { connection.security.servername = "wrong.example"; },
    ];
    for (const mutate of mutations) {
      const transport = new ScriptedTransport([[]]);
      const p = provider(transport);
      const originalOpen = transport.open.bind(transport);
      transport.open = async (binding) => {
        const connection = await originalOpen(binding) as ScriptedConnection;
        mutate(connection);
        return connection;
      };
      const result = await p.sendAlert({ recipient: recipient(), alert: "secret payload" });
      expect(result).toMatchObject({ accepted: false, category: "indeterminate-transport" });
      expect(result).not.toHaveProperty("message");
      expect(transport.connections[0]!.closed).toBe(true);
      expect(transport.bindings[0]!.tls).toEqual({
        minimumVersion: "TLSv1.2",
        rejectUnauthorized: true,
        requireHostnameVerification: true,
        alpnProtocols: ["h2"],
      });
    }
  });

  it("drains a GOAWAY connection and uses a fresh identically bound connection", async () => {
    const transport = new ScriptedTransport([[response(200)], [response(200)]]);
    const p = provider(transport);
    const target = recipient();
    await p.sendAlert({ recipient: target, alert: "first" });
    transport.connections[0]!.goaway("Shutdown");
    const second = await p.sendAlert({ recipient: target, alert: "second" });
    expect(second.category).toBe("accepted");
    expect(transport.connections).toHaveLength(2);
    expect(transport.connections[0]!.closed).toBe(true);
    expect(transport.bindings[0]!.poolKey).toBe(transport.bindings[1]!.poolKey);
    expect(target.invalidations).toEqual([]);
  });

  it("holds the authentication gate at one, then obeys peer decreases and zero", async () => {
    const connection = new DeferredConnection();
    const p = provider(new DirectTransport(connection), undefined, undefined, { localConcurrencyCap: 3 });
    const target = recipient();
    const first = p.sendAlert({ recipient: target, alert: "first" });
    const second = p.sendAlert({ recipient: target, alert: "second" });
    const third = p.sendAlert({ recipient: target, alert: "third" });
    await waitForRequests(connection, 1);
    connection.complete(1, response(200));
    await first;
    await waitForRequests(connection, 3);
    expect(connection.maxActive).toBe(2);

    connection.settings(0);
    const fourth = p.sendAlert({ recipient: target, alert: "fourth" });
    connection.complete(3, response(200));
    connection.complete(5, response(200));
    await Promise.all([second, third]);
    await flush();
    expect(connection.requests).toHaveLength(3);
    connection.settings(1);
    await waitForRequests(connection, 4);
    connection.complete(7, response(200));
    expect((await fourth).category).toBe("accepted");
  });

  it("applies quarantine before releasing a slot to queued work", async () => {
    const connection = new DeferredConnection();
    connection.peerMaxConcurrentStreams = 1;
    const p = provider(new DirectTransport(connection));
    const target = recipient();
    const prime = p.sendAlert({ recipient: target, alert: "prime" });
    await waitForRequests(connection, 1);
    connection.complete(1, response(200));
    await prime;
    const ambiguous = p.sendAlert({ recipient: target, alert: "ambiguous" });
    const queued = p.sendAlert({ recipient: target, alert: "must-not-open" });
    await waitForRequests(connection, 2);
    connection.complete(3, response(403));
    expect((await ambiguous).category).toBe("ambiguous-authorization");
    expect((await queued).category).toBe("pool-quarantined");
    expect(connection.requests).toHaveLength(2);
  });

  it("refreshes queued authorization before releasing work after an expired-token response", async () => {
    const connection = new DeferredConnection();
    connection.peerMaxConcurrentStreams = 1;
    const clock = new MutableClock();
    const p = provider(new DirectTransport(connection), clock);
    const target = recipient();
    const prime = p.sendAlert({ recipient: target, alert: "prime" });
    await waitForRequests(connection, 1);
    connection.complete(1, response(200));
    await prime;
    clock.value += 1_200_000;

    const expired = p.sendAlert({ recipient: target, alert: "expired" });
    const queued = p.sendAlert({ recipient: target, alert: "queued" });
    await waitForRequests(connection, 2);
    const staleAuthorization = connection.requests[1]!.headers["authorization"];
    connection.complete(3, response(403, "ExpiredProviderToken"));
    await waitForRequests(connection, 3);
    expect(connection.requests[2]!.headers["authorization"]).not.toBe(staleAuthorization);
    connection.complete(5, response(200));
    await queued;
    await waitForRequests(connection, 4);
    connection.complete(7, response(200));
    expect((await expired).category).toBe("accepted");
  });

  it("re-resolves a queued recipient at its actual slot and uses only the replacement generation", async () => {
    const connection = new DeferredConnection();
    connection.peerMaxConcurrentStreams = 1;
    const p = provider(new DirectTransport(connection));
    const target = recipient("old-generation-token") as ReturnType<typeof recipient> & {
      active: { token: string; generation: string } | null;
    };
    const prime = p.sendAlert({ recipient: target, alert: "prime" });
    await waitForRequests(connection, 1);
    connection.complete(1, response(200));
    await prime;

    const blocker = p.sendAlert({ recipient: target, alert: "blocker" });
    const queued = p.sendActivity({ recipient: target, operation: "update", contentState: { n: 1 } });
    await waitForRequests(connection, 2);
    target.active = { token: "replacement-token", generation: "8" };
    connection.complete(3, response(200));
    await blocker;
    await waitForRequests(connection, 3);
    expect(connection.requests[2]!.path).toContain("replacement-token");
    expect(connection.requests[2]!.path).not.toContain("old-generation-token");
    connection.complete(5, response(200));
    expect((await queued).category).toBe("accepted");
  });

  it("stops queued work when rotation leaves no active replacement", async () => {
    const connection = new DeferredConnection();
    connection.peerMaxConcurrentStreams = 1;
    const p = provider(new DirectTransport(connection));
    const target = recipient("old-token") as ReturnType<typeof recipient> & {
      active: { token: string; generation: string } | null;
    };
    const prime = p.sendAlert({ recipient: target, alert: "prime" });
    await waitForRequests(connection, 1);
    connection.complete(1, response(200));
    await prime;
    const blocker = p.sendAlert({ recipient: target, alert: "blocker" });
    const queued = p.sendAlert({ recipient: target, alert: "queued" });
    await waitForRequests(connection, 2);
    target.active = null;
    connection.complete(3, response(200));
    await blocker;
    expect((await queued).category).toBe("stale-recipient");
    expect(connection.requests).toHaveLength(2);
  });

  it("blocks queued same-generation sends before releasing a 410 response slot", async () => {
    const connection = new DeferredConnection();
    connection.peerMaxConcurrentStreams = 1;
    const target = recipient("invalidated-token") as ReturnType<typeof recipient> & {
      active: { token: string; generation: string } | null;
    };
    // Simulate a durable adapter that acknowledges invalidation but briefly still resolves stale data.
    let releaseInvalidation: () => void = () => undefined;
    let announceInvalidation: () => void = () => undefined;
    const invalidationStarted = new Promise<void>((resolve) => { announceInvalidation = resolve; });
    target.invalidate = async function (generation: string, details: unknown) {
      this.invalidations.push({ generation, details });
      announceInvalidation();
      await new Promise<void>((resolve) => { releaseInvalidation = resolve; });
    };
    const p = provider(new DirectTransport(connection));
    const prime = p.sendAlert({ recipient: target, alert: "prime" });
    await waitForRequests(connection, 1);
    connection.complete(1, response(200));
    await prime;
    const invalid = p.sendAlert({ recipient: target, alert: "invalid" });
    const queued = p.sendAlert({ recipient: target, alert: "queued" });
    await waitForRequests(connection, 2);
    connection.complete(3, response(410, "Unregistered"));
    await invalidationStarted;
    expect(connection.requests).toHaveLength(2);
    releaseInvalidation();
    expect((await invalid).category).toBe("invalid-recipient");
    expect((await queued).category).toBe("stale-recipient");
    expect(connection.requests).toHaveLength(2);
  });

  it("remediates the JWT actually dispatched when another queued send has already rotated the cache", async () => {
    const connection = new DeferredConnection();
    connection.peerMaxConcurrentStreams = 2;
    const clock = new MutableClock();
    const p = provider(new DirectTransport(connection), clock, undefined, {
      localConcurrencyCap: 2,
      jwtRefreshSeconds: 1_200,
    });
    const target = recipient();
    const prime = p.sendAlert({ recipient: target, alert: "prime" });
    await waitForRequests(connection, 1);
    connection.complete(1, response(200));
    await prime;

    clock.value += 1_200_000;
    const expired = p.sendAlert({ recipient: target, alert: "uses-b" });
    await waitForRequests(connection, 2);
    const tokenB = connection.requests[1]!.headers["authorization"];
    clock.value += 1_200_000;
    const concurrent = p.sendAlert({ recipient: target, alert: "rotates-to-c" });
    await waitForRequests(connection, 3);
    const tokenC = connection.requests[2]!.headers["authorization"];
    expect(tokenC).not.toBe(tokenB);
    connection.complete(3, response(403, "ExpiredProviderToken"));
    await waitForRequests(connection, 4);
    expect(connection.requests[3]!.headers["authorization"]).toBe(tokenC);
    connection.complete(5, response(200));
    connection.complete(7, response(200));
    expect((await concurrent).category).toBe("accepted");
    expect((await expired).category).toBe("accepted");
  });

  it("rechecks validity after queueing and opens no stale stream", async () => {
    const connection = new DeferredConnection();
    connection.peerMaxConcurrentStreams = 1;
    const clock = new MutableClock();
    const p = provider(new DirectTransport(connection), clock);
    const target = recipient();
    const prime = p.sendAlert({ recipient: target, alert: "prime" });
    await waitForRequests(connection, 1);
    connection.complete(1, response(200));
    await prime;
    const blocker = p.sendAlert({ recipient: target, alert: "blocker" });
    const queued = p.sendAlert({
      recipient: target,
      alert: "expires-in-queue",
      validUntilMs: clock.value + 1_000,
    });
    await waitForRequests(connection, 2);
    clock.value += 1_000;
    connection.complete(3, response(200));
    await blocker;
    expect((await queued).category).toBe("retry-exhausted");
    expect(connection.requests).toHaveLength(2);
  });

  it("rechecks validity after connection establishment and recipient resolution", async () => {
    const connectionClock = new MutableClock();
    const connectionTransport = new ScriptedTransport([[response(200)]]);
    const originalOpen = connectionTransport.open.bind(connectionTransport);
    connectionTransport.open = async (binding) => {
      connectionClock.value += 1_000;
      return await originalOpen(binding);
    };
    const connectionResult = await provider(connectionTransport, connectionClock).sendAlert({
      recipient: recipient(),
      alert: "stale-after-connect",
      validUntilMs: connectionClock.value + 1_000,
    });
    expect(connectionResult.category).toBe("retry-exhausted");
    expect(connectionTransport.connections[0]!.requests).toHaveLength(0);

    const resolverClock = new MutableClock();
    let resolves = 0;
    const delayedResolver: RecipientResolver = {
      async resolve() {
        resolves += 1;
        if (resolves === 2) resolverClock.value += 1_000;
        return { token: "current-token", generation: "1" };
      },
      async invalidate() {},
    };
    const resolverTransport = new ScriptedTransport([[response(200)]]);
    const resolverResult = await provider(resolverTransport, resolverClock).sendAlert({
      recipient: delayedResolver,
      alert: "stale-after-resolve",
      validUntilMs: resolverClock.value + 1_000,
    });
    expect(resolverResult.category).toBe("retry-exhausted");
    expect(resolverTransport.connections[0]!.requests).toHaveLength(0);
  });

  it("uses the conservative one-stream gate when no peer setting exists", async () => {
    const connection = new DeferredConnection();
    delete (connection as { peerMaxConcurrentStreams?: number }).peerMaxConcurrentStreams;
    const p = provider(new DirectTransport(connection), undefined, undefined, { localConcurrencyCap: 8 });
    const target = recipient();
    const one = p.sendAlert({ recipient: target, alert: "one" });
    const two = p.sendAlert({ recipient: target, alert: "two" });
    await waitForRequests(connection, 1);
    connection.complete(1, response(200));
    await one;
    await waitForRequests(connection, 2);
    connection.complete(3, response(200));
    expect((await two).category).toBe("accepted");
    expect(connection.maxActive).toBe(1);
  });

  it("uses GOAWAY lastStreamId to preserve safe streams and mark later streams indeterminate", async () => {
    const connection = new DeferredConnection();
    const p = provider(new DirectTransport(connection), undefined, undefined, { localConcurrencyCap: 3 });
    const target = recipient();
    const prime = p.sendAlert({ recipient: target, alert: "prime" });
    await waitForRequests(connection, 1);
    connection.complete(1, response(200));
    await prime;
    const safe = p.sendAlert({ recipient: target, alert: "safe" });
    const unknown = p.sendAlert({ recipient: target, alert: "unknown" });
    await waitForRequests(connection, 3);
    connection.goaway(3);
    connection.complete(3, response(200));
    expect((await safe).category).toBe("accepted");
    expect(await unknown).toMatchObject({ category: "indeterminate-transport", transportCode: "goaway" });
    expect(target.invalidations).toEqual([]);
  });

  it("quarantines recognized authentication GOAWAY reasons without recipient invalidation", async () => {
    const transport = new ScriptedTransport([[response(200)], [response(200)]]);
    const p = provider(transport);
    const target = recipient();
    await p.sendAlert({ recipient: target, alert: "prime" });
    transport.connections[0]!.goaway("InvalidProviderToken", 1);
    const result = await p.sendAlert({ recipient: target, alert: "blocked" });
    expect(result.category).toBe("pool-quarantined");
    expect(transport.connections).toHaveLength(1);
    expect(target.invalidations).toEqual([]);
  });

  it("quarantines TooManyProviderTokenUpdates received in GOAWAY", async () => {
    const transport = new ScriptedTransport([[response(200)]]);
    const p = provider(transport);
    const target = recipient();
    await p.sendAlert({ recipient: target, alert: "prime" });
    transport.connections[0]!.goaway("TooManyProviderTokenUpdates", 1);
    expect((await p.sendAlert({ recipient: target, alert: "blocked" })).category).toBe("pool-quarantined");
    expect(transport.connections).toHaveLength(1);
  });

  it("invalidates an old cached JWT for ExpiredProviderToken GOAWAY and reconnects", async () => {
    const clock = new MutableClock();
    const transport = new ScriptedTransport([[response(200)], [response(200)]]);
    const p = provider(transport, clock);
    const target = recipient();
    await p.sendAlert({ recipient: target, alert: "prime" });
    const oldAuthorization = transport.connections[0]!.requests[0]!.headers["authorization"];
    clock.value += 1_200_000;
    transport.connections[0]!.goaway("ExpiredProviderToken", 1);
    const result = await p.sendAlert({ recipient: target, alert: "corrected" });
    expect(result.category).toBe("accepted");
    expect(transport.connections).toHaveLength(2);
    expect(transport.connections[1]!.requests[0]!.headers["authorization"]).not.toBe(oldAuthorization);
    expect(target.invalidations).toEqual([]);
  });

  it("treats oversized 200 as a permanent bounded protocol failure", async () => {
    const transport = new ScriptedTransport([[
      { kind: "response", status: 200, body: Buffer.alloc(16_385), bodyTruncated: true },
    ]]);
    const result = await provider(transport).sendAlert({ recipient: recipient(), alert: "x" });
    expect(result).toMatchObject({ accepted: false, category: "bounded-protocol-failure", status: 200 });
  });

  it("processes exact response-body bounds and applies safe oversized status branches", async () => {
    const exactJson = Buffer.from(JSON.stringify({ reason: "Forbidden" }));
    const exact = Buffer.concat([exactJson, Buffer.alloc(16_384 - exactJson.length, 0x20)]);
    const exactTransport = new ScriptedTransport([[
      { kind: "response", status: 403, body: exact },
    ]]);
    expect((await provider(exactTransport).sendAlert({ recipient: recipient(), alert: "x" })).category).toBe("forbidden");

    const target = recipient();
    const oversized410 = new ScriptedTransport([[
      { kind: "response", status: 410, body: Buffer.alloc(16_385), bodyTruncated: true },
    ]]);
    expect((await provider(oversized410).sendAlert({ recipient: target, alert: "x" })).category).toBe("invalid-recipient");
    expect(target.invalidations).toHaveLength(1);
  });

  it("classifies representative status/reason/body combinations fail-closed", async () => {
    const permanentCases: Array<[number, string | undefined, string]> = [
      [201, undefined, "permanent-apns-rejection"],
      [302, undefined, "permanent-apns-rejection"],
      [413, "PayloadTooLarge", "permanent-apns-rejection"],
      [400, "BadTopic", "topic-configuration"],
      [403, "Forbidden", "forbidden"],
      [403, "BadEnvironmentKeyIdInToken", "key-environment-configuration"],
      [403, "InvalidProviderToken", "provider-authentication"],
      [403, "MissingProviderToken", "provider-authentication"],
      [403, "BadCertificate", "impossible-authentication-mode"],
      [403, "BadCertificateEnvironment", "impossible-authentication-mode"],
      [429, "TooManyProviderTokenUpdates", "provider-token-cadence"],
    ];
    for (const [status, reason, category] of permanentCases) {
      const transport = new ScriptedTransport([[response(status, reason)]]);
      const p = provider(transport);
      expect((await p.sendAlert({ recipient: recipient(), alert: "x" })).category).toBe(category);
      if (status === 403 || status === 429) {
        expect((await p.sendAlert({ recipient: recipient(), alert: "blocked" })).category).toBe("pool-quarantined");
      }
    }

    const malformed410Target = recipient();
    const malformed410 = new ScriptedTransport([[
      { kind: "response", status: 410, body: Buffer.from("not-json") },
    ]]);
    expect((await provider(malformed410).sendAlert({ recipient: malformed410Target, alert: "x" })).category)
      .toBe("invalid-recipient");
    expect(malformed410Target.invalidations).toHaveLength(1);

    const oversized429 = new ScriptedTransport([[
      { kind: "response", status: 429, body: Buffer.alloc(16_385), bodyTruncated: true },
    ]]);
    expect((await provider(oversized429).sendAlert({ recipient: recipient(), alert: "x" })).category)
      .toBe("ambiguous-rate-limit");
  });

  it("enforces JWT minimum refresh and absolute 60-minute expiry boundaries", async () => {
    const clock = new MutableClock();
    const transport = new ScriptedTransport([[response(200), response(200), response(200), response(200)]]);
    const p = provider(transport, clock, undefined, { jwtRefreshSeconds: 1_200 });
    const target = recipient();
    await p.sendAlert({ recipient: target, alert: "a" });
    const first = transport.connections[0]!.requests[0]!.headers["authorization"];
    clock.value += 1_199_000;
    await p.sendAlert({ recipient: target, alert: "b" });
    expect(transport.connections[0]!.requests[1]!.headers["authorization"]).toBe(first);
    clock.value += 1_000;
    await p.sendAlert({ recipient: target, alert: "c" });
    const refreshed = transport.connections[0]!.requests[2]!.headers["authorization"];
    expect(refreshed).not.toBe(first);
    clock.value += 3_600_000;
    await p.sendAlert({ recipient: target, alert: "d" });
    expect(transport.connections[0]!.requests[3]!.headers["authorization"]).not.toBe(refreshed);
  });

  it("rejects non-JSON values recursively and malformed ActivityKit fields before transport", async () => {
    class CustomState { value = 1; }
    const transport = new ScriptedTransport([]);
    const p = provider(transport);
    const badStates: unknown[] = [
      new Date(),
      new Map(),
      new CustomState(),
      { nested: undefined },
      { nested: Number.NaN },
      { nested: () => undefined },
    ];
    for (const state of badStates) {
      const result = await p.sendActivity({
        recipient: recipient(),
        operation: "update",
        contentState: state as Record<string, unknown>,
      });
      expect(result.category).toBe("validation");
    }
    expect((await p.sendActivity({
      recipient: recipient(),
      operation: "start",
      contentState: {},
      attributesType: "",
      attributes: {},
      alert: "x",
    })).category).toBe("validation");
    expect(transport.connections).toHaveLength(0);
  });

  it("validates customData before spread so ignored properties and getters cannot disappear", async () => {
    class CustomData { value = 1; }
    let getterCalls = 0;
    const getterObject: Record<string, unknown> = {};
    Object.defineProperty(getterObject, "secret", {
      enumerable: true,
      get() {
        getterCalls += 1;
        return "must-not-run";
      },
    });
    const hiddenObject: Record<string, unknown> = {};
    Object.defineProperty(hiddenObject, "hidden", { enumerable: false, value: "ignored" });
    const values: unknown[] = [new Date(), new Map(), new CustomData(), getterObject, hiddenObject];
    const transport = new ScriptedTransport([]);
    const p = provider(transport);
    for (const value of values) {
      expect((await p.sendAlert({
        recipient: recipient(),
        alert: "x",
        customData: value as Record<string, unknown>,
      })).category).toBe("validation");
    }
    expect(getterCalls).toBe(0);
    expect(transport.connections).toHaveLength(0);
  });

  it("enforces configuration limits, exact identifiers, and expiration validity", async () => {
    const invalidConfigs: Partial<ApnsProviderConfig>[] = [
      { teamId: "SHORT" },
      { keyId: "TOO-LONG-KEY" },
      { connectTimeoutMs: 10_001 },
      { requestTimeoutMs: 15_001 },
      { responseBodyLimitBytes: 16_385 },
      { max429Attempts: 5 },
      { retry429HorizonMs: 300_001 },
      { max5xxAttempts: 4 },
      { retry5xxHorizonMs: 3_599_999 },
      { retry5xxHorizonMs: 3_600_001 },
    ];
    for (const override of invalidConfigs) {
      expect(() => new ApnsProviderCleanroom(config(override), new ScriptedTransport([]))).toThrow();
    }
    expect(() => new ApnsProviderCleanroom(config({
      retry5xxHorizonMs: 3_600_001,
      allowExtended5xxHorizon: true,
    }), new ScriptedTransport([]))).not.toThrow();
    const p = provider(new ScriptedTransport([]));
    expect((await p.sendAlert({
      recipient: recipient(),
      alert: "x",
      expiration: 2_000,
      validUntilMs: 1_999_999,
    })).category).toBe("validation");
  });

  it("times out and cancels a dispatched stream without exposing request secrets", async () => {
    const connection = new DeferredConnection();
    const instantTimeout: Scheduler = { async sleep() {} };
    const secret = "recipient-secret-token";
    const result = await provider(new DirectTransport(connection), new MutableClock(), instantTimeout)
      .sendAlert({ recipient: recipient(secret), alert: "distinctive-payload-secret" });
    expect(result).toMatchObject({
      accepted: false,
      category: "indeterminate-transport",
      transportCode: "timeout",
    });
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("distinctive-payload-secret");
    expect(connection.active).toBe(0);
  });

  it("rejects an already-aborted queued acquire without opening another stream", async () => {
    const connection = new DeferredConnection();
    connection.peerMaxConcurrentStreams = 1;
    const p = provider(new DirectTransport(connection));
    const target = recipient();
    const prime = p.sendAlert({ recipient: target, alert: "prime" });
    await waitForRequests(connection, 1);
    connection.complete(1, response(200));
    await prime;
    const blocker = p.sendAlert({ recipient: target, alert: "blocker" });
    await waitForRequests(connection, 2);
    const controller = new AbortController();
    controller.abort();
    const aborted = await p.sendAlert({ recipient: target, alert: "aborted", signal: controller.signal });
    expect(aborted).toMatchObject({ category: "indeterminate-transport", attempt: 1 });
    expect(connection.requests).toHaveLength(2);
    connection.complete(3, response(200));
    await blocker;
  });

  it("bounds connection establishment and aborts its transport signal", async () => {
    let sawAbort = false;
    const neverOpening: ApnsTransport = {
      async open(_binding, signal) {
        signal.addEventListener("abort", () => { sawAbort = true; }, { once: true });
        return await new Promise<ApnsConnection>(() => undefined);
      },
    };
    const instantTimeout: Scheduler = { async sleep() {} };
    const result = await provider(neverOpening, new MutableClock(), instantTimeout)
      .sendAlert({ recipient: recipient(), alert: "x" });
    expect(result.category).toBe("indeterminate-transport");
    expect(sawAbort).toBe(true);
  });

  it("retires pool binding and JWT state before credential reuse", async () => {
    const transport = new ScriptedTransport([[response(200)], [response(200)]]);
    const p = provider(transport);
    const target = recipient();
    await p.sendAlert({ recipient: target, alert: "before" });
    const firstAuthorization = transport.connections[0]!.requests[0]!.headers["authorization"];
    await p.retireCredentials();
    const result = await p.sendAlert({ recipient: target, alert: "after" });
    expect(result.category).toBe("accepted");
    expect(transport.connections).toHaveLength(2);
    expect(transport.connections[0]!.closed).toBe(true);
    expect(transport.connections[1]!.requests[0]!.headers["authorization"]).not.toBe(firstAuthorization);
  });

  it("isolates pool keys across credential and canonical topic generations", () => {
    const baseline = provider(new ScriptedTransport([]));
    const variants = [
      config({ teamId: "TEAM654321" }),
      config({ keyId: "KEY7654321" }),
      config({ configurationGeneration: "generation-2" }),
      config({
        keyScope: "topic-specific",
        appleAssociatedTopics: ["com.example.app", "com.example.app.push-type.liveactivity"],
      }),
    ];
    for (const variant of variants) {
      expect(new ApnsProviderCleanroom(variant, new ScriptedTransport([])).poolKey).not.toBe(baseline.poolKey);
    }
    const ordered = new ApnsProviderCleanroom(config({
      allowedTopics: ["com.example.app", "com.example.app.push-type.liveactivity"],
    }), new ScriptedTransport([]));
    const reordered = new ApnsProviderCleanroom(config({
      allowedTopics: [
        "com.example.app.push-type.liveactivity",
        "com.example.app",
        "com.example.app",
      ],
    }), new ScriptedTransport([]));
    expect(reordered.poolKey).toBe(ordered.poolKey);

    const topicSpecific = new ApnsProviderCleanroom(config({
      keyScope: "topic-specific",
      appleAssociatedTopics: ["com.example.app", "com.example.app.push-type.liveactivity"],
    }), new ScriptedTransport([]));
    const broaderAssociation = new ApnsProviderCleanroom(config({
      keyScope: "topic-specific",
      appleAssociatedTopics: [
        "com.example.app",
        "com.example.app.push-type.liveactivity",
        "com.example.other",
      ],
    }), new ScriptedTransport([]));
    expect(topicSpecific.poolKey).not.toBe(broaderAssociation.poolKey);
  });

  it("covers the full environment, scope, authorization, and topic-association configuration matrix", () => {
    const invalid: ApnsProviderConfig[] = [
      config({ environment: undefined as never }),
      config({ environment: "staging" as never }),
      config({ keyScope: undefined as never }),
      config({ keyScope: "certificate" as never }),
      config({ keyEnvironment: undefined as never }),
      config({ keyEnvironment: "staging" as never }),
      config({ environment: "production", keyEnvironment: "sandbox" }),
      config({ environment: "sandbox", keyEnvironment: "production" }),
      config({ keyEnvironment: "both" }),
      config({ keyEnvironment: "both", dualEnvironmentConfirmed: true, keyScope: "topic-specific" }),
      config({ keyScope: "topic-specific", appleAssociatedTopics: undefined }),
      config({ keyScope: "topic-specific", appleAssociatedTopics: [] }),
      config({ allowedTopics: [] }),
      config({ allowedTopics: ["com.example.app"] }),
      config({ allowedTopics: ["com.example.app.push-type.liveactivity"] }),
      config({
        keyScope: "topic-specific",
        appleAssociatedTopics: ["com.example.app"],
      }),
      config({
        keyScope: "topic-specific",
        allowedTopics: ["com.example.app", "com.example.app.push-type.liveactivity", "com.example.extra"],
        appleAssociatedTopics: ["com.example.app", "com.example.app.push-type.liveactivity"],
      }),
    ];
    for (const candidate of invalid) {
      expect(() => new ApnsProviderCleanroom(candidate, new ScriptedTransport([]))).toThrow();
    }
    for (const environment of ["sandbox", "production"] as const) {
      expect(() => new ApnsProviderCleanroom(config({
        environment,
        keyEnvironment: "both",
        dualEnvironmentConfirmed: true,
      }), new ScriptedTransport([]))).not.toThrow();
    }
    expect(() => new ApnsProviderCleanroom(config({
      keyScope: "topic-specific",
      appleAssociatedTopics: ["com.example.app", "com.example.app.push-type.liveactivity", "com.example.unused"],
    }), new ScriptedTransport([]))).not.toThrow();
  });

  it("uses a locally verified TLS chain and rejects certificate, hostname, trust, chain, and ALPN failures without bypass", async () => {
    const fixtures = generateTlsFixtures();
    try {
      await expect(probeTls(fixtures.valid)).resolves.toMatchObject({
        protocol: expect.stringMatching(/^TLSv1\.[23]$/),
        alpn: "h2",
        authorized: true,
      });
      await expect(probeTls(fixtures.expired)).rejects.toThrow();
      await expect(probeTls(fixtures.future)).rejects.toThrow();
      await expect(probeTls(fixtures.wrongHost)).rejects.toThrow();
      await expect(probeTls(fixtures.untrusted)).rejects.toThrow();
      await expect(probeTls(fixtures.incomplete)).rejects.toThrow();
      await expect(probeTls(fixtures.valid, { ALPNProtocols: undefined })).resolves.toMatchObject({ alpn: false });
      await expect(probeTls(fixtures.valid, { ALPNProtocols: ["http/1.1"] })).rejects.toThrow();

      const transport = new ScriptedTransport([[response(200)]]);
      expect((await provider(transport).sendAlert({ recipient: recipient(), alert: "tls" })).category).toBe("accepted");
      expect(transport.bindings[0]!.tls).toEqual({
        minimumVersion: "TLSv1.2",
        rejectUnauthorized: true,
        requireHostnameVerification: true,
        alpnProtocols: ["h2"],
      });
    } finally {
      fixtures.cleanup();
    }
  }, 30_000);

  it("declares exact HPACK non-indexing behavior and emits one injection-safe semantic header each", async () => {
    const transport = new ScriptedTransport([[response(200)]]);
    await provider(transport).sendAlert({
      recipient: recipient("token/value"),
      alert: "hpack",
      category: "category",
      threadId: "thread",
      collapseId: `org_${"a".repeat(43)}`,
      apnsId: UUID,
    });
    const request = transport.connections[0]!.requests[0]!;
    expect(request.hpack).toEqual({
      neverIndex: [":path", "authorization"],
      normalIndex: ["content-type", "apns-topic", "apns-push-type", "apns-priority"],
      nameOnlyIndex: ["apns-id", "apns-expiration", "apns-collapse-id"],
    });
    expect(Object.keys(request.headers).sort()).toEqual([
      "apns-collapse-id", "apns-expiration", "apns-id", "apns-priority", "apns-push-type", "apns-topic", "authorization", "content-type",
    ]);
    expect(new Set(Object.keys(request.headers)).size).toBe(Object.keys(request.headers).length);
    expect(request.path).toBe("/3/device/token%2Fvalue");

    for (const injected of ["bad\nvalue", "bad\rvalue", "bad\0value"]) {
      const p = provider(new ScriptedTransport([]));
      expect((await p.sendAlert({ recipient: recipient(injected), alert: "x" })).category).toBe("validation");
      expect((await p.sendAlert({ recipient: recipient(), alert: "x", category: injected })).category).toBe("validation");
      expect((await p.sendAlert({ recipient: recipient(), alert: "x", threadId: injected })).category).toBe("validation");
      expect((await p.sendAlert({ recipient: recipient(), alert: "x", collapseId: injected })).category).toBe("validation");
    }
    expect((await provider(new ScriptedTransport([])).sendAlert({
      recipient: recipient(),alert: "x",collapseId: "not-an-origin",
    })).category).toBe("validation");
  });

  it("covers explicit ActivityKit priorities and field types for start, update, and end", async () => {
    const transport = new ScriptedTransport([[response(200), response(200), response(200), response(200), response(200), response(200)]]);
    const p = provider(transport);
    for (const operation of ["start", "update", "end"] as const) {
      for (const priority of [5, 10] as const) {
        const common = { recipient: recipient(), operation, priority, contentState: { operation } };
        const result = operation === "start"
          ? await p.sendActivity({ ...common, attributesType: "Attributes", attributes: {}, alert: "start" })
          : await p.sendActivity(common);
        expect(result.category).toBe("accepted");
      }
    }
    const requests = transport.connections[0]!.requests;
    expect(requests.map((request) => request.headers["apns-priority"])).toEqual(["5", "10", "5", "10", "5", "10"]);
    expect(requests.every((request) => request.headers["apns-push-type"] === "liveactivity")).toBe(true);
    expect(requests.every((request) => request.headers["apns-topic"] === "com.example.app.push-type.liveactivity")).toBe(true);

    const invalidInputs = [
      { operation: "unknown", contentState: {} },
      { operation: "update", contentState: [] },
      { operation: "end", contentState: "bad" },
      { operation: "start", contentState: {}, attributesType: 7, attributes: {}, alert: "x" },
      { operation: "start", contentState: {}, attributesType: "A", attributes: [], alert: "x" },
      { operation: "start", contentState: {}, attributesType: "A", attributes: {}, alert: 7 },
    ];
    for (const input of invalidInputs) {
      expect((await p.sendActivity({ recipient: recipient(), ...input } as never)).category).toBe("validation");
    }
    for (const priority of [-1, 0, 1, 6, 9, 11] as const) {
      expect((await p.sendActivity({
        recipient: recipient(), operation: "update", contentState: {}, priority: priority as never,
      })).category).toBe("validation");
    }
  });

  it("covers omitted, zero, absolute, malformed, and deadline-distinct expiration policy", async () => {
    const transport = new ScriptedTransport([[response(200), response(200), response(200), response(200)]]);
    const clock = new MutableClock();
    const p = provider(transport, clock);
    expect((await p.sendAlert({ recipient: recipient(), alert: "omitted" })).category).toBe("accepted");
    expect((await p.sendAlert({ recipient: recipient(), alert: "zero", expiration: 0 })).category).toBe("accepted");
    expect((await p.sendAlert({ recipient: recipient(), alert: "epoch", expiration: 1_900_000_000 })).category).toBe("accepted");
    expect((await p.sendAlert({
      recipient: recipient(), alert: "finite-app-deadline", expiration: 0, validUntilMs: clock.value + 1_000,
    })).category).toBe("accepted");
    expect(transport.connections[0]!.requests.map((request) => request.headers["apns-expiration"]))
      .toEqual(["0", "0", "1900000000", "0"]);
    for (const expiration of [-1, 1.5, "300", Number.NaN, Number.POSITIVE_INFINITY]) {
      expect((await p.sendAlert({ recipient: recipient(), alert: "bad", expiration: expiration as never })).category)
        .toBe("validation");
    }
  });

  it("invalidates every documented and body-unavailable 410 variant while retaining only valid millisecond timestamps", async () => {
    const variants: Array<{ result: TransportResult; timestamp?: number }> = [
      { result: response(410, "ExpiredToken", { timestamp: 1_800_000_000_001 }), timestamp: 1_800_000_000_001 },
      { result: response(410, "Unregistered") },
      { result: response(410, "UnknownReason", { timestamp: "1800000000001" }) },
      { result: { kind: "response", status: 410, body: Buffer.from("not-json") } },
      { result: { kind: "response", status: 410, body: Buffer.alloc(0) } },
      { result: { kind: "response", status: 410, body: Buffer.alloc(16_385), bodyTruncated: true } },
    ];
    for (const variant of variants) {
      const transport = new ScriptedTransport([[variant.result]]);
      const target = recipient();
      const result = await provider(transport).sendAlert({ recipient: target, alert: "410" });
      expect(result.category).toBe("invalid-recipient");
      expect(result.invalidatedAtMs).toBe(variant.timestamp);
      expect(target.invalidations).toHaveLength(1);
    }
  });

  it("covers all fail-closed 403 body boundaries without replay, JWT churn, connection replacement, or invalidation", async () => {
    const exactReason = Buffer.from(JSON.stringify({ reason: "Forbidden" }));
    const genericBodies: TransportResult[] = [
      { kind: "response", status: 403, body: Buffer.alloc(0) },
      { kind: "response", status: 403, body: Buffer.from("not-json") },
      response(403, "UnknownReason"),
      { kind: "response", status: 403, body: Buffer.alloc(16_385), bodyTruncated: true },
    ];
    const exactTransport = new ScriptedTransport([[
      { kind: "response", status: 403, body: Buffer.concat([exactReason, Buffer.alloc(16_384 - exactReason.length, 0x20)]) },
    ]]);
    expect((await provider(exactTransport).sendAlert({ recipient: recipient(), alert: "exact" })).category).toBe("forbidden");

    for (const scripted of genericBodies) {
      const transport = new ScriptedTransport([[scripted, response(200)]]);
      const target = recipient();
      const result = await provider(transport).sendAlert({ recipient: target, alert: "generic" });
      expect(result.category).toBe("ambiguous-authorization");
      expect(transport.connections).toHaveLength(1);
      expect(transport.connections[0]!.requests).toHaveLength(1);
      expect(target.invalidations).toEqual([]);
      expect((await provider(new ScriptedTransport([[response(200)]])).sendAlert({ recipient: recipient(), alert: "control" })).category)
        .toBe("accepted");
    }

    const repeatedExpired = new ScriptedTransport([[
      response(200), response(403, "ExpiredProviderToken"), response(403, "ExpiredProviderToken"), response(200),
    ]]);
    const expiredClock = new MutableClock();
    const expiredProvider = provider(repeatedExpired, expiredClock);
    const expiredTarget = recipient();
    await expiredProvider.sendAlert({ recipient: expiredTarget, alert: "prime" });
    expiredClock.value += 1_200_000;
    repeatedExpired.connections[0]!.requests.length = 0;
    expect((await expiredProvider.sendAlert({ recipient: expiredTarget, alert: "expired-twice" })).category)
      .toBe("expired-provider-token");
    expect(repeatedExpired.connections[0]!.requests).toHaveLength(2);

    const repeatedBinding = new ScriptedTransport([
      [response(403, "UnrelatedKeyIdInToken")],
      [response(403, "UnrelatedKeyIdInToken")],
      [response(200)],
    ]);
    expect((await provider(repeatedBinding).sendAlert({ recipient: recipient(), alert: "binding-twice" })).category)
      .toBe("connection-key-binding");
    expect(repeatedBinding.connections).toHaveLength(2);
  });

  it("separates bad-device-token invalidation from every topic configuration error", async () => {
    for (const reason of ["BadDeviceToken", "DeviceTokenNotForTopic"] as const) {
      const target = recipient();
      const result = await provider(new ScriptedTransport([[response(400, reason)]])).sendAlert({ recipient: target, alert: reason });
      expect(result.category).toBe("invalid-recipient");
      expect(target.invalidations).toHaveLength(1);
    }
    for (const reason of ["BadTopic", "MissingTopic", "TopicDisallowed"] as const) {
      const target = recipient();
      const result = await provider(new ScriptedTransport([[response(400, reason)]])).sendAlert({ recipient: target, alert: reason });
      expect(result.category).toBe("topic-configuration");
      expect(target.invalidations).toEqual([]);
    }
  });

  it("covers the full 429 reason/body matrix and never rotates JWT for recipient throttling", async () => {
    const retryTransport = new ScriptedTransport([[response(429, "TooManyRequests"), response(200)]]);
    const retryProvider = provider(retryTransport);
    expect((await retryProvider.sendAlert({ recipient: recipient(), alert: "retry" })).category).toBe("accepted");
    const retryRequests = retryTransport.connections[0]!.requests;
    expect(retryRequests).toHaveLength(2);
    expect(retryRequests[0]!.headers.authorization).toBe(retryRequests[1]!.headers.authorization);

    const noReplayCases: Array<{ result: TransportResult; category: string }> = [
      { result: response(429, "TooManyProviderTokenUpdates"), category: "provider-token-cadence" },
      { result: { kind: "response", status: 429, body: Buffer.alloc(0) }, category: "ambiguous-rate-limit" },
      { result: { kind: "response", status: 429, body: Buffer.from("not-json") }, category: "ambiguous-rate-limit" },
      { result: response(429, "UnknownReason"), category: "ambiguous-rate-limit" },
      { result: { kind: "response", status: 429, body: Buffer.alloc(16_385), bodyTruncated: true }, category: "ambiguous-rate-limit" },
    ];
    for (const candidate of noReplayCases) {
      const transport = new ScriptedTransport([[candidate.result, response(200)]]);
      const result = await provider(transport).sendAlert({ recipient: recipient(), alert: "no-replay" });
      expect(result.category).toBe(candidate.category);
      expect(transport.connections[0]!.requests).toHaveLength(1);
    }
  });

  it("keeps malformed bodies safe across status branches and caller-authorizes only bounded indeterminate replay", async () => {
    const statuses = [201, 204, 301, 307, 400, 404, 413];
    for (const status of statuses) {
      const raw = `malformed-secret-${status}`;
      const result = await provider(new ScriptedTransport([[
        { kind: "response", status, body: Buffer.from(raw) },
      ]])).sendAlert({ recipient: recipient(), alert: "body-secret" });
      expect(result.category).toBe("permanent-apns-rejection");
      expect(JSON.stringify(result)).not.toContain(raw);
    }

    let resolves = 0;
    const target = recipient();
    const originalResolve = target.resolve.bind(target);
    target.resolve = async () => { resolves += 1; return await originalResolve(); };
    const transport = new ScriptedTransport([[
      { kind: "failure", code: "reset" },
      response(200),
    ]]);
    const result = await provider(transport).sendAlert({
      recipient: target,
      alert: "authorized-replay",
      apnsId: UUID,
      indeterminateRetries: 1,
    });
    expect(result.category).toBe("accepted");
    expect(resolves).toBe(4);
    const requests = transport.connections[0]!.requests;
    expect(requests).toHaveLength(2);
    expect(requests[0]!.headers["apns-id"]).toBe(requests[1]!.headers["apns-id"]);
    expect(Buffer.from(requests[0]!.body).equals(Buffer.from(requests[1]!.body))).toBe(true);

    const exhausted = await provider(new ScriptedTransport([[
      { kind: "failure", code: "reset" }, { kind: "failure", code: "timeout" }, response(200),
    ]])).sendAlert({ recipient: recipient(), alert: "bounded", indeterminateRetries: 1 });
    expect(exhausted).toMatchObject({ category: "indeterminate-transport", attempt: 2, transportCode: "timeout" });
  });

  it("bounds malformed and oversized GOAWAY diagnostics without recipient invalidation or secret disclosure", async () => {
    for (const event of [
      { lastStreamId: 1, diagnostic: Buffer.from("not-json") },
      { lastStreamId: 1, diagnostic: Buffer.alloc(16_385), diagnosticTruncated: true },
      { lastStreamId: 1, diagnostic: Buffer.from(JSON.stringify({ reason: "token-secret\nInjected" })) },
      { lastStreamId: -1, diagnostic: Buffer.from(JSON.stringify({ reason: "Shutdown" })) },
    ] satisfies GoawayEvent[]) {
      const transport = new ScriptedTransport([[response(200)], [response(200)]]);
      const p = provider(transport);
      const target = recipient("recipient-goaway-secret");
      await p.sendAlert({ recipient: target, alert: "payload-goaway-secret" });
      transport.connections[0]!.goawayEvent(event);
      const result = await p.sendAlert({ recipient: target, alert: "after" });
      expect(result.category).toBe("accepted");
      expect(target.invalidations).toEqual([]);
      expect(JSON.stringify(result)).not.toMatch(/recipient-goaway-secret|payload-goaway-secret|token-secret/);
    }
  });

  it("keeps authentication gates and local caps independent across pools", async () => {
    const one = new DeferredConnection();
    const two = new DeferredConnection();
    one.peerMaxConcurrentStreams = 8;
    two.peerMaxConcurrentStreams = 8;
    const p1 = provider(new DirectTransport(one), undefined, undefined, { localConcurrencyCap: 2 });
    const p2 = provider(new DirectTransport(two), undefined, undefined, { localConcurrencyCap: 3, configurationGeneration: "other" });
    const sends1 = [p1.sendAlert({ recipient: recipient(), alert: "1a" }), p1.sendAlert({ recipient: recipient(), alert: "1b" })];
    const sends2 = [p2.sendAlert({ recipient: recipient(), alert: "2a" }), p2.sendAlert({ recipient: recipient(), alert: "2b" })];
    await waitForRequests(one, 1);
    await waitForRequests(two, 1);
    expect(one.maxActive).toBe(1);
    expect(two.maxActive).toBe(1);
    one.complete(1, response(200));
    two.complete(1, response(200));
    await waitForRequests(one, 2);
    await waitForRequests(two, 2);
    one.complete(3, response(200));
    two.complete(3, response(200));
    expect((await Promise.all([...sends1, ...sends2])).every((result) => result.category === "accepted")).toBe(true);
  });

  it("keeps the initial authentication gate closed after 403, timeout, reset, and GOAWAY", async () => {
    for (const failure of [
      response(403),
      { kind: "failure", code: "timeout" } as const,
      { kind: "failure", code: "reset" } as const,
    ]) {
      const connection = new DeferredConnection();
      connection.peerMaxConcurrentStreams = 20;
      const p = provider(new DirectTransport(connection), undefined, undefined, { localConcurrencyCap: 8 });
      const first = p.sendAlert({ recipient: recipient(), alert: "first" });
      const queued = p.sendAlert({ recipient: recipient(), alert: "queued" });
      await waitForRequests(connection, 1);
      expect(connection.maxActive).toBe(1);
      connection.complete(1, failure);
      const firstResult = await first;
      if (failure.kind === "response") {
        expect(firstResult.category).toBe("ambiguous-authorization");
        expect((await queued).category).toBe("pool-quarantined");
        expect(connection.requests).toHaveLength(1);
      } else {
        expect(firstResult.category).toBe("indeterminate-transport");
        await waitForRequests(connection, 2);
        expect(connection.maxActive).toBe(1);
        connection.complete(3, response(200));
        expect((await queued).category).toBe("accepted");
      }
    }

    const oldConnection = new DeferredConnection();
    const replacement = new DeferredConnection();
    oldConnection.peerMaxConcurrentStreams = 20;
    replacement.peerMaxConcurrentStreams = 20;
    const p = provider(new DeferredTransport([oldConnection, replacement]), undefined, undefined, { localConcurrencyCap: 8 });
    const first = p.sendAlert({ recipient: recipient(), alert: "goaway-first" });
    const queued = p.sendAlert({ recipient: recipient(), alert: "goaway-queued" });
    await waitForRequests(oldConnection, 1);
    oldConnection.goaway(0);
    expect((await first).category).toBe("indeterminate-transport");
    await waitForRequests(replacement, 1);
    expect(oldConnection.maxActive).toBe(1);
    expect(replacement.maxActive).toBe(1);
    replacement.complete(1, response(200));
    expect((await queued).category).toBe("accepted");
  });

  it("redacts tokens, JWTs, key material, payloads, and generations from outcomes and captured diagnostics", async () => {
    const captured: unknown[] = [];
    const methods = ["log", "info", "warn", "error", "debug"] as const;
    const originals = methods.map((method) => console[method]);
    for (const method of methods) console[method] = (...values: unknown[]) => { captured.push(...values); };
    try {
      const token = "distinctive-recipient-token";
      const payload = "distinctive-payload-content";
      const target = recipient(token);
      target.active!.generation = "distinctive-generation";
      const transport = new ScriptedTransport([[{ kind: "failure", code: "protocol" }]]);
      const p = provider(transport);
      const result = await p.sendAlert({ recipient: target, alert: payload });
      const authorization = transport.connections[0]!.requests[0]!.headers.authorization!;
      const serialized = JSON.stringify({ result, captured });
      for (const secret of [token, payload, "distinctive-generation", authorization, privateKeyPem]) {
        expect(serialized).not.toContain(secret);
      }
    } finally {
      methods.forEach((method, index) => { console[method] = originals[index]!; });
    }
  });
});
