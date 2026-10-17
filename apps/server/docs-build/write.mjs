// `pnpm --filter @relo/server docs:build`: rebuild src/web/docs/site.generated.ts from docs/site.
import { writeFileSync } from "node:fs";
import { buildDocsSite, siteModuleSource } from "./build-docs.mjs";

const site = await buildDocsSite();
writeFileSync(new URL("../src/web/docs/site.generated.ts", import.meta.url), siteModuleSource(site));
console.log(`docs: ${site.pages.length} pages`);
