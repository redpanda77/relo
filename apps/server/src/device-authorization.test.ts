import { describe, expect, test } from "vitest";
import { allowedCliScopes, limitedAcrossBuckets, normalizeUserCode } from "./device-authorization.js";
import { persistedMobileAuthorization } from "./mobile-auth.js";

describe("frozen authentication wire values", () => {
  test("matches the complete CLI allowlist including explicit non-default scopes", () => {
    expect([...allowedCliScopes].sort()).toEqual([
      "activities:read",
      "activities:write",
      "devices:read",
      "interactions:create",
      "interactions:read",
      "notifications:send",
      "services:read",
      "services:write",
      "sessions:write",
    ]);
  });

  test("normalizes only unambiguous eight-character human codes", () => {
    expect(normalizeUserCode("abcd efgh")).toBe("ABCD-EFGH");
    expect(normalizeUserCode("ABCD-EFGH")).toBe("ABCD-EFGH");
    expect(normalizeUserCode("ABCI-EFGH")).toBeUndefined();
    expect(normalizeUserCode("ABC-EFGH")).toBeUndefined();
  });

  test("maps the mobile pending wire state only at the legacy database boundary", () => {
    expect(persistedMobileAuthorization("pending")).toBe("unknown");
    expect(persistedMobileAuthorization("authorized")).toBe("authorized");
    expect(persistedMobileAuthorization("denied")).toBe("denied");
  });
});

describe("attempt limits", () => {
  test("a rejected attempt is not counted, so a full bucket empties a window after the last accepted one", () => {
    const store = new Map<string, number[]>();
    const buckets = ["global", "client:203.0.113.7"];
    for (let i = 0; i < 3; i += 1) expect(limitedAcrossBuckets(store, buckets, 3, 10, 60_000, 1_000)).toBe(false);
    // Someone keeps sending for the whole window: every attempt is refused and none is recorded.
    for (let at = 2_000; at <= 60_000; at += 500) expect(limitedAcrossBuckets(store, buckets, 3, 10, 60_000, at)).toBe(true);
    expect(store.get("global")).toHaveLength(3);
    expect(limitedAcrossBuckets(store, buckets, 3, 10, 60_000, 61_001)).toBe(false);
  });

  test("a client over its own limit does not use up the overall budget", () => {
    const store = new Map<string, number[]>();
    for (let i = 0; i < 5; i += 1) limitedAcrossBuckets(store, ["global", "client:a"], 2, 4, 60_000, 1_000);
    expect(store.get("global")).toHaveLength(2);
    expect(limitedAcrossBuckets(store, ["global", "client:b"], 2, 4, 60_000, 1_000)).toBe(false);
  });
});
