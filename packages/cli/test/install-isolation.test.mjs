import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import test from "node:test";

// X.4: tests can never reach the developer's real global npm prefix (where the owner's relo lives).
test("npm's global prefix inside tests is a temporary folder", () => {
  const prefix = execFileSync("npm", ["prefix", "--global"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
  assert.ok(prefix.startsWith(tmpdir()) || prefix.startsWith("/private" + tmpdir()), `global prefix is ${prefix}`);
});

// A test file run on its own (`node --test test/x.test.mjs`, without npm test's --import) once queued
// fixture writes in the developer's real outbox. Every test file loads the hermetic environment first.
test("every CLI test file imports the hermetic environment before anything else", () => {
  const directory = new URL("./", import.meta.url);
  const files = readdirSync(directory).filter((name) => name.endsWith(".test.mjs"));
  assert.ok(files.length > 10);
  const missing = files.filter((name) => {
    const first = readFileSync(new URL(name, directory), "utf8").split(/\r?\n/u).find((line) => /^import\b/u.test(line));
    return first !== 'import "./hermetic-env.mjs";';
  });
  assert.deepEqual(missing, []);
});

test("the hermetic environment is applied once: importing it again changes nothing", async () => {
  const before = { home: process.env.HOME, state: process.env.XDG_STATE_HOME };
  assert.ok(realpathSync(before.state).startsWith(realpathSync(tmpdir())), `state folder is ${before.state}`);
  assert.ok(realpathSync(before.home).startsWith(realpathSync(tmpdir())), `home is ${before.home}`);
  await import(`./hermetic-env.mjs?again=${Date.now()}`);
  assert.deepEqual({ home: process.env.HOME, state: process.env.XDG_STATE_HOME }, before);
});
