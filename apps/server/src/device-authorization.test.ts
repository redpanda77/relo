import { describe, expect, test } from "vitest";
import { allowedCliScopes, normalizeUserCode } from "./device-authorization.js";
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
