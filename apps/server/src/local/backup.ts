import { execFile } from "node:child_process";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import type { LocalLayout } from "./layout.js";

const run = promisify(execFile);

/** How many backups are kept; a new release's backup pushes the oldest out. */
export const BACKUPS_KEPT = 3;

const STAMP = /-(\d{8}T\d{6}Z)$/;
const stamp = (at: Date) => at.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");

/** A release as a folder name part: the version and build, never a path. */
const safeRelease = (release: string) => release.replace(/[^A-Za-z0-9._+]/g, "_").slice(0, 64) || "unknown";

/**
 * Copies the stopped database into backups/<release>-<timestamp>/ before a new release migrates it, and keeps the
 * newest three. The copy is an APFS clone (`cp -c`: instant, no extra space until the files change); a volume that
 * can't clone gets a plain copy. It is made beside its name first and renamed, so a half copy is never mistaken
 * for a backup. PostgreSQL must be stopped: the caller does that, a copy of a running database isn't one.
 */
export async function backupDatabase(layout: LocalLayout, release: string, at = new Date()): Promise<string> {
  const destination = path.join(layout.backups, `${safeRelease(release)}-${stamp(at)}`);
  const partial = `${destination}.partial`;
  await mkdir(layout.backups, { recursive: true, mode: 0o700 });
  await rm(partial, { recursive: true, force: true });
  try {
    // Windows has no cp, and the package carries no pg_dump: the stopped data folder is copied with Node (a file copy is
    // what the Mac's is too, so restoring is the same: replace db/ with the backup).
    if (process.platform === "darwin") {
      await run("cp", ["-c", "-R", layout.db, partial]).catch(async () => {
        await rm(partial, { recursive: true, force: true });
        await run("cp", ["-R", layout.db, partial]);
      });
    } else {
      await cp(layout.db, partial, { recursive: true, errorOnExist: true });
    }
    await rename(partial, destination);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw new Error(`couldn't back up the database before updating: ${error instanceof Error ? error.message : String(error)}`);
  }
  await pruneBackups(layout);
  return destination;
}

/** Deletes all but the newest BACKUPS_KEPT backups (by their timestamp); anything else in the folder is left alone. */
export async function pruneBackups(layout: LocalLayout, keep = BACKUPS_KEPT): Promise<string[]> {
  const entries = await readdir(layout.backups, { withFileTypes: true });
  const backups = entries
    .filter((entry) => entry.isDirectory() && STAMP.test(entry.name))
    .map((entry) => ({ name: entry.name, at: STAMP.exec(entry.name)![1]! }))
    .sort((a, b) => b.at.localeCompare(a.at) || b.name.localeCompare(a.name));
  const removed = backups.slice(keep).map((backup) => backup.name);
  await Promise.all(removed.map((name) => rm(path.join(layout.backups, name), { recursive: true, force: true })));
  return removed;
}
