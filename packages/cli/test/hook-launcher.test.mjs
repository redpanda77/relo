import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { bareCommand, isReloHookCommand, isReloStatusline, reloCommand } from "../src/harness/core/launch.mjs";

// Relo for Mac runs setup with RELO_HOOK_LAUNCHER: hooks then run its launcher by path, whatever relo is first on PATH.
test("Relo for Mac's launcher is written by path and still recognised as Relo's", () => {
  const launch = { launcher: "/Users/me/.local/bin/relo", platform: "darwin" };
  assert.equal(reloCommand("hook guard", launch), `"/Users/me/.local/bin/relo" hook guard`);
  assert.equal(isReloHookCommand(`"/Users/me/.local/bin/relo" hook guard`), true);
  assert.equal(isReloStatusline(`"/Users/me/.local/bin/relo" statusline`), true);
  assert.equal(bareCommand(`"/Users/me/.local/bin/relo" hook stop --agent codex`), "relo hook stop --agent codex");
  // Without it (or a relative path) the command stays bare.
  assert.equal(reloCommand("hook guard", { platform: "darwin" }), "relo hook guard");
  assert.equal(reloCommand("hook guard", { launcher: "relo", platform: "darwin" }), "relo hook guard");
  assert.equal(isReloHookCommand(`"/usr/bin/other" hook guard`), false);
});
