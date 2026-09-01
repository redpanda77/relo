import { afterEach, describe, expect, test, vi } from "vitest";
import {
  ApnsPayloadTooLargeError, apnsCategory, apnsErrorResult, apnsPayload, liveActivityApnsPayload, type ApnsMessage,
} from "./apns.js";

afterEach(() => vi.useRealTimers());

function message(interactionKind?: ApnsMessage["interactionKind"]): ApnsMessage {
  return {
    token: "device-token",
    environment: "sandbox",
    title: "Action required",
    body: "Continue?",
    notificationId: "ntf_11111111-1111-4111-8111-111111111111",
    interactionKind,
  };
}

describe("APNs ordinary interaction categories", () => {
  test.each([
    ["approval", "RELO_APPROVAL"],
    ["yes_no", "RELO_YES_NO"],
    ["text", "RELO_TEXT"],
  ] as const)("maps server interaction kind %s to iOS category %s", (kind, expected) => {
    expect(apnsCategory(kind)).toBe(expected);
    expect((apnsPayload(message(kind)).aps as any).category).toBe(expected);
  });

  test("omits category for non-interactive notifications and ignores client category data", () => {
    const payload = apnsPayload({ ...message(), data: { category: "CLIENT_CONTROLLED" } });
    expect(payload.aps).not.toHaveProperty("category");
    expect(apnsCategory("CLIENT_CONTROLLED" as any)).toBeUndefined();
  });

  test("includes only a server-supplied nonnegative integer badge", () => {
    expect((apnsPayload({ ...message("approval"), badge: 3 }).aps as any).badge).toBe(3);
    expect(apnsPayload({ ...message(), badge: -1 }).aps).not.toHaveProperty("badge");
    expect(apnsPayload({ ...message(), badge: 1.5 }).aps).not.toHaveProperty("badge");
  });

  test("uses a custom-data allowlist that excludes credentials, tokens, secrets, and unknown fields", () => {
    const payload = apnsPayload({
      ...message("approval"),
      data: {
        interactionId: "int_abcdefgh",
        interactionType: "approval",
        privacy: "private",
        context: { computer: "Mac", unknown: "removed" },
        credential: "must-not-leave-server",
        nested: { responseToken: "also-secret", safe: "kept" },
        items: [{ apiSecret: "hidden", value: "visible" }],
      },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/credential|token|secret|must-not-leave-server|also-secret|hidden/i);
    expect(payload).toMatchObject({
      relo: {
        interactionId: "int_abcdefgh", interactionType: "approval", privacy: "private",
      },
    });
    expect((payload.relo as any)).not.toHaveProperty("context");
    expect((payload.relo as any)).not.toHaveProperty("nested");
    expect((payload.relo as any)).not.toHaveProperty("items");
  });

  test("masks private notification content before it leaves for APNs", () => {
    const payload = apnsPayload({
      ...message(),
      title: "Secret project name",
      body: "Raw command output must never appear here",
      imageUrl: "https://example.test/private.png",
      deepLink: "https://example.test/private-destination",
      data: { privacy: "private" },
    });

    expect((payload.aps as any).alert).toEqual({
      title: "Relo",
      body: "New private notification",
    });
    expect(payload.relo).toMatchObject({
      privacy: "private",
      imageUrl: null,
      deepLink: null,
    });
    expect(payload.relo).not.toHaveProperty("context");
    expect(JSON.stringify(payload)).not.toMatch(/Secret project name|Raw command output|private\.png|private-destination/);
  });

  test("preserves standard notification content", () => {
    const payload = apnsPayload({
      ...message(),
      sourceName: "Build Agent",
      conversationId: "svc_11111111-1111-4111-8111-111111111111",
      avatarUrl: "https://example.test/avatar.png",
      imageUrl: "https://example.test/public.png",
      deepLink: "https://example.test/destination",
      data: { privacy: "standard",context: {
        providerName: "Codex",
        computer: "Developer Mac",
        project: "Relo",
        threadName: "Notification policies",
        taskTitle: "Implement server resolution",
      } },
    });

    expect((payload.aps as any).alert).toEqual({ title: "Action required", body: "Continue?" });
    expect(payload.relo).toMatchObject({
      privacy: "standard",
      sourceName: "Build Agent",
      conversationId: "svc_11111111-1111-4111-8111-111111111111",
      avatarUrl: "https://example.test/avatar.png",
      imageUrl: "https://example.test/public.png",
      deepLink: "https://example.test/destination",
      context: {
        providerName: "Codex",
        computer: "Developer Mac",
        project: "Relo",
        threadName: "Notification policies",
        taskTitle: "Implement server resolution",
      },
    });
  });

  test("bounds communication metadata and removes its identifying fields in private mode", () => {
    const standard = apnsPayload({
      ...message(), sourceName: `Agent ${"x".repeat(100)}`, conversationId: "svc_stableopaque",
    });
    expect((standard.relo as any).sourceName).toHaveLength(80);
    expect((standard.relo as any).conversationId).toBe("svc_stableopaque");

    const privatePayload = apnsPayload({
      ...message(), sourceName: "Secret Agent", conversationId: "svc_secretproject",
      avatarUrl: "https://example.test/private-avatar.png", imageUrl: "https://example.test/private.png",
      data: { privacy: "private", context: {
        computer: "Secret Mac", project: "Secret Project", taskTitle: "Secret Task",
      } },
    });
    expect(privatePayload.relo).toMatchObject({ sourceName: "Relo", avatarUrl: null, imageUrl: null });
    expect(privatePayload.relo).not.toHaveProperty("conversationId");
    expect(privatePayload.relo).not.toHaveProperty("context");
    expect(JSON.stringify(privatePayload)).not.toMatch(
      /Secret Agent|secretproject|private-avatar|private\.png|Secret Mac|Secret Project|Secret Task/,
    );
  });

  test("accepts exactly 4096 bytes and rejects the next byte deterministically", () => {
    const base = message();
    const emptySize = Buffer.byteLength(JSON.stringify(apnsPayload({ ...base, body: "" })));
    const exactBody = "x".repeat(4_096-emptySize);
    expect(Buffer.byteLength(JSON.stringify(apnsPayload({ ...base, body: exactBody })))).toBe(4_096);
    expect(() => apnsPayload({ ...base, body: `${exactBody}x` })).toThrow(ApnsPayloadTooLargeError);
    try {
      apnsPayload({ ...base, body: `${exactBody}x` });
    } catch (error) {
      expect(apnsErrorResult(error)).toMatchObject({ kind: "rejected", code: "apns_payload_too_large" });
    }
  });
});

describe("APNs Live Activity payloads", () => {
  test("builds Apple's start envelope with Relo attributes and input push-token request", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
    const payload = liveActivityApnsPayload({
      token: "a".repeat(64),
      environment: "sandbox",
      operation: "start",
      command: {
        activityId: "act_123456789012",
        generation: 7,
        sourceName: "Codex",
        headline: "Build",
        detail: "Compiling",
        status: "Running",
        progress: 0.5,
        symbol: "build",
        accentColor: "#64D2FF",
        expiresAt: "2026-08-07T08:00:00.000Z",
        staleAt: "2026-08-07T04:00:00.000Z",
        primaryLabel: "Allow", secondaryLabel: "Reject",
        style: "standard",
        privacy: "standard",
        sequence: 0,
        interaction: null,
      },
    });
    expect(payload).toMatchObject({ aps: {
      event: "start",
      timestamp: 1_786_060_800,
      "attributes-type": "ReloActivityAttributes",
      "input-push-token": 1,
      attributes: { eventID: "act_123456789012", generation: 7, sourceName: "Codex", style: "standard" },
      "content-state": {
        generation: 7,
        headline: "Build", detail: "Compiling", status: "Running", progress: 0.5,
        sequence: 0, style: "standard", symbol: "build", accentColor: "#64D2FF",
        privacy: "standard", expiresAt: "2026-08-07T08:00:00.000Z",
        staleAt: "2026-08-07T04:00:00.000Z", primaryLabel: "Allow",
        secondaryLabel: "Reject", interaction: null,
      },
      "stale-date": 1_786_075_200,
    } });
  });

  test("private Live Activity pushes contain only generic display content", () => {
    const payload = liveActivityApnsPayload({
      token: "a".repeat(64),
      environment: "sandbox",
      operation: "start",
      command: {
        activityId: "act_123456789012",
        generation: 7,
        sourceName: "Secret project",
        headline: "Raw command",
        detail: "/absolute/private/path",
        status: "token=super-secret",
        progress: 0.8,
        style: "terminal",
        symbol: "code",
        accentColor: "#FF0000",
        privacyMode: "private",
        expiresAt: "2026-08-07T08:00:00.000Z", staleAt: "2026-08-07T04:00:00.000Z",
        primaryLabel: "Leaky", secondaryLabel: "Secret",
        interaction: { credential: "must-not-leak" },
      },
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toMatch(/Secret project|Raw command|absolute\/private|super-secret|must-not-leak|Leaky|#FF0000/);
    expect(payload).toMatchObject({ aps: {
      alert: { title: "Agent task started", body: "Open Relo to view progress." },
      attributes: { generation: 7, sourceName: "Relo", style: "standard" },
      "content-state": {
        generation: 7,
        headline: "Private activity", detail: null, progress: null,
        status: "Open Relo to view", style: "standard", symbol: "terminal",
        accentColor: "#5ED8B7", privacy: "private", primaryLabel: null,
        secondaryLabel: null, interaction: null,
      },
    } });
  });

  test("end pushes include final content and a bounded dismissal date", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-07T00:00:00.000Z"));
    const payload = liveActivityApnsPayload({
      token: "a".repeat(64), environment: "sandbox", operation: "end",
      command: { generation: 7, status: "Done", dismissAfterSeconds: 20_000 },
    });
    expect((payload.aps as any).event).toBe("end");
    expect((payload.aps as any)["dismissal-date"]).toBe(1_786_075_200);
  });

  test("rejects missing or non-positive Live Activity generations", () => {
    for (const generation of [undefined,0,-1,1.5]) {
      expect(() => liveActivityApnsPayload({
        token: "a".repeat(64), environment: "sandbox", operation: "update",
        command: { generation },
      })).toThrow("positive integer");
    }
  });
});
