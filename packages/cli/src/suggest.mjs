// "Did you mean …?" for mistyped commands and options. Candidates come from schema.mjs, which
// test/schema.test.mjs pins to what the CLI really accepts.
import { COMMANDS, findCommand, optionsOf } from "./registry.mjs";

/** Optimal-string-alignment distance: insert, delete, substitute or swap two neighbours. */
export function editDistance(a, b) {
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) rows[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      rows[i][j] = Math.min(rows[i - 1][j] + 1, rows[i][j - 1] + 1, rows[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        rows[i][j] = Math.min(rows[i][j], rows[i - 2][j - 2] + 1);
      }
    }
  }
  return rows[a.length][b.length];
}

/** The nearest candidate within two edits (and fewer edits than the word has letters). */
export function closest(word, candidates, maximum = 2) {
  const lowered = String(word).toLowerCase();
  let best;
  for (const candidate of candidates) {
    const distance = editDistance(lowered, candidate.toLowerCase());
    if (distance <= maximum && distance < Math.max(2, lowered.length)
      && (best === undefined || distance < best.distance)) best = { candidate, distance };
  }
  return best?.candidate;
}

const publicCommands = COMMANDS.filter((command) => !command.internal);
const GLOBAL_OPTIONS = ["json", "full", "help"];

const commandFor = (words) => findCommand(words[0], words[1]);

/** A hint for `Unknown option: --name`, given the positionals typed so far. */
export function optionHint(name, words, allOptions = []) {
  const command = commandFor(words);
  const options = command ? optionsOf(command) : [];
  const valid = command ? [...options, ...GLOBAL_OPTIONS] : [...new Set([...allOptions, ...GLOBAL_OPTIONS])];
  const near = closest(name, valid);
  if (near) return `Did you mean --${near}?`;
  if (command && options.length > 0 && options.length <= 12) {
    return `Options for ${command.name}: ${options.map((option) => `--${option}`).join(" ")}`;
  }
  return "Every flag: relo help all";
}

const groups = [...new Set(COMMANDS.map((command) => command.name.split(" ")[0]))];
const actionsOf = (group) => COMMANDS.filter((command) => command.name.startsWith(`${group} `))
  .map((command) => command.name.split(" ")[1]);

/** `relo hooks` with no action: a group whose commands all take one (the message names them, not "Unknown command"). */
export function missingAction(group, action) {
  if (action !== undefined || COMMANDS.some((command) => command.name === group)) return false;
  return actionsOf(group).length > 0;
}

/**
 * Whether `group action` can be a command at all; a hint when it cannot, else undefined.
 * Words after a bare command such as `ask` or `notify` are its text, not an action.
 */
export function unknownCommandHint(group, action) {
  const bare = COMMANDS.some((command) => command.name === group && !command.name.includes(" "));
  if (bare || group === "notify") return undefined;
  if (!groups.includes(group)) {
    const near = closest(group, publicCommands.map((command) => command.name.split(" ")[0]));
    return near ? `Did you mean ${near}?` : "Commands: relo help all";
  }
  const actions = actionsOf(group);
  if (action !== undefined && actions.includes(action)) return undefined;
  const near = action === undefined ? undefined : closest(action, actions);
  return near ? `Did you mean ${group} ${near}?` : `${group} takes: ${actions.join(", ")}`;
}

/**
 * `relo schema work update`, `work.update`, `ask doctor`: the commands those words name.
 * A group word alone ("activity") selects every action of the group. Returns { commands } or { error, hint }.
 */
export function selectSchemaCommands(words) {
  const tokens = words.flatMap((word) => String(word).split(".")).filter(Boolean);
  const names = publicCommands.map((command) => command.name);
  const named = (name) => COMMANDS.filter((command) => command.name === name || command.alias === name);
  const picked = [];
  let group;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    let found = group === undefined ? [] : named(`${group} ${token}`);
    if (found.length === 0 && groups.includes(token) && !COMMANDS.some((command) => command.name === token)) {
      group = token;
      const action = tokens[index + 1];
      if (action !== undefined && named(`${group} ${action}`).length > 0) continue;
      found = COMMANDS.filter((command) => command.name.startsWith(`${group} `));
    } else if (found.length === 0) {
      found = named(token);
    }
    if (found.length === 0) {
      const near = (group === undefined ? undefined : closest(`${group} ${token}`, names)) ?? closest(token, names) ?? closest(token, groups);
      return { error: `Unknown command: ${token}`, hint: near ? `Did you mean ${near}?` : `Commands: ${names.join(", ")}` };
    }
    for (const command of found) if (!picked.includes(command)) picked.push(command);
  }
  return { commands: picked };
}
