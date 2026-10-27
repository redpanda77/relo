/**
 * The page the server paints before any script runs: the Dashboard's own structure (sidebar or
 * tab bar, the page frame, the real title) in the class names React renders, so its first commit
 * replaces this markup at the same geometry. On Now it is the deck itself: the core painted in
 * today's colours (`orb-palette`, the same colours React computes) and the four readouts with the
 * server's real numbers; only the body is placeholder rows.
 *
 * Loading signals are CSS-only (no inline script under the CSP) and late: the core breathes and
 * the rows shimmer after 400 ms, "Starting Relo" appears after 1 s, and after 8 s an honest
 * "Taking longer than usual · Reload". The design tokens and the delayed reveals live in the
 * Dashboard stylesheet (`src/styles/loading.css`); the inline <style> holds only what makes the
 * placeholder read as a page while that stylesheet is still on its way.
 *
 * Self-contained by design (types are structural, imports are only the shared contracts): the
 * Dashboard's class-parity test renders this module next to React's components.
 */
import { deckBasis, deckColorState, deckColors, deckReadings, type DeckBasisSummary, type DeckNotification } from "@relo/notification-contracts";

export type SkeletonKind = "now" | "list" | "detail";

/** The bootstrap fields the skeleton reads (any Dashboard bootstrap satisfies it structurally). */
export type SkeletonBootstrap = {
  kind: string;
  shell?: { title?: string; active?: string; counts?: { pending?: number } | undefined } | undefined;
  route?: { path?: string; backHref?: string | undefined; selectedProjectId?: string | null | undefined } | undefined;
  approvalRequests?: readonly unknown[] | undefined;
  recentNotifications?: readonly DeckNotification[] | undefined;
  now?: (Partial<DeckBasisSummary> & {
    needsYou: readonly unknown[];
    running: readonly { owner: { state: string } }[];
    waitingOnYou?: readonly unknown[];
    recent?: readonly unknown[];
  }) | null | undefined;
};

/** Which skeleton a page wears: Now's deck, a detail page's trail, or a titled list. */
export function skeletonKindFor(kind: string): SkeletonKind | null {
  if (kind === "auth" || kind === "docs") return null;
  if (kind === "inbox-overview") return "now";
  if (kind === "notification-detail") return "detail";
  return "list";
}

const escapeHtml = (text: string) => text.replace(/[<>&"']/g, (character) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&#39;" })[character]!);

const ICON_PATHS: Record<string, string> = {
  now: '<path d="M16.247 7.761a6 6 0 0 1 0 8.478"/><path d="M19.075 4.933a10 10 0 0 1 0 14.134"/><path d="M4.925 19.067a10 10 0 0 1 0-14.134"/><path d="M7.753 16.239a6 6 0 0 1 0-8.478"/><circle cx="12" cy="12" r="2"/>',
  history: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/><path d="M12 7v5l4 2"/>',
  connections: '<path d="M17 19a1 1 0 0 1-1-1v-2a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2a1 1 0 0 1-1 1z"/><path d="M17 21v-2"/><path d="M19 14V6.5a1 1 0 0 0-7 0v11a1 1 0 0 1-7 0V10"/><path d="M21 21v-2"/><path d="M3 5V3"/><path d="M4 10a2 2 0 0 1-2-2V6a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2a2 2 0 0 1-2 2z"/><path d="M7 5V3"/>',
  testing: '<path d="M14 2v6a2 2 0 0 0 .245.96l5.51 10.08A2 2 0 0 1 18 22H6a2 2 0 0 1-1.755-2.96l5.51-10.08A2 2 0 0 0 10 8V2"/><path d="M6.453 15h11.094"/><path d="M8.5 2h7"/>',
  account: '<circle cx="12" cy="8" r="5"/><path d="M20 21a8 8 0 0 0-16 0"/>',
  docs: '<path d="M12 5v16"/><path d="M20.001 19A2 2 0 0022 17V5a2 2 0 00-1.999-2L16 3.002A5 5 0 0012 5a5 5 0 00-4-2H4a2 2 0 00-2 2v12a2 2 0 001.999 2H8a5 5 0 014 2 5 5 0 014-2z"/>',
  more: '<path d="M4 5h16"/><path d="M4 12h16"/><path d="M4 19h16"/>',
};
const icon = (name: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name]}</svg>`;

type NavEntry = { id: string; label: string; href: string; sections: string[] };
const NAV: NavEntry[] = [
  { id: "now", label: "Now", href: "/dashboard", sections: ["inbox"] },
  { id: "history", label: "History", href: "/dashboard/inbox/notifications", sections: ["inbox-notifications", "inbox-delivery"] },
  { id: "connections", label: "Connections", href: "/dashboard/connections", sections: ["connections", "connections-phones", "connections-clients"] },
];
/** As the Dashboard's sidebar (dashboard-shell.tsx): Test Lab sits with the settings. */
const SETTINGS: NavEntry[] = [
  { id: "account", label: "Account", href: "/dashboard/account", sections: ["account"] },
  { id: "testing", label: "Test Lab", href: "/dashboard/testing", sections: ["testing"] },
  { id: "docs", label: "Documentation", href: "/docs", sections: [] },
];

/** Links are real (they work before React), but the frame is decorative to assistive technology until React's own navigation lands. */
function navLink(entry: NavEntry, active: string, pending: number) {
  const current = entry.sections.includes(active);
  const badge = entry.id === "now" && pending > 0 ? `<span class="loading-nav-badge">${pending > 9 ? "9+" : pending}</span>` : "";
  return `<a class="loading-nav-link" href="${entry.href}" tabindex="-1"${current ? ' data-current="true"' : ""}>${icon(entry.id)}<span class="loading-nav-label">${entry.label}</span>${badge}</a>`;
}

/** Folded (the owner's `sidebar_state=false`), the sidebar starts on the icon rail at every width; tablets always do (loading.css). */
function sidebar(active: string, pending: number, folded: boolean) {
  return `<aside class="loading-sidebar"${folded ? ' data-folded="true"' : ""} aria-hidden="true"><div class="loading-sidebar-glass">`
    + `<div class="loading-sidebar-brand"><span class="brand-orb loading-sidebar-orb"></span><span class="wordmark loading-wordmark">relo</span></div>`
    + `<nav class="loading-nav">${NAV.map((entry) => navLink(entry, active, pending)).join("")}</nav>`
    + `<p class="micro loading-nav-section">Settings</p>`
    + `<nav class="loading-nav">${SETTINGS.map((entry) => navLink(entry, active, 0)).join("")}</nav>`
    + `</div></aside>`;
}

function tabBar(active: string, pending: number) {
  const tab = (entry: NavEntry) => {
    const current = entry.sections.includes(active);
    const badge = entry.id === "now" && pending > 0 ? `<span class="tab-badge">${pending > 9 ? "9+" : pending}</span>` : "";
    return `<a href="${entry.href}" tabindex="-1"${current ? ' data-active="true"' : ""}><span class="tab-icon">${current ? '<span class="tab-pill"></span>' : ""}${icon(entry.id)}${badge}</span><span class="tab-label">${entry.label}</span></a>`;
  };
  return `<nav class="tab-bar" aria-hidden="true">${NAV.slice(0, 4).map(tab).join("")}<a tabindex="-1"><span class="tab-icon">${icon("more")}</span><span class="tab-label">More</span></a></nav>`;
}

/** Placeholder rows: the shape of a frosted list (the rounded glass Now's rows wear), `count` long. */
function rows(count: number) {
  if (count <= 0) return "";
  const row = '<div class="loading-row"><div class="skeleton loading-row-tile"></div><div class="loading-row-lines"><div class="skeleton loading-line" style="width:40%"></div><div class="skeleton loading-line loading-line-sm" style="width:62%"></div></div></div>';
  return `<div class="glass loading-list" data-skeleton-rows>${row.repeat(count)}</div>`;
}

/** The words under the core: "Starting Relo" after 1 s, then "Taking longer than usual · Reload" after 8 s. */
function statusWords(path: string) {
  return `<p class="micro loading-words"><span class="loading-words-start" aria-hidden="true">Starting Relo</span>`
    + `<span class="loading-words-slow">Taking longer than usual · <a href="${escapeHtml(path)}">Reload</a></span></p>`;
}

/**
 * The header's look per state, as the Dashboard derives it (`lib/now-header.ts` HEADER_LOOK; its
 * parity test pins the two). The first frame knows needs you, your turn, running, quiet and clear:
 * offline and connecting are the browser's to know.
 */
type HeaderState = "needs" | "turn" | "running" | "quiet" | "clear";
const HEADER_LOOK: Record<HeaderState, { accent: string; ramp: string; rgb: string; alpha: [number, number, number]; period: string; blobs: [string, string, string]; blobAlpha: number; glow: string }> = {
  needs: { accent: "#FF8A3D", ramp: "#FF6B57", rgb: "255 138 61", alpha: [0.4, 0.17, 0.035], period: "1.8s", blobs: ["#FF7A66", "#FF8A3D", "#8B7CFF"], blobAlpha: 0.2, glow: "1.8s" },
  turn: { accent: "#FBBF24", ramp: "#F59E0B", rgb: "251 191 36", alpha: [0.3, 0.12, 0.03], period: "2.1s", blobs: ["#FBBF24", "#FF7A66", "#8B7CFF"], blobAlpha: 0.16, glow: "2.1s" },
  running: { accent: "#5CE1FF", ramp: "#4D8DFF", rgb: "92 225 255", alpha: [0.28, 0.11, 0.03], period: "1.75s", blobs: ["#8B7CFF", "#38BDF8", "#34D399"], blobAlpha: 0.16, glow: "3.6s" },
  quiet: { accent: "#A99EFF", ramp: "#8B7CFF", rgb: "139 124 255", alpha: [0.22, 0.09, 0.02], period: "3.5s", blobs: ["#8B7CFF", "#4D8DFF", "#94A3B8"], blobAlpha: 0.13, glow: "3.6s" },
  clear: { accent: "#7FA9FF", ramp: "#7FA9FF", rgb: "77 141 255", alpha: [0.14, 0.06, 0.015], period: "7s", blobs: ["#4D8DFF", "#8B7CFF", "#38BDF8"], blobAlpha: 0.08, glow: "3.6s" },
};
/** The gauge ring's four tags, clockwise from the upper left (`GAUGES` in lib/now-header.ts). */
const GAUGE_TAGS = [["Needs you", "#FF8A3D"], ["Your turn", "#FBBF24"], ["Running", "#5CE1FF"], ["Sessions", "#A99EFF"]] as const;
/** The painted core's plasma layers, as the Dashboard's OrbStage paints them (index.css), so the hand-off does not change the picture. */
const PAINTED_CORE_LAYERS = ["band1", "band2", "band3", "shade", "vein"].map((layer) => `<i data-layer="${layer}"></i>`).join("");

/**
 * The deck's numbers and colours exactly as React derives them (`inbox-view.tsx`, `now-deck.tsx`):
 * the four tags are the server's live counts (needs you, waiting on you, running, every non-idle
 * session); the centre holds the top-priority state (`headerState`): needs you, your turn, running,
 * quiet, then clear.
 */
export function nowDeckModel(bootstrap: SkeletonBootstrap, now = new Date()) {
  const summary = bootstrap.now ?? null;
  const approvals = bootstrap.approvalRequests?.length ?? 0;
  const needsYou = (summary?.needsYou.length ?? 0) + approvals;
  const running = summary?.running.length ?? 0;
  const rows = summary?.sessions?.sessions ?? [];
  const sessions = rows.filter((row) => row.phase === "working").length;
  const sessionsLive = rows.filter((row) => row.phase !== "idle" && row.phase !== "ended").length;
  const waiting = summary?.waitingOnYou?.length ?? 0;
  const readings = deckReadings({ notifications: bootstrap.recentNotifications ?? [], running, needsYou, now });
  // The orb's colour follows the deck (`lib/orb-theme.ts`): needs you, else work under way (moving, or
  // only quiet work, desaturated), else clear. Offline is the browser's to know, never the first frame's.
  const basis = deckBasis(summary ? { running: summary.running, quiet: summary.quiet ?? [], sessions: summary.sessions ?? { sessions: [] } } : null);
  const state = deckColorState(needsYou, basis);
  const colors = deckColors(readings.mix, state, { quiet: basis === "quiet" });
  const header: HeaderState = needsYou > 0 ? "needs" : waiting > 0 ? "turn" : running > 0 || sessions > 0 ? "running" : sessionsLive > 0 ? "quiet" : "clear";
  const centre: { header: HeaderState; label: string; value: number | null } = header === "needs" ? { header, label: "Needs you", value: needsYou }
    : header === "turn" ? { header, label: "Your turn", value: waiting }
    : header === "running" ? (running > 0 ? { header, label: "Running", value: running } : { header, label: "Sessions", value: sessions })
    : header === "quiet" ? { header, label: "Sessions", value: sessionsLive }
    : { header, label: "All clear", value: null };
  const live = true;
  // The body as React lays it out: Since you looked's rows (three, one on a phone), then the open
  // work's sections in their order, each a caption over its cards.
  const recent = summary?.recent?.length ?? 0;
  const sections = ([["needsYou", needsYou], ["waitingOnYou", waiting], ["running", running]] as const)
    .filter(([, count]) => count > 0);
  return { sessions, sessionsLive, waiting, running, needsYou, state, header, colors, centre, live, recent, sections, sessionRows: rows.length };
}

/** A gauge tag docked on the ring (the Dashboard's `Readout`); its place is the stylesheet's. */
function readout(label: string, value: number, color: string) {
  const lit = value > 0;
  return `<div class="now-tag" data-readout="${label}"${lit ? ' data-lit="true"' : ""} style="--tone:${color}">`
    + `<span class="readout-value numeral">${value}</span><span class="readout-label">${label}</span></div>`;
}

const bar = (width: string) => `<span class="skeleton loading-line" style="width:${width}"></span>`;

/** A work row's shape (work-card.tsx, row variant): origin, title, summary and standing lines. */
const WORK_ROW = `<div class="loading-work-row"><span>${bar("28%")}</span><span>${bar("52%")}</span><span>${bar("70%")}</span><span>${bar("22%")}</span></div>`;

/** Since you looked (inbox-view.tsx): the caption, its rows (up to four; loading.css shows one on a phone), "Show n more". */
function sinceBlock(recent: number) {
  if (!recent) return "";
  const shown = Math.min(4, recent);
  const list = shown ? `<div class="glass loading-list loading-list-now" data-skeleton-rows>${WORK_ROW.repeat(shown)}</div>` : "";
  // React shows "Show n more" on a phone past one row, and wider past four.
  const more = recent > 1
    ? `<p class="now-more loading-more"${recent > 4 ? " data-wide" : ""} data-phone>${bar("5.5rem")}</p>`
    : "";
  return `<div class="now-block" data-now-slot="sinceYouLooked"><section class="now-section now-since space-y-2.5" data-skeleton-since>`
    + `<p class="micro loading-heading">${bar("7rem")}</p>${list}${more}</section></div>`;
}

/** An open-work section: its caption, then its cards (up to two placeholders, each the height its kind usually is). */
function cardSection(kind: string, count: number) {
  return `<div class="now-block" data-now-slot="${kind}"><section class="${kind === "running" ? "now-running " : ""}now-section space-y-2.5"><p class="micro loading-heading">${bar("6rem")}</p>`
    + `<div class="relative now-card-grid" data-skeleton-rows>${`<div class="glass loading-card" data-card="${kind}"></div>`.repeat(Math.min(2, count))}</div></section></div>`;
}

/** Sessions in the right rail on wide pages (now.css `.now-rail`; loading.css shows it only there). */
function sessionsRail(count: number) {
  if (!count) return "";
  const row = `<div class="loading-session-row">${bar("40%")}${bar("62%")}</div>`;
  return `<aside class="now-rail loading-sessions" aria-hidden="true"><div class="now-rail-inner"><section class="space-y-3"><p class="micro loading-heading">${bar("5rem")}</p>`
    + `<div class="glass loading-list" data-skeleton-rows>${row.repeat(Math.min(3, count))}</div></section></div></aside>`;
}

function nowPage(bootstrap: SkeletonBootstrap, path: string, now: Date) {
  const deck = nowDeckModel(bootstrap, now);
  const look = HEADER_LOOK[deck.header];
  const accent = look.accent;
  const [c1, c2, c3] = deck.colors;
  const number = deck.centre.value === null
    ? '<span class="hud-wordmark">relo</span>'
    : `<span class="hud-number numeral leading-none" style="background-image:linear-gradient(180deg, #ffffff 0%, ${look.ramp} 100%);color:transparent">${deck.centre.value}</span>`;
  const centre = `<div aria-hidden="true" class="now-deck-centre" data-hud-centre="${deck.centre.label}"${deck.live ? ' data-live="true"' : ""}${deck.header === "needs" ? ' data-urgent="true"' : ""} style="--centre-glow:color-mix(in srgb, ${accent} 55%, transparent)">`
    + `<span class="now-deck-centre-number">${number}</span>`
    + `<span class="now-deck-centre-label mt-2 flex items-center gap-2"><span class="hud-center" style="--tone:${accent}">${deck.centre.label}</span></span></div>`;
  const counts = [deck.needsYou, deck.waiting, deck.running, deck.sessionsLive];
  const hud = `<div aria-hidden="true" class="now-hud" data-header="${deck.header}"><div class="now-hud-frame"><div class="now-deck-readouts">`
    + GAUGE_TAGS.map(([label, color], index) => readout(label, counts[index]!, color)).join("")
    + `</div></div></div>`;
  const stage = `<div class="orb-stage now-deck-stage" data-orb-stage="loading" data-loading-core style="--orb-1:${c1};--orb-2:${c2};--orb-3:${c3}">`
    + `<span aria-hidden="true" class="orb-stage-painted">${PAINTED_CORE_LAYERS}</span><div class="orb-stage-centre">${centre}${hud}</div>${statusWords(path)}</div>`;
  const wash = '<div aria-hidden="true" class="now-wash"><i class="now-wash-glow"></i><i class="now-wash-blob" data-blob="1"></i><i class="now-wash-blob" data-blob="2"></i><i class="now-wash-blob" data-blob="3"></i><i class="now-wash-vignette"></i></div>';
  const vars = [["--acc", accent], ["--wa", `rgb(${look.rgb} / ${look.alpha[0]})`], ["--wb", `rgb(${look.rgb} / ${look.alpha[1]})`], ["--wc", `rgb(${look.rgb} / ${look.alpha[2]})`], ["--wp", look.period],
    ["--centre-period", look.glow], ["--blob-1", look.blobs[0]], ["--blob-2", look.blobs[1]], ["--blob-3", look.blobs[2]], ["--blob-o", String(look.blobAlpha)]]
    .map(([name, value]) => `${name}:${value}`).join(";");
  const aside = `<section aria-label="Now overview" class="now-deck" data-state="${deck.state}" data-header="${deck.header}" style="${vars}">${wash}<header class="now-deck-head"><div class="min-w-0"><h1 class="page-title">Now</h1></div></header>${stage}</section>`;
  const body = `<div class="split-page-body page-stack" data-skeleton-body aria-hidden="true">${deck.sections.map(([kind, count]) => cardSection(kind, count)).join("")}${sinceBlock(deck.recent)}${sessionsRail(deck.sessionRows)}</div>`;
  return `<main id="main-content" aria-busy="true" class="split-page canvas" data-loading-page="now"><p class="sr-only" role="status">Loading Now</p><div class="split-page-grid"><div class="split-page-aside">${aside}</div>${body}</div></main>`;
}

const crumb = (href: string, label: string, current: string) =>
  `<p class="page-breadcrumb"><a href="${escapeHtml(href)}" tabindex="-1">${label}</a><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg><span>${escapeHtml(current)}</span></p>`;

function framePage(kind: "list" | "detail", title: string, path: string, backHref: string | null) {
  const breadcrumb = kind === "detail" ? crumb(backHref ?? "/dashboard/inbox/notifications", "History", title) : "";
  const eyebrow = kind === "detail" ? '<p class="mt-1 text-sm text-muted-foreground">Activity detail</p>' : "";
  const body = kind === "detail"
    ? `<div class="glass loading-detail" data-skeleton-rows><div class="skeleton loading-line" style="width:30%"></div><div class="skeleton loading-line loading-line-lg" style="width:72%"></div><div class="skeleton loading-line" style="width:100%"></div><div class="skeleton loading-line" style="width:88%"></div><div class="skeleton loading-line" style="width:60%"></div></div>`
    : rows(4);
  return `<main id="main-content" aria-busy="true" class="page canvas" data-loading-page="${kind}"${kind === "detail" ? ' data-has-back="true"' : ""}><p class="sr-only" role="status">Loading ${escapeHtml(title)}</p>`
    + `<div class="page-frame w-full max-w-[1120px]">${breadcrumb}<header class="flex flex-wrap items-end justify-between gap-4"><div class="min-w-0"><h1 class="page-title">${escapeHtml(title)}</h1>${eyebrow}</div></header>`
    + `<div class="page-stack mt-8" data-skeleton-body aria-hidden="true">${body}<div class="loading-frame-words">${statusWords(path)}</div></div></div></main>`;
}

/**
 * Only what keeps the placeholder a page while the stylesheet is on its way (it is render-blocking,
 * so usually nothing): ink canvas, the sidebar's room, no flash of unstyled icons. Everything timed
 * lives in loading.css.
 */
const INLINE_STYLE = `<style>.loading-shell svg{max-width:24px;max-height:24px}.loading-shell{background:#08080d;color:#f3f3f7}</style>`;

/** The server's first frame for a Dashboard page; null for pages without a shell (sign-in, landing, docs). */
export function renderPageSkeleton(bootstrap: SkeletonBootstrap, options: { now?: Date | undefined; path?: string; sidebarFolded?: boolean | undefined } = {}): string | null {
  const kind = skeletonKindFor(bootstrap.kind);
  if (!kind) return null;
  const active = bootstrap.shell?.active ?? "";
  const pending = Math.max(0, Math.floor(Number(bootstrap.shell?.counts?.pending ?? 0)) || 0);
  const path = options.path ?? "";
  const page = kind === "now"
    ? nowPage(bootstrap, path, options.now ?? new Date())
    : framePage(kind, kind === "detail" ? "Notification" : bootstrap.shell?.title ?? "Relo", path, bootstrap.route?.backHref ?? null);
  return `${INLINE_STYLE}<div class="loading-shell" data-page-skeleton="${kind}">${sidebar(active, pending, options.sidebarFolded === true)}<div class="loading-shell-main" data-dashboard-main>${page}</div>${tabBar(active, pending)}</div>`;
}
