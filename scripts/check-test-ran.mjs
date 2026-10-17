#!/usr/bin/env node
// Fails a test run in which a file ran nothing (plan 10 C4): with a database every DB suite must run, so a file
// whose tests all skipped means a broken guard, a missing variable or a suite that silently stopped running.
//   node scripts/check-test-ran.mjs <vitest json report>
import { readFileSync, realpathSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Files that skip on purpose, each with why. Anything else that runs zero tests fails the gate. */
export const ALLOWED_SKIPS = new Map([
  ["apps/server/src/benchmarks/requester-latency.test.ts", "runs only when RELO_BENCHMARK_SOURCE_COMMIT names a benchmark build"],
]);

const real = (path) => { try { return realpathSync(path); } catch { return path; } };

export function filesThatRanNothing(report, root, allowed = ALLOWED_SKIPS) {
  // Vitest reports real paths; a root under a symlink (macOS /var → /private/var) must be resolved the same way.
  const base = real(root);
  return report.testResults
    .map((file) => ({
      path: relative(base, real(file.name)),
      passed: file.assertionResults.filter((test) => test.status === "passed").length,
      failed: file.assertionResults.filter((test) => test.status === "failed").length,
    }))
    .filter((file) => file.passed === 0 && file.failed === 0 && !allowed.has(file.path))
    .map((file) => file.path);
}

// Real paths on both sides: run through a symlinked folder (macOS /var -> /private/var), the check must still run.
if (process.argv[1] && pathToFileURL(real(resolve(process.argv[1]))).href === pathToFileURL(real(fileURLToPath(import.meta.url))).href) {
  const [reportPath, root = process.cwd()] = process.argv.slice(2);
  const silent = filesThatRanNothing(JSON.parse(readFileSync(reportPath, "utf8")), root);
  if (silent.length) {
    console.error(`These test files ran no tests (skipped or empty) with a database available:\n${silent.map((path) => `  ${path}`).join("\n")}`);
    console.error("Fix the guard, or add the file to ALLOWED_SKIPS in scripts/check-test-ran.mjs with the reason.");
    process.exit(1);
  }
  console.log("Every test file ran.");
}
