import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import type { ApnsRuntimeJob } from "./apns-runtime.js";
import {
  deliveryProjection,
  deliverySerializationEvidence,
  DeliverySerializationValidationError,
  assertOrdinaryDeliveryIntentWithinBudget,
  ordinaryDeliveryPayloadSize,
} from "./delivery-serialization.js";

function job(overrides: Partial<ApnsRuntimeJob> = {}): ApnsRuntimeJob {
  return {
    id: "123e4567-e89b-42d3-a456-426614174000",
    claimToken: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    attemptCount: 1,
    providerAttemptsUsed: 0,
    providerRetryStartedAt: null,
    providerRetryAttemptCap: null,
    providerRetryHorizonAt: null,
    providerNextAttemptNotBefore: null,
    providerStatus: null,
    transport: "notification",
    createdAt: new Date("2026-08-13T00:00:00.000Z"),
    expiresAt: null,
    title: "Build complete",
    body: "The build succeeded",
    sourceName: "Codex",
    conversationId: "conversation-stable",
    avatarUrl: "https://example.test/avatar.png",
    imageUrl: "https://example.test/image.png",
    deepLink: "https://example.test/result",
    notificationId: "ntf_123e4567-e89b-42d3-a456-426614174000",
    accountId: "acc_11111111-1111-4111-8111-111111111111",
    interactionKind: null,
    interactionId: null,
    badge: 1,
    payload: { privacy: "standard",context: { project: "Relo",computer: "Mac" } },
    ...overrides,
  };
}

describe("current delivery serialization", () => {
  test("is deterministic across object key order and repeated evaluation", () => {
    const first = deliverySerializationEvidence(job());
    const reordered = deliverySerializationEvidence(job({
      payload: { context: { computer: "Mac",project: "Relo" },privacy: "standard" },
    }));
    expect(first).toEqual(reordered);
    expect(first.canonicalIntentSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(first.deviceProjectionSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  test("redacts private notification content and identity from the device projection", () => {
    const secret = "PROJECT-CODENAME-ULTRAVIOLET";
    const projection = deliveryProjection(job({
      title: secret,
      body: secret,
      sourceName: secret,
      conversationId: secret,
      avatarUrl: `https://example.test/${secret}`,
      imageUrl: `https://example.test/${secret}`,
      deepLink: `https://example.test/${secret}`,
      payload: { privacy: "private",context: { project: secret,threadName: secret } },
    }));
    expect(JSON.stringify(projection)).not.toContain(secret);
    expect(projection).toMatchObject({
      kind: "alert",
      alert: { title: "Relo",body: "New private notification" },
      customData: { relo: { privacy: "private",sourceName: "Relo" } },
    });
    const firstEvidence = deliverySerializationEvidence(job({
      title: secret,body: secret,sourceName: secret,conversationId: secret,
      payload: { privacy: "private",context: { project: secret } },
    }));
    const secondEvidence = deliverySerializationEvidence(job({
      title: "DIFFERENT-SECRET",body: "DIFFERENT-SECRET",sourceName: "DIFFERENT-SECRET",
      conversationId: "DIFFERENT-SECRET",
      payload: { privacy: "private",context: { project: "DIFFERENT-SECRET" } },
    }));
    expect(firstEvidence).toEqual(secondEvidence);
  });

  test("redacts private Live Activity semantic fields before provider serialization", () => {
    const secret = "PRIVATE-ACTIVITY-CONTENT";
    const projection = deliveryProjection(job({
      transport: "live_activity_start",
      payload: { privacy: "private" },
      activityCommand: {
        activityId: "activity-id",generation: 1,sequence: 0,providerTimestamp: 1_786_579_200,
        privacy: "private",headline: secret,status: secret,detail: secret,sourceName: secret,
        style: secret,symbol: secret,accentColor: secret,
      },
    }));
    expect(JSON.stringify(projection)).not.toContain(secret);
    expect(projection).toMatchObject({
      kind: "activity",operation: "start",
      contentState: { headline: "Private activity",status: "Open Relo to view",privacy: "private" },
      attributes: {
        sourceName: "Relo",style: "standard",
        accountID: "acc_11111111-1111-4111-8111-111111111111",
      },
    });
  });

  test("includes the account identity required by the iOS ActivityKit attributes contract", () => {
    const projection = deliveryProjection(job({
      transport: "live_activity_start",
      activityCommand: {
        activityId: "act_22222222-2222-4222-8222-222222222222",
        generation: 1,sequence: 0,providerTimestamp: 1_786_579_200,
        privacy: "standard",headline: "Build",status: "Starting",sourceName: "Codex",
        style: "standard",
      },
    }));
    expect(projection).toMatchObject({
      kind: "activity",
      attributes: { accountID: "acc_11111111-1111-4111-8111-111111111111" },
    });
    expect(() => deliveryProjection(job({
      accountId: "",
      transport: "live_activity_start",
      activityCommand: {
        activityId: "act_22222222-2222-4222-8222-222222222222",
        generation: 1,sequence: 0,providerTimestamp: 1_786_579_200,
      },
    }))).toThrow(DeliverySerializationValidationError);
  });

  test("accepts exactly 4096 UTF-8 bytes and rejects the next byte", () => {
    const input = {
      title: "Budget",body: "",sourceName: "Relo",conversationId: "budget",
      notificationId: "ntf_budget",payload: { privacy: "standard" },
    };
    const base = ordinaryDeliveryPayloadSize(input);
    const remaining = 4_096 - base;
    const unicodeCount = Math.floor(remaining / 4);
    const body = `${"🚀".repeat(unicodeCount)}${"a".repeat(remaining - unicodeCount * 4)}`;
    expect(ordinaryDeliveryPayloadSize({ ...input,body })).toBe(4_096);
    expect(() => assertOrdinaryDeliveryIntentWithinBudget({ ...input,body })).not.toThrow();
    expect(() => assertOrdinaryDeliveryIntentWithinBudget({ ...input,body: `${body}a` }))
      .toThrow("maximum is 4096 bytes");
  });

  test("keeps request runtimes off the legacy payload builder", async () => {
    const [app,services] = await Promise.all([
      readFile(new URL("app.ts",import.meta.url),"utf8"),
      readFile(new URL("services.ts",import.meta.url),"utf8"),
    ]);
    expect(app).not.toContain('from "./apns.js"');
    expect(services).not.toContain('from "./apns.js"');
  });
});
