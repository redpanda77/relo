// A harness descriptor's paths on this computer. Descriptor paths: "~/x" is under the home folder, a bare
// "x" under the harness's config folder; a project path is under the repository root. No descriptor is
// imported here, so a hook adapter resolves its own paths without loading every harness.
import { join, posix, resolve, win32 } from "node:path";
import { repositoryRoot } from "../shared/repo.mjs";

// Paths for the computer a probe describes: Windows' on win32 whatever the host, so a probe for a Windows computer
// resolves the same in its tests on macOS or Linux.
const pathsFor = (platform) => (platform === "win32" ? win32 : posix);

/** The harness's config folder ({ directory, custom }), or undefined when it has none here. */
export function configDirectory(harness, { env = {}, home, platform = process.platform }) {
  const { join, resolve } = pathsFor(platform);
  const config = harness?.config;
  if (!config) return undefined;
  if (config.at) {
    const directory = config.at({ env, home, platform });
    return directory === undefined ? undefined : { directory, custom: false };
  }
  const standard = resolve(join(home, config.home));
  const moved = config.variable && env[config.variable]?.trim() ? resolve(env[config.variable].trim()) : undefined;
  return { directory: moved ?? standard, custom: moved !== undefined && moved !== standard };
}

/** A descriptor path resolved for this computer, or undefined (no such file on this platform). */
export function harnessPath(harness, spec, probe) {
  if (spec === undefined) return undefined;
  const { join } = pathsFor(probe.platform ?? process.platform);
  if (spec.startsWith("~/")) return join(probe.home, spec.slice(2));
  const folder = configDirectory(harness, probe)?.directory;
  return folder === undefined ? undefined : join(folder, spec);
}

/** A project path from a descriptor, under the repository that holds `cwd`. */
export const projectPath = (spec, { cwd }) => (spec === undefined ? undefined : join(repositoryRoot(cwd), spec));

/**
 * A path a harness sent, kept only when it is absolute on macOS, Linux or Windows ("/Users/x", "C:\\x",
 * "\\\\server\\share") and of a sane length; anything else is undefined.
 */
export const absolutePath = (value) => (typeof value === "string" && value.length <= 4096 && !value.includes("\0")
  && (posix.isAbsolute(value) || win32.isAbsolute(value)) ? value : undefined);
