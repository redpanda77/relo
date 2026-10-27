import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { backupDatabase, BACKUPS_KEPT, pruneBackups } from "./backup.js";
import { ensureLayout, localLayout } from "./layout.js";

async function install() {
  const layout = localLayout(await mkdtemp(path.join(tmpdir(), "relo-backup-")));
  await ensureLayout(layout);
  await mkdir(path.join(layout.db, "base"), { recursive: true });
  await writeFile(path.join(layout.db, "PG_VERSION"), "17\n");
  await writeFile(path.join(layout.db, "base", "1"), "rows");
  return layout;
}

describe("backups before a new release migrates", () => {
  it("copies the database whole into backups/<release>-<timestamp>", async () => {
    const layout = await install();
    const copy = await backupDatabase(layout, "0.19.0 (42)", new Date("2026-10-23T10:11:12Z"));
    expect(path.basename(copy)).toBe("0.19.0__42_-20261023T101112Z");
    expect(await readFile(path.join(copy, "base", "1"), "utf8")).toBe("rows");
    expect(await readFile(path.join(copy, "PG_VERSION"), "utf8")).toBe("17\n");
    // The original is untouched, and no half copy is left.
    expect(await readFile(path.join(layout.db, "base", "1"), "utf8")).toBe("rows");
    expect((await readdir(layout.backups)).filter((name) => name.endsWith(".partial"))).toEqual([]);
  });

  it("keeps the newest three, by timestamp, and leaves other files alone", async () => {
    const layout = await install();
    await writeFile(path.join(layout.backups, "notes.txt"), "mine");
    for (const day of ["20", "21", "22", "23", "24"]) {
      await backupDatabase(layout, day === "22" ? "2.0.0" : "1.0.0", new Date(`2026-10-${day}T09:00:00Z`));
    }
    expect(BACKUPS_KEPT).toBe(3);
    expect((await readdir(layout.backups)).sort()).toEqual([
      "1.0.0-20261023T090000Z", "1.0.0-20261024T090000Z", "2.0.0-20261022T090000Z", "notes.txt",
    ]);
    expect(await pruneBackups(layout)).toEqual([]);
  });

  it("fails clearly, leaving nothing, when the database can't be copied", async () => {
    const layout = await install();
    const missing = { ...layout, db: path.join(layout.root, "no-such-db") };
    await expect(backupDatabase(missing, "1.0.0")).rejects.toThrow(/couldn't back up the database/);
    expect(await readdir(layout.backups)).toEqual([]);
  });
});
