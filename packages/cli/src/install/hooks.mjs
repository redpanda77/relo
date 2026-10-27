// Relo's session hooks in a harness's settings file. Each harness adapter's `install` block says where its
// settings live and which entries each level wants; entries are recognized by their exact command prefix
// `relo hook `, so running setup again is a no-op and a lower --level (or uninstall) deletes only Relo's entries (everyone
// else's hooks, keys and order stay). Only relo setup (--level guide|optimize) and relo uninstall write these files.
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { ADAPTERS, ADAPTER_IDS } from "../harness/adapters/index.mjs";
import { HOOK_COMMAND_PREFIX, layout, parseSettings, planLevel, reloGroups, render } from "../harness/core/install.mjs";

export { HOOK_COMMAND_PREFIX, layout, parseSettings, render };
const HOOK_AGENT_NAMES = ADAPTER_IDS;

/** Every settings file that may hold Relo hooks, with the harness and place each belongs to. */
function hookCandidates({ env, home, cwd }) {
  return HOOK_AGENT_NAMES.flatMap((agent) => ["global", "project"].map((place) =>
    ({ agent, place, path: ADAPTERS[agent].install[place]({ env, home, cwd }) }))).filter(({ path }) => path !== undefined);
}

async function readIfPresent(path) {
  try { return await readFile(path, "utf8"); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

/**
 * What reconciling one settings file to a level does: { path, agent, current, plan }. A harness without command
 * hooks (OpenCode) has a runner, Relo's plugin that runs the file's commands: `plan.runner` { path, content? }
 * when it must be written (any level but off) or deleted (content undefined). `launch` ({ nodePath, entrypoint }: this
 * CLI) is written into the runner, so it runs this relo whatever PATH the harness's service has.
 */
export async function planLevelFile(path, agent, level, launch = {}) {
  const current = await readIfPresent(path);
  const plan = planLevel(path, current, level, ADAPTERS[agent], launch);
  const runner = ADAPTERS[agent].install.runner?.(path);
  if (runner) {
    const wanted = level === "off" ? undefined : runner.content(launch);
    if (await readIfPresent(runner.path) !== wanted) {
      plan.runner = { path: runner.path, content: wanted };
      if (plan.action === "unchanged") plan.action = wanted === undefined ? "removed" : "updated";
    }
  }
  return { path, agent, current, plan };
}

export async function commitLevel({ path, plan }) {
  if (plan.runner) {
    if (plan.runner.content === undefined) await rm(plan.runner.path, { force: true });
    else { await mkdir(dirname(plan.runner.path), { recursive: true }); await writeFile(plan.runner.path, plan.runner.content); }
  }
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
      const events = Object.keys(reloGroups(settings ?? {}, ADAPTERS[candidate.agent]))
        .sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));
      if (events.length > 0) found.push({ ...candidate, events, settings });
    } catch { /* absent or not plain JSON */ }
  }
  return found;
}

