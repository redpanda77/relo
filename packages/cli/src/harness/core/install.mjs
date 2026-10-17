// The `json-hooks-map` settings editor (plan 05 §3.1): reconciles one settings file to exactly the
// adapter's entries for a level. Relo's entries are those whose command starts with `relo hook `;
// everyone else's hooks, keys and order are untouched.
import { UsageError } from "../../shared/errors.mjs";

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

const isRelo = (hook) => typeof hook?.command === "string" && hook.command.startsWith(HOOK_COMMAND_PREFIX);
const canonical = (value) => JSON.stringify(value, Object.keys(value ?? {}).sort());
const roleOf = (hook) => hook.command.slice(HOOK_COMMAND_PREFIX.length).split(" ")[0];

/** Relo's groups per event in a parsed settings object (Relo-only groups, other hooks stripped). */
export function reloGroups(settings) {
  const out = {};
  for (const [event, groups] of Object.entries(settings?.hooks ?? {})) {
    if (!Array.isArray(groups)) continue;
    const mine = groups.filter((g) => Array.isArray(g?.hooks) && g.hooks.some(isRelo))
      .map((g) => ({ ...(g.matcher !== undefined ? { matcher: g.matcher } : {}), hooks: g.hooks.filter(isRelo) }));
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
  const mine = reloGroups(settings);
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
export function planLevel(path, current, level, adapter) {
  const { levels, entries, eventOrder } = adapter.install;
  if (!levels.includes(level)) throw new Error(`unknown hook level ${level}`);
  const form = current === undefined ? { indent: "  ", eol: "\n", final: "\n", bom: "" } : layout(current);
  const settings = current === undefined || current.trim() === "" ? {} : parseSettings(path, current);
  const before = JSON.stringify(settings);
  const had = reloGroups(settings);
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
  const wanted = entries(level);
  for (const event of eventOrder) if (wanted[event]) hooks[event] = [...(hooks[event] ?? []), ...wanted[event]];
  if (Object.keys(hooks).length > 0) settings.hooks = hooks; else delete settings.hooks;
  const changes = { before: Object.keys(had).sort(), after: Object.keys(wanted).sort() };
  if (current === undefined && level === "off") return { action: "unchanged", level, changes };
  if (JSON.stringify(settings) === before && current !== undefined) return { action: "unchanged", level, changes };
  const empty = Object.keys(settings).length === 0;
  const action = current === undefined ? "created" : level === "off" ? "removed" : "updated";
  return { action, level, empty, content: render(settings, form), changes };
}
