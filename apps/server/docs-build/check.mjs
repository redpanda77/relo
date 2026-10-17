// `node apps/server/docs-build/check.mjs`: build the docs in memory and report problems; writes nothing.
// DOCS_DRAFT=1 allows pages that are still stubs (while the docs are being written).
import { buildDocsSite } from "./build-docs.mjs";

try {
  const site = await buildDocsSite();
  console.log(`docs ok: ${site.pages.length} pages`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
