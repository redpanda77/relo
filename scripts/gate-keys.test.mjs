import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { GATES } from "./select-gates.mjs";
import { computeKeys, formatKeys, parseLsTree } from "./gate-keys.mjs";

const base = [
  { path: "pnpm-lock.yaml", blob: "l1" }, { path: "scripts/gates.sh", blob: "g1" },
  { path: "apps/server/src/app.ts", blob: "s1" }, { path: "packages/cli/src/index.ts", blob: "c1" },
  { path: "apps/ios/Sources/ReloApp/NowView.swift", blob: "i1" },
];
const keys = (entries, nodeMajor = "22") => computeKeys(entries, { nodeMajor });
const change = (path, blob) => base.map((e) => (e.path === path ? { ...e, blob } : e));

test("keys are stable and cover every group", () => {
  const a = keys(base), b = keys([...base].reverse());
  assert.deepEqual([...a.keys()], GATES);
  assert.deepEqual([...a], [...b]);
});

test("a mapped file's blob changes only the groups that cover it", () => {
  const a = keys(base), b = keys(change("apps/server/src/app.ts", "s2"));
  for (const g of ["contracts", "dashboard", "server"]) assert.notEqual(a.get(g), b.get(g), g);
  for (const g of ["cli", "skill", "repo"]) assert.equal(a.get(g), b.get(g), g);
});

test("a file no group reads leaves every key alone", () => {
  const a = keys(base), b = keys(change("apps/ios/Sources/ReloApp/NowView.swift", "i2"));
  assert.deepEqual([...a], [...b]);
});

test("the lockfile, gates.sh and the node major change every key", () => {
  const a = keys(base);
  for (const other of [keys(change("pnpm-lock.yaml", "l2")), keys(change("scripts/gates.sh", "g2")), keys(base, "24")]) {
    for (const g of GATES) assert.notEqual(a.get(g), other.get(g), g);
  }
});

test("an unknown path counts for every group", () => {
  const a = keys(base), b = keys([...base, { path: "mystery/file.txt", blob: "m1" }]);
  for (const g of GATES) assert.notEqual(a.get(g), b.get(g), g);
});

test("ls-tree output parses and keys print as 'group key' lines", () => {
  assert.deepEqual(parseLsTree("100644 blob abc\ta b.ts\u0000120000 blob def\tlink\u0000"), [{ blob: "abc", path: "a b.ts" }, { blob: "def", path: "link" }]);
  const lines = formatKeys(keys(base)).trim().split("\n");
  assert.equal(lines.length, GATES.length);
  assert.match(lines[0], /^contracts [0-9a-f]{64}$/u);
});

test("the CLI prints keys for a commit, also through a symlinked path", () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "gate-keys-")));
  const git = (...a) => execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", ...a], { encoding: "utf8" });
  git("init", "-q");
  mkdirSync(join(dir, "apps/server"), { recursive: true });
  writeFileSync(join(dir, "apps/server/a.ts"), "x");
  git("add", "."); git("commit", "-qm", "c");
  const link = join(dir, "..", `gate-keys-link-${process.pid}`);
  symlinkSync(join(process.cwd(), "scripts"), link);
  const out = execFileSync("node", [join(link, "gate-keys.mjs"), "HEAD", "--repo", dir], { encoding: "utf8" });
  assert.equal(out.trim().split("\n").length, GATES.length);
});
