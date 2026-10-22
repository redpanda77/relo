import assert from "node:assert/strict";
import test from "node:test";
import { narrow } from "./narrow-tests.mjs";

const files = [
  { path: "apps/server/src/works.test.ts", text: 'import { createWork } from "./works.js";' },
  { path: "apps/server/src/web.test.ts", text: 'const html = readFileSync(new URL("../dist/index.html", import.meta.url));' },
  { path: "apps/server/src/works.ts", text: "export function createWork() {}" },
  { path: "apps/server/src/web/dashboard-app.ts", text: 'const manifest = await readFile(join(dist, "manifest.json"));' },
  { path: "packages/cli/test/fixtures.mjs", text: 'export const sealed = "e2ee-v1.json";' },
];

test("a server module change runs the tests that import it and every test that reads files", () => {
  assert.deepEqual(narrow("server", ["apps/server/src/works.ts"], files), ["src/web.test.ts", "src/works.ts"]);
});

test("a changed test file runs itself", () => {
  assert.deepEqual(narrow("server", ["apps/server/src/works.test.ts"], files), ["src/web.test.ts", "src/works.test.ts"]);
});

test("modules in other packages are followed through the graph; contracts as the build the tests import", () => {
  assert.deepEqual(narrow("server", ["packages/cli/src/crypto/e2ee.mjs", "packages/contracts/src/works.ts"], files),
    ["../../packages/cli/src/crypto/e2ee.mjs", "../../packages/contracts/dist/src/works.js", "src/web.test.ts"]);
});

test("a data file runs the modules that name it and the modules that read files", () => {
  assert.deepEqual(narrow("server", ["apps/ios/Tests/ReloCoreTests/Fixtures/e2ee-v1.json"], files),
    ["../../packages/cli/test/fixtures.mjs", "src/web.test.ts", "src/web/dashboard-app.ts"]);
});

test("what everything depends on runs the whole suite", () => {
  for (const path of ["apps/server/migrations/0120_x.sql", "apps/server/src/test-support/worker-database.ts", "apps/server/vitest.config.ts",
    "apps/server/package.json", "pnpm-lock.yaml", "something/new.txt"]) {
    assert.equal(narrow("server", ["apps/server/src/works.ts", path], files), "all", path);
  }
});

test("a deleted module runs the whole suite: its importers are in no graph", () => {
  assert.equal(narrow("server", ["apps/server/src/gone.ts"], files, () => false), "all");
});

test("paths that do not select the suite do not widen it", () => {
  assert.deepEqual(narrow("server", ["apps/server/src/works.ts", "apps/notch/boringNotch/ContentView.swift", "docs/internal/STATUS.md"], files),
    ["src/web.test.ts", "src/works.ts"]);
});

test("the dashboard suite narrows the same way", () => {
  const dashboard = [{ path: "apps/dashboard/src/NowView.test.tsx", text: 'import { NowView } from "./NowView";' }];
  assert.deepEqual(narrow("dashboard", ["apps/dashboard/src/NowView.tsx"], dashboard), ["src/NowView.tsx"]);
  assert.equal(narrow("dashboard", ["apps/dashboard/src/test/setup.ts"], dashboard), "all");
});
