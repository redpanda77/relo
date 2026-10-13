import { describe, expect, test } from "vitest";
import {
  futureActivityProviderTimestamp,
  shouldRetryMissingActivityToken,
} from "./delivery-lifecycle.js";

describe("delayed Live Activity token delivery", () => {
  const now = new Date("2026-08-07T00:00:00.000Z").getTime();

  test("retries only while the event is unexpired and attempts remain", () => {
    expect(shouldRetryMissingActivityToken({ attempt_count: 1, expires_at: new Date(now+1) },now)).toBe(true);
    expect(shouldRetryMissingActivityToken({ attempt_count: 1, expires_at: null },now)).toBe(true);
    expect(shouldRetryMissingActivityToken({ attempt_count: 1, expires_at: new Date(now) },now)).toBe(false);
    expect(shouldRetryMissingActivityToken({ attempt_count: 1, expires_at: new Date(now-1) },now)).toBe(false);
    expect(shouldRetryMissingActivityToken({ attempt_count: 120, expires_at: new Date(now+1) },now)).toBe(false);
  });

  test("defers only valid ActivityKit timestamps ahead of the server clock", () => {
    const nowSeconds = Math.floor(now/1_000);
    expect(futureActivityProviderTimestamp({ providerTimestamp: nowSeconds+1 },now)).toBe(nowSeconds+1);
    expect(futureActivityProviderTimestamp({ providerTimestamp: nowSeconds },now)).toBeNull();
    expect(futureActivityProviderTimestamp({ providerTimestamp: -1 },now)).toBeNull();
    expect(futureActivityProviderTimestamp({ providerTimestamp: 1.5 },now)).toBeNull();
    expect(futureActivityProviderTimestamp(null,now)).toBeNull();
  });
});
