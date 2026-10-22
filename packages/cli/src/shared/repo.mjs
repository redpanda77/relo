// The repository a command runs in: the nearest folder above cwd that holds .git (a folder, or the file a
// worktree or submodule has).
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

/** The repository root above `cwd`, or undefined outside a repository. */
function findRepositoryRoot(cwd, exists = existsSync) {
  let current = resolve(cwd);
  for (;;) {
    if (exists(join(current, ".git"))) return current;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The repository root, or `cwd` itself outside a repository (where setup writes project files). */
export const repositoryRoot = (cwd) => findRepositoryRoot(cwd) ?? resolve(cwd);

/** The repository's folder name (the default project), or undefined outside a repository. */
export function repositoryName(cwd, exists = existsSync) {
  const root = findRepositoryRoot(cwd, exists);
  return root === undefined ? undefined : basename(root);
}

/**
 * The project the nearest named place above `cwd` gives: a folder named with `relo project NAME` (`names`,
 * keyed by absolute path) or a repository, whichever is closer, so a name saved for a repository or a folder
 * inside one wins over the repository's own name, and a repository inside a named folder keeps its own.
 * { name, via: "config"|"git", root } or undefined when no folder above is either.
 */
export function namedPlace(cwd, { exists = existsSync, names = {} } = {}) {
  let current = resolve(cwd);
  for (;;) {
    if (typeof names[current] === "string") return { name: names[current], via: "config", root: current };
    if (exists(join(current, ".git"))) return { name: basename(current), via: "git", root: current };
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

/** The working folder's own name, the last fallback; the home folder is "Home", never the login name. */
export function folderName(cwd, home = homedir()) {
  const path = resolve(cwd);
  if (path === resolve(home)) return "Home";
  return basename(path) || undefined;
}
