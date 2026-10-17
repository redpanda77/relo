import type { Context,Hono } from "hono";
import type { DocsSiteBootstrap } from "@relo/notification-contracts/dashboard/docs";
import { DOCS_SITE } from "./docs/site.generated.js";
import type { DocsPage,DocsSite } from "./docs/types.js";
import { secureHtml } from "./http.js";

/**
 * The public docs site (plan 08): `/docs` and `/docs/*` serve the built pages (apps/server/docs-build) in
 * the app's docs layout, readable signed out and without JavaScript (the article is in the document; React
 * adds navigation, search and copy buttons). `/docs/<page>.md`, `/docs.md`, `/llms.txt`, `/llms-full.txt`
 * `/agents.md` and `/install.md` serve the same pages as Markdown for agents and tools. Nothing here reads an account.
 */
const GITHUB_URL = "https://github.com/redpanda77/relo";
/** The docs' example server address, which /install.md swaps for this server's. */
const EXAMPLE_ORIGIN = "https://relo.example.com";

const escapeHtml = (text: string) => text.replace(/[&<>"]/g,(character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[character]!);

export function docsPageFor(site: DocsSite,path: string): DocsPage | undefined {
  const clean = path.replace(/\/+$/,"") || "/docs";
  return site.pages.find((page) => page.path === clean);
}

export function docsBootstrap(site: DocsSite,path: string,signedIn: boolean,releaseIdentity: string): DocsSiteBootstrap {
  const page = docsPageFor(site,path);
  return {
    version: 1,
    kind: "docs",
    route: { path: page?.path ?? (path.startsWith("/docs") ? path : "/docs") },
    viewer: { signedIn },
    release: { server: releaseIdentity,cli: site.cli },
    sections: site.sections,
    page: page ? {
      path: page.path,title: page.title,summary: page.summary,section: page.section,html: page.html,outline: page.outline,
      editUrl: page.editUrl,prev: page.prev,next: page.next,breadcrumbs: page.breadcrumbs,
    } : null,
  };
}

/** The page as plain HTML, in the classes the React layout uses, for readers without JavaScript and for crawlers. */
export function docsStaticMarkup(bootstrap: DocsSiteBootstrap): string {
  const page = bootstrap.page;
  const current = bootstrap.route.path;
  const link = (path: string,title: string) =>
    `<a class="docs-nav-link" href="${escapeHtml(path)}"${path === current ? ' aria-current="page"' : ""}>${escapeHtml(title)}</a>`;
  const currentAttribute = (path: string) => (path === current ? ' aria-current="page"' : "");
  const sidebar = bootstrap.sections.map((section) => `<div class="docs-nav-section"><p class="docs-nav-title">${section.path ? `<a href="${escapeHtml(section.path)}"${currentAttribute(section.path)}>${escapeHtml(section.title)}</a>` : escapeHtml(section.title)}</p>`
    + (section.pages.length ? `<ul>${section.pages.map((item) => `<li>${link(item.path,item.title)}</li>`).join("")}</ul>` : "")
    + section.groups.map((group) => `<p class="docs-nav-group">${escapeHtml(group.title)}</p><ul>${group.pages.map((item) => `<li>${link(item.path,item.title)}</li>`).join("")}</ul>`).join("")
    + `</div>`).join("");
  const crumbs = page?.breadcrumbs.length
    ? `<nav class="docs-breadcrumbs" aria-label="Breadcrumbs"><ol>${page.breadcrumbs.map((crumb) => `<li>${crumb.path ? `<a href="${escapeHtml(crumb.path)}">${escapeHtml(crumb.title)}</a>` : `<span>${escapeHtml(crumb.title)}</span>`}</li>`).join("")}</ol></nav>` : "";
  const body = page
    ? `${crumbs}<header class="docs-page-header"><h1>${escapeHtml(page.title)}</h1><p class="docs-lede">${escapeHtml(page.summary)}</p></header>`
      + `<article class="docs-prose">${page.html}</article>`
      + `<nav class="docs-pager" aria-label="Previous and next">${page.prev ? `<a class="docs-pager-link" rel="prev" href="${escapeHtml(page.prev.path)}"><span class="micro">Previous</span>${escapeHtml(page.prev.title)}</a>` : "<span></span>"}`
      + `${page.next ? `<a class="docs-pager-link" data-next rel="next" href="${escapeHtml(page.next.path)}"><span class="micro">Next</span>${escapeHtml(page.next.title)}</a>` : ""}</nav>`
    : `<header class="docs-page-header"><h1>Page not found</h1><p class="docs-lede">There is no docs page at this address. Start from the <a href="/docs">docs home</a>.</p></header>`;
  const cta = bootstrap.viewer.signedIn ? `<a class="capsule-cta docs-cta" href="/dashboard">Open Dashboard</a>` : `<a class="capsule-cta docs-cta" href="/sign-in">Sign in</a>`;
  return `<div class="docs"><header class="docs-header"><div class="docs-header-inner">`
    + `<a class="docs-brand" href="/" aria-label="Relo home"><span class="brand-orb size-7" aria-hidden="true"></span><span class="wordmark">relo</span></a>`
    + `<a class="docs-brand-section" href="/docs">Docs</a>`
    + `<nav class="docs-top-links" aria-label="Site"><a href="/">Home</a><a href="/docs/privacy">Privacy</a><a href="${GITHUB_URL}" rel="external noopener">GitHub</a></nav>`
    + `<div class="docs-header-actions">${cta}</div></div></header>`
    + `<div class="docs-body"><aside class="docs-sidebar" aria-label="Docs pages"><nav>${sidebar}</nav></aside>`
    + `<main class="docs-main" id="docs-article">${body}</main></div></div>`;
}

const INSTALL_CODE = /^rci_[A-Za-z0-9_-]{32}(\.[A-Za-z0-9_-]{22})?$/;

/** What an agent reads when the owner's Connect a computer wizard hands it a code: join with it, never sign in. */
export const installWithCode = (origin: string,code: string) => `# Set up Relo on this computer

You are a coding agent. The owner made a one-time code in Relo's Connect a computer, so there is nothing to sign in to
and nothing to ask: the code carries the choices the owner made.

1. Run this command. It installs the Relo CLI from ${origin}, signs this computer in with the code and sets up the agents here
   the way the owner chose. Do not run \`relo auth login\`; the code replaces it.

\`\`\`sh
curl -fsSL ${origin}/install.sh | sh -s -- ${code}
\`\`\`

2. The command sends the owner a first notification itself when it finishes. Do not send another.

If \`relo\` is not found later, it is at \`~/.local/bin/relo\`.

3. If the command says the code was rejected (a code works once, for 30 minutes), stop and tell the owner to make a new one in Connect a computer. Do not retry with the same code.

Tell the owner in a sentence what happened. Never put a token or password in a file or on a command line.
`;

const markdown = (context: Context,text: string) => context.body(text,200,{
  "content-type": "text/markdown; charset=utf-8","cache-control": "public, max-age=300","x-content-type-options": "nosniff",
});

/** The index agents read first: every page with its summary, as the llms.txt convention lists them. */
export function llmsText(site: DocsSite,origin = ""): string {
  const lines = ["# Relo","","> Every agent, script and app you run, wherever it runs, in one place on your iPhone: live status,","> time-sensitive alerts, details and questions, end-to-end encrypted, on a server you run.",""];
  for (const section of site.sections) {
    lines.push(`## ${section.title}`,"");
    const pages = [...(section.path ? [section.path] : []),...section.pages.map((item) => item.path),...section.groups.flatMap((group) => group.pages.map((item) => item.path))];
    for (const path of pages) {
      const page = docsPageFor(site,path);
      if (page) lines.push(`- [${page.title}](${origin}${page.path === "/docs" ? "/docs.md" : `${page.path}.md`}): ${page.summary}`);
    }
    lines.push("");
  }
  lines.push("## Optional","",`- [Everything in one file](${origin}/llms-full.txt): every page above, in order.`,"");
  return lines.join("\n");
}

export function registerDocsSite(app: Hono,dependencies: {
  releaseIdentity: string;
  /** The server's canonical origin (APP_URL) for absolute links; behind a tunnel the request URL can say http. */
  origin?: string;
  signedIn(headers: Headers): Promise<boolean>;
  renderDocument(bootstrap: DocsSiteBootstrap,options: { rootHtml: string }): Promise<string>;
  site?: DocsSite;
}): void {
  const site = dependencies.site ?? DOCS_SITE;
  const page = async (context: Context) => {
    const path = new URL(context.req.url).pathname;
    if (path.endsWith(".md")) {
      const found = docsPageFor(site,path.slice(0,-".md".length));
      return found ? markdown(context,found.markdown) : context.notFound();
    }
    const bootstrap = docsBootstrap(site,path,await dependencies.signedIn(context.req.raw.headers),dependencies.releaseIdentity);
    const html = await dependencies.renderDocument(bootstrap,{ rootHtml: docsStaticMarkup(bootstrap) });
    const response = secureHtml(context,html);
    return bootstrap.page ? response : new Response(response.body,{ status: 404,headers: response.headers });
  };
  app.get("/docs",page);
  app.get("/docs/search.json",(context) => context.json({
    pages: site.pages.map((item) => ({ path: item.path,title: item.title,section: item.section,summary: item.summary,sections: item.search })),
  },200,{ "cache-control": "public, max-age=300" }));
  app.get("/docs/*",page);
  app.get("/docs.md",(context) => markdown(context,docsPageFor(site,"/docs")!.markdown));
  app.get("/agents.md",(context) => {
    const agents = docsPageFor(site,"/docs/agents");
    return agents ? markdown(context,agents.markdown) : context.notFound();
  });
  // The page a coding agent reads when the owner pastes the landing page's one line, in this server's own address.
  app.get("/install.md",(context) => {
    // With a one-time code from Connect a computer the page is a short, code-specific instruction (plan 13); never echo a bad code.
    const code = context.req.query("code") ?? "";
    if (INSTALL_CODE.test(code)) {
      const at = dependencies.origin ?? new URL(context.req.url).origin;
      return context.body(installWithCode(at,code),200,{
        "content-type": "text/markdown; charset=utf-8","cache-control": "no-store","x-content-type-options": "nosniff" });
    }
    const install = docsPageFor(site,"/docs/get-started/with-an-agent");
    const origin = dependencies.origin ?? new URL(context.req.url).origin;
    return install ? markdown(context,install.markdown.replaceAll(EXAMPLE_ORIGIN,origin)) : context.notFound();
  });
  app.get("/llms.txt",(context) => context.text(llmsText(site,dependencies.origin ?? new URL(context.req.url).origin),200,{ "cache-control": "public, max-age=300" }));
  app.get("/llms-full.txt",(context) => context.text(site.pages.map((item) => item.markdown).join("\n---\n\n"),200,{ "cache-control": "public, max-age=300" }));
}
