import { readdir } from "node:fs/promises";
import { describe,expect,test } from "vitest";
import {
  dashboardAppAssetResponse,
  landingPreloadTags,
  pagePreloadTags,
  renderDashboardAppDocumentFromIndex,
  type TestLabDashboardBootstrap,
} from "./dashboard-app.js";
import type { InboxDashboardBootstrap } from "./dashboard-inbox.js";
import type { DashboardAuthBootstrap } from "./dashboard-auth.js";

function bootstrap(accountName = "Owner"): TestLabDashboardBootstrap {
  return {
    version: 1,
    kind: "test-lab",
    route: { path: "/dashboard/testing",selectedActivityId: null,compose: false },
    shell: {
      title: "Live Activity Test Lab",
      description: "Test the system.",
      active: "testing",
      releaseIdentity: "test-release",
      account: {
        id: "acc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        initial: "O",
        name: accountName,
        email: "owner@example.test",
      },
    },
    summary: { total: 0,active: 0,awaitingProvider: 0,awaitingPhone: 0,awaitingResponse: 0 },
    devices: [],
    runs: [],
    composer: {
      defaultPreset: "standard",
      presets: [],
    },
  };
}

function inboxBootstrap(title: string): InboxDashboardBootstrap {
  return {
    version: 1,
    kind: "notification-history",
    route: {
      path: "/dashboard/inbox/notifications",
      page: 1,
      filters: { kind: null,state: null,project: null },
    },
    filterOptions: { projects: [] },
    shell: {
      title,
      description: "Persistent notifications.",
      active: "inbox-notifications",
      releaseIdentity: "test-release",
      account: {
        id: "acc_aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        initial: "O",
        name: "Owner",
        email: "owner@example.test",
      },
      counts: { pending: 0,notifications: 0,deliveries: 0 },
    },
    notifications: [],
    pagination: {
      page: 1,
      pageSize: 25,
      total: 0,
      pageCount: 1,
      previousHref: null,
      nextHref: null,
    },
  };
}

describe("dashboard React application delivery", () => {
  test("renders the public authentication entry without requiring a dashboard shell", () => {
    const indexHtml = `<!doctype html><html><head><title>Dashboard</title></head><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>`;
    const auth: DashboardAuthBootstrap = {
      version: 1,
      kind: "auth",
      view: "form",
      route: { path: "/", nextPath: "/dashboard" },
      mode: "sign-in",
      title: "Sign in to Relo",
      description: "Authenticate the private owner.",
    };
    const html = renderDashboardAppDocumentFromIndex(indexHtml,auth);

    expect(html).toContain('data-dashboard-entry="auth"');
    expect(html).toContain("<title>Sign in to Relo · Relo</title>");
    expect(html).toContain("Loading authentication…");
  });

  test("the landing chunk, its imports and CSS are preloaded with the document; the entry and unsafe paths are not", () => {
    const tags = landingPreloadTags({
      "index.html": { file: "assets/index-a.js", isEntry: true, imports: ["_utils-b.js"] },
      "_utils-b.js": { file: "assets/utils-b.js" },
      "_icon-c.js": { file: "assets/icon-c.js", imports: ["index.html"] },
      "_bad.js": { file: "../../etc/passwd" },
      "src/features/landing/landing-page.tsx": {
        file: "assets/landing-page-d.js", css: ["assets/landing-page-e.css"],
        imports: ["_utils-b.js", "_icon-c.js", "index.html", "_bad.js"],
      },
      "src/features/landing/landing-scene.ts": { file: "assets/landing-scene-f.js", imports: ["src/lib/orb-scene.ts"] },
      "src/lib/orb-scene.ts": { file: "assets/orb-scene-g.js", imports: ["index.html"] },
    });
    expect(tags).toContain('<link rel="stylesheet" crossorigin href="/assets/landing-page-e.css">');
    for (const file of ["landing-page-d.js","utils-b.js","icon-c.js"])
      expect(tags).toContain(`<link rel="modulepreload" crossorigin href="/assets/${file}">`);
    for (const file of ["landing-scene-f.js","orb-scene-g.js"])
      expect(tags).toContain(`<link rel="modulepreload" crossorigin href="/assets/${file}" fetchpriority="low">`);
    expect(tags).not.toContain("index-a.js");
    expect(tags).not.toContain("passwd");
    expect(landingPreloadTags({})).toBe("");
  });

  test("a Dashboard page preloads its own chunk and the motion features; Now adds the orb scene at low priority",() => {
    const manifest = {
      "index.html": { file: "assets/index-a.js", isEntry: true },
      "_utils-b.js": { file: "assets/utils-b.js" },
      "src/features/inbox/inbox-feature.tsx": { file: "assets/inbox-feature-c.js", css: ["assets/inbox-d.css"], imports: ["_utils-b.js", "index.html"] },
      "src/features/connections/connections-feature.tsx": { file: "assets/connections-feature-e.js", imports: ["_utils-b.js"] },
      "src/lib/motion-features.ts": { file: "assets/motion-features-f.js" },
      "src/lib/orb-scene.ts": { file: "assets/orb-scene-g.js", imports: ["_three-h.js"] },
      "_three-h.js": { file: "assets/three-h.js" },
    };
    const now = pagePreloadTags(manifest,"inbox-overview");
    for (const file of ["inbox-feature-c.js","utils-b.js","motion-features-f.js"])
      expect(now).toContain(`<link rel="modulepreload" crossorigin href="/assets/${file}">`);
    expect(now).toContain('<link rel="stylesheet" crossorigin href="/assets/inbox-d.css">');
    for (const file of ["orb-scene-g.js","three-h.js"])
      expect(now).toContain(`<link rel="modulepreload" crossorigin href="/assets/${file}" fetchpriority="low">`);
    expect(now).not.toContain("index-a.js");

    const connections = pagePreloadTags(manifest,"connections");
    expect(connections).toContain("connections-feature-e.js");
    expect(connections).toContain("motion-features-f.js");
    expect(connections).not.toContain("orb-scene");
    expect(connections).not.toContain("inbox-feature");
    expect(pagePreloadTags(manifest,"auth")).toBe("");
  });

  test("the landing document carries a description for link previews; the form does not", () => {
    const indexHtml = `<!doctype html><html><head><title>Dashboard</title></head><body><div id="root"></div></body></html>`;
    const base: DashboardAuthBootstrap = {
      version: 1, kind: "auth", view: "landing", route: { path: "/", nextPath: "/dashboard" },
      mode: "sign-in", registration: "closed", title: "Sign in to Relo", description: "x",
    };
    expect(renderDashboardAppDocumentFromIndex(indexHtml,base)).toContain('<meta name="description"');
    expect(renderDashboardAppDocumentFromIndex(indexHtml,{ ...base, view: "form" })).not.toContain('<meta name="description"');
  });

  test("injects bootstrap JSON without permitting a script breakout", () => {
    const indexHtml = `<!doctype html><html><head><link rel="icon" href="/vite.svg"><title>Dashboard</title></head><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>`;
    const hostileName = "</script><script>globalThis.compromised=true</script>";
    const html = renderDashboardAppDocumentFromIndex(indexHtml,bootstrap(hostileName));

    expect(html).toContain('id="root" data-dashboard-entry="test-lab"');
    expect(html).toContain("IMPECCABLE-DIRECTION seed=relo-plum-coral");
    expect(html).not.toContain(hostileName);
    expect(html).toContain("\\u003c/script\\u003e\\u003cscript\\u003e");
    expect(html).not.toContain("/vite.svg");
    const json = html.match(
      /<script id="relo-dashboard-bootstrap" type="application\/json">([^<]*)<\/script>/,
    )?.[1];
    expect(json).toBeDefined();
    expect(JSON.parse(json!).shell.account.name).toBe(hostileName);
  });

  test("renders the Inbox entry without allowing a title breakout", () => {
    const indexHtml = `<!doctype html><html><head><title>Dashboard</title></head><body><div id="root"></div><script type="module" src="/assets/index-abc.js"></script></body></html>`;
    const hostileTitle = "</title><script>globalThis.compromised=true</script>";
    const html = renderDashboardAppDocumentFromIndex(indexHtml,inboxBootstrap(hostileTitle));

    expect(html).toContain('data-dashboard-entry="notification-history"');
    expect(html).toContain("&lt;/title&gt;&lt;script&gt;");
    expect(html).not.toContain(hostileTitle);
    expect(JSON.parse(html.match(
      /<script id="relo-dashboard-bootstrap" type="application\/json">([^<]*)<\/script>/,
    )?.[1] ?? "{}").shell.title).toBe(hostileTitle);
  });

  test("serves only allowlisted files emitted by the dashboard build", async () => {
    const assetsUrl = new URL("../../../dashboard/dist/assets/",import.meta.url);
    const assetNames = await readdir(assetsUrl);
    const javascriptAsset = assetNames.find((name) => name.endsWith(".js"));
    expect(javascriptAsset).toBeDefined();

    const response = await dashboardAppAssetResponse(javascriptAsset!);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("content-type")).toContain("text/javascript");
    expect(response?.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    expect(response?.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await response!.arrayBuffer()).byteLength).toBeGreaterThan(0);
    await expect(dashboardAppAssetResponse("../package.json")).resolves.toBeNull();
    await expect(dashboardAppAssetResponse("not-in-the-build.js")).resolves.toBeNull();
    await expect(dashboardAppAssetResponse("index-abc.exe")).resolves.toBeNull();
  });
});
