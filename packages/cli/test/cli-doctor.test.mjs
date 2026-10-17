import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { AuthError, EXIT } from "../src/shared/errors.mjs";
import { execute, overrides, WAIT_EVENT, DELIVERY_JOB, EVIDENCE_FIXTURE, issuedCredential } from "./cli-fixtures.mjs";

test("doctor reports missing local login without leaking its path", async () => {
  const output = await execute(["doctor"],{
    configPath: () => "/private/relo/config.json",
    loadConfig: async () => { throw new AuthError("missing",{ code: "CONFIG_NOT_FOUND" }); },
  });
  assert.equal(output.exitCode,EXIT.AUTH);
  assert.equal(output.data.checks.localConfig.state,"CONFIG_NOT_FOUND");
  assert.equal(JSON.stringify(output).includes("/private/relo"),false);
});

test("doctor returns one honest readiness result", async () => {
  const output = await execute(["doctor"],overrides({
    ready: async () => ({ status: "ok" }),
    authStatus: async () => ({ authenticated: true,credential: issuedCredential().credential }),
    doctor: async () => ({
      version: 1,ok: true,releaseIdentity: "0.7.22-test",
      checks: {
        database: { ok: true },worker: { ok: true,state: "ready" },
        apns: { ok: true,state: "configured" },devices: { ok: true,notificationAuthorized: 1 },
      },
    }),
  }));
  assert.equal(output.exitCode,EXIT.OK);
  assert.equal(output.data.ok,true);
  assert.equal(output.data.checks.runtime.releaseIdentity,"0.7.22-test");
});

test("doctor rejects activity credentials that cannot inspect delivery evidence", async () => {
  const output = await execute(["doctor"],overrides({
    ready: async () => ({ status: "ok" }),
    authStatus: async () => ({
      authenticated: true,
      credential: issuedCredential({
        credential: {
          ...issuedCredential().credential,
          scopes: ["activities:read","activities:write"],
        },
      }).credential,
    }),
    doctor: async () => ({ version: 1,ok: true,checks: {} }),
  }));
  assert.equal(output.exitCode,EXIT.AUTH);
  assert.equal(output.data.ok,false);
  assert.equal(output.data.checks.auth.state,"activity_evidence_scope_missing");
  assert.deepEqual(output.data.checks.auth.missingScopes,["devices:read"]);
  assert.equal(output.data.checks.runtime.ok,true);
});

test("doctor smoke never mistakes server acceptance for provider or phone receipt", async () => {
  let request;
  const output = await execute(["doctor","--smoke"],overrides({
    ready: async () => ({ status: "ok" }),
    authStatus: async () => ({ authenticated: true,credential: issuedCredential().credential }),
    doctor: async () => ({ version: 1,ok: true,checks: {} }),
    sendNotification: async (body) => {
      request = body;
      return { eventId: "ntf_smoke",delivery: { durableCommands: 1 } };
    },
  }));
  assert.equal(output.exitCode,EXIT.OK);
  assert.equal(output.data.checks.smoke.serverAccepted,true);
  assert.equal(output.data.checks.smoke.providerAccepted,null);
  assert.equal(output.data.checks.smoke.phoneReceived,null);
  assert.equal(request.sourceName,"Relo doctor");
});

test("delivery reconciliation exposes only the three server-guarded operator actions", async () => {
  const calls = [];
  const client = {
    reconcileDelivery: async (id,action) => {
      calls.push({ id,action });
      return { deliveryId: id,action,state: action === "mark_accepted" ? "accepted" : action,replayed: false };
    },
  };
  const response = await execute([
    "delivery","reconcile",DELIVERY_JOB,"mark-accepted","--json",
  ],overrides(client));
  assert.equal(response.command,"delivery.reconcile");
  assert.deepEqual(calls,[{ id: DELIVERY_JOB,action: "mark_accepted" }]);
  await assert.rejects(
    execute(["delivery","reconcile",DELIVERY_JOB,"force-retry"],overrides(client)),
    /reconciliation action/,
  );
  await assert.rejects(
    execute(["delivery", "reconcile", DELIVERY_JOB], overrides(client)),
    /Usage: relo delivery reconcile/,
  );
  await assert.rejects(
    execute(["delivery","reconcile","not-a-job","cancel"],overrides(client)),
    /public job_/,
  );
});

test("evidence commands preserve the canonical vocabulary and guarded filters",async () => {
  const calls = [];
  const metrics = {
    version: 1,generatedAt: "2026-08-14T12:01:00.000Z",
    queue: { pendingJobs: 2,oldestAgeMs: 12000 },worker: { lagMs: 4000 },
    delivery: { retryRate1h: 0.25,ambiguousOutcomes1h: 1,invalidatedTokens24h: 0,
      receiptLatencyP95Ms24h: 900 },
  };
  const client = {
    getEvidenceTimeline: async (options) => { calls.push(options); return EVIDENCE_FIXTURE; },
    getEvidenceMetrics: async () => metrics,
  };
  const timeline = await execute([
    "evidence","timeline","--notification",WAIT_EVENT,"--limit","25","--cursor","next-page",
  ],overrides(client));
  assert.equal(timeline.command,"evidence.timeline");
  assert.deepEqual(timeline.data,EVIDENCE_FIXTURE);
  assert.deepEqual(calls,[{ notificationId: WAIT_EVENT,limit: 25,cursor: "next-page" }]);
  assert.deepEqual((await execute(["evidence","metrics"],overrides(client))).data,metrics);
  await assert.rejects(
    execute(["evidence","timeline","--notification","private-project-name"],overrides(client)),
    /public ntf_/,
  );
  await assert.rejects(
    execute(["evidence","timeline","--limit","101"],overrides(client)),
    /at most 100/,
  );
});
