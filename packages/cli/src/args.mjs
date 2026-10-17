import { UsageError } from "./shared/errors.mjs";
import { findCommand, optionsOf } from "./registry.mjs";
import { OPTIONS } from "./shared/options.mjs";
import { optionHint } from "./suggest.mjs";

// An option's type comes from its definition (shared/options.mjs); a command entry may override it
// (`relo setup --project` is a flag, everywhere else --project names the work's project). --help, --json,
// --full and --version are global flags, except where a command defines one itself (`relo update --version X`).
const GLOBAL_FLAGS = new Set(["help", "json", "full", "version"]);

function optionType(name, positionals) {
  const entry = findCommand(positionals[0], positionals[1]);
  const override = entry?.types?.[name];
  if (override) return override;
  if (GLOBAL_FLAGS.has(name) && !(entry && optionsOf(entry).includes(name))) return "boolean";
  const definition = OPTIONS[name];
  if (!definition) return undefined;
  return definition.type === "boolean" ? "boolean" : definition.repeatable ? "repeatable" : "value";
}

const FORBIDDEN_SECRET_OPTIONS = new Set(["token", "api-token", "secret", "authorization"]);

export function parseArgs(argv) {
  const positionals = [];
  const options = { device: [], scope: [] };
  let afterSeparator = false;
  let separatorAt;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!afterSeparator && argument === "--") {
      afterSeparator = true;
      separatorAt = positionals.length;
      continue;
    }
    if (afterSeparator || !argument.startsWith("--")) {
      positionals.push(argument);
      continue;
    }

    const equalsAt = argument.indexOf("=");
    const name = argument.slice(2, equalsAt === -1 ? undefined : equalsAt);
    const inlineValue = equalsAt === -1 ? undefined : argument.slice(equalsAt + 1);
    if (FORBIDDEN_SECRET_OPTIONS.has(name)) {
      throw new UsageError(`--${name} is forbidden; credentials come from relo auth login (mode-0600 config file) or the RELO_TOKEN environment variable`);
    }
    const type = optionType(name, positionals);
    if (type === "boolean") {
      if (inlineValue !== undefined) throw new UsageError(`--${name} does not accept a value`);
      options[name] = true;
      continue;
    }
    if (type === undefined) {
      throw new UsageError(`Unknown option: --${name}`, { hint: optionHint(name, positionals, Object.keys(OPTIONS)) });
    }
    const value = inlineValue ?? argv[++index];
    if (value === undefined || value === "" || value.startsWith("--")) {
      throw new UsageError(`--${name} requires a value`);
    }
    if (type === "repeatable") {
      const values = options[name] ?? [];
      values.push(value);
      options[name] = values;
    }
    else if (options[name] !== undefined) throw new UsageError(`--${name} may only be specified once`);
    else options[name] = value;
  }

  return { positionals, options, ...(separatorAt === undefined ? {} : { separatorAt }) };
}
