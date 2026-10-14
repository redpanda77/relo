// `relo setup --hooks`: Relo's session hooks in ONE harness settings file the owner chooses. Each
// harness adapter's `install` block says where its settings live and which entries each level wants;
// entries are recognized by their exact command prefix `relo hook `, so running setup again is a no-op
// and `--hooks off` deletes only Relo's entries (everyone else's hooks, keys and order stay).
// Never automatic: nothing but `relo setup --hooks` and `relo hooks off` writes these files; doctor only reads them.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { UsageError } from "./errors.mjs";
import { ADAPTERS, ADAPTER_IDS, adapterFor } from "./harness/adapters/index.mjs";
import { HOOK_COMMAND_PREFIX, layout, parseSettings, planLevel, reloGroups, render } from "./harness/core/install.mjs";

export { HOOK_COMMAND_PREFIX, layout, parseSettings, render };
export const HOOK_AGENT_NAMES = ADAPTER_IDS;

export function hookAgent(name) {
  const adapter = adapterFor(name ?? undefined);
  if (adapter) return adapter.id;
  throw new UsageError(`Hooks are available for ${HOOK_AGENT_NAMES.join(" and ")}, not "${name}".`, {
    hint: "Without hooks nothing breaks: cards go stale on their own and end. For another harness, keep one card per session with RELO_SESSION.",
  });
}

/** Every settings file that may hold Relo hooks, with the harness and place each belongs to. */
export function hookCandidates({ env, home, cwd }) {
  return HOOK_AGENT_NAMES.flatMap((agent) => ["global", "project"].map((place) =>
    ({ agent, place, path: ADAPTERS[agent].install[place]({ env, home, cwd }) })));
}

async function readIfPresent(path) {
  try { return await readFile(path, "utf8"); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

/** What reconciling one settings file to a level does: { path, agent, current, plan }. */
export async function planLevelFile(path, agent, level) {
  const current = await readIfPresent(path);
  return { path, agent, current, plan: planLevel(path, current, level, ADAPTERS[agent]) };
}

export async function commitLevel({ path, plan }) {
  if (plan.content === undefined) return;
  if (plan.action === "removed" && plan.empty) { await rm(path); return; }
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, plan.content);
}

/** Files that hold Relo hooks right now: [{ agent, place, path, events }]. Reads only; unreadable files are skipped. */
export function findHooks({ env, home, cwd }) {
  const found = [];
  const seen = new Set();
  for (const candidate of hookCandidates({ env, home, cwd })) {
    if (seen.has(candidate.path)) continue;
    seen.add(candidate.path);
    try {
      const settings = JSON.parse(readFileSync(candidate.path, "utf8").replace(/^﻿/u, ""));
      const order = ADAPTERS[candidate.agent].install.eventOrder;
      const events = Object.keys(reloGroups(settings ?? {}))
        .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
      if (events.length > 0) found.push({ ...candidate, events, settings });
    } catch { /* absent or not plain JSON */ }
  }
  return found;
}

/** Informational, for `relo doctor --full`: where Relo's hooks are and which events they cover. */
export function inspectHooks({ env, home, cwd }) {
  const found = findHooks({ env, home, cwd });
  return found.length === 0 ? { state: "none" }
    : { state: "set", files: found.map(({ path, agent, events }) => ({ file: path.startsWith(home) ? `~${path.slice(home.length)}` : path, agent, events })) };
}

export async function fileExists(path) {
  try { await stat(path); return true; } catch { return false; }
}
