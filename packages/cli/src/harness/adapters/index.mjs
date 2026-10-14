// The built-in harness adapters, by id. Adding a harness is adding a module here; nothing in the core
// changes (ADR 0008 principle 12).
import claudeCode from "./claude-code/index.mjs";
import gemini from "./gemini/index.mjs";

export const ADAPTERS = Object.freeze({ [claudeCode.id]: claudeCode, [gemini.id]: gemini });
export const DEFAULT_ADAPTER = claudeCode.id;
export const ADAPTER_IDS = Object.freeze(Object.keys(ADAPTERS));

/** The adapter for an id or alias (case-insensitive), or undefined. */
export function adapterFor(name = DEFAULT_ADAPTER) {
  const wanted = String(name).toLowerCase();
  return ADAPTERS[wanted] ?? Object.values(ADAPTERS).find((adapter) => adapter.aliases?.includes(wanted));
}
