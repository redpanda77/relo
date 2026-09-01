import { afterEach,describe,expect,test,vi } from "vitest";
import {
  DeliveryClaimOwnershipLostError,
  DeliverySerializationMismatchError,
  claimDeliveryJobs,
  deferFutureActivityTimestamp,
  finalizeDeliveryClaim,
  heartbeatDeliveryClaim,
  markDeliveryClaimForReconciliation,
  markDeliveryDispatchStarted,
  pinDeliverySerializationEvidence,
  quarantineDeliverySerializationMismatch,
  quarantineInvalidDeliverySerialization,
  quarantineAbandonedProcessingClaims,
  retryPreparingDeliveryClaim,
  withJobLeaseHeartbeat,
  type ClaimedDeliveryJob,
} from "./apns-worker-state.js";

type Statement = { text: string; values?: unknown[] };

class FakeDatabase {
  readonly statements: Statement[] = [];
  owned = true;
  currentClaimToken: string | undefined;
  quarantineCounts = [1,1];

  async query(text: string,values?: unknown[]) {
    this.statements.push({ text,...(values ? { values } : {}) });
    if (text.startsWith("WITH candidates")) return { rowCount: 0,rows: [] };
    if (text.includes("claim_phase='preparing'") && text.startsWith("UPDATE delivery_jobs SET state='retry'")) {
      return { rowCount: this.quarantineCounts[0],rows: [] };
    }
    if (text.includes("claim_phase IS DISTINCT FROM 'preparing'")) {
      return { rowCount: this.quarantineCounts[1],rows: [] };
    }
    if (text.includes("WHERE id=$1 AND state='processing' AND claim_token=$2")) {
      const tokenMatches = this.currentClaimToken === undefined || values?.[1] === this.currentClaimToken;
      return { rowCount: this.owned && tokenMatches ? 1 : 0,rows: [] };
    }
    return { rowCount: 1,rows: [] };
  }

  async connect() {
    return { query: this.query.bind(this),release() {} };
  }
}

class RestartSweepDatabase extends FakeDatabase {
  state: "processing" | "reconciliation_required" = "processing";
  leaseExpired = false;
  transitions = 0;

  override async query(text: string,values?: unknown[]) {
    this.statements.push({ text,...(values ? { values } : {}) });
    if (text.startsWith("WITH candidates")) return { rowCount: 0,rows: [] };
    if (text.includes("claim_phase='preparing'") && text.startsWith("UPDATE delivery_jobs SET state='retry'")) {
      return { rowCount: 0,rows: [] };
    }
    if (text.includes("claim_phase IS DISTINCT FROM 'preparing'")) {
      if (this.state === "processing" && this.leaseExpired) {
        this.state = "reconciliation_required";
        this.transitions += 1;
        return { rowCount: 1,rows: [] };
      }
      return { rowCount: 0,rows: [] };
    }
    if (text.includes("WHERE id=$1 AND state='processing' AND claim_token=$2")) {
      return { rowCount: this.state === "processing" ? 1 : 0,rows: [] };
    }
    return { rowCount: 1,rows: [] };
  }
}

class SerializationEvidenceDatabase {
  intent: string | null = null;
  projection: string | null = null;
  state = "processing";

  async query(text: string,values?: unknown[]) {
    if (text.startsWith("UPDATE delivery_jobs SET canonical_intent_sha256")) {
      const intent = String(values![2]);
      const projection = String(values![3]);
      if (this.state !== "processing"
        || (this.intent !== null && this.intent !== intent)
        || (this.projection !== null && this.projection !== projection)) {
        return { rowCount: 0,rows: [] };
      }
      this.intent ??= intent;
      this.projection ??= projection;
      return { rowCount: 1,rows: [] };
    }
    if (text.startsWith("SELECT canonical_intent_sha256")) {
      return this.state === "processing"
        ? { rowCount: 1,rows: [{
          canonical_intent_sha256: this.intent,
          device_projection_sha256: this.projection,
        }] }
        : { rowCount: 0,rows: [] };
    }
    if (text.startsWith("UPDATE delivery_jobs SET state='permanently_failed'")) {
      if (this.state !== "processing") return { rowCount: 0,rows: [] };
      this.state = "permanently_failed";
      return { rowCount: 1,rows: [] };
    }
    return { rowCount: 1,rows: [] };
  }
}

function job(overrides: Partial<ClaimedDeliveryJob> = {}): ClaimedDeliveryJob {
  return {
    id: "job-id",claim_token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    canonical_intent_sha256: null,device_projection_sha256: null,
    principal_id: "principal-id",device_id: "device-id",transport: "notification",
    live_activity_id: null,event_id: "event-id",title: "Title",body: "Body",source: "Codex",
    service_id: null,requester_credential_id: null,service_image_url: null,image_url: null,
    deep_link: null,expires_at: null,payload: {},interaction_kind: null,interaction_id: null,
    interaction_state: null,interaction_expires_at: null,credential_version: 1,attempt_count: 1,
    provider_attempts_used: 0,provider_retry_started_at: null,provider_status: null,
    provider_retry_attempt_cap: null,provider_retry_horizon_at: null,
    provider_next_attempt_not_before: null,apns_priority: null,first_claimed_at: null,
    last_claimed_at: null,last_dispatch_started_at: null,
    created_at: new Date("2026-08-07T00:00:00.000Z"),...overrides,
  };
}

afterEach(() => vi.useRealTimers());

describe("APNs worker claim fencing", () => {
  test("claims only queued work and persists a unique preparing fence with account binding", async () => {
    const db = new FakeDatabase();
    await claimDeliveryJobs(db as never,20,new Date("2026-08-07T00:00:00.000Z"));
    const sql = db.statements[0]!.text;
    expect(sql).toContain("j.state IN ('pending','retry')");
    expect(sql).not.toMatch(/lease_expires_at\s*</);
    expect(sql).toContain("claim_token=gen_random_uuid()");
    expect(sql).toContain("claim_phase='preparing'");
    expect(sql).toContain("candidate_device.principal_id=candidate_event.principal_id");
    expect(sql).toContain("j.provider_attempts_used,j.provider_retry_started_at,j.provider_retry_attempt_cap");
    expect(sql).toContain("j.provider_retry_horizon_at,j.provider_next_attempt_not_before,j.provider_status");
  });

  test("safely requeues only pre-dispatch expiry and quarantines dispatch-started or legacy claims", async () => {
    const db = new FakeDatabase();
    await expect(quarantineAbandonedProcessingClaims(db as never)).resolves.toEqual({
      safelyRequeued: 1,reconciliationRequired: 1,
    });
    const safe = db.statements[0]!.text;
    const uncertain = db.statements[1]!.text;
    expect(safe).toContain("claim_phase='preparing'");
    expect(safe).not.toMatch(/provider_attempts_used\s*=/);
    expect(safe).not.toMatch(/provider_retry_started_at\s*=/);
    expect(uncertain).toContain("state='reconciliation_required'");
    expect(uncertain).toContain("claim_phase IS DISTINCT FROM 'preparing'");
  });

  test("a fast restart sweeps again after lease expiry exactly once without reclaiming the dispatch", async () => {
    const db = new RestartSweepDatabase();
    await expect(quarantineAbandonedProcessingClaims(db as never)).resolves.toEqual({
      safelyRequeued: 0,reconciliationRequired: 0,
    });
    await expect(claimDeliveryJobs(db as never,20,new Date("2026-08-07T00:00:00.000Z")))
      .resolves.toEqual([]);
    db.leaseExpired = true;
    await expect(quarantineAbandonedProcessingClaims(db as never)).resolves.toEqual({
      safelyRequeued: 0,reconciliationRequired: 1,
    });
    await expect(quarantineAbandonedProcessingClaims(db as never)).resolves.toEqual({
      safelyRequeued: 0,reconciliationRequired: 0,
    });
    expect(db.transitions).toBe(1);
    await expect(claimDeliveryJobs(db as never,20,new Date("2026-08-07T00:00:00.000Z")))
      .resolves.toEqual([]);
    await expect(heartbeatDeliveryClaim(db as never,"job-id",job().claim_token)).rejects
      .toBeInstanceOf(DeliveryClaimOwnershipLostError);
  });

  test("stale worker A cannot heartbeat, cross the fence, or complete work reclaimed by B", async () => {
    const db = new FakeDatabase();
    db.currentClaimToken = "claim-b";
    await expect(heartbeatDeliveryClaim(db as never,"job-id","stale-a")).rejects
      .toBeInstanceOf(DeliveryClaimOwnershipLostError);
    await expect(markDeliveryDispatchStarted(db as never,"job-id","stale-a",10)).rejects
      .toBeInstanceOf(DeliveryClaimOwnershipLostError);
    await expect(finalizeDeliveryClaim(db as never,job({ claim_token: "stale-a" }),{
      kind: "accepted",providerMessageId: "123e4567-e89b-42d3-a456-426614174999",
    })).rejects.toBeInstanceOf(DeliveryClaimOwnershipLostError);
    expect(db.statements.some(({ text }) => text.startsWith("UPDATE notification_events"))).toBe(false);
    await expect(heartbeatDeliveryClaim(db as never,"job-id","claim-b")).resolves.toBeUndefined();
  });

  test("persists claim, dispatch-fence, and provider-priority evidence", async () => {
    const db = new FakeDatabase();
    await claimDeliveryJobs(db as never,20,new Date("2026-08-07T00:00:00.000Z"));
    expect(db.statements[0]!.text).toContain("first_claimed_at=COALESCE");
    await markDeliveryDispatchStarted(db as never,"job-id",job().claim_token,10);
    expect(db.statements[1]).toMatchObject({ values: ["job-id",job().claim_token,10] });
    expect(db.statements[1]!.text).toContain("last_dispatch_started_at=clock_timestamp()");
  });

  test("pins deterministic intent and projection identity before the dispatch fence", async () => {
    const db = new SerializationEvidenceDatabase();
    const evidence = {
      canonicalIntentSha256: "a".repeat(64),
      deviceProjectionSha256: "b".repeat(64),
    };
    await expect(pinDeliverySerializationEvidence(db as never,job(),evidence)).resolves.toBeUndefined();
    await expect(pinDeliverySerializationEvidence(db as never,job(),evidence)).resolves.toBeUndefined();
    expect(db).toMatchObject({ intent: "a".repeat(64),projection: "b".repeat(64) });
  });

  test("quarantines a retry whose projection no longer matches pinned evidence", async () => {
    const db = new SerializationEvidenceDatabase();
    await pinDeliverySerializationEvidence(db as never,job(),{
      canonicalIntentSha256: "a".repeat(64),deviceProjectionSha256: "b".repeat(64),
    });
    await expect(pinDeliverySerializationEvidence(db as never,job(),{
      canonicalIntentSha256: "a".repeat(64),deviceProjectionSha256: "c".repeat(64),
    })).rejects.toBeInstanceOf(DeliverySerializationMismatchError);
    await quarantineDeliverySerializationMismatch(db as never,job());
    expect(db.state).toBe("permanently_failed");
  });

  test("quarantines an invalid delivery without entering a retry loop", async () => {
    const db = new SerializationEvidenceDatabase();
    await quarantineInvalidDeliverySerialization(db as never,job());
    expect(db.state).toBe("permanently_failed");
  });

  test("pre-dispatch failures retry only the owned preparing claim without resetting provider budget", async () => {
    const db = new FakeDatabase();
    await retryPreparingDeliveryClaim(db as never,job());
    const statement = db.statements[0]!.text;
    expect(statement).toContain("claim_phase='preparing'");
    expect(statement).not.toMatch(/provider_attempts_used\s*=/);
    expect(statement).not.toMatch(/provider_retry_started_at\s*=/);
    expect(statement).toContain("state='retry'");
  });

  test("defers a monotonic ActivityKit timestamp before crossing the APNs dispatch fence", async () => {
    const db = new FakeDatabase();
    await deferFutureActivityTimestamp(db as never,job(),1_786_104_001);
    expect(db.statements[0]).toMatchObject({
      values: ["job-id",job().claim_token,1_786_104_001],
    });
    expect(db.statements[0]!.text).toContain("state='retry'");
    expect(db.statements[0]!.text).toContain("activity_timestamp_pending");
    expect(db.statements[0]!.text).toContain("claim_phase='preparing'");
    expect(db.statements[0]!.text).not.toContain("provider_attempts_used");
  });

  test("records invalidated recipients in the explicit token-invalid terminal state", async () => {
    const db = new FakeDatabase();
    await finalizeDeliveryClaim(db as never,job(),{
      kind: "invalid_token",code: "BadDeviceToken",message: "invalid-recipient",
    });
    expect(db.statements.some(({ text }) => text.includes("state='token_invalid'"))).toBe(true);
  });

  test("heartbeat ownership loss aborts the in-flight operation", async () => {
    vi.useFakeTimers();
    const db = new FakeDatabase();
    db.owned = false;
    const outer = new AbortController();
    const running = withJobLeaseHeartbeat(
      db as never,"job-id","stale-a",outer.signal,
      async (signal) => await new Promise<never>((_resolve,reject) => {
        signal.addEventListener("abort",() => reject(Object.assign(new Error("aborted"),{
          name: "AbortError",
        })),{ once: true });
      }),
    );
    const rejected = expect(running).rejects.toBeInstanceOf(DeliveryClaimOwnershipLostError);
    await vi.advanceTimersByTimeAsync(30_000);
    await rejected;
  });

  test("heartbeat cadence also sweeps other expired claims during a long dispatch", async () => {
    vi.useFakeTimers();
    const db = new FakeDatabase();
    db.quarantineCounts = [0,1];
    const outer = new AbortController();
    const running = withJobLeaseHeartbeat(
      db as never,"job-id",job().claim_token,outer.signal,
      async (signal) => await new Promise<never>((_resolve,reject) => {
        signal.addEventListener("abort",() => reject(Object.assign(new Error("aborted"),{
          name: "AbortError",
        })),{ once: true });
      }),
    );
    await vi.advanceTimersByTimeAsync(30_000);
    expect(db.statements.some(({ text }) => text.includes("claim_phase IS DISTINCT FROM 'preparing'")))
      .toBe(true);
    outer.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
  });

  test("shutdown aborts without waiting for or issuing a heartbeat", async () => {
    vi.useFakeTimers();
    const db = new FakeDatabase();
    const outer = new AbortController();
    const running = withJobLeaseHeartbeat(
      db as never,"job-id",job().claim_token,outer.signal,
      async (signal) => await new Promise<never>((_resolve,reject) => {
        signal.addEventListener("abort",() => reject(Object.assign(new Error("aborted"),{
          name: "AbortError",
        })),{ once: true });
      }),
    );
    outer.abort();
    await expect(running).rejects.toMatchObject({ name: "AbortError" });
    expect(db.statements).toHaveLength(0);
  });

  test("known acceptance ambiguity is terminally fenced for manual reconciliation", async () => {
    const db = new FakeDatabase();
    await markDeliveryClaimForReconciliation(
      db as never,job(),"known_apns_acceptance_persistence_failed",
      "APNs accepted the request but final durable state was not confirmed",
      "123e4567-e89b-42d3-a456-426614174999",
    );
    expect(db.statements[0]).toMatchObject({
      text: expect.stringContaining("state='reconciliation_required'"),
      values: [
        "job-id",job().claim_token,"known_apns_acceptance_persistence_failed",
        "APNs accepted the request but final durable state was not confirmed",
        "123e4567-e89b-42d3-a456-426614174999",
      ],
    });
    expect(db.statements[0]!.text).toContain("state='processing' AND claim_token=$2");
    expect(db.statements[0]!.text).toContain("claim_phase='dispatch_started'");
  });
});
