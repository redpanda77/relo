import { Hono } from "hono";
import { describe, expect, test } from "vitest";
import {
  createDashboardAuthHandler,
  type DashboardAuthBootstrap,
} from "./dashboard-auth.js";

function application(options: { claimed?: boolean; authenticated?: boolean } = {}) {
  const app = new Hono();
  const handler = createDashboardAuthHandler({
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
    });
  app.get("/", handler);
  app.get("/sign-in", handler);
  return app;
}

describe("React dashboard authentication handler", () => {
  test("redirects an authenticated owner to the dashboard", async () => {
    const response = await application({ authenticated: true }).request("/");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("/dashboard");
  });

  test("shows a signed-out visitor to a claimed server the landing page", async () => {
    const response = await application().request("/");
    const result = JSON.parse(await response.text()) as DashboardAuthBootstrap;
    expect(result).toMatchObject({ view: "landing", route: { path: "/", nextPath: "/dashboard" } });
  });

  test("goes straight to the form for a return path or an unclaimed server", async () => {
    const withNext = JSON.parse(await (await application().request("/?next=%2Fdashboard")).text());
    expect(withNext).toMatchObject({ view: "form", route: { path: "/" } });
    const unclaimed = JSON.parse(await (await application({ claimed: false }).request("/")).text());
    expect(unclaimed).toMatchObject({ view: "form", mode: "sign-up" });
    const signIn = JSON.parse(await (await application().request("/sign-in")).text());
    expect(signIn).toMatchObject({ view: "form", mode: "sign-in", route: { path: "/sign-in" } });
  });

  test("renders sign in and preserves a safe dashboard return path", async () => {
    const response = await application().request(
      "/sign-in?next=%2Fdashboard%2Ftesting",
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
      "/sign-in?next=https%3A%2F%2Fevil.example",
    );
    const result = JSON.parse(await response.text()) as DashboardAuthBootstrap;
    expect(result).toMatchObject({
      mode: "sign-up",
      route: { nextPath: "/dashboard" },
    });
  });
});
