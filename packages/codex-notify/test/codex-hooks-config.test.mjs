import assert from "node:assert/strict";
import { mkdtemp,readFile,rm,stat,writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  inspectCodexLifecycleHooks,installCodexLifecycleHooks,uninstallCodexLifecycleHooks,
} from "../src/codex-hooks-config.mjs";

const values = (directory) => ({
  hooksConfig: join(directory,"hooks.json"),hook: "/opt/relo-codex-hook",
  relo: "/opt/relo",installationIdPath: "/private/codex.identity",
});

test("installs, diagnoses, refreshes, and surgically removes additive lifecycle hooks",async () => {
  const directory = await mkdtemp(join(tmpdir(),"relo-codex-hooks-"));
  try {
    const input = values(directory);
    await writeFile(input.hooksConfig,JSON.stringify({ hooks: { Stop: [{ hooks: [{
      type: "command",command: "/opt/existing",statusMessage: "Existing",
    }] }] } }),{ mode: 0o600 });
    const installed = await installCodexLifecycleHooks(input);
    assert.equal(installed.installed,true);
    assert.equal(installed.changed,true);
    assert.equal((await stat(input.hooksConfig)).mode & 0o077,0);
    let config = JSON.parse(await readFile(input.hooksConfig,"utf8"));
    assert.equal(config.hooks.Stop.flatMap((group) => group.hooks).some((hook) => hook.command === "/opt/existing"),true);
    assert.equal((await inspectCodexLifecycleHooks(input)).installed,true);
    const unchanged = await installCodexLifecycleHooks(input);
    assert.equal(unchanged.changed,false);
    config = JSON.parse(await readFile(input.hooksConfig,"utf8"));
    for (const groups of Object.values(config.hooks)) {
      assert.equal(groups.flatMap((group) => group.hooks).filter((hook) =>
        hook.statusMessage?.startsWith("Relo: Live Activity lifecycle"),
      ).length,1);
    }
    const removed = await uninstallCodexLifecycleHooks(input);
    assert.equal(removed.removed,5);
    config = JSON.parse(await readFile(input.hooksConfig,"utf8"));
    assert.equal(config.hooks.Stop[0].hooks[0].command,"/opt/existing");
    assert.equal((await inspectCodexLifecycleHooks(input)).installed,false);
  } finally {
    await rm(directory,{ recursive: true,force: true });
  }
});

test("refreshes lifecycle hooks from another install prefix without touching unrelated hooks",async () => {
  const directory = await mkdtemp(join(tmpdir(),"relo-codex-hooks-prefix-"));
  try {
    const current = values(directory);
    const prior = { ...current,hook: "/old/bin/relo-codex-hook",relo: "/old/bin/relo" };
    await writeFile(current.hooksConfig,JSON.stringify({ hooks: { Stop: [{ hooks: [{
      type: "command",command: "/opt/user-hook",statusMessage: "User hook",
    }] }] } }),{ mode: 0o600 });
    await installCodexLifecycleHooks(prior);
    const stale = await inspectCodexLifecycleHooks(current);
    assert.equal(stale.installed,false);
    assert.deepEqual(stale.staleEvents,[
      "UserPromptSubmit","PostToolUse","PermissionRequest","Stop","SessionEnd",
    ]);

    const refreshed = await installCodexLifecycleHooks(current);
    assert.equal(refreshed.changed,true);
    assert.equal((await inspectCodexLifecycleHooks(current)).installed,true);
    const config = JSON.parse(await readFile(current.hooksConfig,"utf8"));
    const stopHooks = config.hooks.Stop.flatMap((group) => group.hooks);
    assert.equal(stopHooks.some((hook) => hook.command === "/opt/user-hook"),true);
    assert.equal(stopHooks.filter((hook) => hook.statusMessage?.startsWith(
      "Relo: Live Activity lifecycle",
    )).length,1);
  } finally {
    await rm(directory,{ recursive: true,force: true });
  }
});

test("install preserves a concurrent user edit instead of overwriting hooks.json",async () => {
  const directory = await mkdtemp(join(tmpdir(),"relo-codex-hooks-race-"));
  try {
    const input = values(directory);
    await writeFile(input.hooksConfig,'{"description":"before"}\n',{ mode: 0o600 });
    await assert.rejects(
      installCodexLifecycleHooks(input,{
        beforeCommit: async () => writeFile(
          input.hooksConfig,'{"description":"concurrent"}\n',{ mode: 0o600 },
        ),
      }),
      (error) => error.code === "CONFIGURATION_CHANGED",
    );
    assert.equal(await readFile(input.hooksConfig,"utf8"),'{"description":"concurrent"}\n');
  } finally {
    await rm(directory,{ recursive: true,force: true });
  }
});

test("uninstall preserves a concurrent user edit instead of removing hooks",async () => {
  const directory = await mkdtemp(join(tmpdir(),"relo-codex-hooks-uninstall-race-"));
  try {
    const input = values(directory);
    await installCodexLifecycleHooks(input);
    const concurrent = '{"description":"concurrent","hooks":{}}\n';
    await assert.rejects(
      uninstallCodexLifecycleHooks(input,{
        beforeCommit: async () => writeFile(input.hooksConfig,concurrent,{ mode: 0o600 }),
      }),
      (error) => error.code === "CONFIGURATION_CHANGED",
    );
    assert.equal(await readFile(input.hooksConfig,"utf8"),concurrent);
  } finally {
    await rm(directory,{ recursive: true,force: true });
  }
});
