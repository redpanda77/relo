import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import { generateToken, hashToken } from "./auth.js";
import { internalId, publicId } from "./ids.js";
import { createNotificationSchema, heartbeatSchema, registerDeviceSchema } from "./schemas.js";

describe("identity and persistence contracts", () => {
  test("public identifiers round-trip without exposing a different entity type", () => {
    const uuid = "11111111-1111-4111-8111-111111111111";
    expect(internalId("dev", publicId("dev", uuid))).toBe(uuid);
    expect(internalId("ntf", publicId("dev", uuid))).toBeUndefined();
    for (const prefix of ["usr", "acc", "key", "svc", "dev", "ntf", "int", "job", "act", "cnv", "wrk"] as const) {
      expect(internalId(prefix, `${prefix}_not-a-uuid`)).toBeUndefined();
      expect(internalId(prefix, `${prefix}_11111111111141118111111111111111`)).toBeUndefined();
    }
  });

  test("credentials are high entropy and only their digest is persisted", () => {
    const token = generateToken();
    expect(token.startsWith("relo_")).toBe(true);
    expect(token.length).toBeGreaterThan(40);
    expect(hashToken(token)).toMatch(/^[a-f0-9]{64}$/);
    expect(hashToken(token)).not.toContain(token);
  });

  test("device registration requires current app identity", () => {
    expect(registerDeviceSchema.safeParse({ installationId: "missing-everything" }).success).toBe(false);
    expect(registerDeviceSchema.parse({
      stableDeviceId: "stable-1", installationId: "install-1", name: "iPhone",
      bundleIdentifier: "com.example.relo.notifications", appVersion: "1.0.0", appBuild: "1",
      osVersion: "18.0", apnsEnvironment: "sandbox",
    })).not.toHaveProperty("capabilities");
  });

  test("a partial heartbeat does not apply registration defaults", () => {
    expect(heartbeatSchema.parse({ liveActivityPushToStartToken: "b".repeat(64) })).toEqual({
      liveActivityPushToStartToken: "b".repeat(64),
    });
  });

  test("notification payloads are bounded before entering the outbox", () => {
    expect(createNotificationSchema.safeParse({ source: "Codex", title: "", body: "done" }).success).toBe(false);
    expect(createNotificationSchema.safeParse({ source: "Codex", title: "Done", body: "x".repeat(4097) }).success).toBe(false);
  });

  test("migration enforces owner isolation, idempotency, and one job per event/device", async () => {
    const sql = await readFile(new URL("../migrations/0001_initial.sql", import.meta.url), "utf8");
    expect(sql).toContain("UNIQUE (principal_id, idempotency_key)");
    expect(sql).toContain("UNIQUE (notification_event_id, device_id)");
    expect(sql).toContain("principal_id uuid NOT NULL REFERENCES owner_principals");
    expect(sql).toContain("WHERE state IN ('pending', 'retry')");
  });

  test("clean-room APNs migration preserves payload identity and immutable attempt history", async () => {
    const sql = await readFile(new URL(
      "../migrations/0013_cleanroom_apns_runtime.sql",
      import.meta.url,
    ), "utf8");
    expect(sql).toContain("apns_payload_sha256");
    expect(sql).toContain("CREATE TABLE delivery_attempts");
    expect(sql).toContain("UNIQUE (delivery_job_id, job_attempt)");
    expect(sql).toContain("provider_attempts integer NOT NULL CHECK (provider_attempts >= 0)");
    expect(sql).toContain("delivery_jobs_provider_attempt_horizon_check");
    expect(sql).toContain("provider_first_attempt_at timestamptz");
    expect(sql).toContain("claim_token uuid NOT NULL");
    expect(sql).toContain("UNIQUE (claim_token)");
    expect(sql).toContain("CREATE TRIGGER delivery_attempts_no_update");
    expect(sql).toContain("CREATE TRIGGER delivery_attempts_no_delete");
    expect(sql).toContain("REVOKE UPDATE,DELETE ON delivery_attempts FROM PUBLIC");
    expect(sql).toContain("CREATE TRIGGER delivery_jobs_bind_exact_target");
    expect(sql).not.toContain("ON CONFLICT (delivery_job_id,job_attempt) DO UPDATE");
    expect(sql).not.toMatch(/apns_token|authorization|private_key/i);
  });

  test("Live Activity command generation migration backfills durable identity and constrains tokens", async () => {
    const sql = await readFile(new URL(
      "../migrations/0020_live_activity_command_generations.sql",
      import.meta.url,
    ),"utf8");
    expect(sql).toContain("ADD COLUMN generation integer");
    expect(sql).toContain("SET generation=activity.generation");
    expect(sql).toContain("ALTER COLUMN generation SET NOT NULL");
    expect(sql).toContain("CHECK (generation > 0)");
    expect(sql).toContain("jsonb_set(event.payload,'{liveActivity,generation}'");
    expect(sql).toContain("legacy Live Activity command could not be bound to a generation");
  });

  test("agent lifecycle migration binds an opaque run to one credential activity", async () => {
    const sql = await readFile(new URL(
      "../migrations/0022_agent_lifecycle_identity.sql",
      import.meta.url,
    ),"utf8");
    expect(sql).toContain("ADD COLUMN lifecycle_provider text");
    expect(sql).toContain("ADD COLUMN lifecycle_run_id text");
    expect(sql).toContain("live_activities_lifecycle_identity_pair");
    expect(sql).toContain("live_activities_credential_lifecycle_run_idx");
    expect(sql).toContain("live_activities_service_lifecycle_run_idx");
  });

  test("delivery reconciliation resolutions are append-only and operator attributable", async () => {
    const sql = await readFile(new URL(
      "../migrations/0024_delivery_reconciliation_resolution.sql",
      import.meta.url,
    ),"utf8");
    expect(sql).toContain("CREATE TABLE delivery_reconciliation_resolutions");
    expect(sql).toContain("action IN ('mark_accepted','retry','cancel')");
    expect(sql).toContain("delivery_job_id uuid NOT NULL UNIQUE");
    expect(sql).toContain("CREATE TRIGGER delivery_reconciliation_resolutions_no_update");
    expect(sql).not.toContain("CREATE TRIGGER delivery_reconciliation_resolutions_no_delete");
    expect(sql).toContain("REVOKE UPDATE,DELETE,TRUNCATE");
    expect(sql).toContain("GRANT SELECT,INSERT ON delivery_reconciliation_resolutions TO relo_runtime");
  });

  test("worker selects only the clean-room provider stack while legacy transport stays quarantined", async () => {
    const source = await readFile(new URL("./worker.ts", import.meta.url), "utf8");
    expect(source).toContain('from "./apns-http2-transport.js"');
    expect(source).toContain('from "./apns-recipient-resolver.js"');
    expect(source).toContain('from "./apns-runtime.js"');
    expect(source).toContain("await markDeliveryDispatchStarted(db,job.id,job.claim_token,providerPriority)");
    expect(source).toContain("known_apns_acceptance_persistence_failed");
    expect(source).toContain("error instanceof ApnsOutcomePersistenceError");
    expect(source).toContain("await assertPreparedApnsCutover");
    expect(source).toContain("await readProtectedApnsPrivateKey(config)");
    expect(source).toContain('apnsOperationalLog("apns_worker_cycle"');
    expect(source).toContain("await apns.warm(shutdown.signal)");
    expect(source).toContain("DeliveryJobWakeup.listen(db)");
    expect(source.match(/await quarantineAbandonedProcessingClaims\(db\)/g)).toHaveLength(3);
    expect(source).toContain('interactionId: job.interaction_id ? publicId("int",job.interaction_id) : null');
    expect(source).not.toContain('from "./apns.js"');
    expect(source).not.toContain("new ApnsClient");
  });

  test("APNs operations audit is append-only and runtime-owned only for select and insert", async () => {
    const sql = await readFile(new URL(
      "../migrations/0016_apns_operations_and_observability.sql",
      import.meta.url,
    ),"utf8");
    expect(sql).toContain("CREATE TABLE apns_operation_audit");
    expect(sql).toContain("delivery_attempts_created_desc_idx");
    expect(sql).toContain("CREATE TRIGGER delivery_jobs_notify_ready");
    expect(sql).toContain("first_claimed_at timestamptz");
    expect(sql).toContain("apns_priority smallint");
    expect(sql).toContain("CREATE TRIGGER apns_operation_audit_no_update");
    expect(sql).toContain("CREATE TRIGGER apns_operation_audit_no_delete");
    expect(sql).toContain("GRANT SELECT,INSERT ON apns_operation_audit TO relo_runtime");
    expect(sql).toContain("REVOKE UPDATE,DELETE,TRUNCATE ON apns_operation_audit FROM relo_runtime");
    expect(sql).not.toMatch(/apns_token|private_key|provider_message_id/i);
  });
});
