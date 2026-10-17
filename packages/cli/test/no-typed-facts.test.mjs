import "./hermetic-env.mjs";
// Plan 10 M6: the product's numbers come from the generated facts; one typed back into the source (the freshness
// windows, the card's life, the question limits) fails here. Engineering timeouts are not facts and are allowed.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const TYPED = /\b(?:20|60) \* 60_?000\b|\b(?:1_?200_?000|28_?800_?000|28_?800|604_?800|2_?592_?000)\b(?![^\n]*→)/u;
const files = (directory) => readdirSync(directory).flatMap((name) => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? files(path) : name.endsWith(".mjs") && !name.endsWith(".generated.mjs") ? [path] : [];
});

test("no product number is typed into the CLI's source", () => {
  const offenders = files(SRC).flatMap((path) => readFileSync(path, "utf8").split("\n")
    .map((line, index) => (TYPED.test(line) && !line.trim().startsWith("*") && !line.trim().startsWith("//") ? `${relative(SRC, path)}:${index + 1}` : null))
    .filter(Boolean));
  assert.deepEqual(offenders, [], "read it from shared/facts.generated.mjs (FACTS)");
});
