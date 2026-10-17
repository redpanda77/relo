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
import { deckBasis, deckColorState, deckColors, deckReadings, ORB_SIGNAL_COLORS, type DeckBasisSummary, type DeckNotification, type DeckState } from "@relo/notification-contracts";

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

const CENTRE_RAMP: Record<DeckState, string> = { clear: ORB_SIGNAL_COLORS.done, running: "#4d8dff", needsYou: "#ff6b57" };
const DECK_LEAD_COLOR: Record<DeckState, string> = { clear: ORB_SIGNAL_COLORS.done, running: ORB_SIGNAL_COLORS.running, needsYou: ORB_SIGNAL_COLORS.needsYou };
/** The Sessions readout's violet (`lib/signal.ts` SESSIONS_CSS). */
const SESSIONS_COLOR = ORB_SIGNAL_COLORS.message;
/** The painted core's plasma layers, as the Dashboard's OrbStage paints them (index.css), so the hand-off does not change the picture. */
const PAINTED_CORE_LAYERS = ["band1", "band2", "band3", "shade", "vein"].map((layer) => `<i data-layer="${layer}"></i>`).join("");

/**
 * The deck's numbers and colours exactly as React derives them (`inbox-view.tsx`, `now-deck.tsx`):
 * the four readouts are the server's live counts (sessions working, waiting on you, running, needs
 * you); the centre is the first of an alternating pair (`centreFor`).
 */
export function nowDeckModel(bootstrap: SkeletonBootstrap, now = new Date()) {
  const summary = bootstrap.now ?? null;
  const approvals = bootstrap.approvalRequests?.length ?? 0;
  const needsYou = (summary?.needsYou.length ?? 0) + approvals;
  const running = summary?.running.length ?? 0;
  const sessions = summary?.sessions?.sessions.filter((row) => row.phase === "working").length ?? 0;
  const waiting = summary?.waitingOnYou?.length ?? 0;
  const readings = deckReadings({ notifications: bootstrap.recentNotifications ?? [], running, needsYou, now });
  // Colour follows the deck (`lib/orb-theme.ts`): needs you, else work under way (moving, or only
  // quiet work, desaturated), else clear. Offline is the browser's to know, never the first frame's.
  const basis = deckBasis(summary ? { running: summary.running, quiet: summary.quiet ?? [], sessions: summary.sessions ?? { sessions: [] } } : null);
  const state = deckColorState(needsYou, basis);
  const colors = deckColors(readings.mix, state, { quiet: basis === "quiet" });
  const centre: { state: DeckState; label: string; value: number | null } = needsYou > 0 ? { state: "needsYou", label: "Needs you", value: needsYou }
    : running > 0 ? { state: "running", label: "Running", value: running }
    : sessions > 0 ? { state: "running", label: "Sessions", value: sessions }
    // Today's count is a calendar day in the owner's timezone, which only the browser knows.
    : { state: "clear", label: "Today", value: null };
  const live = centre.state !== "clear" && (basis === "moving" || needsYou > 0);
  // The body as React lays it out: Since you looked's rows (three, one on a phone), then the open
  // work's sections in their order, each a caption over its cards.
  const recent = summary?.recent?.length ?? 0;
  const sections = ([["needsYou", needsYou], ["waitingOnYou", waiting], ["running", running]] as const)
    .filter(([, count]) => count > 0);
  return { sessions, waiting, running, needsYou, state, colors, centre, live, recent, sections, sessionRows: summary?.sessions?.sessions.length ?? 0 };
}

/** A readout; `null` is a number only the browser can know (a placeholder slot of the digits' size). */
function readout(label: string, value: number | null, color: string, lit: boolean) {
  return `<div class="flex min-w-0 flex-col gap-1.5" data-readout="${label}"${lit ? ' data-lit="true"' : ""} style="--n:${Math.min(value ?? 0, 10)};--tone:${color}">`
    + `<span class="readout-label micro truncate"${lit ? ` style="color:${color}"` : ""}>${label}</span>`
    + `<span class="readout-value numeral text-[1.75rem] leading-none" style="color:${lit ? color : "var(--muted-foreground)"}">${value ?? '<span class="skeleton loading-readout"></span>'}</span></div>`;
}

const bar = (width: string) => `<span class="skeleton loading-line" style="width:${width}"></span>`;

/** A work row's shape (work-card.tsx, row variant): origin, title, summary and standing lines. */
const WORK_ROW = `<div class="loading-work-row"><span>${bar("28%")}</span><span>${bar("52%")}</span><span>${bar("70%")}</span><span>${bar("22%")}</span></div>`;

/** Since you looked (inbox-view.tsx): the sentence, its rows (loading.css shows one on a phone), "Show n more". */
function sinceBlock(recent: number) {
  if (!recent) return "";
  const shown = Math.min(3, recent);
  const list = shown ? `<div class="glass loading-list loading-list-now" data-skeleton-rows>${WORK_ROW.repeat(shown)}</div>` : "";
  // React shows "Show n more" on a phone past one row, and wider past three.
  const more = recent > 1
    ? `<p class="now-more loading-more"${recent > 3 ? " data-wide" : ""} data-phone>${bar("5.5rem")}</p>`
    : "";
  return `<div class="now-block" data-now-slot="sinceYouLooked"><section class="space-y-3" data-skeleton-since>`
    + `<p class="text-sm loading-since">${bar("55%")}</p>${list}${more}</section></div>`;
}

/** An open-work section: its caption, then its cards (up to two placeholders, each the height its kind usually is). */
function cardSection(kind: string, count: number) {
  return `<div class="now-block" data-now-slot="${kind}"><section class="${kind === "running" ? "now-running " : ""}now-section space-y-3"><p class="micro loading-heading">${bar("6rem")}</p>`
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
  const lit = deck.centre.state !== "clear";
  const accent = DECK_LEAD_COLOR[deck.centre.state];
  const [c1, c2, c3] = deck.colors;
  const centreValue = deck.centre.value === null ? '<span class="skeleton loading-centre-slot"></span>' : String(deck.centre.value);
  const number = `<span class="hud-number numeral text-[4.25rem] leading-none @3xl:text-[5rem]" style="background-image:${lit ? `linear-gradient(180deg, #ffffff 0%, ${CENTRE_RAMP[deck.centre.state]} 100%)` : "none"};color:${lit ? "transparent" : "#ffffff"}">${centreValue}</span>`;
  const centre = `<div aria-hidden="true" class="now-deck-centre" data-hud-centre="${deck.centre.label}"${deck.live ? ' data-live="true"' : ""}${deck.centre.state === "needsYou" ? ' data-urgent="true"' : ""} style="--centre-glow:color-mix(in srgb, ${accent} 55%, transparent)">`
    + `<span class="now-deck-centre-number">${number}</span>`
    + `<span class="now-deck-centre-label mt-2 flex items-center gap-2"><span class="hud-center" style="--tone:${accent}">${deck.centre.label}</span></span></div>`;
  const stage = `<div class="orb-stage now-deck-stage" data-orb-stage="loading" data-loading-core style="--orb-1:${c1};--orb-2:${c2};--orb-3:${c3}">`
    + `<span aria-hidden="true" class="orb-stage-painted">${PAINTED_CORE_LAYERS}</span><div class="orb-stage-centre">${centre}</div>${statusWords(path)}</div>`;
  const readouts = `<div class="now-deck-instruments"><div aria-hidden="true" class="now-deck-readouts">`
    + readout("Sessions", deck.sessions, SESSIONS_COLOR, deck.sessions > 0)
    + readout("Waiting", deck.waiting, ORB_SIGNAL_COLORS.attention, deck.waiting > 0)
    + readout("Running", deck.running, ORB_SIGNAL_COLORS.running, deck.running > 0)
    + readout("Needs you", deck.needsYou, ORB_SIGNAL_COLORS.needsYou, deck.needsYou > 0)
    + `</div></div>`;
  // Beside the work (1100px+) the deck also carries one sentence (it counts today, so a placeholder).
  const more = `<div class="now-deck-more loading-deck-more"><p class="now-deck-sentence">${bar("92%")}${bar("60%")}</p></div>`;
  const aside = `<section aria-label="Now overview" class="now-deck" data-state="${deck.state}"><header class="now-deck-head"><div class="min-w-0"><h1 class="page-title">Now</h1></div></header>${stage}${readouts}${more}</section>`;
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
