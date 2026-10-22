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
  test("a choice push names the RELO_CHOICE category and carries its options for the phone's extension", () => {
    const options = [{ id: "ship",label: "Ship" },{ id: "wait",label: "Wait" },{ id: "rollback",label: "Roll back" }];
    const projection = deliveryProjection(job({
      interactionKind: "choice",interactionId: "int_22222222-2222-4222-8222-222222222222",
      payload: { privacy: "standard",context: { project: "Relo" },interactionOptions: options },
    }));
    expect(projection).toMatchObject({ category: "RELO_CHOICE",
      customData: { relo: { interactionType: "choice",interactionOptions: options } } });
    const binary = deliveryProjection(job({ interactionKind: "yes_no",interactionId: "int_22222222-2222-4222-8222-222222222222" }));
    expect(JSON.stringify(binary)).not.toContain("interactionOptions");
  });

  test("new device and computer notices name the RELO_DEVICE_ACCESS category", () => {
    for (const payload of [{ deviceApproval: { deviceId: "dev_11111111-1111-4111-8111-111111111111" } },
      { computerApproval: { clientId: "key_11111111-1111-4111-8111-111111111111" } }]) {
      expect(deliveryProjection(job({ deepLink: "relo://security/request/dev_1",payload: { privacy: "standard",...payload } })))
        .toMatchObject({ category: "RELO_DEVICE_ACCESS",customData: { relo: { deepLink: "relo://security/request/dev_1" } } });
    }
    expect(deliveryProjection(job())).not.toHaveProperty("category");
  });

  test("a browser link request names the RELO_BROWSER_LINK category", () => {
    expect(deliveryProjection(job({ deepLink: "relo://security/request/brw_1",
      payload: { privacy: "standard",browserLink: { browserId: "brw_11111111-1111-4111-8111-111111111111" } } })))
      .toMatchObject({ category: "RELO_BROWSER_LINK",customData: { relo: { deepLink: "relo://security/request/brw_1" } } });
  });

  test("standard alerts carry the account label in safe context", () => {
    const projection = deliveryProjection(job({
      payload: { privacy: "standard",context: { computer: "Mac",account: "work" } },
    }));
    expect(projection).toMatchObject({ customData: { relo: { context: { computer: "Mac",account: "work" } } } });
  });

  test("decision pushes retain their original action deadline and opaque recipient scope", () => {
    const input = job({
      interactionKind: "yes_no", interactionId: "int_22222222-2222-4222-8222-222222222222",
      expiresAt: new Date("2026-08-13T00:01:00Z"),
      ...{ deviceId: "dev_33333333-3333-4333-8333-333333333333",
        interactionExpiresAt: new Date("2026-08-13T00:15:00Z") },
      payload: { privacy: "private", context: { project: "PRIVATE-PROJECT" } },
    });
    const projection = deliveryProjection(input);
    expect(projection).toMatchObject({ customData: { relo: {
      accountId: input.accountId, deviceId: "dev_33333333-3333-4333-8333-333333333333",
      interactionId: input.interactionId, interactionType: "yes_no",
      interactionExpiresAt: "2026-08-13T00:15:00.000Z",
    } } });
    expect(JSON.stringify(projection)).not.toContain("PRIVATE-PROJECT");
  });

  test("a question answered in Relo carries no answer buttons on the notification", () => {
    const withButtons = deliveryProjection(job({ interactionKind: "approval",
      interactionId: "int_22222222-2222-4222-8222-222222222222" }));
    const inApp = deliveryProjection(job({ interactionKind: "approval",
      interactionId: "int_22222222-2222-4222-8222-222222222222", payload: { answerInApp: true } }));
    if (withButtons.kind !== "alert" || inApp.kind !== "alert") throw new Error("Expected ordinary projections");
    expect(withButtons.category).toBe("RELO_APPROVAL");
    expect(inApp.category).toBeUndefined();
  });

  test("interactive admission reserves recipient metadata before its device is known", () => {
    const admission = job({ interactionKind: "approval", interactionId: "int_22222222-2222-4222-8222-222222222222" });
    const actual = { ...admission, deviceId: "dev_33333333-3333-4333-8333-333333333333",
      interactionExpiresAt: new Date("2026-08-13T00:15:00Z") };
    const projection = deliveryProjection(actual);
    if (projection.kind !== "alert") throw new Error("Expected ordinary projection");
    expect(ordinaryDeliveryPayloadSize({ ...admission, badge: undefined })).toBeGreaterThanOrEqual(Buffer.byteLength(JSON.stringify({
      ...projection.customData, aps: { alert: projection.alert, sound: projection.sound,
        badge: Number.MAX_SAFE_INTEGER, "mutable-content": 1, category: projection.category,
        "thread-id": projection.threadId },
    })));
  });

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

  const card = (owner: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) => job({
    transport: "live_activity_update",
    activityCommand: {
      activityId: "act_22222222-2222-4222-8222-222222222222",operation: "update",
      generation: 1,sequence: 3,providerTimestamp: 1_786_579_200,privacy: "standard",
      headline: "Build",status: "Compiling",staleAt: "2026-08-13T04:00:00.000Z",relevanceScore: 0.99,priority: 10,
      ...(owner ? { owner } : {}),...extra,
    },
  } as never);

  test("update payload staleDate = evidence + T_fresh, not the producer's stale-after", () => {
    const projection = deliveryProjection(card({ state: "moving",needsYou: null,staleDate: "2026-08-13T00:20:00.000Z" }));
    expect(projection).toMatchObject({ kind: "activity",staleDate: Date.parse("2026-08-13T00:20:00.000Z") / 1_000 });
    expect(projection).toMatchObject({ contentState: { staleAt: Date.parse("2026-08-13T00:20:00.000Z") / 1_000 } });
  });

  test("progress update is priority 5, a question update priority 10", () => {
    expect(deliveryProjection(card({ state: "moving",needsYou: null,staleDate: "2026-08-13T00:20:00.000Z" })))
      .toMatchObject({ priority: 5,relevanceScore: 0.7 });
    expect(deliveryProjection(card({ state: "needs_you",needsYou: "question",staleDate: "2026-08-13T00:20:00.000Z" })))
      .toMatchObject({ priority: 10,relevanceScore: 1 });
    expect(deliveryProjection(card({ state: "stale",needsYou: null,staleDate: "2026-08-13T00:20:00.000Z",changed: true })))
      .toMatchObject({ priority: 10,relevanceScore: 0.3 });
  });

  test("content-state carries owner state, private cards included", () => {
    expect(deliveryProjection(card({ state: "working_quietly",needsYou: null,staleDate: "2026-08-13T00:20:00.000Z" })))
      .toMatchObject({ contentState: { owner: { state: "working_quietly",needsYou: null } } });
    expect(deliveryProjection(card({ state: "needs_you",needsYou: "permission",staleDate: "2026-08-13T00:20:00.000Z" },
      { privacy: "private" }))).toMatchObject({ contentState: { owner: { state: "needs_you",needsYou: "permission" } } });
  });

  test("end dismissal comes from the table: done 15 min, failed 60 min, dropped at once", () => {
    const end = (state: string) => deliveryProjection(job({
      transport: "live_activity_update",
      activityCommand: { activityId: "act_1",operation: "end",generation: 1,sequence: 4,providerTimestamp: 1_786_579_200,
        privacy: "standard",dismissAfterSeconds: 14_400,owner: { state,needsYou: null,staleDate: null } },
    } as never));
    expect(end("done")).toMatchObject({ dismissalDate: 1_786_579_200 + 900,priority: 10,relevanceScore: 0 });
    expect(end("failed")).toMatchObject({ dismissalDate: 1_786_579_200 + 3_600 });
    expect(end("dropped")).toMatchObject({ dismissalDate: 1_786_579_200 });
  });

  test("a question notice is time-sensitive, a notify is active", () => {
    expect(deliveryProjection(job())).toMatchObject({ interruptionLevel: "active" });
    expect(deliveryProjection(job({ interactionKind: "approval",interactionId: "int_22222222-2222-4222-8222-222222222222" })))
      .toMatchObject({ interruptionLevel: "time-sensitive" });
    expect(deliveryProjection(job({ payload: { privacy: "standard",answerInApp: true } })))
      .toMatchObject({ interruptionLevel: "time-sensitive" });
    expect(deliveryProjection(job({ payload: { privacy: "standard",deviceApproval: { deviceId: "dev_1" } } })))
      .toMatchObject({ interruptionLevel: "active" });
  });

  test("an alert push names Relo's cue for its moment in aps.sound (ADR 0013)", () => {
    const sound = (overrides: Partial<ApnsRuntimeJob>) => {
      const projection = deliveryProjection(job(overrides));
      if (projection.kind !== "alert") throw new Error("Expected ordinary projection");
      return projection.sound;
    };
    const outcome = (result: string) => ({ privacy: "standard",interruptionLevel: "passive",
      workOutcome: { workId: "wrk_1",round: 1,result } });
    expect(sound({ interactionKind: "approval",interactionId: "int_22222222-2222-4222-8222-222222222222" })).toBe("needs-you.caf");
    expect(sound({ payload: { privacy: "standard",answerInApp: true } })).toBe("needs-you.caf");
    expect(sound({ payload: { privacy: "standard",questionFallback: { activityId: "act_1" } } })).toBe("needs-you.caf");
    expect(sound({ payload: { privacy: "standard",browserLink: { browserId: "brw_1" } } })).toBe("needs-you.caf");
    expect(sound({ payload: { privacy: "standard",computerApproval: { clientId: "key_1" } } })).toBe("needs-you.caf");
    expect(sound({ payload: outcome("failed") })).toBe("failed.caf");
    expect(sound({ payload: outcome("finished") })).toBe("done.caf");
    expect(sound({ payload: outcome("delivered") })).toBe("done.caf");
    expect(sound({})).toBe("default");
  });

  test("a done outcome stays passive while it carries the done cue", () => {
    expect(deliveryProjection(job({ payload: { privacy: "standard",interruptionLevel: "passive",
      workOutcome: { workId: "wrk_1",round: 1,result: "finished" } } })))
      .toMatchObject({ sound: "done.caf",interruptionLevel: "passive" });
  });

  test("a Live Activity alert carries the card's cue in aps.alert.sound; silent states and progress carry none", () => {
    const alerted = (state: string) => deliveryProjection(card({ state,needsYou: null,staleDate: null },{ alertOwner: "apns" }));
    expect(alerted("needs_you")).toMatchObject({ alert: { sound: "needs-you.caf" } });
    expect(alerted("failed")).toMatchObject({ alert: { sound: "failed.caf" } });
    expect(alerted("done")).toMatchObject({ alert: { sound: "done.caf" } });
    expect(alerted("waiting_on_you")).toMatchObject({ alert: { sound: "your-turn.caf" } });
    expect(JSON.stringify((alerted("moving") as { alert: unknown }).alert)).not.toContain("sound");
    expect(deliveryProjection(card({ state: "needs_you",needsYou: null,staleDate: null }))).not.toHaveProperty("alert");
    const start = deliveryProjection(job({
      transport: "live_activity_start",
      activityCommand: { activityId: "act_1",generation: 1,sequence: 0,providerTimestamp: 1_786_579_200,privacy: "standard",
        headline: "Build",status: "Starting",owner: { state: "moving",needsYou: null,staleDate: null } },
    } as never));
    expect(JSON.stringify((start as { alert: unknown }).alert)).not.toContain("sound");
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
    const webhooks = ["index.ts","auth.ts","cards.ts","notices.ts","works.ts","admin.ts","schemas.ts"];
    const [app,...services] = await Promise.all([
      readFile(new URL("app.ts",import.meta.url),"utf8"),
      ...webhooks.map((file) => readFile(new URL(`webhooks/${file}`,import.meta.url),"utf8")),
    ]);
    expect(app).not.toContain('from "./apns.js"');
    for (const source of services) expect(source).not.toContain('from "../apns.js"');
  });
});
