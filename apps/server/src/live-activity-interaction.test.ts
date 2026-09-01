import { readFile } from "node:fs/promises";
import { describe, expect, test } from "vitest";
import {
  activityKitContentStateWireSchema,activityKitInteractionWireSchema,createLiveActivityCredential,
  projectLiveActivityCommand,verifyLiveActivityCredential,
} from "./live-activity-interaction.js";

describe("Live Activity response credentials", () => {
  const secret = "test-only-response-derivation-secret";
  const input = {
    interactionId: "11111111-1111-4111-8111-111111111111",
    notificationEventId: "22222222-2222-4222-8222-222222222222",
    deviceId: "33333333-3333-4333-8333-333333333333",
    principalId: "44444444-4444-4444-8444-444444444444",
    credentialVersion: 3,
    expiresAt: new Date("2030-01-01T00:00:00.000Z"),
  };

  test("binds a fixed-width credential to the request, event, device, and expiry", () => {
    const credential = createLiveActivityCredential(secret,input);
    expect(credential).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyLiveActivityCredential(secret,credential,input)).toBe(true);
    expect(verifyLiveActivityCredential(secret,credential,{ ...input, deviceId: "44444444-4444-4444-8444-444444444444" })).toBe(false);
    expect(verifyLiveActivityCredential(secret,credential,{ ...input, principalId: "55555555-5555-4555-8555-555555555555" })).toBe(false);
    expect(verifyLiveActivityCredential(secret,credential,{ ...input, credentialVersion: 4 })).toBe(false);
    expect(verifyLiveActivityCredential(secret,credential,{ ...input, expiresAt: new Date("2030-01-01T00:00:01.000Z") })).toBe(false);
  });

  test("projects the exact Swift-compatible JSON-primitive interaction fixture", async () => {
    const stored = { operation: "start", interaction: null };
    const projected = projectLiveActivityCommand(secret,{
      ...input, interactionKind: "approval", interactionState: "pending",
    },stored);
    expect(stored).toEqual({ operation: "start", interaction: null });
    const fixture = JSON.parse(await readFile(new URL(
      "../fixtures/activitykit-content-state-interaction.json",
      import.meta.url,
    ), "utf8"));
    expect(activityKitContentStateWireSchema.parse(fixture)).toEqual(fixture);
    const interaction = activityKitInteractionWireSchema.parse(projected.interaction);
    expect(interaction).toEqual(fixture.interaction);
    expect(Object.values(interaction).every((value) =>
      value === null || ["string", "number", "boolean"].includes(typeof value),
    )).toBe(true);
    expect(JSON.stringify(stored)).not.toContain(interaction.credential);
  });

  test("enforces the integer Unix-seconds interaction expiry boundary", () => {
    const base = {
      id: "int_11111111-1111-4111-8111-111111111111",
      notificationID: "ntf_22222222-2222-4222-8222-222222222222",
      targetDeviceID: "dev_33333333-3333-4333-8333-333333333333",
      accountID: "acc_44444444-4444-4444-8444-444444444444",
      kind: "approval", state: "pending",
      credential: "a".repeat(43),
    };
    expect(activityKitInteractionWireSchema.parse({ ...base, expiresAtUnixSeconds: 0 }).expiresAtUnixSeconds).toBe(0);
    expect(activityKitInteractionWireSchema.parse({
      ...base, expiresAtUnixSeconds: Number.MAX_SAFE_INTEGER,
    }).expiresAtUnixSeconds).toBe(Number.MAX_SAFE_INTEGER);
    for (const expiresAtUnixSeconds of [null, 1.5, "1893456000", -1, Number.MAX_SAFE_INTEGER + 1]) {
      expect(activityKitInteractionWireSchema.safeParse({ ...base, expiresAtUnixSeconds }).success).toBe(false);
    }
    expect(activityKitInteractionWireSchema.safeParse(base).success).toBe(false);
  });
});
