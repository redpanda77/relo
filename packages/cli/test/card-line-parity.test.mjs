import "./hermetic-env.mjs";
// The CLI echo's "Owner sees" line must be the shared plan line (plan UX U2, one rule for every surface):
// the CLI runs the contracts plan engine's generated copy and is held to the shared fixture directly.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cardLine, ownerSees } from "../src/work/echo.mjs";

const fixtures = JSON.parse(readFileSync(new URL("../../contracts/test/fixtures/plan-progress.json", import.meta.url), "utf8"));
const OPTIONS = { paused: (work) => ({ ...work, lifecycle: "paused" }), ended: (work, ended) => ({ ...work, lifecycle: "finished", result: ended }) };

for (const entry of fixtures) {
  test(`CLI plan line matches plan-progress.json: ${entry.name}`, () => {
    const work = { lifecycle: "open", plan: entry.plan };
    if (!entry.progressOptions) assert.equal(cardLine(work), entry.text);
    for (const variant of entry.variants ?? []) {
      const shaped = variant.options.paused ? OPTIONS.paused(work) : OPTIONS.ended(work, variant.options.ended);
      assert.equal(cardLine(shaped), variant.text);
    }
  });
}

test("Owner sees quotes the shared line for an open work with a plan", () => {
  const entry = fixtures.find((c) => c.name === "flat plan, third step current");
  assert.equal(ownerSees({ lifecycle: "open", plan: entry.plan }), `Owner sees: on the Lock Screen, "${entry.text}"`);
});
