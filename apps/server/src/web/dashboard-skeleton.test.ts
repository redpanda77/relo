import { describe,expect,test } from "vitest";
import { deckColors } from "@relo/notification-contracts";
import { nowDeckModel,renderPageSkeleton,skeletonKindFor,type SkeletonBootstrap } from "./dashboard-skeleton.js";
import { renderDashboardAppDocumentFromIndex,type DashboardBootstrap } from "./dashboard-app.js";
import { dashboardDocumentOptions } from "./http.js";

const now = new Date(2026,9,15,15,0,0);
const today = new Date(2026,9,15,9,0,0).toISOString();

const nowBootstrap: SkeletonBootstrap = {
  kind: "inbox-overview",
  route: { path: "/dashboard" },
  shell: { title: "Now",active: "inbox",counts: { pending: 2 } },
  approvalRequests: [{}],
  recentNotifications: [
    { kind: "live_activity",state: "ended",createdAt: today,activity: { state: "ended",outcome: "completed",updatedAt: today } },
    { kind: "live_activity",state: "ended",createdAt: today,activity: { state: "ended",outcome: "failed",updatedAt: today } },
    { kind: "live_activity",state: "ended",createdAt: today,activity: { state: "ended",outcome: "failed",updatedAt: today } },
  ],
  now: {
    needsYou: [{}],running: [{ owner: { state: "moving" } }],waitingOnYou: [{},{}],quiet: [],recent: [{},{},{},{}],
    sessions: { sessions: [{ phase: "working",workId: null },{ phase: "working",workId: "act_x" },{ phase: "idle",workId: null }] },
  },
};

describe("the server's first frame",() => {
  test("each page kind wears its skeleton; sign-in, landing and docs wear none",() => {
    expect(skeletonKindFor("inbox-overview")).toBe("now");
    expect(skeletonKindFor("notification-detail")).toBe("detail");
    expect(skeletonKindFor("connections")).toBe("list");
    expect(skeletonKindFor("auth")).toBeNull();
    expect(skeletonKindFor("docs")).toBeNull();
    expect(renderPageSkeleton({ kind: "auth" })).toBeNull();
  });

  test("Now shows the server's real numbers and paints the core in today's colours",() => {
    const deck = nowDeckModel(nowBootstrap,now);
    // The four readouts are the server's live counts: sessions working, waiting on you, running, needs you.
    expect(deck).toMatchObject({ sessions: 2,waiting: 2,running: 1,needsYou: 2,sessionsLive: 2,state: "needsYou",header: "needs",centre: { label: "Needs you",value: 2 },recent: 4 });
    // Failed (2) is today's biggest other meaning: it lights the needs-you ramp's peaks.
    expect(deck.colors).toEqual(deckColors({ done: 1,failed: 2,needsYou: 2,running: 1 },"needsYou"));
    expect(deck.colors[2]).toBe("#f43f5e");

    const html = renderPageSkeleton(nowBootstrap,{ now,path: "/dashboard" })!;
    expect(html).toContain('<h1 class="page-title">Now</h1>');
    expect(html).toContain('class="orb-stage now-deck-stage" data-orb-stage="loading"');
    expect(html).toContain("--orb-1:#ff8a3d;--orb-2:#ff6b57;--orb-3:#f43f5e");
    expect([...html.matchAll(/data-readout="([^"]+)"/g)].map((match) => match[1])).toEqual(["Needs you","Your turn","Running","Sessions"]);
    for (const [label,value] of [["Needs you",2],["Your turn",2],["Running",1],["Sessions",2]] as const)
      expect(html).toMatch(new RegExp(`data-readout="${label}"[^]*?class="readout-value numeral[^"]*"[^>]*>${value}<`));
    expect(html).not.toContain('data-readout="Today"');
    // The body as React's: the open sections in order, each a caption over its cards, then Since you
    // looked (four rows; "Show n more" past four, and past one on a phone); Sessions in the rail.
    expect(html).toMatch(/data-skeleton-body[^>]*><div class="now-block" data-now-slot="needsYou">/);
    expect(html).toContain('<div class="now-block" data-now-slot="sinceYouLooked"><section class="now-section now-since space-y-2.5" data-skeleton-since><p class="micro loading-heading">');
    expect(html.match(/class="loading-work-row"/g)).toHaveLength(4);
    expect(html).toContain('class="now-more loading-more" data-phone');
    expect(html).not.toContain('data-wide');
    expect([...html.matchAll(/class="now-block" data-now-slot="([^"]+)"/g)].map((match) => match[1])).toEqual(["needsYou","waitingOnYou","running","sinceYouLooked"]);
    expect(html).toContain('<section class="now-running now-section space-y-2.5">');
    expect(html).toContain('<aside class="now-rail loading-sessions" aria-hidden="true">');
    expect(html.match(/class="loading-session-row"/g)).toHaveLength(3);
    expect(html).toContain('<main id="main-content" aria-busy="true"');
    expect(html.match(/role="status"/g)).toHaveLength(1);
    expect(html).toContain("Loading Now");
    expect(html).toContain("Starting Relo");
    expect(html).toContain('Taking longer than usual · <a href="/dashboard">Reload</a>');
    expect(html).toContain('<span class="wordmark loading-wordmark">relo</span>');
    expect(html).toContain('class="tab-bar"');
    // The sidebar's groups as the Dashboard's: Test Lab sits with the settings.
    const [primary,settings] = [...html.matchAll(/<nav class="loading-nav">(.*?)<\/nav>/g)].map((match) => [...match[1]!.matchAll(/href="([^"]+)"/g)].map((link) => link[1]));
    expect(primary).toEqual(["/dashboard","/dashboard/inbox/notifications","/dashboard/connections"]);
    expect(settings).toEqual(["/dashboard/account","/dashboard/testing","/docs"]);
  });

  test("only quiet work paints the running ramp desaturated, as the deck does",() => {
    const deck = nowDeckModel({ kind: "inbox-overview",now: { needsYou: [],running: [{ owner: { state: "stale" } }],quiet: [],sessions: { sessions: [] } } },now);
    expect(deck).toMatchObject({ state: "running",centre: { label: "Running",value: 1 } });
    expect(deck.colors).toEqual(deckColors({ running: 1 },"running",{ quiet: true }));
    expect(deck.colors[0]).not.toBe("#5ce1ff");
  });

  test("no rows when nothing is open, and the core is clear",() => {
    const deck = nowDeckModel({ kind: "inbox-overview",now: { needsYou: [],running: [],recent: [] } },now);
    expect(deck).toMatchObject({ state: "clear",sections: [],centre: { label: "All clear",value: null } });
    const html = renderPageSkeleton({ kind: "inbox-overview",now: { needsYou: [],running: [],recent: [] } },{ now })!;
    expect(html).not.toContain("loading-work-row");
    expect(html).not.toContain("loading-more");
    expect(html).not.toContain("now-rail");
  });

  test("working sessions without live cards are the centre, as on the iPhone",() => {
    const deck = nowDeckModel({ kind: "inbox-overview",now: { needsYou: [],running: [],quiet: [],sessions: { sessions: [{ phase: "working",workId: null }] } } },now);
    expect(deck).toMatchObject({ sessions: 1,centre: { header: "running",label: "Sessions",value: 1 } });
  });

  test("a clear core shows the wordmark and ALL CLEAR (Today's count is the browser's, and no longer shown)",() => {
    const html = renderPageSkeleton({ ...nowBootstrap,approvalRequests: [],now: { needsYou: [],running: [],recent: [] } },{ now })!;
    expect(html).toContain('data-hud-centre="All clear"');
    expect(html).toContain('<span class="hud-wordmark">relo</span>');
    expect(html).not.toContain("hud-number");
    expect(html).toContain('data-header="clear"');
    expect(html).not.toContain('class="loading-row"');
  });

  test("the sidebar starts folded on the rail when the owner left it folded",() => {
    const open = renderPageSkeleton(nowBootstrap,{ now })!;
    expect(open).toContain('<aside class="loading-sidebar" aria-hidden="true">');
    const folded = renderPageSkeleton(nowBootstrap,{ now,sidebarFolded: true })!;
    expect(folded).toContain('<aside class="loading-sidebar" data-folded="true" aria-hidden="true">');
    const list = renderPageSkeleton({ kind: "connections",shell: { title: "Connections",active: "connections" } },{ sidebarFolded: true })!;
    expect(list).toContain('data-folded="true"');
  });

  test("the request's sidebar cookie reaches the document's first frame",() => {
    const request = (cookie?: string) => ({ req: { header: (name: string) => name === "cookie" ? cookie : undefined } });
    expect(dashboardDocumentOptions(request())).toEqual({ sidebarFolded: false });
    expect(dashboardDocumentOptions(request("sidebar_state=true; theme=dark"))).toEqual({ sidebarFolded: false });
    expect(dashboardDocumentOptions(request("theme=dark; sidebar_state=false"))).toEqual({ sidebarFolded: true });
    expect(dashboardDocumentOptions(request("sidebar_state=false; a=b"))).toEqual({ sidebarFolded: true });
    expect(dashboardDocumentOptions(request("other_sidebar_state=false"))).toEqual({ sidebarFolded: false });
    expect(dashboardDocumentOptions(request("sidebar_state=falsey"))).toEqual({ sidebarFolded: false });

    const indexHtml = `<!doctype html><html><head><title>Dashboard</title></head><body><div id="root"></div></body></html>`;
    const bootstrap = {
      ...nowBootstrap,
      version: 1,
      shell: { title: "Now",description: "",active: "inbox",releaseIdentity: "r",account: { id: "acc_x",initial: "O",name: "O",email: "o@example.test" },counts: { pending: 2,notifications: 0,deliveries: 0 } },
    } as unknown as DashboardBootstrap;
    const folded = renderDashboardAppDocumentFromIndex(indexHtml,bootstrap,"",{ now,...dashboardDocumentOptions(request("sidebar_state=false")) });
    expect(folded).toContain('class="loading-sidebar" data-folded="true"');
    const open = renderDashboardAppDocumentFromIndex(indexHtml,bootstrap,"",{ now });
    expect(open).not.toContain("data-folded");
  });

  test("list and detail pages carry the real title in the page frame",() => {
    const list = renderPageSkeleton({ kind: "connections",shell: { title: "Connections",active: "connections" } })!;
    expect(list).toContain('<h1 class="page-title">Connections</h1>');
    expect(list).toContain('class="page canvas"');
    expect(list).toContain('data-current="true"');
    const detail = renderPageSkeleton({ kind: "notification-detail",route: { backHref: "/dashboard/inbox/notifications?page=2" } })!;
    expect(detail).toContain('<h1 class="page-title">Notification</h1>');
    expect(detail).toContain('href="/dashboard/inbox/notifications?page=2"');
  });

  test("escapes what it prints and never carries a script",() => {
    const html = renderPageSkeleton({ kind: "connections",shell: { title: "</h1><script>alert(1)</script>" } })!;
    expect(html).not.toContain("<script");
    expect(html).toContain("&lt;/h1&gt;&lt;script&gt;");
  });

  test("the document's only script besides the entry is the JSON bootstrap",() => {
    const indexHtml = `<!doctype html><html><head><title>Dashboard</title></head><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>`;
    const html = renderDashboardAppDocumentFromIndex(indexHtml,{
      ...nowBootstrap,
      version: 1,
      shell: { title: "Now",description: "",active: "inbox",releaseIdentity: "r",account: { id: "acc_x",initial: "O",name: "O",email: "o@example.test" },counts: { pending: 2,notifications: 0,deliveries: 0 } },
    } as unknown as DashboardBootstrap,"",{ now });
    const scripts = html.match(/<script\b[^>]*>/g) ?? [];
    expect(scripts).toEqual(['<script id="relo-dashboard-bootstrap" type="application/json">','<script type="module" src="/assets/index-abc.js">']);
    expect(html).toContain('data-page-skeleton="now"');
    expect(html).not.toContain("Loading dashboard…");
  });
});
