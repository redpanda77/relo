import { describe, expect, test } from "vitest";
import { credentialConversationId, eventConversationId, normalizedConversationTitle } from "./communication.js";

describe("notification communication metadata", () => {
  test("normalizes title whitespace and case for stable credential conversations", () => {
    const credentialId = "11111111-1111-4111-8111-111111111111";
    expect(normalizedConversationTitle("  Deploy   READY  ")).toBe("deploy ready");
    expect(credentialConversationId(credentialId,"Deploy ready"))
      .toBe(credentialConversationId(credentialId,"  DEPLOY   READY "));
  });

  test("separates conversations for different visible titles and credentials", () => {
    const first = "11111111-1111-4111-8111-111111111111";
    const second = "22222222-2222-4222-8222-222222222222";
    expect(credentialConversationId(first,"Build"))
      .not.toBe(credentialConversationId(first,"Deploy"));
    expect(credentialConversationId(first,"Build"))
      .not.toBe(credentialConversationId(second,"Build"));
  });

  test("gives interactions their own conversation before service or credential grouping", () => {
    const input = {
      eventId: "11111111-1111-4111-8111-111111111111",
      interactionId: "22222222-2222-4222-8222-222222222222",
      serviceId: "33333333-3333-4333-8333-333333333333",
      credentialId: "44444444-4444-4444-8444-444444444444",
      title: "Approval",
    };
    expect(eventConversationId(input)).toBe(`int_${input.interactionId}`);
    expect(eventConversationId({ ...input,interactionId: null })).toBe(`svc_${input.serviceId}`);
    expect(eventConversationId({ ...input,interactionId: null,serviceId: null }))
      .toBe(credentialConversationId(input.credentialId,input.title));
  });
});
