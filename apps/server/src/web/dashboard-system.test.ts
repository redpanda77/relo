import { Hono } from "hono";
import { describe, expect, test, vi } from "vitest";
import {
  createDashboardSystemHandlers,
  type SystemDashboardBootstrap,
} from "./dashboard-system.js";

function fixture(options: { authenticated?: boolean; identity?: boolean } = {}) {
  const renderDocument = vi.fn(async (bootstrap: SystemDashboardBootstrap) =>
    JSON.stringify(bootstrap),
  );
  // This owner is not the server admin, so the account page carries no server section.
  const query = vi.fn(async (sql: string) => sql.includes("server_admin") ? { rows: [],rowCount: 0 } : {
    rows: options.identity === false ? [] : [{ provider: "better-auth" }],
    rowCount: options.identity === false ? 0 : 1,
  });
  const handlers = createDashboardSystemHandlers({
    db: { query } as any,
    releaseIdentity: "test-release",
    serverOrigin: "https://relo.example",
    getAccount: async () =>
      options.authenticated === false
        ? null
        : {
            principalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            accountId: "acc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            user: {
              id: "owner-user",
              name: "Relo Owner",
              email: "owner@example.test",
            },
          },
    renderDocument,
  });
  const app = new Hono();
  app.get("/dashboard/account", handlers.account);
  app.get("/dashboard/docs", handlers.docs);
  return { app, query, renderDocument };
}

describe("dashboard system handlers", () => {
  test("redirects unauthenticated system routes without rendering data", async () => {
    const { app, query, renderDocument } = fixture({ authenticated: false });
    for (const path of ["/dashboard/account", "/dashboard/docs"]) {
      const response = await app.request(path);
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe(
        `/?next=${encodeURIComponent(path)}`,
      );
    }
    expect(query).not.toHaveBeenCalled();
    expect(renderDocument).not.toHaveBeenCalled();
  });

  test("scopes account identity data and emits a secure typed bootstrap", async () => {
    const { app, query } = fixture();
    const response = await app.request("/dashboard/account");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("content-security-policy")).toContain(
      "default-src 'self'",
    );
    expect(response.headers.get("content-security-policy")).toContain(
      "frame-ancestors 'none'",
    );
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining("principal_id=$1"),
      ["aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "owner-user"],
    );
    expect(await response.json()).toMatchObject({
      server: null,
      kind: "account",
      route: { path: "/dashboard/account" },
      shell: { active: "account", releaseIdentity: "test-release" },
      account: {
        id: "acc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        name: "Relo Owner",
        email: "owner@example.test",
        serverOrigin: "https://relo.example",
        authentication: "Better Auth email/password session",
        liveActivityPolicySource: "system",
        liveActivityPolicy: {
          preset: "automatic",
          colorStrategy: "thread",
        },
      },
    });
  });

  test("fails closed when the scoped account identity is unavailable", async () => {
    const { app } = fixture({ identity: false });
    expect((await app.request("/dashboard/account")).status).toBe(404);
  });

  test("returns structured documentation and stable machine links", async () => {
    const { app, query } = fixture();
    const response = await app.request("/dashboard/docs");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const bootstrap = (await response.json()) as SystemDashboardBootstrap;
    expect(bootstrap.kind).toBe("docs");
    if (bootstrap.kind !== "docs") throw new Error("Expected docs bootstrap");
    expect(bootstrap.sections.map((section) => section.title)).toEqual([
      "Send notifications",
      "Authorize agents and the CLI",
      "Coordinate Live Activities",
      "Operate safely",
    ]);
    expect(bootstrap.machineLinks).toEqual([
      { label: "/docs.md", href: "/docs.md" },
      { label: "/agents.md", href: "/agents.md" },
      { label: "/llms.txt", href: "/llms.txt" },
    ]);
    expect(JSON.stringify(bootstrap)).not.toContain("<section");
    expect(query).not.toHaveBeenCalled();
  });
});
