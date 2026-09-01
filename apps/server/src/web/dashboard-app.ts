import { readFile,readdir } from "node:fs/promises";
import { extname } from "node:path";
import type { LiveActivityPresentation } from "@relo/notification-contracts";
import { publicId } from "../ids.js";
import { presentationFromRow } from "../presentation-runtime.js";
import type { InboxDashboardBootstrap } from "./dashboard-inbox.js";
import type { DashboardAuthBootstrap } from "./dashboard-auth.js";
import type { ConnectionsDashboardBootstrap } from "./dashboard-connections.js";
import type { ActivityHistoryBootstrap } from "./dashboard-activity-history.js";
import type { SystemDashboardBootstrap } from "./dashboard-system.js";
import type { ProjectsDashboardBootstrap } from "./dashboard-projects.js";

const dashboardDistUrl = new URL("../../../dashboard/dist/",import.meta.url);
const dashboardAssetsUrl = new URL("assets/",dashboardDistUrl);

const assetContentTypes: Record<string,string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

type DashboardBuild = {
  indexHtml: string;
  assets: ReadonlyMap<string,URL>;
};

type ActivityOwnerKind =
  | "provider_run"
  | "service_run"
  | "manual_key"
  | "credential_session"
  | "dashboard_test";

let dashboardBuildPromise: Promise<DashboardBuild> | undefined;

async function dashboardBuild(): Promise<DashboardBuild> {
  dashboardBuildPromise ??= Promise.all([
    readFile(new URL("index.html",dashboardDistUrl),"utf8"),
    readdir(dashboardAssetsUrl,{ withFileTypes: true }),
  ]).then(([indexHtml,entries]) => ({
    indexHtml,
    assets: new Map(entries
      .filter((entry) => entry.isFile() && /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(entry.name))
      .map((entry) => [entry.name,new URL(entry.name,dashboardAssetsUrl)])),
  }));
  return dashboardBuildPromise;
}

export async function dashboardAppAssetResponse(assetName: string): Promise<Response | null> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(assetName)) return null;
  const build = await dashboardBuild();
  const assetUrl = build.assets.get(assetName);
  const contentType = assetContentTypes[extname(assetName).toLowerCase()];
  if (!assetUrl || !contentType) return null;
  const bytes = await readFile(assetUrl);
  return new Response(new Uint8Array(bytes),{ headers: {
    "cache-control": "public, max-age=31536000, immutable",
    "content-type": contentType,
    "x-content-type-options": "nosniff",
  } });
}

export type TestLabDashboardBootstrap = {
  version: 1;
  kind: "test-lab";
  route: {
    path: string;
    selectedActivityId: string | null;
    compose: boolean;
  };
  shell: {
    title: "Live Activity Test Lab";
    description: string;
    active: "testing";
    releaseIdentity: string;
    account: { id: string; initial: string; name: string; email: string };
  };
  summary: {
    total: number;
    active: number;
    awaitingProvider: number;
    awaitingPhone: number;
    awaitingResponse: number;
  };
  devices: Array<{
    id: string;
    name: string;
    model: string | null;
    appVersion: string | null;
    osVersion: string | null;
    notificationAuthorization: string;
    liveActivityAuthorization: string;
    lastSeenAt: string | null;
    ready: boolean;
  }>;
  runs: Array<{
    id: string;
    title: string;
    detail: string | null;
    style: string;
    status: string;
    state: string;
    progress: number | null;
    generation: number;
    sequence: number;
    presentation: LiveActivityPresentation | null;
    targetDeviceIds: string[];
    targetDeviceName: string | null;
    requesterLabel: string;
    ownerControlled: boolean;
    ownerKind: ActivityOwnerKind;
    evidence: {
      provider: {
        state: string | null;
        durableCommands: number;
        apnsJobs: number;
      };
      phone: { expected: number; confirmed: number };
      response: {
        kind: string | null;
        state: string | null;
        action: string | null;
        respondedAt: string | null;
      };
    };
    createdAt: string | null;
    updatedAt: string | null;
  }>;
  composer: {
    defaultPreset: "standard";
    presets: Array<{
      id: string;
      label: string;
      presentation: LiveActivityPresentation;
    }>;
  };
};

export type DashboardBootstrap =
  | DashboardAuthBootstrap
  | TestLabDashboardBootstrap
  | ActivityHistoryBootstrap
  | InboxDashboardBootstrap
  | ProjectsDashboardBootstrap
  | ConnectionsDashboardBootstrap
  | SystemDashboardBootstrap;

type TestLabDashboardBootstrapInput = {
  path: string;
  selectedActivityId: string | null;
  compose: boolean;
  releaseIdentity: string;
  account: { id: string; name: string; email: string };
  devices: Array<Record<string,any>>;
  activities: Array<Record<string,any>>;
  presets: Array<{ id: string; label: string; presentation: LiveActivityPresentation }>;
};

function isoDate(value: unknown): string | null {
  if (!value) return null;
  const date = new Date(String(value));
  return Number.isFinite(date.valueOf()) ? date.toISOString() : null;
}

function count(value: unknown): number {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : 0;
}

function activityOwnerKind(row: Record<string,any>): ActivityOwnerKind {
  if (row.lifecycle_provider && row.lifecycle_run_id) return "provider_run";
  if (row.requester_service_id) return "service_run";
  if (row.requester_credential_id && row.activity_key) return "manual_key";
  if (row.requester_credential_id) return "credential_session";
  return "dashboard_test";
}

export function createTestLabDashboardBootstrap(
  input: TestLabDashboardBootstrapInput,
): TestLabDashboardBootstrap {
  const devices = input.devices.map((row) => ({
    id: publicId("dev",String(row.id)),
    name: String(row.name ?? "Unnamed iPhone"),
    model: row.model == null ? null : String(row.model),
    appVersion: row.app_version == null ? null : String(row.app_version),
    osVersion: row.os_version == null ? null : String(row.os_version),
    notificationAuthorization: String(row.notification_authorization ?? "unknown"),
    liveActivityAuthorization: String(row.live_activity_authorization ?? "unknown"),
    lastSeenAt: isoDate(row.last_seen_at),
    ready: row.live_activity_authorization === "authorized"
      && ["authorized","provisional"].includes(String(row.notification_authorization)),
  }));
  const runs = input.activities.map((row) => {
    const deliverySummary = row.delivery_summary && typeof row.delivery_summary === "object"
      ? row.delivery_summary as Record<string,unknown> : {};
    const presentation = presentationFromRow(row);
    return {
      id: publicId("act",String(row.id)),
      title: String(row.title ?? "Untitled run"),
      detail: row.detail == null ? null : String(row.detail),
      style: String(row.style ?? "standard"),
      status: String(row.status ?? "Unknown"),
      state: String(row.state ?? "unknown"),
      progress: row.progress == null ? null : Number(row.progress),
      generation: Math.max(1,count(row.generation)),
      sequence: count(row.sequence),
      presentation,
      targetDeviceIds: Array.isArray(row.target_device_ids)
        ? row.target_device_ids.map((id: unknown) => publicId("dev",String(id))) : [],
      targetDeviceName: row.target_device_name == null ? null : String(row.target_device_name),
      requesterLabel: String(row.requester_label ?? "Dashboard"),
      ownerControlled: !row.requester_service_id && !row.requester_credential_id,
      ownerKind: activityOwnerKind(row),
      evidence: {
        provider: {
          state: row.delivery_state == null ? null : String(row.delivery_state),
          durableCommands: count(deliverySummary.durableCommands),
          apnsJobs: count(deliverySummary.apnsJobs),
        },
        phone: {
          expected: count(row.expected_receipts),
          confirmed: count(row.confirmed_receipts),
        },
        response: {
          kind: row.interaction_kind == null ? null : String(row.interaction_kind),
          state: row.interaction_state == null ? null : String(row.interaction_state),
          action: row.interaction_action == null ? null : String(row.interaction_action),
          respondedAt: isoDate(row.interaction_responded_at),
        },
      },
      createdAt: isoDate(row.created_at),
      updatedAt: isoDate(row.updated_at),
    };
  });
  return {
    version: 1,
    kind: "test-lab",
    route: {
      path: input.path,
      selectedActivityId: input.selectedActivityId,
      compose: input.compose,
    },
    shell: {
      title: "Live Activity Test Lab",
      description: "Compose one replaceable run for the selected iPhone, then inspect server, provider, phone, and response evidence.",
      active: "testing",
      releaseIdentity: input.releaseIdentity,
      account: {
        id: input.account.id,
        initial: input.account.name.trim().charAt(0).toUpperCase() || "K",
        name: input.account.name,
        email: input.account.email,
      },
    },
    summary: {
      total: runs.length,
      active: runs.filter((run) => run.state === "active").length,
      awaitingProvider: runs.filter((run) => run.state === "active" && !run.evidence.provider.state).length,
      awaitingPhone: runs.filter((run) => run.evidence.phone.expected > run.evidence.phone.confirmed).length,
      awaitingResponse: runs.filter((run) => run.evidence.response.state === "pending").length,
    },
    devices,
    runs,
    composer: {
      defaultPreset: "standard",
      presets: input.presets,
    },
  };
}

export function serializeDashboardBootstrap(value: DashboardBootstrap): string {
  return JSON.stringify(value).replace(/[<>&\u2028\u2029]/g,(character) => ({
    "<": "\\u003c",
    ">": "\\u003e",
    "&": "\\u0026",
    "\u2028": "\\u2028",
    "\u2029": "\\u2029",
  })[character]!);
}

export function renderDashboardAppDocumentFromIndex(
  indexHtml: string,
  bootstrap: DashboardBootstrap,
): string {
  if (!indexHtml.includes('<div id="root"></div>')) {
    throw new Error("Dashboard build is missing the React root");
  }
  const documentTitle = bootstrap.kind === "auth" ? bootstrap.title : bootstrap.shell.title;
  const title = `${documentTitle} · Relo`.replace(/[<>&]/g,(character) => ({
    "<": "&lt;",
    ">": "&gt;",
    "&": "&amp;",
  })[character]!);
  const loadingLabel = bootstrap.kind === "test-lab" ? "Loading Test Lab…"
    : bootstrap.kind === "auth" ? "Loading authentication…" : "Loading dashboard…";
  const root = `<div id="root" data-dashboard-entry="${bootstrap.kind}"><main aria-busy="true"><p role="status">${loadingLabel}</p></main></div><script id="relo-dashboard-bootstrap" type="application/json">${serializeDashboardBootstrap(bootstrap)}</script>`;
  return indexHtml
    .replace(/<link rel="icon"[^>]*>\s*/i,"")
    .replace(/<title>[^<]*<\/title>/i,`<title>${title}</title>`)
    .replace("<head>",'<head><meta name="referrer" content="no-referrer">')
    .replace("<body>",'<body><!-- IMPECCABLE-DIRECTION seed=relo-plum-coral | THESIS: An authored notification operations console that feels energetic and technically credible. | OWN-WORLD: Warm near-black plum surfaces, restrained coral actions, and notification-owned accents. | STORY: Orient, inspect, act, then verify across provider, phone, and response evidence. | FIRST VIEWPORT: Navigation, page purpose, system status, and primary work are immediately legible. | FORM: Real shadcn components, crisp borders, compact data, and mono technical identifiers. | FINISH: Every state is keyboard-safe and responsive; tonal gradients remain scoped to notification previews. -->')
    .replace('<div id="root"></div>',root);
}

export async function renderDashboardAppDocument(
  bootstrap: DashboardBootstrap,
): Promise<string> {
  return renderDashboardAppDocumentFromIndex((await dashboardBuild()).indexHtml,bootstrap);
}
