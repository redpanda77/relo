// The `json-hooks-map` settings editor (plan 05 §3.1): reconciles one settings file to exactly the
// adapter's entries for a level. Relo's entries are those whose command starts with `relo hook `;
// everyone else's hooks, keys and order are untouched. An adapter whose file holds named hooks
// (`install.named`, Antigravity: { "<hook name>": { Event: [...] } }) gets one named hook of Relo's own, read and
// written here in the same { Event: [group] } shape: its `inline` events list handlers without a group.
import { UsageError } from "../../shared/errors.mjs";
import { bareCommand, isReloHookCommand, reloRest } from "./launch.mjs";

export const HOOK_COMMAND_PREFIX = "relo hook ";

export function layout(text) {
  const indent = text.match(/^([ \t]+)"/mu)?.[1] ?? "  ";
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const final = /(\r?\n)\s*$/u.test(text) ? eol : "";
  return { indent, eol, final, bom: text.startsWith("\uFEFF") ? "\uFEFF" : "" };
}

export function render(settings, form) {
  const body = JSON.stringify(settings, null, form.indent);
  return form.bom + (form.eol === "\r\n" ? body.replaceAll("\n", "\r\n") : body) + form.final;
}

export function parseSettings(path, text) {
  let settings;
  try {
    settings = JSON.parse(text.replace(/^\uFEFF/u, ""));
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

// Bare (`relo hook x`) or absolute (`"node" "relo.mjs" hook x`, written on Windows): both are Relo's.
const isRelo = (hook) => isReloHookCommand(hook?.command);
const canonical = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort());
const roleOf = (hook) => reloRest(hook.command).slice("hook ".length).split(" ")[0];

/** The hook events of a parsed settings file as { Event: [group] }: its `hooks`, or the adapter's named hook. */
function hookEvents(settings, adapter) {
  const named = adapter?.install?.named;
  if (!named) return settings?.hooks ?? {};
  const own = settings?.[named.key];
  if (!own || typeof own !== "object" || Array.isArray(own)) return {};
  return Object.fromEntries(Object.entries(own).filter(([, value]) => Array.isArray(value))
    .map(([event, value]) => [event, named.inline.includes(event) ? [{ hooks: value }] : value]));
}

/** The adapter's named hook for { Event: [group] } entries, in its file's own shape. */
function namedHook(entries, adapter) {
  const { named, eventOrder } = adapter.install;
  return Object.fromEntries(eventOrder.filter((event) => entries[event])
    .map((event) => [event, named.inline.includes(event) ? entries[event].flatMap((g) => g.hooks) : entries[event]]));
}

/** Relo's groups per event in a parsed settings object (Relo-only groups, other hooks stripped). */
export function reloGroups(settings, adapter) {
  const out = {};
  for (const [event, groups] of Object.entries(hookEvents(settings, adapter))) {
    if (!Array.isArray(groups)) continue;
    const mine = groups.filter((g) => Array.isArray(g?.hooks) && g.hooks.some(isRelo))
      .map((g) => ({ ...(g.matcher !== undefined ? { matcher: g.matcher } : {}), hooks: g.hooks.filter(isRelo).map((h) => ({ ...h, command: bareCommand(h.command) })) }));
    if (mine.length > 0) out[event] = mine;
  }
  return out;
}

const signature = (groups) => JSON.stringify(Object.keys(groups).sort().map((event) =>
  [event, groups[event].map((g) => [g.matcher ?? null, g.hooks.map((h) => canonical(h))])]));

/**
 * { level: <one of the adapter's levels> | legacy | custom, outdated: string[], nearest? }. legacy: Relo
 * entries that use none of the commands of the adapter's first level (an install from an older CLI).
 * nearest: for a custom set, the lowest level that runs all of its hook commands (options drifted, or an
 * older smaller set), which relo setup --refresh rewrites it to.
 */
export function inferLevel(settings, adapter) {
  const { levels, entries } = adapter.install;
  const mine = reloGroups(settings, adapter);
  if (Object.keys(mine).length === 0) return { level: "off", outdated: [] };
  for (const level of levels) if (level !== "off" && signature(entries(level)) === signature(mine)) return { level, outdated: [] };
  const roles = new Set(Object.values(mine).flatMap((gs) => gs.flatMap((g) => g.hooks.map(roleOf))));
  const first = levels.find((level) => level !== "off");
  const anchors = new Set(Object.values(entries(first)).flatMap((gs) => gs.flatMap((g) => g.hooks.map(roleOf))));
  const legacy = ![...roles].some((role) => anchors.has(role));
  // A level that runs every command found: the same set with drifted options, or a smaller older set (the
  // retired reminders level is the local half of presence), which refresh rewrites to the lowest such level.
  const same = (level) => {
    const wanted = new Set(Object.values(entries(level)).flatMap((gs) => gs.flatMap((g) => g.hooks.map(roleOf))));
    return [...roles].every((role) => wanted.has(role));
  };
  const nearest = legacy ? undefined : levels.find((level) => level !== "off" && same(level));
  return { level: legacy ? "legacy" : "custom", outdated: Object.keys(mine).sort(), ...(nearest ? { nearest } : {}) };
}

/** { action: created|updated|unchanged|removed, level, content?, empty?, changes: {before, after} } */
export function planLevel(path, current, level, adapter, launch) {
  const { levels, entries, eventOrder } = adapter.install;
  if (!levels.includes(level)) throw new Error(`unknown hook level ${level}`);
  const form = current === undefined ? { indent: "  ", eol: "\n", final: "\n", bom: "" } : layout(current);
  const settings = current === undefined || current.trim() === "" ? {} : parseSettings(path, current);
  const before = JSON.stringify(settings);
  const had = reloGroups(settings, adapter);
  const wanted = entries(level, launch);
  const changes = { before: Object.keys(had).sort(), after: Object.keys(wanted).sort() };
  if (adapter.install.named) {
    // Relo's named hook is rewritten whole; the owner's `enabled` switch on it is kept.
    const { key } = adapter.install.named;
    const own = settings[key];
    const enabled = own && typeof own === "object" && !Array.isArray(own) ? own.enabled : undefined;
    delete settings[key];
    if (Object.keys(wanted).length > 0) settings[key] = { ...(enabled === undefined ? {} : { enabled }), ...namedHook(wanted, adapter) };
    return outcome({ current, level, settings, before, form, changes });
  }
  const hooks = settings.hooks ?? {};
  for (const event of Object.keys(hooks)) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = hooks[event].flatMap((g) => {
      if (!Array.isArray(g?.hooks) || !g.hooks.some(isRelo)) return [g];
      const rest = g.hooks.filter((h) => !isRelo(h));
      return rest.length > 0 ? [{ ...g, hooks: rest }] : [];
    });
    if (kept.length > 0) hooks[event] = kept; else delete hooks[event];
  }
  for (const event of eventOrder) if (wanted[event]) hooks[event] = [...(hooks[event] ?? []), ...wanted[event]];
  if (Object.keys(hooks).length > 0) settings.hooks = hooks; else delete settings.hooks;
  return outcome({ current, level, settings, before, form, changes });
}

function outcome({ current, level, settings, before, form, changes }) {
  if (current === undefined && level === "off") return { action: "unchanged", level, changes };
  if (JSON.stringify(settings) === before && current !== undefined) return { action: "unchanged", level, changes };
  const empty = Object.keys(settings).length === 0;
  const action = current === undefined ? "created" : level === "off" ? "removed" : "updated";
  return { action, level, empty, content: render(settings, form), changes };
}
