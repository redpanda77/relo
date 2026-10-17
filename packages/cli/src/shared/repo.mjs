// The repository a command runs in: the nearest folder above cwd that holds .git (a folder, or the file a
// worktree or submodule has).
import { existsSync } from "node:fs";
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
