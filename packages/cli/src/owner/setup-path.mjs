// `relo setup --path`: the folder `relo` lives in, on PATH.
// POSIX, by the install script's rule (apps/server/src/computer-invites.ts installScript): every one of .profile,
// .bashrc and .zshrc that exists gets the line when it does not mention .local/bin; when none exists, the one for
// $SHELL is created. Idempotent.
// Windows: %LOCALAPPDATA%\Relo\bin joins the USER Path in the registry (windows-path.mjs); never the machine Path.
import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { windowsPaths } from "./windows-launcher.mjs";
import { addToUserPath, removeFromUserPath } from "./windows-path.mjs";

const FILES = [".profile", ".bashrc", ".zshrc"];
const LINE = 'export PATH="$HOME/.local/bin:$PATH"';

const shellFile = (shell) => (/\/zsh$/u.test(shell) ? ".zshrc" : /\/bash$/u.test(shell) ? ".bashrc" : ".profile");

/**
 * Returns { bin, changed: [file names written or that would be], unchanged: [file names already set] }.
 * On win32, changed/unchanged hold "user Path" and `bin` is the launcher folder; `run` is the registry runner.
 */
export async function putOnPath({ home, env = {}, dryRun = false, platform = process.platform, run }) {
  if (platform === "win32") {
    const bin = windowsPaths({ home, env }).bin;
    const { changed } = await addToUserPath(bin, { run, env, dryRun });
    return { bin, changed: changed ? ["user Path"] : [], unchanged: changed ? [] : ["user Path"] };
  }
  const changed = [];
  const unchanged = [];
  const existing = FILES.filter((name) => existsSync(join(home, name)));
  for (const name of existing) {
    const file = join(home, name);
    if (readFileSync(file, "utf8").includes(".local/bin")) { unchanged.push(`~/${name}`); continue; }
    if (!dryRun) appendFileSync(file, `\n${LINE}\n`);
    changed.push(`~/${name}`);
  }
  if (existing.length === 0) {
    const name = shellFile(String(env.SHELL ?? ""));
    if (!dryRun) writeFileSync(join(home, name), `${LINE}\n`);
    changed.push(`~/${name}`);
  }
  return { bin: "~/.local/bin", changed, unchanged };
}

/** Windows uninstall: removes only Relo's own entry from the user Path. */
export async function takeOffPath({ home, env = {}, dryRun = false, run }) {
  return removeFromUserPath(windowsPaths({ home, env }).bin, { run, env, dryRun });
}
