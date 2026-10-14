import assert from "node:assert/strict";
import test from "node:test";
import { checkStepNames, isGenericStepName } from "../src/step-names.mjs";

test("placeholders and fillers are generic; concrete names are not", () => {
  for (const name of ["Step 1", "step2", "Phase 3", "STAGE 1", "Task 4", "Part 2", "Item #3", "todo", "TBD", "misc", "next", "Next",
    "...", "7", "Go", "ab", "Step", "Phase"]) assert.equal(isGenericStepName(name), true, name);
  for (const name of ["Run migrations", "Install on iPhone", "Build", "Ship", "Review the diff", "Go live", "QA"]) {
    assert.equal(isGenericStepName(name), name === "QA", name);
  }
  assert.throws(() => checkStepNames(["Build", "Test", "build"]), /appears twice/u);
  assert.deepEqual(checkStepNames(["Build image", "Run tests"]), ["Build image", "Run tests"]);
});
