import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  createDashboardAuthHandler,
  type DashboardAuthBootstrap,
} from "./dashboard-auth.js";

function application(options: { claimed?: boolean; authenticated?: boolean } = {}) {
  const app = new Hono();
  app.get(
    "/",
    createDashboardAuthHandler({
      db: {
        async query() {
          return {
            rows: options.claimed === false ? [] : [{ exists: 1 }],
            rowCount: options.claimed === false ? 0 : 1,
          };
        },
      } as any,
      getAccount: async () => (options.authenticated ? {} : null),
      renderDocument: async (bootstrap) => JSON.stringify(bootstrap),
    }),
  );
  return app;
}

describe("React dashboard authentication handler", () => {
  test("redirects an authenticated owner to the dashboard", async () => {
    const response = await application({ authenticated: true }).request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
  });

  test("renders sign in and preserves a safe dashboard return path", async () => {
    const response = await application().request(
      "/?next=%2Fdashboard%2Ftesting",
    );
    expect(response.status).toBe(200);
    const result = JSON.parse(await response.text()) as DashboardAuthBootstrap;
    expect(result).toMatchObject({
      kind: "auth",
      mode: "sign-in",
      route: { nextPath: "/dashboard/testing" },
    });
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
  });

  test("renders first-owner creation and rejects external return paths", async () => {
    const response = await application({ claimed: false }).request(
      "/?next=https%3A%2F%2Fevil.example",
    );
    const result = JSON.parse(await response.text()) as DashboardAuthBootstrap;
    expect(result).toMatchObject({
      mode: "sign-up",
      route: { nextPath: "/dashboard" },
    });
  });
});
