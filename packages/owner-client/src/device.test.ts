import { describe, expect, it } from "vitest";
import { createComputerInvite, registerDevice, registrationBody, phoneReceivesPushes, deviceStanding } from "./device.js";
import { OwnerHttp } from "./http.js";
import { DEVICE, FakeServer, ORIGIN } from "./test-support/fakeServer.js";
import type { DeviceInfo } from "./types.js";

const info: DeviceInfo = { name: "Ada's PC", bundleIdentifier: "app.relo.windows", appVersion: "0.1.0", appBuild: "1", osVersion: "10.0.26200", model: "Surface" };
const ids = { stableDeviceId: "stable-1", installationId: "install-1" };

describe("registration", () => {
  it("sends exactly the strict body of an owner overview device", () => {
    const body = registrationBody(ids, info);
    expect(body).toEqual({
      stableDeviceId: "stable-1", installationId: "install-1", name: "Ada's PC", bundleIdentifier: "app.relo.windows",
      appVersion: "0.1.0", appBuild: "1", osVersion: "10.0.26200", model: "Surface",
      apnsEnvironment: "production", notificationAuthorization: "denied", liveActivityAuthorization: "denied",
      capabilities: ["choice_questions", "owner_overview"],
    });
    expect(body).not.toHaveProperty("apnsToken");
  });

  it("is idempotent: the same attempt twice gives one registration and the same credential", async () => {
    const server = new FakeServer();
    const http = new OwnerHttp(ORIGIN, server.fetch);
    const input = { sessionToken: server.session, sessionId: "ses_1", ids, info };
    const first = await registerDevice(http, input);
    const second = await registerDevice(http, input);
    expect(second.credential.accessToken).toBe(first.credential.accessToken);
    expect(server.registrations.size).toBe(1);
    const call = server.seen[0]!;
    expect(call.headers.Authorization).toBe(`Bearer ${server.session}`);
    expect(call.headers["Idempotency-Key"]).toMatch(/^win-register:install-1:ses_1:[0-9a-f]{16}$/);
    expect(server.seen[1]!.headers["Idempotency-Key"]).toBe(call.headers["Idempotency-Key"]);
  });

  it("registers again under a new key when the body changed (an update) without a 409 reaching the caller", async () => {
    const server = new FakeServer();
    const http = new OwnerHttp(ORIGIN, server.fetch);
    await registerDevice(http, { sessionToken: server.session, sessionId: "ses_1", ids, info });
    const next = await registerDevice(http, { sessionToken: server.session, sessionId: "ses_1", ids, info: { ...info, appVersion: "0.2.0" } });
    expect(next.device.deviceId).toBe(DEVICE);
    expect(server.registrations.size).toBe(2);
  });

  it("retries once under a new key on a 409 replay, then reports conflict", async () => {
    const keys: string[] = [];
    const http = new OwnerHttp(ORIGIN, async (_url, init) => {
      keys.push((init!.headers as Record<string, string>)["Idempotency-Key"]!);
      return new Response(JSON.stringify({ error: "idempotency_conflict" }), { status: 409 });
    });
    await expect(registerDevice(http, { sessionToken: "t", sessionId: "s", ids, info })).rejects.toMatchObject({ kind: "conflict" });
    expect(keys).toHaveLength(2);
    expect(keys[1]).toBe(`${keys[0]}:again`);
  });

  it("reports an expired account session as unauthorized", async () => {
    const server = new FakeServer();
    await expect(registerDevice(new OwnerHttp(ORIGIN, server.fetch), { sessionToken: "stale", sessionId: "s", ids, info }))
      .rejects.toMatchObject({ kind: "unauthorized" });
  });

  it("rejects a response that is not the contract", async () => {
    const http = new OwnerHttp(ORIGIN, async () => new Response(JSON.stringify({ device: {} }), { status: 200 }));
    await expect(registerDevice(http, { sessionToken: "t", sessionId: "s", ids, info })).rejects.toMatchObject({ kind: "invalid_response" });
  });
});

describe("phone presence", () => {
  it("counts only another trusted real phone", async () => {
    const server = new FakeServer();
    server.deviceToken = "tok";
    const http = new OwnerHttp(ORIGIN, server.fetch);
    server.devicesList = [{ trusted: true, isCurrent: true }, { trusted: true, ownerOverview: true }, { trusted: true, isSimulator: true }, { trusted: false }];
    expect(await phoneReceivesPushes(http, "tok")).toBe(false);
    server.devicesList.push({ trusted: true });
    expect(await phoneReceivesPushes(http, "tok")).toBe(true);
  });

  it("says whether a trusted device approved this device", async () => {
    const server = new FakeServer();
    server.deviceToken = "tok";
    const http = new OwnerHttp(ORIGIN, server.fetch);
    server.devicesList = [{ trusted: false, isCurrent: true }];
    expect(await deviceStanding(http, "tok")).toEqual({ phone: false, thisTrusted: false });
    server.devicesList = [{ trusted: true, isCurrent: true }, { trusted: true }];
    expect(await deviceStanding(http, "tok")).toEqual({ phone: true, thisTrusted: true });
    server.devicesList = [{ trusted: true }];
    expect((await deviceStanding(http, "tok")).thisTrusted).toBeNull();
  });
});

describe("computer invites", () => {
  const CODE = `rci_${"A".repeat(32)}`;
  const answer = (status: number, body: unknown = {}) => {
    const seen: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchLike = async (url: string, init?: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify(body), { status });
    };
    return { seen, http: new OwnerHttp(ORIGIN, fetchLike) };
  };

  it("asks the server for a one-time code as the device and returns it", async () => {
    const { seen, http } = answer(201, { inviteId: "cin_1", code: CODE, expiresAt: "2030-01-01T00:00:00.000Z", command: "x" });
    expect(await createComputerInvite(http, { accessToken: "tok" })).toEqual({ code: CODE, expiresAt: "2030-01-01T00:00:00.000Z" });
    expect(seen[0]!.url).toBe(`${ORIGIN}/api/devices/self/computer-invites`);
    expect(seen[0]!.init?.method).toBe("POST");
    expect((seen[0]!.init?.headers as Record<string, string>).Authorization).toBe("Bearer tok");
  });

  it("names a refused credential, a throttled server and a bad answer", async () => {
    await expect(createComputerInvite(answer(403).http, { accessToken: "t" })).rejects.toMatchObject({ kind: "unauthorized" });
    await expect(createComputerInvite(answer(429).http, { accessToken: "t" })).rejects.toMatchObject({ kind: "rate_limited" });
    await expect(createComputerInvite(answer(500).http, { accessToken: "t" })).rejects.toMatchObject({ kind: "unavailable" });
    await expect(createComputerInvite(answer(201, { code: "nope", expiresAt: "x" }).http, { accessToken: "t" })).rejects.toMatchObject({ kind: "invalid_response" });
  });
});
