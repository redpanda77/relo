import assert from "node:assert/strict";
import test from "node:test";
import { ReloApiClient } from "../src/api-client.mjs";
import { ApiError, NetworkError } from "../src/errors.mjs";

test("sends bearer auth and idempotency through headers, not URLs or bodies", async () => {
  let request;
  const client = new ReloApiClient({
    apiUrl: "https://server.example.test/",
    token: "klb_secret_that_must_not_leak_anywhere_else",
    fetchImpl: async (url, init) => {
      request = { url: String(url), init };
      return Response.json({ event: { id: "evt_1" }, delivery: { accepted: 1 } }, { status: 202 });
    },
  });
  const response = await client.sendNotification({ body: "Done" }, "build-12345678");
  assert.equal(response.event.id, "evt_1");
  assert.equal(request.url, "https://server.example.test/api/notifications");
  assert.equal(request.init.headers.authorization, "Bearer klb_secret_that_must_not_leak_anywhere_else");
  assert.equal(request.init.headers["idempotency-key"], "build-12345678");
  assert.equal(request.init.body.includes("klb_secret"), false);
});

test("withdraws an encoded notification under the exact producer route", async () => {
  let request;
  const client = new ReloApiClient({
    apiUrl:"https://example.test",token:"x".repeat(40),
    fetchImpl:async (url,init) => {
      request={ url:String(url),init };
      return Response.json({ eventId:"ntf_1",state:"withdrawn",replayed:false });
    },
  });
  await client.withdrawNotification("ntf/id with spaces","withdraw-key");
  assert.equal(request.url,"https://example.test/api/notifications/ntf%2Fid%20with%20spaces/withdraw");
  assert.equal(request.init.method,"POST");
  assert.equal(request.init.headers["idempotency-key"],"withdraw-key");
});

test("normalizes API and transport failures", async () => {
  const denied = new ReloApiClient({
    apiUrl: "https://example.test",
    token: "x".repeat(40),
    fetchImpl: async () => Response.json({ error: { code: "SCOPE_MISSING", message: "Not permitted" } }, { status: 403 }),
  });
  await assert.rejects(
    denied.listDevices(),
    (error) => error instanceof ApiError && error.status === 403 && error.code === "SCOPE_MISSING",
  );

  const offline = new ReloApiClient({
    apiUrl: "https://example.test",
    token: "x".repeat(40),
    fetchImpl: async () => {
      throw new Error("host unreachable");
    },
  });
  await assert.rejects(offline.listDevices(), (error) => error instanceof NetworkError);
});

test("encodes path identifiers and long-poll timeout query values", async () => {
  const seen = [];
  const client = new ReloApiClient({
    apiUrl: "https://example.test",
    token: "x".repeat(40),
    fetchImpl: async (url, init) => {
      seen.push({ url: String(url), init });
      return Response.json({ interaction: { id: "int_1", state: "approved" } });
    },
  });
  await client.waitForInteraction("id/with spaces", 45);
  await client.getInteraction("id/with spaces");
  await client.cancelInteraction("id/with spaces");
  await client.createActivityWait("deploy/key with spaces", { type: "approval" }, "wait-key");
  await client.getActivity("deploy/key with spaces");
  await client.diagnoseActivity("deploy/key with spaces");
  await client.updateActivity("deploy/key with spaces", { status: "Running" }, "update-key");
  await client.endActivity("deploy/key with spaces", { status: "Complete" }, "end-key");
  assert.deepEqual(
    seen.map(({ url }) => url),
    [
      "https://example.test/api/interactions/id%2Fwith%20spaces/wait?timeoutSeconds=45",
      "https://example.test/api/interactions/id%2Fwith%20spaces",
      "https://example.test/api/interactions/id%2Fwith%20spaces/cancel",
      "https://example.test/api/live-activities/deploy%2Fkey%20with%20spaces/wait",
      "https://example.test/api/live-activities/deploy%2Fkey%20with%20spaces",
      "https://example.test/api/live-activities/deploy%2Fkey%20with%20spaces/diagnosis",
      "https://example.test/api/live-activities/deploy%2Fkey%20with%20spaces",
      "https://example.test/api/live-activities/deploy%2Fkey%20with%20spaces/end",
    ],
  );
  assert.deepEqual(
    seen.slice(2).map(({ init }) => init.method),
    ["POST", "POST", "GET", "GET", "PATCH", "POST"],
  );
  assert.deepEqual(JSON.parse(seen[2].init.body), {});
  assert.equal(seen[3].init.headers["idempotency-key"], "wait-key");
  assert.deepEqual(JSON.parse(seen[3].init.body), { type: "approval" });
});

test("adds an explicit activity list limit without changing the default route", async () => {
  const urls = [];
  const client = new ReloApiClient({
    apiUrl: "https://example.test",
    token: "x".repeat(40),
    fetchImpl: async (url) => { urls.push(String(url)); return Response.json({ activities: [] }); },
  });
  await client.listActivities();
  await client.listActivities(25);
  assert.deepEqual(urls, [
    "https://example.test/api/live-activities",
    "https://example.test/api/live-activities?limit=25",
  ]);
});

test("reconciles an exact delivery job with a guarded action body", async () => {
  let request;
  const client = new ReloApiClient({
    apiUrl: "https://example.test",token: "x".repeat(40),
    fetchImpl: async (url,init) => {
      request = { url: String(url),init };
      return Response.json({ deliveryId: "job_public",action: "retry",state: "retry",replayed: false });
    },
  });
  await client.reconcileDelivery("job/id with spaces","retry");
  assert.equal(request.url,"https://example.test/api/deliveries/job%2Fid%20with%20spaces/reconcile");
  assert.equal(request.init.method,"POST");
  assert.deepEqual(JSON.parse(request.init.body),{ action: "retry" });
});

test("requests evidence with encoded optional filters and label-free metrics",async () => {
  const urls = [];
  const client = new ReloApiClient({
    apiUrl: "https://example.test",token: "x".repeat(40),
    fetchImpl: async (url) => { urls.push(String(url)); return Response.json({ version: 1 }); },
  });
  await client.getEvidenceTimeline({
    notificationId: "ntf_11111111-1111-4111-8111-111111111111",limit: 25,cursor: "page+/=",
  });
  await client.getEvidenceMetrics();
  assert.deepEqual(urls,[
    "https://example.test/api/evidence/timeline?notificationId=ntf_11111111-1111-4111-8111-111111111111&limit=25&cursor=page%2B%2F%3D",
    "https://example.test/api/evidence/metrics",
  ]);
});

test("resolves lifecycle identity by origin in a JSON body", async () => {
  let request;
  const client = new ReloApiClient({
    apiUrl: "https://example.test",
    token: "x".repeat(40),
    fetchImpl: async (url,init) => {
      request = { url: String(url),init };
      return Response.json({ found: false,activity: null });
    },
  });
  const origin = {
    sourceInstance: "codex-installation",project: "relo",
    thread: "opaque-thread",channel: "task-progress",
  };
  assert.deepEqual(await client.resolveActivity(origin),{ found: false,activity: null });
  assert.equal(request.url,"https://example.test/api/live-activities/resolve");
  assert.equal(request.init.method,"POST");
  assert.deepEqual(JSON.parse(request.init.body),{ origin });

  const lifecycle = { provider: "codex",runId: "codex-run-123" };
  await client.resolveActivity({ lifecycle });
  assert.deepEqual(JSON.parse(request.init.body),{ lifecycle });
});

test("renews an exact provider activity lease without an idempotency header",async () => {
  const requests = [];
  const client = new ReloApiClient({
    apiUrl: "https://example.test",token: "secret",
    fetchImpl: async (url,options) => {
      requests.push({ url: String(url),options });
      return Response.json({ activity: { id: "act_123",sequence: 4 },renewed: true });
    },
  });
  await client.heartbeatActivity("act_123",{
    lifecycle: { provider: "codex",runId: "codex-run-123" },leaseAfterSeconds: 3_600,
  });
  assert.equal(requests[0].url,"https://example.test/api/live-activities/act_123/heartbeat");
  assert.equal(requests[0].options.method,"POST");
  assert.equal(requests[0].options.headers["idempotency-key"],undefined);
});

test("uses the current device inventory routes exactly", async () => {
  const urls = [];
  const client = new ReloApiClient({
    apiUrl: "https://example.test",
    token: "x".repeat(40),
    fetchImpl: async (url) => {
      urls.push(String(url));
      return Response.json({ devices: [] });
    },
  });
  await client.listDevices();
  await client.listDevices({ limit: 25 });
  await client.listDevices({ cursor: "opaque" });
  await client.listDevices({ limit: 10, cursor: "next" });
  assert.deepEqual(urls, [
    "https://example.test/api/devices",
    "https://example.test/api/devices?limit=25",
    "https://example.test/api/devices?cursor=opaque",
    "https://example.test/api/devices?limit=10&cursor=next",
  ]);
});

test("uses canonical service list, create, and revocation routes", async () => {
  const requests = [];
  const client = new ReloApiClient({
    apiUrl: "https://example.test",
    token: "x".repeat(40),
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ services: [] });
    },
  });
  await client.listServices();
  await client.createService({ title: "Builds", destinationUrl: "https://example.test/builds" });
  await client.revokeService("svc_path/with spaces");
  assert.deepEqual(
    requests.map(({ url, init }) => [url, init.method]),
    [
      ["https://example.test/api/services", "GET"],
      ["https://example.test/api/services", "POST"],
      ["https://example.test/api/services/svc_path%2Fwith%20spaces", "DELETE"],
    ],
  );
  assert.deepEqual(JSON.parse(requests[1].init.body), {
    title: "Builds",
    destinationUrl: "https://example.test/builds",
  });
});

test("uses frozen public device-authorization routes without bearer headers", async () => {
  const requests = [];
  const client = new ReloApiClient({
    apiUrl: "https://example.test",
    fetchImpl: async (url, init) => {
      requests.push({ url: String(url), init });
      if (String(url).endsWith("/start")) {
        return Response.json({ deviceCode: "d".repeat(43) }, { status: 201 });
      }
      return Response.json({ error: "authorization_pending", intervalSeconds: 5 }, { status: 400 });
    },
  });
  await client.startDeviceAuthorization({ clientName: "Mac", scopes: ["notifications:send"] });
  await assert.rejects(
    client.pollDeviceAuthorization("d".repeat(43)),
    (error) =>
      error instanceof ApiError &&
      error.code === "AUTHORIZATION_PENDING" &&
      error.details.intervalSeconds === 5,
  );
  assert.deepEqual(
    requests.map(({ url }) => url),
    [
      "https://example.test/api/device-authorizations/start",
      "https://example.test/api/device-authorizations/token",
    ],
  );
  assert.equal(requests.some(({ init }) => "authorization" in init.headers), false);
});

test("preserves rate-limit timing for the authorization poller", async () => {
  const client = new ReloApiClient({
    apiUrl: "https://example.test",
    fetchImpl: async () =>
      Response.json(
        { error: "rate_limited", intervalSeconds: 30 },
        { status: 429, headers: { "retry-after": "60" } },
      ),
  });
  await assert.rejects(
    client.pollDeviceAuthorization("d".repeat(43)),
    (error) =>
      error instanceof ApiError &&
      error.details.intervalSeconds === 30 &&
      error.details.retryAfterSeconds === 60,
  );
});

test("an API error carries the server's sentence, not only its code", async () => {
  const client = new ReloApiClient({
    apiUrl: "https://example.test",
    token: "x".repeat(40),
    fetchImpl: async () => Response.json({ error: "choice_unsupported", message: "Update Relo on Old iPhone to answer questions with options." },
      { status: 409 }),
  });
  await assert.rejects(client.createActivityWait("act_1", { type: "choice" }, "key"), (error) => {
    assert.equal(error.code, "CHOICE_UNSUPPORTED");
    assert.equal(error.message, "Update Relo on Old iPhone to answer questions with options.");
    return true;
  });
});
