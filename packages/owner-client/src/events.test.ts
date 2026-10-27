import { afterEach, describe, expect, it, vi } from "vitest";
import { backoffMs, followEvents, RECONCILE, SseParser } from "./events.js";
import { OwnerHttp } from "./http.js";
import { FakeServer, ORIGIN } from "./test-support/fakeServer.js";

const realImmediate = setImmediate;
const flush = async () => { for (let i = 0; i < 5; i++) await new Promise((r) => realImmediate(r)); };

afterEach(() => vi.useRealTimers());

describe("SseParser", () => {
  it("reads current frames across chunks and CRLF, ignoring comments", () => {
    const parser = new SseParser();
    expect(parser.push(": keepalive\n\nevent: cur")).toEqual([]);
    expect(parser.push('rent\r\ndata: {"a":1}\r\n\r\n')).toEqual([{ event: "current", data: '{"a":1}' }]);
  });

  it("refuses a frame over 8 KB", () => {
    expect(() => new SseParser().push("data: " + "x".repeat(9000))).toThrow(expect.objectContaining({ kind: "invalid_response" }));
  });
});

describe("backoff", () => {
  it("doubles from 250 ms to a 5 s ceiling with jitter in the upper half", () => {
    expect(backoffMs(0, () => 0)).toBe(125);
    expect(backoffMs(0, () => 0.999)).toBeLessThanOrEqual(250);
    expect(backoffMs(5, () => 0.999)).toBeLessThanOrEqual(5000);
    expect(backoffMs(9, () => 0)).toBe(2500);
  });
});

describe("followEvents", () => {
  it("delivers hints with the device bearer and reconnects after the stream drops, asking for a full read", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = new FakeServer();
    const hints: unknown[] = [];
    const controller = new AbortController();
    const done = followEvents({
      http: new OwnerHttp(ORIGIN, server.fetch), token: server.deviceToken, signal: controller.signal,
      onHint: (h) => hints.push(h), random: () => 0,
    });
    await flush();
    expect(server.eventConnections).toBe(1);
    expect(server.seen[0]!.headers).toMatchObject({ Authorization: `Bearer ${server.deviceToken}`, Accept: "text/event-stream" });
    server.hint(["sub_00000000-0000-4000-8000-000000000001"]);
    await flush();
    expect(hints).toEqual([{ subjectIds: ["sub_00000000-0000-4000-8000-000000000001"], invalidateCounts: true }]);

    server.dropStreams();
    await flush();
    expect(hints.at(-1)).toEqual(RECONCILE); // immediate reconcile on failure
    expect(server.eventConnections).toBe(1); // waiting out the backoff
    await vi.advanceTimersByTimeAsync(130);
    await flush();
    expect(server.eventConnections).toBe(2);
    expect(hints.filter((h) => h === RECONCILE).length).toBe(2); // failure, reconnect

    controller.abort();
    await done;
  });

  it("gives up when the credential is refused", async () => {
    const server = new FakeServer();
    await expect(followEvents({
      http: new OwnerHttp(ORIGIN, server.fetch), token: "wrong", signal: new AbortController().signal, onHint: () => undefined,
    })).rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("reconnects when the stream goes silent past the idle timeout", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const server = new FakeServer();
    const controller = new AbortController();
    const done = followEvents({
      http: new OwnerHttp(ORIGIN, server.fetch), token: server.deviceToken, signal: controller.signal,
      onHint: () => undefined, random: () => 0, idleTimeoutMs: 1000,
    });
    await flush();
    await vi.advanceTimersByTimeAsync(1100);
    await flush();
    await vi.advanceTimersByTimeAsync(200);
    await flush();
    expect(server.eventConnections).toBe(2);
    controller.abort();
    await done;
  });
});
