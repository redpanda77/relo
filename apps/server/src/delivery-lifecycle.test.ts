import { describe, expect, test } from "vitest";
import {
  DELIVERY_JOB_TTL_SECONDS,
  TERMINAL_DELIVERY_JOB_TTL_SECONDS,
  cancelUndeliverableDeliveryJobs,
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

test("keeps terminal commands reconcilable for one hour while ordinary jobs expire after five minutes", async () => {
  const statements: Array<{ text: string; values?: unknown[] }> = [];
  const db = {
    async query(text: string,values?: unknown[]) {
      statements.push({ text,values });
      return { rowCount: 7,rows: [] };
    },
  };

  await expect(cancelUndeliverableDeliveryJobs(db as never)).resolves.toBe(7);
  expect(statements).toHaveLength(1);
  expect(statements[0]?.values).toEqual([300,3600]);
  expect(DELIVERY_JOB_TTL_SECONDS).toBe(300);
  expect(TERMINAL_DELIVERY_JOB_TTL_SECONDS).toBe(3600);
  expect(statements[0]?.text).toContain("j.state IN ('pending','retry')");
  expect(statements[0]?.text).toContain("e.payload#>>'{liveActivity,operation}'='end'");
  expect(statements[0]?.text).toContain("$2*interval '1 second'");
  expect(statements[0]?.text).toContain("delivery_deadline_exceeded");
  expect(statements[0]?.text).not.toContain("DELETE FROM delivery_jobs");
});
