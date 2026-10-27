#!/usr/bin/env node
// Per-test selection inside a gate (scripts/gates.sh): a selected suite runs only the test files its changed paths reach.
//   node scripts/narrow-tests.mjs <server|dashboard> <file listing changed paths> [repo root]
// Prints "all" (run the whole suite) or "related <paths...>" (paths relative to the suite's package, for `vitest related`,
// which runs every test whose import graph holds one of them). What it passes:
//   - every changed module (TypeScript or JavaScript, in any package: the graph follows relative imports across them;
//     a contracts module as the built file the package exports, which is what tests import),
//   - every test that reads, globs, spawns or dynamically imports files (no import graph shows what it reaches),
//   - for a changed data file (Markdown, JSON, HTML, CSS, an asset): every module that names it, and every module that
//     reads files, so the tests that reach it through a helper run too.
// It fails closed: what everything depends on runs the whole suite (migrations, test setup, configs, manifests, the
// lockfile, a deleted module, a path no rule knows).
import { readFileSync, realpathSync } from "node:fs";
import { basename, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";
import { gatesFor } from "./select-gates.mjs";

export const SUITES = {
  // The DB suite belongs to the "server" gate group; its setup files load before every test.
  server: { gate: "server", dir: "apps/server", tests: /^apps\/server\/src\/.*\.test\.ts$/u },
  dashboard: { gate: "dashboard", dir: "apps/dashboard", tests: /^apps\/dashboard\/src\/.*\.test\.tsx?$/u },
};
const MODULE = /\.(ts|tsx|mts|js|mjs)$/u;
// Where modules live that a test's import graph can reach (the scan for data-file readers stays inside them).
const SOURCES = /^(apps\/server\/src|apps\/dashboard\/src|packages\/cli\/(src|test)|packages\/contracts\/src|packages\/owner-crypto\/src)\/.*\.(ts|tsx|mts|js|mjs)$/u;
// Everything depends on these: the whole suite runs.
const EVERYTHING = [
  /^apps\/server\/migrations\//u,
  /^apps\/server\/src\/test-support\//u,
  /^apps\/dashboard\/src\/test\//u,
  /(^|\/)(package\.json|tsconfig[^/]*\.json|vitest\.config\.[^/]+|vite\.config\.[^/]+)$/u,
  /^(pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|\.npmrc)$/u,
];
export const INDIRECT = /readFileSync|readdirSync|readFile\(|readdir\(|globSync|import\.meta\.glob|spawn|execFile|exec\(|fork\(|new URL\(|import\(/u;
const READS = /readFileSync|readdirSync|readFile\(|readdir\(|globSync|import\.meta\.glob/u;

/** What a module change is to a test's graph: contracts tests import the package's build, not its source. */
const asImported = (path) => path.replace(/^packages\/contracts\/src\/(.*)\.ts$/u, "packages/contracts/dist/src/$1.js");

/**
 * paths: changed repo paths. files: [{ path, text }] of the test files and the source modules (SOURCES).
 * exists: whether a path is in the tree. Returns "all" or the related paths, relative to the suite's package.
 */
export function narrow(suite, paths, files, exists = () => true) {
  const { gate, dir, tests } = SUITES[suite];
  const mine = paths.filter((path) => (gatesFor(path) ?? [gate]).includes(gate));
  if (!mine.length) return "all";
  if (mine.some((path) => gatesFor(path) === null || EVERYTHING.some((pattern) => pattern.test(path)) || !exists(path))) return "all";
  const related = new Set(files.filter((f) => tests.test(f.path) && INDIRECT.test(f.text)).map((f) => f.path));
  const data = [];
  for (const path of mine) (MODULE.test(path) ? related.add(asImported(path)) : data.push(path));
  if (data.length) {
    const names = data.map((path) => basename(path));
    for (const f of files) {
      if (!SOURCES.test(f.path) && !tests.test(f.path)) continue;
      if (READS.test(f.text) || names.some((name) => f.text.includes(name))) related.add(asImported(f.path));
    }
  }
  return [...related].map((path) => relative(dir, path)).sort();
}

// Real paths on both sides: a script under a symlinked folder (macOS /var -> /private/var) must still run.
const invoked = process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (invoked && invoked === pathToFileURL(realpathSync(new URL(import.meta.url))).href) {
  const [suite, listPath, root = process.cwd()] = process.argv.slice(2);
  if (!SUITES[suite] || !listPath) { console.error("usage: narrow-tests.mjs <server|dashboard> <changed-paths-file> [root]"); process.exit(2); }
  const paths = readFileSync(listPath, "utf8").split("\n").map((line) => line.trim()).filter(Boolean);
  // The archive a release gates has no .git: its tracked files are listed beside it (head-gates.sh).
  let tracked;
  try { tracked = readFileSync(resolve(root, ".relo-tracked-files"), "utf8").split("\0"); }
  catch { tracked = execFileSync("git", ["-C", root, "ls-files", "-z"], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }).split("\0"); }
  const files = tracked
    .filter((path) => SOURCES.test(path) || SUITES[suite].tests.test(path))
    .map((path) => ({ path, text: readFileSync(resolve(root, path), "utf8") }));
  const inTree = new Set(tracked);
  const result = narrow(suite, paths, files, (path) => inTree.has(path));
  console.log(result === "all" ? "all" : `related ${result.join(" ")}`);
}
