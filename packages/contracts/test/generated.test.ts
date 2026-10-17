import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import test from "node:test";
import { generatedFiles, staleGeneratedFiles } from "../scripts/generated.js";
import { FACTS, FACT_UNITS, factEntries } from "../src/facts.js";

test("every fact has a unit, and the units name only facts", () => {
  const ids = factEntries().map(([id]) => id);
  assert.deepEqual(Object.keys(FACT_UNITS).sort(), [...ids].sort());
  for (const [id, value] of factEntries()) {
    if (FACT_UNITS[id] === "seconds-list") assert.ok(Array.isArray(value), id);
    else assert.ok(Number.isInteger(value) && (value as number) > 0, id);
  }
  assert.equal(FACTS.card.maxSeconds, 8 * 60 * 60);
});

test("the CLI's generated copies match contracts", () => {
  if (process.env.UPDATE_GENERATED === "1") {
    for (const [path, contents] of Object.entries(generatedFiles())) writeFileSync(path, contents);
  }
  assert.deepEqual(staleGeneratedFiles(), [], "run UPDATE_GENERATED=1 pnpm --filter @relo/notification-contracts test");
});
