import assert from "node:assert/strict";
import { test } from "node:test";
import { filesThatRanNothing } from "./check-test-ran.mjs";

const file = (name, ...statuses) => ({ name: `/repo/${name}`, assertionResults: statuses.map((status) => ({ status })) });

test("a file whose tests all skipped fails unless it skips on purpose", () => {
  const report = { testResults: [
    file("apps/server/src/ran.test.ts", "passed", "skipped"),
    file("apps/server/src/silent.test.ts", "skipped", "skipped"),
    file("apps/server/src/empty.test.ts"),
    file("apps/server/src/broken.test.ts", "failed"),
    file("apps/server/src/benchmarks/requester-latency.test.ts", "skipped"),
  ] };
  assert.deepEqual(filesThatRanNothing(report, "/repo"), ["apps/server/src/silent.test.ts", "apps/server/src/empty.test.ts"]);
});
