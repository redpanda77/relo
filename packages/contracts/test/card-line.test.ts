import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { cardLine,type CardLineWork } from "../src/card-line.js";

const fixture = JSON.parse(readFileSync(new URL("../fixtures/card-line-v1.json",import.meta.url),"utf8")) as {
  version: 1; cases: Array<{ name: string; work: CardLineWork; expected: string }>;
};

test("card-line-v1 fixture is versioned and covers the required cases",() => {
  assert.equal(fixture.version,1);
  const names = fixture.cases.map((entry) => entry.name);
  for (const required of ["step with a count","count complete gets a check","skipped steps are neither done nor to go","no plan: the label alone"]) {
    assert.ok(names.includes(required),required);
  }
});

for (const entry of fixture.cases) {
  test(`cardLine: ${entry.name}`,() => assert.equal(cardLine(entry.work),entry.expected));
}

test("the line never carries a plan-wide percent or a placeholder",() => {
  for (const entry of fixture.cases) {
    const line = cardLine(entry.work);
    assert.doesNotMatch(line,/%/u);
    assert.doesNotMatch(line,/\bs\d+\b|undefined|null|…|\?\?/u);
  }
});
