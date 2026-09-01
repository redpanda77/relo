import { describe,expect,test } from "vitest";
import {
  apnsOperationalLog,
  emptyApnsWorkerCycle,
  observeApnsRuntimeResult,
  safeDiagnosticCode,
} from "./apns-observability.js";

describe("APNs operational observability", () => {
  test("counts provider outcomes without identifiers, payloads, or credentials", () => {
    const cycle = emptyApnsWorkerCycle();
    observeApnsRuntimeResult(cycle,{ kind: "accepted",providerMessageId: "provider-id" });
    observeApnsRuntimeResult(cycle,{ kind: "retry",code: "retry",message: "ignored" });
    observeApnsRuntimeResult(cycle,{ kind: "invalid_token",code: "BadDeviceToken",message: "ignored" });
    observeApnsRuntimeResult(cycle,{ kind: "unavailable",code: "missing",message: "ignored" });
    observeApnsRuntimeResult(cycle,{ kind: "reconcile",code: "ambiguous",message: "ignored" });
    observeApnsRuntimeResult(cycle,{ kind: "rejected",code: "rejected",message: "ignored" });
    expect(cycle).toMatchObject({
      acceptedByApns: 1,retryScheduled: 1,tokenInvalid: 1,recipientUnavailable: 1,
      reconciliationFenced: 1,rejected: 1,queueToFirstClaimMaxMs: 0,
    });
    const serialized = apnsOperationalLog("apns_worker_cycle",cycle);
    expect(serialized).not.toContain("provider-id");
    expect(serialized).not.toContain("BadDeviceToken");
  });

  test("allows bounded diagnostic codes and rejects content-bearing values", () => {
    expect(safeDiagnosticCode("BadDeviceToken")).toBe("BadDeviceToken");
    expect(safeDiagnosticCode("provider.dispatch_timeout")).toBe("provider.dispatch_timeout");
    expect(safeDiagnosticCode("token abc.def")).toBeNull();
    expect(safeDiagnosticCode("x".repeat(81))).toBeNull();
    expect(safeDiagnosticCode(null)).toBeNull();
  });
});
