// `relo setup --hooks`: Relo's session hooks in ONE harness settings file the owner chooses.
// Entries are recognized by their exact command prefix `relo hook `, so running setup again is a
// no-op and --remove deletes only Relo's entries (everyone else's hooks, keys and order stay).
// Never automatic: nothing but `relo setup --hooks` writes these files; doctor only reads them.
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { UsageError } from "./errors.mjs";
import { HOOK_HARNESSES } from "./commands/hook.mjs";
import { repositoryRoot } from "./setup.mjs";

export const HOOK_COMMAND_PREFIX = "relo hook ";
const EVENT_ORDER = ["start", "prompt", "tool", "stop", "end"];

/** Per harness: settings paths (docs: code.claude.com/docs/en/settings, geminicli.com/docs/hooks) and hook timeout. */
export const HOOK_TARGETS = {
  "claude-code": {
    global: ({ env, home }) => join(env.CLAUDE_CONFIG_DIR?.trim() ? resolve(env.CLAUDE_CONFIG_DIR.trim()) : join(home, ".claude"), "settings.json"),
    project: ({ cwd }) => join(repositoryRoot(cwd), ".claude", "settings.json"),
    timeout: 5, // seconds
    command: (event) => `${HOOK_COMMAND_PREFIX}${event}`,
  },
  gemini: {
    global: ({ home }) => join(home, ".gemini", "settings.json"),
    project: ({ cwd }) => join(repositoryRoot(cwd), ".gemini", "settings.json"),
    timeout: 5_000, // milliseconds
    command: (event) => `${HOOK_COMMAND_PREFIX}${event} --agent gemini`,
  },
};

export const HOOK_AGENT_NAMES = Object.keys(HOOK_TARGETS);
const ALIASES = { claude: "claude-code", "gemini-cli": "gemini" };

export function hookAgent(name) {
  const wanted = ALIASES[String(name ?? "claude-code").toLowerCase()] ?? String(name ?? "claude-code").toLowerCase();
  if (HOOK_AGENT_NAMES.includes(wanted)) return wanted;
  throw new UsageError(`Hooks are available for ${HOOK_AGENT_NAMES.join(" and ")}, not "${name}".`, {
    hint: "Without hooks nothing breaks: cards go stale on their own and end. For another harness, keep one card per session with RELO_SESSION.",
  });
}

/** Every settings file that may hold Relo hooks, with the harness and place each belongs to. */
export function hookCandidates({ env, home, cwd }) {
  return HOOK_AGENT_NAMES.flatMap((agent) => ["global", "project"].map((place) =>
    ({ agent, place, path: HOOK_TARGETS[agent][place]({ env, home, cwd }) })));
}

const isRelo = (hook) => typeof hook?.command === "string" && hook.command.startsWith(HOOK_COMMAND_PREFIX);

function layout(text) {
  const indent = text.match(/^([ \t]+)"/mu)?.[1] ?? "  ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const final = /(\r?\n)\s*$/u.test(text) ? eol : "";
  return { indent, eol, final, bom: text.startsWith("﻿") ? "﻿" : "" };
}

function render(settings, form) {
  const body = JSON.stringify(settings, null, form.indent);
  return form.bom + (form.eol === "\r\n" ? body.replaceAll("\n", "\r\n") : body) + form.final;
}

function parse(path, text) {
  let settings;
  try {
    settings = JSON.parse(text.replace(/^﻿/u, ""));
  } catch {
    throw new UsageError(`${path} is not plain JSON, so Relo will not edit it.`, { hint: "Fix the file (no comments or trailing commas), then run setup again." });
  }
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new UsageError(`${path} must hold a JSON object.`);
  }
  if (settings.hooks !== undefined && (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks))) {
    throw new UsageError(`${path}: "hooks" must be an object.`);
  }
  return settings;
}

const groupsOf = (settings, name) => (Array.isArray(settings.hooks?.[name]) ? settings.hooks[name] : []);

/** Which events hold a Relo hook in this file (harness event names). */
export function reloHookEvents(settings, agent) {
  const names = Object.keys(HOOK_HARNESSES[agent].events);
  return names.filter((name) => groupsOf(settings, name).some((group) => Array.isArray(group?.hooks) && group.hooks.some(isRelo)));
}

async function readIfPresent(path) {
  try { return await readFile(path, "utf8"); } catch (error) { if (error?.code === "ENOENT") return undefined; throw error; }
}

/** What installing (or removing) Relo's hooks does to one settings file: { action, content?, hooks, empty? }. */
export function planHooks(path, current, agent, { remove = false } = {}) {
  const target = HOOK_TARGETS[agent];
  const names = Object.entries(HOOK_HARNESSES[agent].events)
    .sort(([, a], [, b]) => EVENT_ORDER.indexOf(a) - EVENT_ORDER.indexOf(b)).map(([name]) => name);
  const eventOf = HOOK_HARNESSES[agent].events;
  if (current === undefined) {
    if (remove) return { action: "unchanged", hooks: [] };
  }
  const text = current ?? "";
  const form = current === undefined ? { indent: "  ", eol: "\n", final: "\n", bom: "" } : layout(text);
  const settings = current === undefined || text.trim() === "" ? {} : parse(path, text);
  const before = JSON.stringify(settings);

  if (remove) {
    const removedFrom = [];
    for (const name of Object.keys(settings.hooks ?? {})) {
      if (!Array.isArray(settings.hooks[name])) continue;
      const kept = [];
      let touched = false;
      for (const group of settings.hooks[name]) {
        if (!Array.isArray(group?.hooks) || !group.hooks.some(isRelo)) { kept.push(group); continue; }
        touched = true;
        const rest = group.hooks.filter((hook) => !isRelo(hook));
        if (rest.length > 0) kept.push({ ...group, hooks: rest });
      }
      if (!touched) continue;
      removedFrom.push(name);
      if (kept.length > 0) settings.hooks[name] = kept; else delete settings.hooks[name];
    }
    if (removedFrom.length === 0) return { action: "unchanged", hooks: [] };
    if (Object.keys(settings.hooks).length === 0) delete settings.hooks;
    const empty = Object.keys(settings).length === 0;
    return { action: "removed", hooks: names.filter((name) => removedFrom.includes(name)), empty, content: render(settings, form) };
  }

  settings.hooks ??= {};
  for (const name of names) {
    const wanted = { type: "command", command: target.command(eventOf[name]), timeout: target.timeout };
    const groups = Array.isArray(settings.hooks[name]) ? settings.hooks[name] : [];
    let found = false;
    const next = groups.map((group) => {
      if (!Array.isArray(group?.hooks) || !group.hooks.some(isRelo)) return group;
      found = true;
      let placed = false;
      const hooks = group.hooks.flatMap((hook) => {
        if (!isRelo(hook)) return [hook];
        if (placed) return [];
        placed = true;
        return [{ ...hook, ...wanted }];
      });
      return { ...group, hooks };
    });
    if (!found) next.push({ hooks: [wanted] });
    settings.hooks[name] = next;
  }
  const created = current === undefined;
  if (!created && JSON.stringify(settings) === before) return { action: "unchanged", hooks: names };
  return { action: created ? "created" : "updated", hooks: names, content: render(settings, form) };
}

export async function planHooksFile(path, agent, options) {
  const current = await readIfPresent(path);
  return { path, agent, current, plan: planHooks(path, current, agent, options) };
}

export async function commitHooks({ path, plan }, { makeDirectory = false } = {}) {
  if (plan.content === undefined) return;
  if (plan.action === "removed" && plan.empty) { await rm(path); return; }
  if (makeDirectory) await mkdir(dirname(path), { recursive: true });
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
      const events = reloHookEvents(settings ?? {}, candidate.agent);
      if (events.length > 0) found.push({ ...candidate, events });
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
