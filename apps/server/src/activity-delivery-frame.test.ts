import { describe, expect, test } from "vitest";
import { activityProviderTimestamp } from "./activities.js";
import { nextActivityProviderTimestamp } from "./activity-delivery-frame.js";

describe("ActivityKit transport time", () => {
  test("thirty domain revisions do not manufacture twenty-nine seconds of future time", () => {
    const now = Date.parse("2026-09-30T12:00:00.100Z");
    const second = Math.floor(now/1_000);
    for (let sequence = 0; sequence < 30; sequence += 1) {
      expect(activityProviderTimestamp({ created_at: new Date(now),updated_at: new Date(now),sequence })).toBe(second);
      expect(nextActivityProviderTimestamp(null,now)).toEqual({ kind: "ready",timestamp: second });
    }
    expect(nextActivityProviderTimestamp(second,now)).toEqual({ kind: "wait",untilMs: (second+1)*1_000,reason: "next_second" });
    expect(nextActivityProviderTimestamp(second,(second+1)*1_000)).toEqual({ kind: "ready",timestamp: second+1 });
  });

  test("clock rollback preserves the last fence and reports degraded clock health", () => {
    const previous = 1_790_769_600;
    expect(nextActivityProviderTimestamp(previous,(previous-10)*1_000)).toEqual({
      kind: "wait",untilMs: (previous+1)*1_000,reason: "clock_rollback",
    });
  });

  test("invalid clock data cannot become a provider timestamp", () => {
    expect(() => nextActivityProviderTimestamp(null,NaN)).toThrow();
    expect(() => nextActivityProviderTimestamp(-1,Date.now())).toThrow();
  });
});
