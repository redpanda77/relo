import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ensureLayout, localLayout } from "./layout.js";
import { assertCompatible, databaseState, DatabaseVersionError, initialise, parsePostgresMajor } from "./postgres.js";

async function layoutWithBinaries(major: number) {
  const layout = localLayout(await mkdtemp(path.join(tmpdir(), "relo-pg-")));
  await ensureLayout(layout);
  const bin = path.join(layout.root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "postgres"), `#!/bin/sh\necho "postgres (PostgreSQL) ${major}.2"\n`);
  await chmod(path.join(bin, "postgres"), 0o755);
  // An initdb that must never run in these tests.
  await writeFile(path.join(bin, "initdb"), "#!/bin/sh\necho initdb-ran > \"$(dirname \"$0\")/initdb-ran\"\n");
  await chmod(path.join(bin, "initdb"), 0o755);
  return { layout, bin };
}

describe("local PostgreSQL data folder", () => {
  it("reads the major from postgres --version and from PG_VERSION", () => {
    expect(parsePostgresMajor("postgres (PostgreSQL) 17.2\n")).toBe(17);
    expect(parsePostgresMajor("postgres (PostgreSQL) 18.0 (Homebrew)")).toBe(18);
    expect(parsePostgresMajor("17\n")).toBe(17);
    expect(parsePostgresMajor("nothing")).toBeNull();
  });

  it.skipIf(process.platform === "win32")("refuses data from another major, naming why", async () => {
    const { layout, bin } = await layoutWithBinaries(17);
    await mkdir(layout.db, { recursive: true });
    await writeFile(path.join(layout.db, "PG_VERSION"), "16\n");
    await expect(assertCompatible(layout, bin)).rejects.toThrow(DatabaseVersionError);
    await expect(assertCompatible(layout, bin)).rejects.toThrow("This Relo data was made by a newer or older database; Relo can't open it");
    await writeFile(path.join(layout.db, "PG_VERSION"), "17\n");
    await expect(assertCompatible(layout, bin)).resolves.toBeUndefined();
  });

  it("never wipes a folder that has files but no database; it initialises only a missing or empty one", async () => {
    const { layout, bin } = await layoutWithBinaries(17);
    expect(await databaseState(layout)).toBe("missing");
    await mkdir(layout.db, { recursive: true });
    expect(await databaseState(layout)).toBe("empty");
    await writeFile(path.join(layout.db, "precious"), "keep me");
    expect(await databaseState(layout)).toBe("unknown");
    await expect(initialise(layout, bin)).rejects.toThrow(/won't overwrite/);
    expect(await readFile(path.join(layout.db, "precious"), "utf8")).toBe("keep me");
    await expect(readFile(path.join(bin, "initdb-ran"), "utf8")).rejects.toThrow();
  });

  it("leaves an existing database alone", async () => {
    const { layout, bin } = await layoutWithBinaries(17);
    await mkdir(layout.db, { recursive: true });
    await writeFile(path.join(layout.db, "PG_VERSION"), "17\n");
    await initialise(layout, bin);
    await expect(readFile(path.join(bin, "initdb-ran"), "utf8")).rejects.toThrow();
  });
});
