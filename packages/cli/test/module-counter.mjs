// Preloaded with `--import` by the startup budget test: on exit, prints the package modules the process
// loaded as one JSON line on stderr, so a test can pin what a command pays for at startup.
import { registerHooks } from "node:module";

const PACKAGE = new URL("../", import.meta.url).href;
const loaded = new Set();
registerHooks({
  load(url, context, next) {
    if (url.startsWith(PACKAGE) && !url.includes("/test/")) loaded.add(url.slice(PACKAGE.length));
    return next(url, context);
  },
});
process.on("exit", () => process.stderr.write(`${JSON.stringify({ reloModules: [...loaded].sort() })}\n`));
