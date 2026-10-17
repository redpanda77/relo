// Every command, from the spec file of the module that owns it. An entry is data: its name, summary,
// positionals and options (relo schema and help render them), and either a handler { load, run, auth?,
// dryRunnable? } or `variants` with one handler per producer type ("agent" serves agent sessions and
// unidentified callers, "script" scripts and apps). Loading the registry loads no handler.
import { WORK_COMMANDS, WORK_GROUP } from "./work/spec.mjs";
import { MESSAGE_COMMANDS } from "./messages/spec.mjs";
import { SCRIPT_COMMANDS } from "./script/spec.mjs";
import { OWNER_COMMANDS } from "./owner/spec.mjs";
import { HARNESS_COMMANDS } from "./harness/spec.mjs";
import { ROOT_COMMANDS } from "./root-spec.mjs";

export const COMMANDS = Object.freeze([...WORK_COMMANDS, ...MESSAGE_COMMANDS, ...SCRIPT_COMMANDS, ...OWNER_COMMANDS, ...HARNESS_COMMANDS, ...ROOT_COMMANDS]);

// An alias is another name for the same command: `relo notify TEXT` is notify send, `relo work state` is state.
const BY_NAME = new Map(COMMANDS.flatMap((entry) => [[entry.name, entry], ...(entry.alias ? [[entry.alias, entry]] : [])]));

/** The options an entry documents: its own list, else every variant's, in order. */
export const optionsOf = (entry) => entry.options ?? [...new Set(Object.values(entry.variants ?? {}).flatMap((variant) => variant.options ?? []))];

/** Groups that answer an unknown action themselves rather than with "Unknown command". */
const GROUP_HANDLERS = new Map([["work", WORK_GROUP]]);

/** The entry for `group action` (or the one-word `group`), else the group's shared handler; undefined when unknown. */
export function findCommand(group, action) {
  return BY_NAME.get(`${group} ${action}`) ?? BY_NAME.get(group) ?? GROUP_HANDLERS.get(group);
}

/** The handler that serves this caller's producer type ("agent", "script" or "owner"). */
export function handlerFor(entry, surface) {
  return entry.variants ? entry.variants[surface] : entry;
}

/**
 * `relo admin X …`: administration's own commands (admin works, admin finish), or a cross-session view
 * marked `admin: true` (sessions, the card lookups), run as the owner. Undefined for anything else.
 */
export function findAdminCommand(group, action) {
  const own = BY_NAME.get(`admin ${group}`);
  if (own) return { entry: own, words: 1 };
  const view = findCommand(group, action);
  return view?.admin ? { entry: view, words: view.name.split(" ").length } : undefined;
}
