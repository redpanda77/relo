import assert from "node:assert/strict";
import test from "node:test";
import { cliImporters, parseArgs, selectChecks } from "./check-changed.mjs";

const files = {
  "packages/cli/test/auto-update.test.mjs": 'import { askToUpdate } from "../src/owner/update.mjs";',
  "packages/cli/test/other.test.mjs": 'import x from "../src/args.mjs";',
  "packages/cli/src/owner/update.mjs": "",
  "apps/server/src/foo.ts": "", "apps/server/src/foo.test.ts": "", "apps/server/src/bar.ts": "",
  "apps/dashboard/src/a.tsx": "", "apps/dashboard/src/a.test.tsx": "",
  ...Object.fromEntries(["environment", "state-paths", "reachability", "registry", "schema"].map((n) => [`packages/cli/test/${n}.test.mjs`, ""])),
};
const fs = {
  exists: (path) => path in files,
  read: (path) => files[path],
  list: (dir) => Object.keys(files).filter((p) => p.startsWith(`${dir}/`)).map((p) => p.slice(dir.length + 1)),
};
const names = (paths) => selectChecks(paths, fs).checks.map((check) => check.name);
const find = (paths, name) => selectChecks(paths, fs).checks.find((check) => check.name === name);

test("a CLI-only change selects CLI checks and no server, dashboard, docs or Swift work", () => {
  assert.deepEqual(names(["packages/cli/src/owner/update.mjs"]), ["cli-syntax", "cli-tests", "public-check"]);
  const tests = find(["packages/cli/src/owner/update.mjs"], "cli-tests");
  assert.deepEqual(tests.cmd.slice(-1), ["test/auto-update.test.mjs"]);
  assert.ok(tests.cmd.includes("./test/hermetic-env.mjs"));
  // Only the changed file is parsed, not the whole package.
  assert.deepEqual(find(["packages/cli/src/owner/update.mjs"], "cli-syntax").cmd.slice(-1), ["src/owner/update.mjs"]);
});

test("a CLI source with no importing test runs the convention tests", () => {
  const tests = find(["packages/cli/src/unknown.mjs"], "cli-tests");
  assert.equal(tests.cmd.filter((arg) => arg.endsWith(".test.mjs")).length, 5);
});

test("the notifications skill is a CLI change", () => {
  assert.ok(names(["skills/relo-notifications/SKILL.md"]).includes("cli-tests"));
});

test("cliImporters resolves specifiers rather than matching names", () => {
  assert.deepEqual(cliImporters("packages/cli/src/owner/update.mjs", fs), ["packages/cli/test/auto-update.test.mjs"]);
  assert.deepEqual(cliImporters("packages/cli/src/update.mjs", fs), []);
});

test("a server .ts change selects the typecheck and only its neighbour test", () => {
  assert.deepEqual(names(["apps/server/src/foo.ts"]), ["server-typecheck", "server-tests", "public-check"]);
  assert.deepEqual(find(["apps/server/src/foo.ts"], "server-tests").cmd, ["npx", "vitest", "run", "src/foo.test.ts"]);
  assert.deepEqual(names(["apps/server/src/bar.ts"]), ["server-typecheck", "public-check"]);
});

test("a dashboard change selects tsc -b and its neighbour test", () => {
  assert.deepEqual(find(["apps/dashboard/src/a.tsx"], "dashboard-tests").cmd, ["npx", "vitest", "run", "src/a.test.tsx"]);
  assert.deepEqual(find(["apps/dashboard/src/a.tsx"], "dashboard-typecheck").cmd, ["npx", "tsc", "-b"]);
});

test("contracts select their typecheck and tests", () => {
  assert.deepEqual(names(["packages/contracts/src/x.ts"]), ["contracts-typecheck", "contracts-tests", "public-check"]);
});

test("a notch or iOS change runs nothing heavy and says so", () => {
  for (const path of ["apps/notch/Sources/A.swift", "apps/ios/Sources/B.swift"]) {
    const { checks, notes } = selectChecks([path], fs);
    assert.deepEqual(checks.map((check) => check.name), ["public-check"]);
    assert.match(notes.join("\n"), /Swift/u);
  }
});

test("the docs build runs only when site docs changed", () => {
  assert.ok(names(["docs/site/index.md"]).includes("docs-build"));
  assert.ok(!names(["packages/cli/src/args.mjs"]).includes("docs-build"));
});

test("argument parsing", () => {
  assert.deepEqual(parseArgs(["--files", "a", "b", "--plan"]), { mode: "files", files: ["a", "b"], since: undefined, plan: true });
  assert.equal(parseArgs(["--since", "origin/main"]).since, "origin/main");
  assert.throws(() => parseArgs(["--nope"]));
});

test("a change to hook code measures the hook budgets on this Mac; other CLI code does not", () => {
  assert.ok(names(["packages/cli/src/harness/adapters/claude-code/descriptor.mjs"]).includes("cli-hook-budget"));
  assert.ok(!names(["packages/cli/src/owner/update.mjs"]).includes("cli-hook-budget"));
});
