import { describe, expect, test } from "vitest";
import { createDashboardRouteHandlers } from "./dashboard-route-handlers.js";

describe("dashboard React route composition", () => {
  test("exposes one isolated handler for every capability route family", () => {
    const handlers = createDashboardRouteHandlers({
      db: {} as any,
      releaseIdentity: "test-release",
      serverOrigin: "https://relo.example",
      getAccount: async () => null,
      renderDocument: async () => "",
      testLab: { presets: [] },
    });

    expect(Object.keys(handlers).sort()).toEqual([
      "activityHistory",
      "auth",
      "connections",
      "inbox",
      "system",
      "testLab",
    ]);
    expect(Object.keys(handlers.inbox).sort()).toEqual([
      "delivery",
      "detail",
      "history",
      "overview",
    ]);
    expect(Object.keys(handlers.connections).sort()).toEqual([
      "overview",
    ]);
    expect(Object.keys(handlers.system).sort()).toEqual(["account", "docs"]);
  });
});
