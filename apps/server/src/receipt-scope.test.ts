import { existsSync, readdirSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import { receiptServerOriginHash, requiredReceiptServerOriginHash } from "./receipt-scope.js";
import { deliveryProjection, deliverySerializationEvidence, ordinaryDeliveryPayloadSize,
  DeliverySerializationValidationError } from "./delivery-serialization.js";
import type { ApnsRuntimeJob } from "./apns-runtime.js";
import { pinDeliverySerializationEvidence, DeliverySerializationMismatchError,
  quarantineDeliverySerializationMismatch } from "./apns-worker-state.js";

const fixtureBytes = readFileSync(new URL("../../../packages/contracts/fixtures/receipt-scope-v1.json", import.meta.url), "utf8");
const fixture = JSON.parse(fixtureBytes) as { origin: string; normalized: string; sha256: string }[];
const recipient = {
  accountId: "acc_11111111-1111-4111-8111-111111111111",
  deviceId: "dev_22222222-2222-4222-8222-222222222222",
  serverOriginHash: receiptServerOriginHash("https://relo.example"),
};
/** The public Compose file plus any private deployment Compose files present in this checkout. */
function composeFiles(): URL[] {
  const root = new URL("../../../", import.meta.url);
  const files = [new URL("deploy/compose.yaml", root)];
  const operations = new URL("docs/internal/operations/", root);
  if (!existsSync(operations)) return files;
  for (const entry of readdirSync(operations, { withFileTypes: true })) {
    const candidate = new URL(`${entry.name}/compose.yaml`, operations);
    if (entry.isDirectory() && existsSync(candidate)) files.push(candidate);
  }
  return files;
}
function job(privacy = "standard"): ApnsRuntimeJob {
  return { id: "job", claimToken: "claim", attemptCount: 1, providerAttemptsUsed: 0,
    providerRetryStartedAt: null, providerRetryAttemptCap: null, providerRetryHorizonAt: null,
    providerNextAttemptNotBefore: null, providerStatus: null, transport: "notification",
    createdAt: new Date("2026-09-30T00:00:00Z"), expiresAt: null, title: "Title", body: "Body",
    sourceName: "Relo", conversationId: null, avatarUrl: null, imageUrl: null, deepLink: null,
    notificationId: "ntf_33333333-3333-4333-8333-333333333333", ...recipient,
    interactionKind: null, interactionId: null, badge: 0, payload: { privacy } };
}

describe("scoped notification receipt wire", () => {
  test("worker requires an explicit origin rather than inheriting a localhost default", () => {
    expect(() => requiredReceiptServerOriginHash(undefined)).toThrow("APP_URL must explicitly configure");
    expect(() => requiredReceiptServerOriginHash("")).toThrow("APP_URL must explicitly configure");
    expect(requiredReceiptServerOriginHash("https://relo.example")).toBe(recipient.serverOriginHash);
  });
  test("API and worker compose services receive the same configured origin", () => {
    for (const path of composeFiles()) {
      const compose = readFileSync(path, "utf8");
      const api = compose.slice(compose.indexOf("  api:"), compose.indexOf("  worker:"));
      const worker = compose.slice(compose.indexOf("  worker:"));
      const expression = /APP_URL: (.+)/;
      const apiOrigin = api.match(expression)?.[1];
      expect(apiOrigin).toBeTruthy();
      expect(worker.match(expression)?.[1]).toBe(apiOrigin);
    }
  });
  test.each(fixture)("hashes $origin with the Swift fixture", ({ origin, sha256 }) => {
    expect(receiptServerOriginHash(origin)).toBe(sha256);
    expect(readFileSync(new URL("../../ios/Tests/ReloCoreTests/Fixtures/receipt-scope-v1.json", import.meta.url), "utf8")).toBe(fixtureBytes);
  });
  test.each(["https://user:pass@example.com", "https://example.com/path", "https://example.com?q=1", "https://example.com#x", "file:///tmp"]) (
    "rejects a non-origin %s", origin => { expect(() => receiptServerOriginHash(origin)).toThrow(); });
  test.each(["standard", "private"])("includes exact scope for %s noninteractive alerts", privacy => {
    expect(deliveryProjection(job(privacy))).toMatchObject({ customData: { relo: { receiptScope: recipient } } });
  });
  test("invalid partial recipient scope fails closed", () => {
    expect(() => deliveryProjection({ ...job(), deviceId: "" })).toThrow(DeliverySerializationValidationError);
    expect(() => deliveryProjection({ ...job(), serverOriginHash: "event-origin-hash" })).toThrow(DeliverySerializationValidationError);
  });
  test("admission reserves receipt metadata even before the recipient is known", () => {
    const { accountId: _a, deviceId: _d, serverOriginHash: _s, ...admission } = job();
    const actual = ordinaryDeliveryPayloadSize(job());
    expect(ordinaryDeliveryPayloadSize(admission)).toBe(actual);
    const projection = deliveryProjection(job());
    if (projection.kind !== "alert") throw new Error("Expected ordinary alert");
    const deliveredBytes = Buffer.byteLength(JSON.stringify({ ...projection.customData,
      aps: { alert: projection.alert, sound: projection.sound, badge: 0, "mutable-content": 1,
        "interruption-level": projection.interruptionLevel } }));
    expect(actual).toBe(deliveredBytes);
  });
  test("scope changes projection identity, and repeated claims preserve it", () => {
    const first = deliverySerializationEvidence(job());
    expect(deliverySerializationEvidence({ ...job(), attemptCount: 2, claimToken: "another" })).toEqual(first);
    expect(deliverySerializationEvidence({ ...job(), serverOriginHash: "f".repeat(64) }).deviceProjectionSha256)
      .not.toBe(first.deviceProjectionSha256);
  });
  test("a predecessor pin is quarantined rather than rewritten with new receipt metadata", async () => {
    const { serverOriginHash: _s, ...oldJob } = job();
    const oldEvidence = deliverySerializationEvidence(oldJob);
    const newEvidence = deliverySerializationEvidence(job());
    expect(newEvidence.deviceProjectionSha256).not.toBe(oldEvidence.deviceProjectionSha256);
    let quarantined = false;
    const db = { query: async (sql: string, values: unknown[]) => {
      if (sql.startsWith("UPDATE delivery_jobs SET canonical_intent_sha256")) {
        expect(values[3]).toBe(newEvidence.deviceProjectionSha256);
        return { rowCount: 0, rows: [] };
      }
      if (sql.includes("SELECT canonical_intent_sha256")) return { rowCount: 1, rows: [{
        canonical_intent_sha256: oldEvidence.canonicalIntentSha256,
        device_projection_sha256: oldEvidence.deviceProjectionSha256,
      }] };
      if (sql.includes("delivery_serialization_mismatch")) { quarantined = true; return { rowCount: 1, rows: [] }; }
      throw new Error("Unexpected SQL");
    } };
    await expect(pinDeliverySerializationEvidence(db as never, { id: "job", claim_token: "claim" }, newEvidence))
      .rejects.toBeInstanceOf(DeliverySerializationMismatchError);
    await quarantineDeliverySerializationMismatch(db as never, { id: "job", claim_token: "claim" });
    expect(quarantined).toBe(true);
  });
});
