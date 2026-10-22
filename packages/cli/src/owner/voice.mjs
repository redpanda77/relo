import { resolve } from "node:path";
import { UsageError } from "../shared/errors.mjs";
import { VOICE_LEVELS } from "../shared/config.mjs";
import { result } from "../shared/outcome.mjs";
import { namedPlace } from "../shared/repo.mjs";
import { voiceSetting } from "../work/spoken.mjs";

const USAGE = `Usage: relo voice [${VOICE_LEVELS.join("|")}] [--here] [--clear]`;

const SOURCES = { env: "RELO_VOICE", project: "this repository or folder (relo voice --here)", config: "the default (relo voice)", default: "Relo's default" };

/** The level work started here gets, and where it comes from. */
function describe(dependencies) {
  const { level, via } = voiceSetting(dependencies);
  return { voice: level, via };
}

const message = ({ voice, via }) => `Voice here: ${voice}, from ${SOURCES[via]}. ${{
  off: "Relo for Mac says nothing of work started here.",
  brief: "Relo for Mac says only the kind and the work's name.",
  full: "Relo for Mac says the kind, the name and what happened.",
  verbose: "Relo for Mac says the kind, the name, what happened and each finished step.",
}[voice]}`;

/**
 * `relo voice [LEVEL] [--here] [--clear]` (ADR 0015 revision 1): how much Relo for Mac may say of work started on
 * this computer, saved in Relo's own config: the default for every project, or with --here for the nearest
 * repository or folder only. The level rides each card sealed; the Mac says the lower of it and its own setting.
 */
export async function runVoiceCommand(command) {
  const { options, group, action, rest, dependencies } = command;
  if (group !== "voice") return undefined;
  const words = [action, ...rest].filter((word) => word !== undefined);
  if (words.length > 1 || (words.length === 1 && options.clear)) throw new UsageError(USAGE);
  if (words.length === 0 && !options.clear) {
    const now = describe(dependencies);
    return result("voice", now, { message: message(now) });
  }
  const level = options.clear ? undefined : String(words[0]).toLowerCase();
  if (level !== undefined && !VOICE_LEVELS.includes(level)) throw new UsageError(USAGE);

  const path = dependencies.configPath();
  const config = await dependencies.loadStoredConfig(path);
  const voices = { ...config.voices };
  let key = "*";
  if (options.here) {
    const place = namedPlace(dependencies.cwd, { names: voices });
    key = place?.root ?? resolve(dependencies.cwd);
  }
  if (level === undefined) delete voices[key];
  else voices[key] = level;
  await dependencies.writeConfig(path, { ...config, voices }, { expectedRevision: config.revision });
  const next = { ...dependencies, loadVoices: () => voices };
  const now = describe(next);
  return result("voice", { ...now, ...(options.here ? { place: key } : {}), ...(level === undefined ? { cleared: true } : { saved: true }) }, { message: message(now) });
}
