import type { Handler } from "hono";
import type { LiveActivityPresentationPolicy } from "@relo/notification-contracts";
import type { Database } from "../db.js";
import { publicId } from "../ids.js";
import {
  effectivePresentationPolicy,
  parsePresentationPolicy,
} from "../presentation-policy.js";
import { accountOrRedirect,isoDate,pageNumber,secureHtml } from "./http.js";
import type { z } from "zod";
import { connectionsDashboardBootstrapSchema,connectionsOverviewSchema,connectionsShellSchema } from "@relo/notification-contracts/dashboard/connections";

const pageSize = 25;
/** One page shows every connection a single-owner server realistically has; larger totals are disclosed, never hidden. */
const overviewLimit = 200;

export type DashboardConnectionsShell = z.input<typeof connectionsShellSchema>;

export type DashboardConnectionsPagination = {
  page: number;
  pageSize: 25;
  total: number;
  pageCount: number;
  previousHref: string | null;
  nextHref: string | null;
};

type ConnectionsSummary = {
  services: number;
  phones: number;
  clients: number;
  pending: number;
  notifications: number;
  deliveries: number;
};

type ConnectionsBootstrapBase = {
  version: 1;
  route: { path: string; page: number };
  shell: DashboardConnectionsShell;
  summary: Pick<ConnectionsSummary, "services" | "phones" | "clients">;
  pagination: DashboardConnectionsPagination;
};

export type ConnectionsServicesBootstrap = ConnectionsBootstrapBase & {
  kind: "connections-services";
  services: Array<{
    id: string;
    title: string;
    prefix: string;
    imageUrl: string | null;
    destinationUrl: string | null;
    liveActivityPolicy: LiveActivityPresentationPolicy | null;
    effectiveLiveActivityPolicy: LiveActivityPresentationPolicy;
    liveActivityPolicySource: "service" | "account" | "system";
    createdAt: string | null;
  }>;
};

export type ConnectionsPhonesBootstrap = ConnectionsBootstrapBase & {
  kind: "connections-phones";
  phones: Array<{
    id: string;
    name: string;
    model: string;
    appVersion: string;
    osVersion: string;
    notificationAuthorization: string;
    liveActivityAuthorization: string;
    lastSeenAt: string | null;
  }>;
};

export type ConnectionsClientsBootstrap = ConnectionsBootstrapBase & {
  kind: "connections-clients";
  clients: Array<{
    id: string;
    label: string;
    prefix: string;
    scopes: string[];
    createdAt: string | null;
    expiresAt: string | null;
    lastUsedAt: string | null;
    liveActivityPolicy: LiveActivityPresentationPolicy | null;
    effectiveLiveActivityPolicy: LiveActivityPresentationPolicy;
    liveActivityPolicySource: "client" | "account" | "system";
    maxActiveCards: number | null;
  }>;
};


export type ConnectionsOverviewBootstrap = z.input<typeof connectionsOverviewSchema>;
export type ConnectionsDashboardBootstrap = z.input<typeof connectionsDashboardBootstrapSchema>;

export type ConnectionsDashboardAccount = {
  principalId: string;
  accountId: string;
  user: { name: string; email: string };
};

type ConnectionsHandlerDependencies = {
  db: Database;
  releaseIdentity: string;
  getAccount(headers: Headers): Promise<ConnectionsDashboardAccount | null>;
  renderDocument(bootstrap: ConnectionsDashboardBootstrap): Promise<string>;
};

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : 0;
}

function pagination(
  path: string,
  requestedPage: number,
  totalValue: unknown,
): DashboardConnectionsPagination {
  const total = number(totalValue);
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(requestedPage, pageCount);
  return {
    page,
    pageSize,
    total,
    pageCount,
    previousHref: page > 1 ? `${path}?page=${page - 1}` : null,
    nextHref: page < pageCount ? `${path}?page=${page + 1}` : null,
  };
}

async function loadSummary(
  db: Database,
  principalId: string,
): Promise<ConnectionsSummary> {
  const result = await db.query<ConnectionsSummary>(
    `SELECT
      (SELECT count(*)::int FROM webhook_services WHERE principal_id=$1 AND revoked_at IS NULL) AS services,
      (SELECT count(*)::int FROM devices WHERE principal_id=$1 AND revoked_at IS NULL) AS phones,
      (SELECT count(*)::int FROM principal_api_keys WHERE principal_id=$1 AND revoked_at IS NULL
        AND (expires_at IS NULL OR expires_at>now())) AS clients,
      (SELECT count(*)::int FROM interaction_requests WHERE principal_id=$1 AND state='pending'
        AND expires_at>now()) AS pending,
      (SELECT count(*)::int FROM notification_events WHERE principal_id=$1) AS notifications,
      (SELECT count(*)::int FROM delivery_jobs j JOIN notification_events e ON e.id=j.notification_event_id
        WHERE e.principal_id=$1) AS deliveries`,
    [principalId],
  );
  const row = result.rows[0];
  return {
    services: number(row?.services),
    phones: number(row?.phones),
    clients: number(row?.clients),
    pending: number(row?.pending),
    notifications: number(row?.notifications),
    deliveries: number(row?.deliveries),
  };
}

async function loadAccountPolicy(db: Database,principalId: string): Promise<unknown> {
  const result = await db.query<{ live_activity_policy: unknown }>(
    "SELECT live_activity_policy FROM owner_principals WHERE id=$1 AND disabled_at IS NULL",
    [principalId],
  );
  return result.rows[0]?.live_activity_policy ?? null;
}

function shell(input: {
  account: ConnectionsDashboardAccount;
  releaseIdentity: string;
  active: DashboardConnectionsShell["active"];
  title: string;
  description: string;
  summary: ConnectionsSummary;
}): DashboardConnectionsShell {
  return {
    title: input.title,
    description: input.description,
    active: input.active,
    releaseIdentity: input.releaseIdentity,
    account: {
      id: input.account.accountId,
      initial: input.account.user.name.trim().charAt(0).toUpperCase() || "K",
      name: input.account.user.name,
      email: input.account.user.email,
    },
    counts: {
      pending: input.summary.pending,
      notifications: input.summary.notifications,
      deliveries: input.summary.deliveries,
    },
  };
}

function common(input: {
  context: any;
  account: ConnectionsDashboardAccount;
  releaseIdentity: string;
  active: DashboardConnectionsShell["active"];
  title: string;
  description: string;
  summary: ConnectionsSummary;
  total: number;
}) {
  const pages = pagination(
    input.context.req.path,
    pageNumber(input.context.req.query("page")),
    input.total,
  );
  return {
    pages,
    base: {
      version: 1 as const,
      route: { path: input.context.req.path, page: pages.page },
      shell: shell(input),
      summary: {
        services: input.summary.services,
        phones: input.summary.phones,
        clients: input.summary.clients,
      },
      pagination: pages,
    },
  };
}

async function loadServices(db: Database, principalId: string, accountPolicy: unknown, limit: number) {
  const result = await db.query<any>(
    `SELECT id,title,secret_prefix,image_url,default_url,live_activity_policy,created_at
    FROM webhook_services WHERE principal_id=$1 AND revoked_at IS NULL
    ORDER BY created_at DESC,id DESC LIMIT $2`,
    [principalId, limit],
  );
  return result.rows.map((row): ConnectionsServicesBootstrap["services"][number] => {
    const resolved = effectivePresentationPolicy(row.live_activity_policy,accountPolicy,"service");
    return {
      id: publicId("svc", String(row.id)),
      title: String(row.title),
      prefix: String(row.secret_prefix),
      imageUrl: row.image_url == null ? null : String(row.image_url),
      destinationUrl: row.default_url == null ? null : String(row.default_url),
      liveActivityPolicy: parsePresentationPolicy(row.live_activity_policy),
      effectiveLiveActivityPolicy: resolved.policy,
      liveActivityPolicySource: resolved.source as "service" | "account" | "system",
      createdAt: isoDate(row.created_at),
    };
  });
}

async function loadPhones(db: Database, principalId: string, limit: number) {
  const result = await db.query<any>(
    `SELECT id,name,model,app_version,os_version,notification_authorization,
      live_activity_authorization,last_seen_at
    FROM devices WHERE principal_id=$1 AND revoked_at IS NULL
    ORDER BY last_seen_at DESC,id DESC LIMIT $2`,
    [principalId, limit],
  );
  return result.rows.map((row): ConnectionsPhonesBootstrap["phones"][number] => ({
    id: publicId("dev", String(row.id)),
    name: String(row.name),
    model: String(row.model ?? "Unknown model"),
    appVersion: String(row.app_version ?? "Unknown"),
    osVersion: String(row.os_version ?? "Unknown"),
    notificationAuthorization: String(row.notification_authorization ?? "unknown"),
    liveActivityAuthorization: String(row.live_activity_authorization ?? "unknown"),
    lastSeenAt: isoDate(row.last_seen_at),
  }));
}

async function loadClients(db: Database, principalId: string, accountPolicy: unknown, limit: number) {
  const result = await db.query<any>(
    `SELECT id,label,token_prefix,scopes,live_activity_policy,max_active_cards,created_at,expires_at,last_used_at
    FROM principal_api_keys WHERE principal_id=$1 AND revoked_at IS NULL
      AND (expires_at IS NULL OR expires_at>now())
    ORDER BY created_at DESC,id DESC LIMIT $2`,
    [principalId, limit],
  );
  return result.rows.map((row): ConnectionsClientsBootstrap["clients"][number] => {
    const resolved = effectivePresentationPolicy(row.live_activity_policy,accountPolicy,"client");
    return {
      id: publicId("key", String(row.id)),
      label: String(row.label),
      prefix: String(row.token_prefix),
      scopes: Array.isArray(row.scopes) ? row.scopes.map(String) : [],
      liveActivityPolicy: parsePresentationPolicy(row.live_activity_policy),
      effectiveLiveActivityPolicy: resolved.policy,
      liveActivityPolicySource: resolved.source as "client" | "account" | "system",
      maxActiveCards: row.max_active_cards == null ? null : Number(row.max_active_cards),
      createdAt: isoDate(row.created_at),
      expiresAt: isoDate(row.expires_at),
      lastUsedAt: isoDate(row.last_used_at),
    };
  });
}

export function createDashboardConnectionsHandlers(
  dependencies: ConnectionsHandlerDependencies,
): { overview: Handler } {
  const { db, getAccount, releaseIdentity, renderDocument } = dependencies;

  const overview: Handler = async (context) => {
    const account = await accountOrRedirect(context, getAccount);
    if (account instanceof Response) return account;
    const accountPolicy = await loadAccountPolicy(db,account.principalId);
    const summary = await loadSummary(db, account.principalId);
    const { base } = common({
      context, account, releaseIdentity, active: "connections",
      title: "Connections",
      description: "Phones, CLI clients, and webhooks connected to this server.",
      summary, total: 0,
    });
    const [phones, clients, services] = await Promise.all([
      loadPhones(db, account.principalId, overviewLimit),
      loadClients(db, account.principalId, accountPolicy, overviewLimit),
      loadServices(db, account.principalId, accountPolicy, overviewLimit),
    ]);
    const bootstrap: ConnectionsOverviewBootstrap = { ...base, kind: "connections", phones, clients, services };
    return secureHtml(context, await renderDocument(bootstrap));
  };

  return { overview };
}
