import { describe, expect, test } from "vitest";
import {
  createInteractionSchema,
  interactionSchema,
  liveActivityUpdateTokenSchema,
  notificationRequestSchema,
} from "./schemas.js";

describe("server notification appearance schemas", () => {
  test("accepts public HTTPS images and rejects local or private network images", () => {
    expect(notificationRequestSchema.safeParse({
      title: "Done", body: "Complete", sourceName: "Codex",
      imageUrl: "https://images.example.test/result.png",
    }).success).toBe(true);
    for (const imageUrl of [
      "http://images.example.test/result.png",
      "https://localhost/result.png",
      "https://127.0.0.1/result.png",
      "https://192.168.1.10/result.png",
      "https://buildserver/result.png",
      "https://assets.internal/result.png",
      "https://assets.home/result.png",
      "https://assets.lan/result.png",
      "https://localhost./result.png",
      "https://assets.internal./result.png",
    ]) {
      expect(notificationRequestSchema.safeParse({
        title: "Done", body: "Complete", sourceName: "Codex", imageUrl,
      }).success).toBe(false);
    }
    const trailingDot = "https://images.example.test./result.png";
    expect(notificationRequestSchema.parse({
      title: "Done", body: "Complete", sourceName: "Codex", imageUrl: trailingDot,
    }).imageUrl).toBe(trailingDot);
  });

  test("allows appearance fields only for ordinary interactions", () => {
    const fields = {
      imageUrl: "https://images.example.test/approval.png",
      destinationUrl: "https://example.test/approval/42",
    };
    expect(createInteractionSchema.safeParse({
      title: "Review", prompt: "Continue?", type: "approval", ...fields,
    }).success).toBe(true);
    expect(createInteractionSchema.safeParse({
      title: "Review", prompt: "Continue?", type: "approval",
      presentation: "live_activity", ...fields,
    }).success).toBe(false);
  });

  test("allows multiple explicit targets for interactive Live Activities", () => {
    expect(createInteractionSchema.safeParse({
      title: "Review", prompt: "Continue?", type: "approval", presentation: "live_activity",
      deviceIds: ["dev_11111111-1111-4111-8111-111111111111","dev_22222222-2222-4222-8222-222222222222"],
    }).success).toBe(true);
  });

  test("requires a positive activity generation for update-token registration", () => {
    const registration = {
      token: "a".repeat(64), nativeActivityId: "native-activity", environment: "sandbox", generation: 2,
    };
    expect(liveActivityUpdateTokenSchema.parse(registration).generation).toBe(2);
    for (const generation of [undefined,0,-1,1.5]) {
      expect(liveActivityUpdateTokenSchema.safeParse({ ...registration,generation }).success).toBe(false);
    }
  });

  test("bounds destination URLs consistently", () => {
    expect(createInteractionSchema.safeParse({
      title: "Review", prompt: "Continue?", type: "approval",
      destinationUrl: `https://example.test/${"x".repeat(2_100)}`,
    }).success).toBe(false);
    expect(notificationRequestSchema.safeParse({
      title: "Done", body: "Complete", sourceName: "Codex",
      destinationUrl: `https://example.test/${"x".repeat(2_100)}`,
    }).success).toBe(false);
  });

  test("accepts 4,000-character text answers and rejects longer or misplaced response text", () => {
    const answer = (response: string) => ({
      kind: "answer", value: { response }, idempotencyKey: "text-answer-boundary",
    });
    expect(interactionSchema.safeParse(answer("x".repeat(4_000))).success).toBe(true);
    expect(interactionSchema.safeParse(answer("x".repeat(4_001))).success).toBe(false);
    expect(interactionSchema.parse(answer("  accepted  ")).value.response).toBe("accepted");
    expect(interactionSchema.safeParse({
      kind: "approve", value: { response: "not allowed" }, idempotencyKey: "binary-with-text",
    }).success).toBe(false);
  });
});
