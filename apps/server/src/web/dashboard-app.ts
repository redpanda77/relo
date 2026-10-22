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
import type { DocsSiteBootstrap } from "@relo/notification-contracts/dashboard/docs";
import { cardEvidence } from "./run-evidence.js";
import { renderPageSkeleton } from "./dashboard-skeleton.js";
import { isoDate,type DashboardDocumentOptions } from "./http.js";
import type { z } from "zod";
import { testLabBootstrapSchema } from "@relo/notification-contracts/dashboard/test-lab";

const dashboardDistUrl = new URL("../../../dashboard/dist/",import.meta.url);
const dashboardAssetsUrl = new URL("assets/",dashboardDistUrl);

const assetContentTypes: Record<string,string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".m4a": "audio/mp4",
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
  /** Vite's manifest (empty without one): which chunks each page needs, for `pagePreloadTags`. */
  manifest: Record<string,ManifestChunk>;
};

type ManifestChunk = { file: string; css?: string[]; imports?: string[]; isEntry?: boolean };

const LANDING_CHUNK = "src/features/landing/landing-page.tsx";
const LANDING_SCENE_CHUNK = "src/features/landing/landing-scene.ts";
const MOTION_CHUNK = "src/lib/motion-features.ts";
const ORB_SCENE_CHUNK = "src/lib/orb-scene.ts";
const INBOX_CHUNK = "src/features/inbox/inbox-feature.tsx";

/** The lazy chunk each Dashboard page renders (`dashboard-page-loaders.ts`). */
const PAGE_CHUNKS: Record<string,string> = {
  "inbox-overview": INBOX_CHUNK,
  "notification-history": INBOX_CHUNK,
  "delivery-history": INBOX_CHUNK,
  "notification-detail": INBOX_CHUNK,
  connections: "src/features/connections/connections-feature.tsx",
  account: "src/features/account/account-page.tsx",
  "activity-history": "src/features/test-lab/activity-history-page.tsx",
  "test-lab": "src/features/test-lab/test-lab-page.tsx",
};

/** Which page a document is, for its preloads: the landing, a Dashboard page kind, or none. */
export type PreloadPage = "landing" | (string & {});

/**
 * Every page's code is a lazy chunk. Without help the browser finds it only after the entry has
 * run, then its CSS and imports, then the scene: a chain of round trips that a slow link turns into
 * seconds. Listing them in the document fetches them in parallel with the entry. The page's chunk
 * and the motion features come first; decoration (the WebGL scene: the landing's, or the orb on
 * Now) follows at low priority, behind everything the text needs.
 */
export function pagePreloadTags(manifest: Record<string,ManifestChunk>,page: PreloadPage): string {
  const main = page === "landing" ? LANDING_CHUNK : PAGE_CHUNKS[page];
  if (!main) return "";
  const scripts = new Set<string>();
  const styles = new Set<string>();
  const visit = (key: string) => {
    const chunk = manifest[key];
    if (!chunk || chunk.isEntry || scripts.has(chunk.file)) return;
    scripts.add(chunk.file);
    chunk.css?.forEach((file) => styles.add(file));
    chunk.imports?.forEach(visit);
  };
  visit(main);
  if (!scripts.size) return "";
  if (page !== "landing") visit(MOTION_CHUNK);
  const safe = (file: string) => /^assets\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(file);
  const tags = [
    ...[...styles].filter(safe).map((file) => `<link rel="stylesheet" crossorigin href="/${file}">`),
    ...[...scripts].filter(safe).map((file) => `<link rel="modulepreload" crossorigin href="/${file}">`),
  ];
  const sceneKey = page === "landing" ? LANDING_SCENE_CHUNK : page === "inbox-overview" ? ORB_SCENE_CHUNK : null;
  const scene = new Set<string>();
  const visitScene = (key: string) => {
    const chunk = manifest[key];
    if (!chunk || chunk.isEntry || scripts.has(chunk.file) || scene.has(chunk.file)) return;
    scene.add(chunk.file);
    chunk.imports?.forEach(visitScene);
  };
  if (sceneKey) visitScene(sceneKey);
  for (const file of scene) if (safe(file)) tags.push(`<link rel="modulepreload" crossorigin href="/${file}" fetchpriority="low">`);
  return tags.join("");
}

/** The landing's preloads (kept for callers that predate `pagePreloadTags`). */
export function landingPreloadTags(manifest: Record<string,ManifestChunk>): string {
  return pagePreloadTags(manifest,"landing");
}

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
    readFile(new URL(".vite/manifest.json",dashboardDistUrl),"utf8").then(JSON.parse).catch(() => ({})),
  ]).then(([indexHtml,entries,manifest]) => ({
    indexHtml,
    manifest: manifest as Record<string,ManifestChunk>,
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

export type TestLabDashboardBootstrap = z.input<typeof testLabBootstrapSchema>;

export type DashboardBootstrap =
  | DashboardAuthBootstrap
  | TestLabDashboardBootstrap
  | ActivityHistoryBootstrap
  | InboxDashboardBootstrap
  | ConnectionsDashboardBootstrap
  | SystemDashboardBootstrap
  | DocsSiteBootstrap;

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
        activityKit: cardEvidence(row.card_shown_at),
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

const LANDING_DESCRIPTION = "Live status from every agent, script and app you run, wherever it runs. One place, on your iPhone.";
const LANDING_META = `<meta name="description" content="${LANDING_DESCRIPTION}"><meta property="og:title" content="Relo · Every agent, one place"><meta property="og:description" content="${LANDING_DESCRIPTION}"><meta property="og:type" content="website">`;

const escapeText = (text: string) => text.replace(/[<>&"]/g,(character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;" })[character]!);

/**
 * `rootHtml` replaces the loading placeholder inside #root with markup a reader can use before (or
 * without) JavaScript: a docs page puts its whole article there. React replaces it when it starts.
 */
export function renderDashboardAppDocumentFromIndex(
  indexHtml: string,
  bootstrap: DashboardBootstrap,
  preload = "",
  options: { rootHtml?: string; now?: Date } & DashboardDocumentOptions = {},
): string {
  if (!indexHtml.includes('<div id="root"></div>')) {
    throw new Error("Dashboard build is missing the React root");
  }
  const documentTitle = bootstrap.kind === "auth"
    ? bootstrap.view === "landing" ? "Every agent, one place" : bootstrap.title
    : bootstrap.kind === "docs" ? bootstrap.page?.title ?? "Page not found"
    : bootstrap.shell.title;
  const title = escapeText(bootstrap.kind === "auth" && bootstrap.view === "landing"
    ? `Relo · ${documentTitle}` : bootstrap.kind === "docs" ? `${documentTitle} · Relo docs` : `${documentTitle} · Relo`);
  const loadingLabel = bootstrap.kind === "test-lab" ? "Loading Test Lab…"
    : bootstrap.kind === "auth" ? bootstrap.view === "landing" ? "Loading Relo…" : "Loading authentication…"
    : "Loading dashboard…";
  const landing = bootstrap.kind === "auth" && bootstrap.view === "landing";
  // A Dashboard page paints its own structure first (dashboard-skeleton.ts); sign-in keeps a status line.
  const skeleton = bootstrap.kind === "auth" || bootstrap.kind === "docs" ? null
    : renderPageSkeleton(bootstrap,{ now: options.now, path: bootstrap.route.path, sidebarFolded: options.sidebarFolded });
  const placeholder = options.rootHtml ?? skeleton ?? `<main aria-busy="true"><p role="status">${loadingLabel}</p></main>`;
  const root = `<div id="root" data-dashboard-entry="${bootstrap.kind}">${placeholder}</div><script id="relo-dashboard-bootstrap" type="application/json">${serializeDashboardBootstrap(bootstrap)}</script>`;
  return indexHtml
    .replace(/<link rel="icon"[^>]*>\s*/i,"")
    .replace(/<title>[^<]*<\/title>/i,`<title>${title}</title>`)
    .replace("<head>",`<head><meta name="referrer" content="no-referrer">${landing ? LANDING_META : ""}${bootstrap.kind === "docs" ? "" : preload}${bootstrap.kind === "docs" && bootstrap.page ? docsMeta(bootstrap.page.title,bootstrap.page.summary) : ""}`)
    .replace("<body>",'<body><!-- IMPECCABLE-DIRECTION seed=relo-plum-coral | THESIS: An authored notification operations console that feels energetic and technically credible. | OWN-WORLD: Warm near-black plum surfaces, restrained coral actions, and notification-owned accents. | STORY: Orient, inspect, act, then verify across provider, phone, and response evidence. | FIRST VIEWPORT: Navigation, page purpose, system status, and primary work are immediately legible. | FORM: Real shadcn components, crisp borders, compact data, and mono technical identifiers. | FINISH: Every state is keyboard-safe and responsive; tonal gradients remain scoped to notification previews. -->')
    .replace('<div id="root"></div>',() => root);
}

const docsMeta = (title: string,summary: string) =>
  `<meta name="description" content="${escapeText(summary)}"><meta property="og:title" content="${escapeText(title)} · Relo docs"><meta property="og:description" content="${escapeText(summary)}"><meta property="og:type" content="article">`;

export async function renderDashboardAppDocument(
  bootstrap: DashboardBootstrap,
  options: { rootHtml?: string } & DashboardDocumentOptions = {},
): Promise<string> {
  const build = await dashboardBuild();
  const page: PreloadPage | null = bootstrap.kind === "docs" ? null
    : bootstrap.kind === "auth" ? bootstrap.view === "landing" ? "landing" : null
    : bootstrap.kind;
  return renderDashboardAppDocumentFromIndex(build.indexHtml,bootstrap,page ? pagePreloadTags(build.manifest,page) : "",options);
}
