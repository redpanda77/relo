// Creating a symlink on Windows needs Developer Mode or an elevated shell (EPERM otherwise). Tests that must
// make a link skip, with this reason, when the machine cannot; CI runners and Developer Mode machines run them.
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function probe() {
  if (process.platform !== "win32") return false;
  const folder = mkdtempSync(join(tmpdir(), "relo-symlink-probe-"));
  try {
    writeFileSync(join(folder, "target"), "");
    symlinkSync(join(folder, "target"), join(folder, "link"));
    return false;
  } catch {
    return "this Windows account cannot create symlinks (enable Developer Mode to run this test)";
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

export const symlinkSkip = probe();
