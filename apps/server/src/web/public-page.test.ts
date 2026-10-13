import { describe, expect, it } from "vitest";

import { publicErrorPage, wantsHtmlPage } from "./public-page.js";

describe("public pages", () => {
  it("serves branded pages only to browsers, never to API, webhook or health clients", () => {
    expect(wantsHtmlPage("/dashboard/missing", "text/html,application/xhtml+xml")).toBe(true);
    expect(wantsHtmlPage("/dashboard/missing", "application/json")).toBe(false);
    expect(wantsHtmlPage("/dashboard/missing", undefined)).toBe(false);
    for (const path of ["/api/inbox", "/hooks/secret", "/health/live", "/api"]) {
      expect(wantsHtmlPage(path, "text/html")).toBe(false);
    }
  });

  it("renders a scriptless page that says what happened and offers a way back", () => {
    for (const status of [404, 500] as const) {
      const html = publicErrorPage(status);
      expect(html).not.toContain("<script");
      expect(html).toContain('href="/dashboard"');
      expect(html).toContain(String(status));
    }
    expect(publicErrorPage(404)).toContain("This page isn't here");
    expect(publicErrorPage(500)).toContain("Relo couldn't load this page");
  });
});
