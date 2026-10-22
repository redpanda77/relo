// A script that decides "am I the program?" by comparing paths must compare real paths: macOS resolves /var to
// /private/var for the running module, so a plain comparison from a release copy in $TMPDIR is false and the script
// silently does nothing, exit 0. On 19 Oct that made the release gates pass without running.
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

test("every entry-point check compares real paths", () => {
  // A release copy has no .git: head-gates.sh lists the tracked files in RELO_PUBLIC_FILES_FROM (NUL-separated).
  const tracked = process.env.RELO_PUBLIC_FILES_FROM
    ? readFileSync(process.env.RELO_PUBLIC_FILES_FROM, "utf8").split("\0")
    : execFileSync("git", ["ls-files"], { cwd: root, encoding: "utf8" }).split("\n");
  const files = tracked.filter((file) => /\.(mjs|js|ts)$/u.test(file)).filter((file) => file && !/(^|\/)(node_modules|test|tests)\//u.test(file) && !/\.test\.(mjs|js|ts|tsx)$/u.test(file)
      && !file.startsWith("apps/notch/"));
  const offenders = [];
  for (const file of files) {
    let text;
    try { text = readFileSync(join(root, file), "utf8"); } catch { continue; }
    for (const line of text.split("\n")) {
      if (line.includes("process.argv[1]") && /import\.meta\.url|scriptPath|invokedPath/u.test(line) && !/realpathSync|\breal\(/u.test(line)) offenders.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "use realpathSync on both sides");
});

test("the step runner runs when started through a symlinked path", () => {
  const link = join(mkdtempSync(join(tmpdir(), "relo-entry-")), "repo");
  symlinkSync(root, link);
  const result = spawnSync(process.execPath, [join(link, "scripts", "step.mjs"), "--name", "probe", "--", process.execPath, "-e", "process.exit(7)"], { encoding: "utf8" });
  assert.equal(result.status, 7, `it must run the command, not exit quietly: ${result.stderr}`);
  assert.match(result.stderr, /probe: failed \(exit 7\)/u);
});
