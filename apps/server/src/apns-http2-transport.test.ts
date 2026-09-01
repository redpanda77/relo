import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createSecureServer, sensitiveHeaders, type ServerHttp2Session, type ServerHttp2Stream } from "node:http2";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { boundedGoawayEvent, NodeHttp2ApnsTransport, prepareNodeHttp2Headers } from "./apns-http2-transport.js";
import type { GoawayEvent, PreparedApnsRequest, TransportBinding } from "./apns-provider-cleanroom.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function certificate(): { key: Buffer; cert: Buffer } {
  const directory = mkdtempSync(join(tmpdir(), "relo-apns-adapter-"));
  temporaryDirectories.push(directory);
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes",
    "-keyout", "key.pem", "-out", "cert.pem", "-days", "1",
    "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost",
  ], { cwd: directory, stdio: "ignore" });
  return { key: readFileSync(join(directory, "key.pem")), cert: readFileSync(join(directory, "cert.pem")) };
}

function binding(authority: string, servername = "localhost"): TransportBinding {
  return {
    authority,
    servername,
    environment: "sandbox",
    poolKey: "adapter-test",
    connectTimeoutMs: 1_000,
    tls: {
      minimumVersion: "TLSv1.2",
      rejectUnauthorized: true,
      requireHostnameVerification: true,
      alpnProtocols: ["h2"],
    },
  };
}

function request(authority: string, path = "/3/device/test-token", limit = 16_384): PreparedApnsRequest {
  return {
    method: "POST",
    authority,
    path,
    headers: {
      authorization: "bearer test-jwt",
      "content-type": "application/json",
      "apns-topic": "com.example.app",
      "apns-push-type": "alert",
      "apns-priority": "10",
      "apns-expiration": "0",
      "apns-id": "123e4567-e89b-42d3-a456-426614174000",
    },
    hpack: {
      neverIndex: [":path", "authorization"],
      normalIndex: ["content-type", "apns-topic", "apns-push-type", "apns-priority"],
      nameOnlyIndex: ["apns-id", "apns-expiration"],
    },
    body: Buffer.from('{"aps":{"alert":"hello"}}'),
    responseBodyLimitBytes: limit,
  };
}

async function listen(server: ReturnType<typeof createSecureServer>): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no address");
  return address.port;
}

describe("Node HTTP/2 APNs transport", () => {
  test("uses verified TLS/h2, exact bytes, selected response metadata, and a reusable session", async () => {
    const tls = certificate();
    const received: Array<{ headers: Record<string, unknown>; body: Buffer }> = [];
    const server = createSecureServer({ ...tls, allowHTTP1: false, settings: { maxConcurrentStreams: 4 } });
    server.on("stream", (stream: ServerHttp2Stream, headers) => {
      const chunks: Buffer[] = [];
      stream.on("data", (chunk: Buffer) => chunks.push(chunk));
      stream.on("end", () => {
        received.push({ headers, body: Buffer.concat(chunks) });
        stream.respond({ ":status": 200, "apns-id": "123e4567-e89b-42d3-a456-426614174999" });
        stream.end();
      });
    });
    const port = await listen(server);
    const authority = `localhost:${port}`;
    const transport = new NodeHttp2ApnsTransport({ ca: tls.cert });
    const connection = await transport.open(binding(authority), new AbortController().signal);
    try {
      expect(connection.security).toMatchObject({
        alpnProtocol: "h2", authorized: true, hostnameVerified: true, servername: "localhost",
      });
      for (const path of ["/3/device/first", "/3/device/second"]) {
        const prepared = request(authority, path);
        const result = await connection.openStream(prepared, new AbortController().signal).result;
        expect(result).toMatchObject({
          kind: "response", status: 200,
          headers: { "apns-id": "123e4567-e89b-42d3-a456-426614174999" },
        });
      }
      expect(received).toHaveLength(2);
      expect(received.map((item) => item.headers[":path"])).toEqual(["/3/device/first", "/3/device/second"]);
      expect(received.every((item) => item.body.equals(request(authority).body))).toBe(true);
    } finally {
      connection.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("marks secret and high-cardinality fields sensitive for Node HPACK", () => {
    const headers = prepareNodeHttp2Headers(request("api.sandbox.push.apple.com:443"));
    expect(headers[sensitiveHeaders]).toEqual([":path", "authorization", "apns-id", "apns-expiration"]);
    expect(headers["authorization"]).toBe("bearer test-jwt");
    expect(headers[":path"]).toBe("/3/device/test-token");
  });

  test("bounds response bodies and GOAWAY diagnostics", async () => {
    const tls = certificate();
    let serverSession: ServerHttp2Session | undefined;
    const server = createSecureServer({ ...tls, allowHTTP1: false });
    server.on("session", (session) => { serverSession = session; });
    server.on("stream", (stream) => {
      stream.on("data", () => undefined);
      stream.on("end", () => {
        stream.respond({ ":status": 403 });
        stream.end(Buffer.alloc(17, 0x78));
      });
    });
    const port = await listen(server);
    const authority = `localhost:${port}`;
    const connection = await new NodeHttp2ApnsTransport({ ca: tls.cert })
      .open(binding(authority), new AbortController().signal);
    try {
      const result = await connection.openStream(request(authority, "/3/device/bounded", 16), new AbortController().signal).result;
      expect(result).toMatchObject({ kind: "response", status: 403, bodyTruncated: true });
      if (result.kind === "response") expect(result.body.byteLength).toBe(17);

      const goaway = new Promise<{ diagnostic?: Uint8Array; diagnosticTruncated?: boolean }>((resolve) => {
        connection.onGoaway(resolve);
      });
      serverSession?.goaway(0, 1, Buffer.from("not-json"));
      await expect(goaway).resolves.toMatchObject({ diagnostic: Buffer.from("not-json") });
      expect(boundedGoawayEvent(1, Buffer.alloc(16_385))).toMatchObject({
        diagnosticTruncated: true,
        diagnostic: expect.objectContaining({ byteLength: 16_384 }),
      });
    } finally {
      connection.close();
      serverSession?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("rejects untrusted and hostname-mismatched local peers without a verification bypass", async () => {
    const tls = certificate();
    const server = createSecureServer({ ...tls, allowHTTP1: false });
    const port = await listen(server);
    const authority = `localhost:${port}`;
    try {
      await expect(new NodeHttp2ApnsTransport().open(binding(authority), new AbortController().signal)).rejects.toThrow();
      await expect(new NodeHttp2ApnsTransport({ ca: tls.cert }).open(
        binding(authority, "wrong.example"), new AbortController().signal,
      )).rejects.toThrow();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  test("turns an abrupt session failure into a draining event and typed stream failure", async () => {
    const tls = certificate();
    let serverSession: ServerHttp2Session | undefined;
    const server = createSecureServer({ ...tls, allowHTTP1: false });
    server.on("session", (session) => { serverSession = session; });
    server.on("stream", (stream) => {
      stream.on("data", () => undefined);
      serverSession?.destroy();
    });
    const port = await listen(server);
    const authority = `localhost:${port}`;
    const connection = await new NodeHttp2ApnsTransport({ ca: tls.cert })
      .open(binding(authority), new AbortController().signal);
    try {
      const draining = new Promise<GoawayEvent>((resolve) => connection.onGoaway(resolve));
      const result = connection.openStream(request(authority), new AbortController().signal).result;
      await expect(result).resolves.toMatchObject({ kind: "failure" });
      await expect(draining).resolves.toMatchObject({ lastStreamId: expect.any(Number) });
    } finally {
      connection.close();
      serverSession?.destroy();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
