import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const lib = new URL("./gates-cache.sh", import.meta.url).pathname;
const bash = (dir, script) => execFileSync("bash", ["-c", `source ${lib}; ${script}`], { cwd: dir, encoding: "utf8" });
const setup = () => {
  const dir = mkdtempSync(join(tmpdir(), "gates-cache-"));
  writeFileSync(join(dir, "keys"), "contracts k1\nserver k2\ncli k3\n");
  return dir;
};

test("a group whose key line passed before is skipped, others stay selected", () => {
  const dir = setup();
  writeFileSync(join(dir, "passed"), "server k2\ncli OLD\n");
  assert.equal(bash(dir, `SELECTED="contracts server cli"; cache_apply keys passed; echo "$SELECTED|$CACHED"`).trim(), "contracts cli|server");
});

test("a missing passed file skips nothing", () => {
  assert.equal(bash(setup(), `SELECTED="contracts server"; cache_apply keys nope; echo "$SELECTED|$CACHED"`).trim(), "contracts server|");
});

test("only groups that ran and did not fail are recorded", () => {
  const dir = setup();
  bash(dir, `SELECTED="contracts server cli"; cache_record keys passed "server typecheck"`);
  assert.equal(readFileSync(join(dir, "passed"), "utf8"), "contracts k1\ncli k3\n");
});

test("a failure outside any group records nothing", () => {
  const dir = setup();
  bash(dir, `SELECTED="contracts server"; cache_record keys passed "contracts build"`);
  assert.throws(() => readFileSync(join(dir, "passed"), "utf8"));
});

test("recording dedupes and keeps the 200 newest lines", () => {
  const dir = setup();
  writeFileSync(join(dir, "passed"), Array.from({ length: 250 }, (_, i) => `old h${i}`).join("\n") + "\ncontracts k1\n");
  bash(dir, `SELECTED="contracts server"; cache_record keys passed`);
  const lines = readFileSync(join(dir, "passed"), "utf8").trim().split("\n");
  assert.equal(lines.length, 200);
  assert.deepEqual(lines.slice(-2), ["contracts k1", "server k2"]);
  assert.equal(lines.filter((l) => l === "contracts k1").length, 1);
});
