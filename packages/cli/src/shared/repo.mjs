// The repository a command runs in: the nearest folder above cwd that holds .git (a folder, or the file a
// worktree or submodule has).
import { existsSync, readFileSync, statSync } from "node:fs";
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

/**
 * The name a repository root goes by: its folder, except in a linked worktree, whose .git is a file pointing into
 * the main repository (gitdir: <main>/.git/worktrees/<name>): the project is the main repository, never the
 * worktree folder an agent or tool happened to create. A submodule keeps its own folder name.
 */
export function rootName(root, { read = (path) => (statSync(path).isFile() ? readFileSync(path, "utf8") : undefined) } = {}) {
  try {
    const gitdir = /^gitdir:\s*(.+?)\s*$/mu.exec(read(join(root, ".git")) ?? "")?.[1];
    const main = gitdir && /^(.*?)[\\/]\.git[\\/]worktrees[\\/][^\\/]+[\\/]?$/u.exec(resolve(root, gitdir))?.[1];
    if (main) return basename(main);
  } catch { /* unreadable: the folder name */ }
  return basename(root);
}

/** The repository root, or `cwd` itself outside a repository (where setup writes project files). */
export const repositoryRoot = (cwd) => findRepositoryRoot(cwd) ?? resolve(cwd);

/** The repository's folder name (the default project), or undefined outside a repository. */
export function repositoryName(cwd, exists = existsSync) {
  const root = findRepositoryRoot(cwd, exists);
  return root === undefined ? undefined : rootName(root);
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
    if (exists(join(current, ".git"))) return { name: rootName(current), via: "git", root: current };
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
