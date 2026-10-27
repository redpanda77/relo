// The hook path's adapter loader: a hook imports only the adapter of the harness it runs for, not every adapter
// (startup-budget.test.mjs). One loader per id in adapters/index.mjs (catalog.test.mjs holds them equal);
// an alias or unknown name falls back to that index.
const LOADERS = Object.freeze({
  antigravity: () => import("./antigravity/index.mjs"),
  "claude-code": () => import("./claude-code/index.mjs"),
  codex: () => import("./codex/index.mjs"),
  gemini: () => import("./gemini/index.mjs"),
  opencode: () => import("./opencode/index.mjs"),
});

export const LOADER_IDS = Object.freeze(Object.keys(LOADERS));

/** The adapter for an id or alias (case-insensitive), or undefined; the default is Claude Code's, like adapterFor. */
export async function loadAdapter(name = "claude-code") {
  const load = LOADERS[String(name).toLowerCase()];
  if (load) return (await load()).default;
  return (await import("./index.mjs")).adapterFor(name);
}
