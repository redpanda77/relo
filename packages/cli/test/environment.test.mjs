// The environment list (shared/environment.mjs) is every variable the CLI reads, no more and no less.
import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ENVIRONMENT } from "../src/shared/environment.mjs";

const SRC = fileURLToPath(new URL("../src/", import.meta.url));

test("every RELO_ and XDG_ variable the CLI reads is listed, and every listed one is read", () => {
  const read = new Set();
  for (const name of readdirSync(SRC, { recursive: true }).map((file) => file.replaceAll("\\", "/")).filter((file) => file.endsWith(".mjs") && file !== "shared/environment.mjs")) {
    const code = readFileSync(join(SRC, name), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/u.test(line)).join("\n");
    for (const [variable] of code.matchAll(/\b(?:RELO|XDG)_[A-Z_]+\b/gu)) read.add(variable);
  }
  const listed = new Set(ENVIRONMENT.map((variable) => variable.name));
  assert.deepEqual([...read].filter((variable) => !listed.has(variable)).sort(), [], "read but not listed");
  assert.deepEqual([...listed].filter((variable) => !read.has(variable)).sort(), [], "listed but never read");
});

test("one state root: only work/state-file.mjs builds a path in the state folder", () => {
  const offenders = [];
  for (const name of readdirSync(SRC, { recursive: true }).map((file) => file.replaceAll("\\", "/")).filter((file) => file.endsWith(".mjs") && !["work/state-file.mjs", "shared/environment.mjs"].includes(file))) {
    const code = readFileSync(join(SRC, name), "utf8").split("\n").filter((line) => !/^\s*(\/\/|\*|\/\*\*)/u.test(line)).join("\n");
    if (/XDG_STATE_HOME|["']\.local["']\s*,\s*["']state["']|\.local\/state/u.test(code)) offenders.push(name);
  }
  assert.deepEqual(offenders, [], "use statePath() from work/state-file.mjs");
});

test("every setting in the registry names a listed variable, and every listed variable that overrides one names it back", async () => {
  const { SETTINGS } = await import("../src/shared/settings.mjs");
  for (const setting of SETTINGS) {
    const variable = ENVIRONMENT.find((entry) => entry.name === setting.env);
    assert.ok(variable, `${setting.key}: ${setting.env} is not in shared/environment.mjs`);
    assert.equal(variable.setting, setting.key, `${setting.env} must say it overrides ${setting.key}`);
  }
  for (const variable of ENVIRONMENT.filter((entry) => entry.setting)) {
    assert.ok(SETTINGS.some((setting) => setting.key === variable.setting && setting.env === variable.name), `${variable.name}: unknown setting ${variable.setting}`);
  }
});
