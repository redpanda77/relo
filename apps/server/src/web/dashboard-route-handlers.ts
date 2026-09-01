import type { LiveActivityPresentation } from "@relo/notification-contracts";
import type { Database } from "../db.js";
import { createDashboardActivityHistoryHandler } from "./dashboard-activity-history.js";
import type { DashboardBootstrap } from "./dashboard-app.js";
import { createDashboardAuthHandler } from "./dashboard-auth.js";
import { createDashboardConnectionsHandlers } from "./dashboard-connections.js";
import { createDashboardInboxHandlers } from "./dashboard-inbox.js";
import { createDashboardSystemHandlers } from "./dashboard-system.js";
import { createDashboardTestLabHandler } from "./dashboard-test-lab.js";

type DashboardRouteAccount = {
  principalId: string;
  accountId: string;
  user: { id: string; name: string; email: string };
};

type DashboardRouteDependencies = {
  db: Database;
  releaseIdentity: string;
  serverOrigin: string;
  getAccount(headers: Headers): Promise<DashboardRouteAccount | null>;
  renderDocument(bootstrap: DashboardBootstrap): Promise<string>;
  testLab: {
    presets: Array<{
      id: string;
      label: string;
      presentation: LiveActivityPresentation;
    }>;
  };
};

export function createDashboardRouteHandlers(
  dependencies: DashboardRouteDependencies,
) {
  const shared = {
    db: dependencies.db,
    getAccount: dependencies.getAccount,
    releaseIdentity: dependencies.releaseIdentity,
    renderDocument: dependencies.renderDocument,
  };
  return {
    auth: createDashboardAuthHandler({
      db: dependencies.db,
      getAccount: dependencies.getAccount,
      renderDocument: dependencies.renderDocument,
    }),
    inbox: createDashboardInboxHandlers(shared),
    connections: createDashboardConnectionsHandlers(shared),
    testLab: createDashboardTestLabHandler({
      ...shared,
      ...dependencies.testLab,
    }),
    activityHistory: createDashboardActivityHistoryHandler(shared),
    system: createDashboardSystemHandlers({
      ...shared,
      serverOrigin: dependencies.serverOrigin,
    }),
  };
}
