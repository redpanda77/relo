import { resolve } from "node:path";
import { requireText } from "../shared/validate.mjs";
import { UsageError } from "../shared/errors.mjs";
import { fallbackProject, projectLabel } from "../shared/identity.mjs";
import { result } from "../shared/outcome.mjs";
import { namedPlace } from "../shared/repo.mjs";
import { envSetting } from "../shared/settings.mjs";

const USAGE = "Usage: relo project [NAME] [--clear]";

/** The project cards started here get, and where it comes from: env, config (a saved name), git or folder. */
function describe(dependencies, names) {
  const { env, cwd } = dependencies;
  const place = namedPlace(cwd, { names });
  const project = projectLabel(env, cwd, undefined, names) ?? fallbackProject(undefined, dependencies);
  const via = envSetting("project", env) ? "RELO_PROJECT" : place?.via ?? "folder";
  return { project: project ?? null, via };
}

/**
 * `relo project [NAME] [--clear]`: the project name for this place, saved in Relo's own config (never a file in
 * the folder) under the nearest named place: the folder a name was saved for, else the repository, else this folder.
 */
export async function runProjectCommand(command) {
  const { options, group, action, rest, dependencies } = command;
  if (group !== "project") return undefined;
  const words = [action, ...rest].filter((word) => word !== undefined);
  if (words.length > 1 || (words.length === 1 && options.clear)) throw new UsageError(USAGE);
  const names = dependencies.loadProjects?.() ?? {};
  if (words.length === 0 && !options.clear) return result("project", describe(dependencies, names));

  const name = options.clear ? undefined : requireText(words[0], "Project name", 120);
  const place = namedPlace(dependencies.cwd, { names });
  const key = place?.root ?? resolve(dependencies.cwd);
  const path = dependencies.configPath();
  const config = await dependencies.loadStoredConfig(path);
  const projects = { ...config.projects };
  if (name === undefined) delete projects[key];
  else projects[key] = name;
  await dependencies.writeConfig(path, { ...config, projects }, { expectedRevision: config.revision });
  return result("project", { ...describe(dependencies, projects), ...(name === undefined ? { cleared: true } : { saved: true }) });
}
