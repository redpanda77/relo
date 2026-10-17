import "./hermetic-env.mjs";
// Plan 10 D2: every file and folder the CLI keeps is listed on the docs' files page, so the page cannot fall
// behind the code. A new state path fails here until docs/site/reference/files.md says what it holds.
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL("../src", import.meta.url));
const FILES_PAGE = readFileSync(new URL("../../../docs/site/reference/files.md", import.meta.url), "utf8");
const sources = (directory) => readdirSync(directory).flatMap((name) => {
  const path = join(directory, name);
  return statSync(path).isDirectory() ? sources(path) : name.endsWith(".mjs") ? [readFileSync(path, "utf8")] : [];
});

test("every state and data path the CLI writes is on the files page", () => {
  const code = sources(SRC).join("\n");
  const named = new Set([
    ...[...code.matchAll(/statePath\([^"\n]*?"([^"]+)"/gu)].map((match) => match[1]),
    ...[...code.matchAll(/join\(stateRoot\([^)]*\),\s*"([^"]+)"\)/gu)].map((match) => match[1]),
    ...[...code.matchAll(/join\((?:dataRoot|dataDirectory)\([^)]*\),\s*"([^"]+)"\)/gu)].map((match) => match[1]),
  ]);
  assert.ok(named.size >= 8, `found ${[...named].join(", ")}`);
  const missing = [...named].filter((name) => !FILES_PAGE.includes(`\`${name}/\``) && !FILES_PAGE.includes(`\`${name}\``));
  assert.deepEqual(missing, [], "add these to docs/site/reference/files.md");
  assert.ok(FILES_PAGE.includes("~/.local/share/relo/"), "the data folder");
});
