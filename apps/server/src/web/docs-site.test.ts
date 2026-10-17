import { readFileSync,writeFileSync } from "node:fs";
import { Hono } from "hono";
import { describe,expect,test } from "vitest";
// The docs builder is plain ESM outside src (a dev tool: markdown-it and the CLI are not runtime dependencies).
import { buildDocsSite,siteModuleSource } from "../../docs-build/build-docs.mjs";
import { renderDashboardAppDocumentFromIndex } from "./dashboard-app.js";
import { DOCS_SITE } from "./docs/site.generated.js";
import { docsBootstrap,docsStaticMarkup,registerDocsSite } from "./docs-site.js";

const generated = new URL("./docs/site.generated.ts",import.meta.url);

describe("docs site build", () => {
  /** docs/site and the CLI's facts build to exactly the committed module. UPDATE_DOCS=1 rewrites it. */
  test("the committed site module is current", async () => {
    const source = siteModuleSource(await buildDocsSite());
    if (process.env.UPDATE_DOCS === "1") writeFileSync(generated,source);
    expect(readFileSync(generated,"utf8"),"docs are stale: pnpm --filter @relo/server docs:build").toBe(source);
  },30_000);

  test("every page has a title, a summary, an outline target for each heading and no stub", () => {
    expect(DOCS_SITE.pages.length).toBeGreaterThan(40);
    for (const page of DOCS_SITE.pages) {
      expect(page.title,page.path).toBeTruthy();
      expect(page.summary,page.path).toBeTruthy();
      expect(page.html,page.path).not.toContain("DRAFT-STUB");
      for (const item of page.outline) expect(page.html,`${page.path}#${item.id}`).toContain(`id="${item.id}"`);
    }
    const paths = DOCS_SITE.pages.map((page) => page.path);
    expect(new Set(paths).size).toBe(paths.length);
    for (const required of ["/docs","/docs/get-started","/docs/reference/cli/work","/docs/agents","/docs/troubleshooting"]) expect(paths).toContain(required);
  });
});

function docsApp(signedIn = false,origin = "https://relo.example.com") {
  const app = new Hono();
  registerDocsSite(app,{
    releaseIdentity: "0.18.30+abcdef12",
    origin,
    signedIn: async () => signedIn,
    renderDocument: async (bootstrap,{ rootHtml }) => `<html><body>${rootHtml}<script id="bootstrap">${JSON.stringify(bootstrap)}</script></body></html>`,
  });
  return app;
}

describe("docs routes", () => {
  test("a docs page reads signed out, without JavaScript: the article is in the document", async () => {
    const response = await docsApp().request("/docs/get-started");
    expect(response.status).toBe(200);
    const html = await response.text();
    const page = DOCS_SITE.pages.find((item) => item.path === "/docs/get-started")!;
    expect(html).toContain(`<h1>${page.title}</h1>`);
    expect(html).toContain(page.html.slice(0,200));
    expect(html).toContain('href="/sign-in"');
    expect(html).toContain('aria-current="page"');
    expect(html).not.toContain("Open Dashboard");
  });

  test("a signed-in owner gets the same page with a way back to the Dashboard", async () => {
    const html = await (await docsApp(true).request("/docs")).text();
    expect(html).toContain("Open Dashboard");
  });

  test("an unknown page is a 404 inside the docs, and a trailing slash finds the page", async () => {
    const missing = await docsApp().request("/docs/no-such-page");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("Page not found");
    expect((await docsApp().request("/docs/guides/")).status).toBe(200);
  });

  test("every page is also Markdown, and the agent indexes list them", async () => {
    const app = docsApp();
    const markdown = await app.request("/docs/how-it-works.md");
    expect(markdown.headers.get("content-type")).toContain("text/markdown");
    expect(await markdown.text()).toMatch(/^# How/u);
    expect(await (await app.request("/docs.md")).text()).toMatch(/^# /u);
    expect((await app.request("/agents.md")).status).toBe(200);
    // The canonical origin, not the request's (behind a tunnel the request says http).
    const llms = await (await app.request("http://relo.example.com/llms.txt")).text();
    expect(llms).toContain("https://relo.example.com/docs/get-started.md");
    expect(llms).toContain("/llms-full.txt");
    const full = await (await app.request("/llms-full.txt")).text();
    for (const page of DOCS_SITE.pages.slice(0,5)) expect(full).toContain(`# ${page.title}`);
    expect((await app.request("/docs/nope.md")).status).toBe(404);
  });

  test("/install.md is the agent setup page in this server's own address", async () => {
    const install = await docsApp(false,"https://relo.home.test").request("http://localhost/install.md");
    expect(install.headers.get("content-type")).toContain("text/markdown");
    const text = await install.text();
    expect(text).toMatch(/^# Set up with your agent/u);
    expect(text).toContain('relo auth login --api-url "https://relo.home.test"');
    expect(text).toContain("Read https://relo.home.test/install.md");
    expect(text).not.toContain("relo.example.com");
  });

  test("/install.md with a one-time code tells the agent to join with it, never to sign in, and is never cached",async () => {
    const code = `rci_${"aB3_-".repeat(6)}ab`;
    const install = await docsApp(false,"https://relo.home.test").request(`http://localhost/install.md?code=${code}`);
    expect(install.headers.get("cache-control")).toBe("no-store");
    const text = await install.text();
    expect(text).toContain(`curl -fsSL https://relo.home.test/install.sh | sh -s -- ${code}`);
    expect(text).toContain("sends the owner a first notification itself");
    expect(text).toContain("make a new one in Connect a computer");
    expect(text).not.toMatch(/relo auth login --/u);
  });

  test("/install.md accepts the code with its bind half and rejects a bad one",async () => {
    const code = `rci_${"aB3_-".repeat(6)}ab.${"Zy9_-".repeat(4)}Qw`;
    const app = docsApp(false,"https://relo.home.test");
    const text = await (await app.request(`http://localhost/install.md?code=${code}`)).text();
    expect(text).toContain(`install.sh | sh -s -- ${code}`);
    const bad = await (await app.request(`http://localhost/install.md?code=${code}x`)).text();
    expect(bad).not.toContain("sh -s -- rci_");
  });

  test("/install.md with a malformed code is today's page and never echoes it",async () => {
    const bad = "rci_<script>alert(1)</script>";
    const install = await docsApp(false,"https://relo.home.test").request(`http://localhost/install.md?code=${encodeURIComponent(bad)}`);
    const text = await install.text();
    expect(text).toMatch(/^# Set up with your agent/u);
    expect(text).not.toContain("alert(1)");
    expect(install.headers.get("cache-control")).not.toBe("no-store");
  });

  test("search has every page and its sections", async () => {
    const body = await (await docsApp().request("/docs/search.json")).json() as { pages: Array<{ path: string; sections: unknown[] }> };
    expect(body.pages.length).toBe(DOCS_SITE.pages.length);
    expect(body.pages.every((page) => page.sections.length > 0)).toBe(true);
  });

  test("the document carries the page's title and summary, escaped, and its article in the root", () => {
    const bootstrap = docsBootstrap(DOCS_SITE,"/docs/privacy",false,"0.18.30+abcdef12");
    const html = renderDashboardAppDocumentFromIndex('<html><head><title>x</title></head><body><div id="root"></div></body></html>',bootstrap,"",{ rootHtml: docsStaticMarkup(bootstrap) });
    expect(html).toContain(`<title>${bootstrap.page!.title} · Relo docs</title>`);
    expect(html).toContain('<meta name="description"');
    expect(html).toContain('<div id="root" data-dashboard-entry="docs"><div class="docs">');
    expect(html).not.toContain("Loading dashboard");
  });
});
