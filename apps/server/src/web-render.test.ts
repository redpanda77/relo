import { describe, expect, test } from "vitest";
import { authorizationRateLimitBuckets } from "./device-authorization.js";
import { safeNextPath } from "./web.js";
import { escapeHtml } from "./web/http.js";

describe("server-rendered HTML safety", () => {
  test("escapes hostile account names and email-like text before interpolation", () => {
    const hostileName = `<img src=x onerror="alert('name')"> & owner`;
    const hostileEmail = `owner+<svg/onload='alert(1)'>@example.test`;

    const rendered = `${escapeHtml(hostileName)}|${escapeHtml(hostileEmail)}`;

    expect(rendered).not.toContain("<img");
    expect(rendered).not.toContain("<svg");
    expect(rendered).not.toContain(`onerror="`);
    expect(rendered).toBe(
      "&lt;img src=x onerror=&quot;alert(&#39;name&#39;)&quot;&gt; &amp; owner|owner+&lt;svg/onload=&#39;alert(1)&#39;&gt;@example.test",
    );
  });

  test("accepts only same-origin relative post-login paths", () => {
    expect(safeNextPath("/cli/authorize?code=ABCD-EFGH")).toBe("/cli/authorize?code=ABCD-EFGH");
    for (const unsafe of ["https://evil.example/", "//evil.example/", "\\evil.example", "javascript:alert(1)", "/ok\nLocation: evil"]) {
      expect(safeNextPath(unsafe)).toBe("/dashboard");
    }
  });

  test("authorization rate limiting never trusts spoofable forwarding headers", () => {
    expect(authorizationRateLimitBuckets()).toEqual(["global"]);
    expect(authorizationRateLimitBuckets({ req: { header: () => "203.0.113.1" } } as any)).toEqual(["global"]);
    expect(authorizationRateLimitBuckets({
      env: { incoming: { socket: { remoteAddress: "192.0.2.25", remotePort: 51_234, remoteFamily: "IPv4" } } },
      req: { header: () => "198.51.100.2" },
    } as any)).toEqual(["global", "client:192.0.2.25"]);
  });
});
