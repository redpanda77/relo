import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { inspectRelos } from "../src/install/inspect.mjs";

const root = mkdtempSync(join(tmpdir(), "relo-relos-"));

/** A fake @relo/cli package at <base>/<name>/lib/node_modules/@relo/cli with bin/relo.mjs. Returns its relo.mjs path. */
function pkg(base, version) {
  const dir = join(base, "node_modules", "@relo", "cli");
  mkdirSync(join(dir, "bin"), { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@relo/cli", version }));
  writeFileSync(join(dir, "bin", "relo.mjs"), "#!/usr/bin/env node\n");
  return join(dir, "bin", "relo.mjs");
}
function binDir(name, install) {
  const dir = join(root, name, "bin");
  mkdirSync(dir, { recursive: true });
  install(join(dir, "relo"));
  return dir;
}
const linkTo = (target) => (file) => symlinkSync(target, file);
const launcherTo = (target) => (file) => { writeFileSync(file, `#!/bin/sh\nexec /usr/bin/node ${target} "$@"\n`); chmodSync(file, 0o755); };
const path = (...dirs) => ({ PATH: dirs.join(delimiter) });

test("one install is not a warning, even through a launcher and a symlink", () => {
  const script = pkg(join(root, "a"), "0.17.64");
  const direct = binDir("a1", linkTo(script));
  const launcher = binDir("a2", launcherTo(script));
  const result = inspectRelos({ env: path(direct, launcher, join(root, "nowhere")) });
  assert.equal(result.ok, true);
  assert.equal(result.installs.length, 1);
  assert.equal(result.installs[0].version, "0.17.64");
});

test("two installs: names both, says the first is older", () => {
  const old = pkg(join(root, "nvm", "lib"), "0.17.58");
  const app = pkg(join(root, "Relo.app", "Contents", "Resources", "server", "cli-root"), "0.17.64");
  const first = binDir("b1", linkTo(old));
  const second = binDir("b2", launcherTo(app));
  const result = inspectRelos({ env: path(first, second) });
  assert.equal(result.ok, false);
  assert.equal(result.state, "older_first");
  assert.equal(result.first, join(first, "relo"));
  assert.deepEqual(result.installs.map((row) => row.version), ["0.17.58", "0.17.64"]);
  assert.match(result.hint, /0\.17\.58/u);
  assert.match(result.hint, /0\.17\.64/u);
  assert.match(result.hint, /older than 0\.17\.64/u);
  assert.match(result.hint, /npm uninstall --global @relo\/cli/u);
  assert.match(result.hint, /Relo for Mac/u);
  assert.doesNotMatch(result.hint, /brew/u);
});

test("two installs with the newest first: several, not older_first; unreadable version is unknown", () => {
  const newer = pkg(join(root, "c"), "0.18.0");
  const older = pkg(join(root, "Cellar", "relo"), "0.17.1");
  const first = binDir("c1", linkTo(newer));
  const second = binDir("c2", linkTo(older));
  const third = binDir("c3", (file) => { writeFileSync(file, "#!/bin/sh\necho hi\n"); chmodSync(file, 0o755); });
  const result = inspectRelos({ env: path(first, second, third) });
  assert.equal(result.state, "several");
  assert.doesNotMatch(result.hint, /older than/u);
  assert.equal(result.installs.at(-1).version, "unknown");
  assert.match(result.hint, /brew uninstall relo/u);
});
