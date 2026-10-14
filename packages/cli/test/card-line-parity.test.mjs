import "./hermetic-env.mjs";
// The CLI echo's "Owner sees" line must be the shared Lock Screen line (plan 2.25):
// the CLI stays dependency-free, so it is held to the contracts fixture directly.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cardLine, ownerSees } from "../src/work/echo.mjs";

const fixture = JSON.parse(readFileSync(new URL("../../contracts/fixtures/card-line-v1.json", import.meta.url), "utf8"));

for (const entry of fixture.cases) {
  test(`CLI cardLine matches card-line-v1: ${entry.name}`, () => assert.equal(cardLine(entry.work), entry.expected));
}

test("Owner sees quotes the shared line for an open work with a plan", () => {
  const entry = fixture.cases.find((c) => c.name === "step with a count");
  assert.equal(ownerSees({ ...entry.work, lifecycle: "open" }), `Owner sees: on the Lock Screen, "${entry.expected}"`);
});
