// `pnpm --filter @relo/server docs:preview`: the docs site on http://127.0.0.1:8250 with no database,
// rebuilt from docs/site on every request (stubs allowed), in the real layout and Dashboard bundle
// (build it first: pnpm --filter @relo/dashboard exec vite build).
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { dashboardAppAssetResponse,renderDashboardAppDocument } from "../src/web/dashboard-app.js";
import { registerDocsSite } from "../src/web/docs-site.js";
import type { DocsSite } from "../src/web/docs/types.js";
// @ts-ignore plain ESM dev tool
import { buildDocsSite } from "./build-docs.mjs";

process.env.DOCS_DRAFT ??= "1";
const port = Number(process.env.PORT ?? 8250);

const app = new Hono();
app.get("/assets/:asset",async (context) => (await dashboardAppAssetResponse(context.req.param("asset"))) ?? context.notFound());
app.all("*",async (context) => {
  // A fresh build per request, so an edited page shows on reload.
  let site: DocsSite;
  try { site = await buildDocsSite() as DocsSite; } catch (error) {
    return context.text(`docs build failed:\n\n${(error as Error).message}`,500);
  }
  const inner = new Hono();
  registerDocsSite(inner,{ releaseIdentity: "preview+local",signedIn: async () => false,renderDocument: renderDashboardAppDocument,site });
  inner.get("/",(c) => c.redirect("/docs"));
  return inner.fetch(context.req.raw);
});
serve({ fetch: app.fetch,port,hostname: "127.0.0.1" });
console.log(`docs preview on http://127.0.0.1:${port}/docs`);
