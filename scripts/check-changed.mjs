#!/usr/bin/env node
// Fast local checks that run only what the changed paths need (plan 15), so the Mac never runs a full suite.
//   node scripts/check-changed.mjs                 staged + unstaged changes vs HEAD
//   node scripts/check-changed.mjs --since <ref>   everything changed since <ref> (committed or not)
//   node scripts/check-changed.mjs --files a b c   exactly these paths
//   node scripts/check-changed.mjs --staged        staged paths only (the pre-commit hook)
//   node scripts/check-changed.mjs --plan ...      print the selected checks and run none
//   node scripts/check-changed.mjs --preflight ... only the CLI tests, docs freshness and public:check (deploy.sh)
// Every check runs through scripts/step.mjs (a budget, a no-output timeout, no stdin). Exit 1 if any check fails.
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CLI_CONVENTION_TESTS = ["environment", "state-paths", "reachability", "registry", "schema"]
  .map((name) => `packages/cli/test/${name}.test.mjs`);
// Tests that scan every CLI source, so no importer finds them: any source change runs them (each failed a release once).
const CLI_SCAN_TESTS = ["environment", "catalog", "harness-invariants"].map((name) => `packages/cli/test/${name}.test.mjs`);
// The checks a release cannot afford to learn about from the remote gates: seconds here, minutes there (deploy.sh).
const PREFLIGHT = new Set(["cli-syntax", "cli-tests", "docs-fresh", "public-check"]);

const defaultFs = {
  exists: (path) => existsSync(join(ROOT, path)),
  read: (path) => readFileSync(join(ROOT, path), "utf8"),
  list: (dir) => { try { return readdirSync(join(ROOT, dir)); } catch { return []; } },
};

/** CLI test files (repo-relative) that import `module` (repo-relative), found by resolving each test's import specifiers. */
export function cliImporters(module, fs = defaultFs) {
  const found = [];
  for (const name of fs.list("packages/cli/test").filter((file) => file.endsWith(".test.mjs"))) {
    const testPath = `packages/cli/test/${name}`;
    const text = fs.read(testPath);
    const specifiers = [...text.matchAll(/(?:from|import)\s*\(?\s*["'](\.[^"']+)["']/gu)].map((match) => match[1]);
    if (specifiers.some((specifier) => posix.join("packages/cli/test", specifier) === module)) found.push(testPath);
  }
  return found;
}

const unique = (list) => [...new Set(list)];
const isTest = (path) => /\.test\.[cm]?[jt]sx?$/u.test(path);
/** The test beside a source file (foo.ts -> foo.test.ts, foo.tsx -> foo.test.tsx or .ts), when it exists. */
function neighbours(path, fs) {
  if (isTest(path)) return fs.exists(path) ? [path] : [];
  const match = /^(.*)\.(tsx?)$/u.exec(path);
  if (!match) return [];
  return [`${match[1]}.test.ts`, `${match[1]}.test.tsx`].filter((candidate) => fs.exists(candidate));
}

/**
 * The checks changed paths need: [{ name, cwd, timeout, cmd }]. `notes` lists what is deliberately not run.
 * Pure given `fs`, so tests can prove the selection without running anything.
 */
export function selectChecks(paths, fs = defaultFs) {
  const checks = [];
  const notes = [];
  const under = (prefix) => paths.filter((path) => path.startsWith(prefix));

  const cli = [...under("packages/cli/"), ...under("skills/relo-notifications/")];
  if (cli.length) {
    // Only the changed .mjs files: parsing all of them is 14 s, the release gates do that.
    const sources = cli.filter((path) => /^packages\/cli\/(bin|src|scripts)\/.*\.mjs$/u.test(path) && fs.exists(path))
      .map((path) => path.slice("packages/cli/".length));
    if (sources.length) checks.push({ name: "cli-syntax", cwd: "packages/cli", timeout: "60s",
      cmd: ["node", "-e", "for (const f of process.argv.slice(1)) require('node:child_process').execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' })", ...sources] });
    const tests = [];
    let unmatched = false;
    for (const path of cli) {
      if (/^packages\/cli\/test\/.*\.test\.mjs$/u.test(path)) { if (fs.exists(path)) tests.push(path); continue; }
      if (/^packages\/cli\/test\//u.test(path)) { // a fixture or helper: whoever imports it
        const importers = cliImporters(path, fs);
        if (importers.length) tests.push(...importers); else unmatched = true;
        continue;
      }
      const importers = /^packages\/cli\/src\/.*\.mjs$/u.test(path) ? cliImporters(path, fs) : [];
      if (importers.length) tests.push(...importers); else unmatched = true;
    }
    if (unmatched || tests.length === 0) tests.push(...CLI_CONVENTION_TESTS.filter((test) => fs.exists(test)));
    if (cli.some((path) => path.startsWith("packages/cli/src/"))) tests.push(...CLI_SCAN_TESTS.filter((test) => fs.exists(test)));
    const files = unique(tests).map((test) => test.replace(/^packages\/cli\//u, ""));
    // Bundle the skill first, as the package's own test script does: the copy in packages/cli/skill goes stale.
    checks.push({ name: "cli-tests", cwd: "packages/cli", timeout: "120s",
      cmd: ["sh", "-c", 'node scripts/bundle-skill.mjs && exec node --import ./test/hermetic-env.mjs --test "$@"', "cli-tests", ...files] });
    // Hook code: its wall-clock budgets are measured here, on the Mac the hooks run on (the builder skips them).
    if (cli.some((path) => /^packages\/cli\/(bin\/|src\/(hook-deps|cli|deps)\.mjs$|src\/harness\/)/u.test(path))) {
      checks.push({ name: "cli-hook-budget", cwd: "packages/cli", timeout: "60s",
        cmd: ["node", "--import", "./test/hermetic-env.mjs", "--test", "--test-name-pattern=costs at most 20 ms|p95 under 50 ms",
          "test/startup-budget.test.mjs", "test/harness-invariants.test.mjs"] });
    }
  }

  const server = under("apps/server/src/");
  if (server.length) {
    checks.push({ name: "server-typecheck", cwd: "apps/server", timeout: "180s", cmd: ["npx", "tsc", "-p", "tsconfig.json", "--noEmit"] });
    const tests = unique(server.flatMap((path) => neighbours(path, fs))).map((test) => test.replace(/^apps\/server\//u, ""));
    if (tests.length) checks.push({ name: "server-tests", cwd: "apps/server", timeout: "120s", cmd: ["npx", "vitest", "run", ...tests] });
    notes.push("server: the whole DB suite is never run here");
  }

  const dashboard = under("apps/dashboard/src/");
  if (dashboard.length) {
    checks.push({ name: "dashboard-typecheck", cwd: "apps/dashboard", timeout: "180s", cmd: ["npx", "tsc", "-b"] });
    const tests = unique(dashboard.flatMap((path) => neighbours(path, fs))).map((test) => test.replace(/^apps\/dashboard\//u, ""));
    if (tests.length) checks.push({ name: "dashboard-tests", cwd: "apps/dashboard", timeout: "120s", cmd: ["npx", "vitest", "run", ...tests] });
  }

  if (under("packages/owner-crypto/").length) {
    checks.push({ name: "owner-crypto-typecheck", cwd: "packages/owner-crypto", timeout: "120s", cmd: ["npx", "tsc", "-p", "tsconfig.json", "--noEmit"] });
    checks.push({ name: "owner-crypto-tests", cwd: "packages/owner-crypto", timeout: "120s", cmd: ["npx", "vitest", "run"] });
    // The Dashboard bundles it from source: it must still compile.
    if (!dashboard.length) checks.push({ name: "dashboard-typecheck", cwd: "apps/dashboard", timeout: "180s", cmd: ["npx", "tsc", "-b"] });
  }

  if (under("packages/contracts/src/").length || under("packages/contracts/test/").length) {
    checks.push({ name: "contracts-typecheck", cwd: "packages/contracts", timeout: "120s", cmd: ["npx", "tsc", "-p", "tsconfig.json", "--noEmit"] });
    checks.push({ name: "contracts-tests", cwd: "packages/contracts", timeout: "120s", cmd: ["npx", "tsx", "--test", "test/*.test.ts"] });
  }

  if (under("packages/owner-client/src/").length) {
    checks.push({ name: "owner-client-typecheck", cwd: "packages/owner-client", timeout: "120s", cmd: ["npx", "tsc", "-p", "tsconfig.json", "--noEmit"] });
    checks.push({ name: "owner-client-tests", cwd: "packages/owner-client", timeout: "120s", cmd: ["npx", "vitest", "run"] });
  }

  if (under("apps/notch/").length || under("apps/ios/").length) {
    notes.push("Swift (apps/notch, apps/ios): not run by this command; the Mac app build is separate");
  }

  if (under("docs/site/").length) {
    checks.push({ name: "docs-build", cwd: "apps/server", timeout: "120s", cmd: ["npm", "run", "docs:build"] });
  }
  // The docs site carries the CLI's help and environment: a CLI source change can leave it stale.
  if (under("docs/site/").length || under("packages/cli/src/").length) {
    checks.push({ name: "docs-fresh", cwd: "apps/server", timeout: "60s",
      cmd: ["npx", "vitest", "run", "src/web/docs-site.test.ts", "-t", "the committed site module is current"] });
  }

  checks.push({ name: "public-check", cwd: ".", timeout: "60s", cmd: ["npm", "run", "public:check"] });
  return { checks, notes };
}

function git(args) {
  const result = spawnSync("git", args, { cwd: ROOT, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.trim()}`);
  return result.stdout.split("\n").map((line) => line.trim()).filter(Boolean);
}

export function parseArgs(argv) {
  const options = { mode: "working", files: [], since: undefined, plan: false, preflight: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--plan") options.plan = true;
    else if (arg === "--preflight") options.preflight = true;
    else if (arg === "--staged") options.mode = "staged";
    else if (arg === "--since") { options.mode = "since"; options.since = argv[++i]; if (!options.since) throw new Error("--since takes a ref"); }
    else if (arg === "--files") { options.mode = "files"; while (i + 1 < argv.length && !argv[i + 1].startsWith("--")) options.files.push(argv[++i]); }
    else throw new Error(`unknown option ${arg}`);
  }
  return options;
}

function changedPaths(options) {
  if (options.mode === "files") return options.files;
  if (options.mode === "staged") return git(["diff", "--cached", "--name-only", "--diff-filter=ACMR"]);
  if (options.mode === "since") return unique([...git(["diff", "--name-only", "--diff-filter=ACMR", `${options.since}...HEAD`]), ...git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"])]);
  return unique([...git(["diff", "--name-only", "--diff-filter=ACMR", "HEAD"]), ...git(["ls-files", "--others", "--exclude-standard"])]);
}

function main() {
  const options = parseArgs(process.argv.slice(2));
  const paths = changedPaths(options);
  const selected = selectChecks(paths);
  const notes = selected.notes;
  const checks = options.preflight ? selected.checks.filter((check) => PREFLIGHT.has(check.name)) : selected.checks;
  console.log(`check-changed: ${paths.length} changed path(s); checks: ${checks.map((check) => check.name).join(", ")}`);
  for (const note of notes) console.log(`  note: ${note}`);
  if (options.plan) { for (const check of checks) console.log(`  ${check.name} (${check.cwd}): ${check.cmd.join(" ")}`); return 0; }
  const started = Date.now();
  const results = [];
  for (const check of checks) {
    const t0 = Date.now();
    const run = spawnSync("node", [join(ROOT, "scripts/step.mjs"), "--name", check.name, "--timeout", check.timeout, "--", ...check.cmd],
      { cwd: join(ROOT, check.cwd), stdio: ["ignore", "inherit", "inherit"] });
    results.push({ name: check.name, ok: run.status === 0, seconds: (Date.now() - t0) / 1000 });
  }
  console.log("check-changed summary:");
  for (const r of results) console.log(`  ${r.ok ? "ok  " : "FAIL"} ${r.name} ${r.seconds.toFixed(1)}s`);
  console.log(`  total ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const failed = results.filter((r) => !r.ok).map((r) => r.name);
  if (failed.length) { console.error(`check-changed: failed: ${failed.join(", ")}`); return 1; }
  return 0;
}

const invoked = process.argv[1] && pathToFileURL(realpathSync(resolve(process.argv[1]))).href;
if (invoked && invoked === pathToFileURL(realpathSync(fileURLToPath(import.meta.url))).href) {
  try { process.exit(main()); } catch (error) { console.error(`check-changed: ${error.message}`); process.exit(2); }
}
