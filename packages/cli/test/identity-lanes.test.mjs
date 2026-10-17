import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { test } from "node:test";
import { observedLabels } from "../src/harness/core/labels.mjs";
import { detectIdentityDefaults, detectOrigin } from "../src/shared/identity.mjs";

// A card (declared lane) and its session row (hook lane) name the same computer and project.
const hookDeps = (env, cached) => ({
  env, accountProbes: {}, computerName: () => "Detected Mac", loadComputerName: () => cached,
  configPath: () => "/none", loadStoredConfig: async () => { throw new Error("no config"); }, writeConfig: async () => {},
});

for (const [name, env, cached] of [
  ["a stored name wins over detection", {}, "Stored Mac"],
  ["RELO_COMPUTER wins over everything", { RELO_COMPUTER: "Env Mac" }, "Stored Mac"],
  ["nothing stored: detected", {}, undefined],
]) {
  test(`both lanes agree on the computer: ${name}`, async () => {
    const hook = await observedLabels({ cwd: undefined, harnessEnv: env, config: undefined, dependencies: hookDeps(env, cached) });
    const declared = detectOrigin(env, { platform: "linux", hostname: () => "Detected Mac" }, () => cached);
    assert.equal(hook.labels.computer, declared.computer);
  });
}

test("both lanes agree on the project, cleaned the same way", async () => {
  const env = { RELO_PROJECT: "  my\tproject  " };
  const hook = await observedLabels({ cwd: undefined, harnessEnv: env, config: undefined, dependencies: hookDeps(env) });
  assert.equal(hook.labels.project, detectIdentityDefaults(env, "/nowhere").project);
  assert.equal(hook.labels.project, "my project");
});
