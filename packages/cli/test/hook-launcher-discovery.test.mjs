import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { cardDependencies, fakeHome } from "./fake-cards.mjs";

async function sandbox() {
  const home = await fakeHome({ agents: ["claude-code"], installed: ["claude-code"] });
  const cwd = await mkdtemp(join(tmpdir(), "relo-cwd-"));
  const healthy = { ready: async () => ({ ready: true }), doctor: async () => ({ version: 1, ok: true }),
    authStatus: async () => ({ authenticated: true, credential: { id: "c", clientName: "Studio", prefix: "p", expiresAt: "2027-01-01T00:00:00Z",
      scopes: ["activities:read", "activities:write", "devices:read", "interactions:create", "interactions:read", "notifications:send"] } }) };
  const deps = { ...cardDependencies(healthy), home, cwd, env: {} };
  const go = (argv) => run(argv, { stdout: () => {}, stderr: () => {}, stdoutIsTTY: false }, deps);
  const commands = async () => JSON.stringify(JSON.parse(await readFile(join(home, ".claude", "settings.json"), "utf8")).hooks);
  return { home, go, commands };
}

const launcher = async (home, text) => {
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  await writeFile(join(home, ".local", "bin", "relo"), text, { mode: 0o755 });
  return join(home, ".local", "bin", "relo");
};

test("setup finds Relo for Mac's launcher by its marker, without RELO_HOOK_LAUNCHER", async () => {
  const box = await sandbox();
  const path = await launcher(box.home, "#!/bin/sh\n# Written by Relo for Mac\nexec relo-app \"$@\"\n");
  await box.go(["setup", "--agent", "claude-code", "--level", "guide"]);
  const text = await box.commands();
  assert.ok(text.includes(`\\"${path}\\" hook `), text);
  assert.doesNotMatch(text, /"relo hook/u);
});

test("a file without the marker is not Relo for Mac's launcher", async () => {
  const box = await sandbox();
  await launcher(box.home, "#!/bin/sh\nexec some-other-relo \"$@\"\n");
  await box.go(["setup", "--agent", "claude-code", "--level", "guide"]);
  assert.match(await box.commands(), /"relo hook /u);
});

test("refresh keeps an absolute launcher hook whose target still exists, and drops one that is gone", async () => {
  const box = await sandbox();
  const path = await launcher(box.home, "#!/bin/sh\n# Written by Relo for Mac\n");
  await box.go(["setup", "--agent", "claude-code", "--level", "guide"]);
  // The app's launcher goes away without a marker: the absolute form is kept while its target exists.
  await writeFile(path, "#!/bin/sh\nexec other\n", { mode: 0o755 });
  await box.go(["setup", "--refresh"]);
  assert.ok((await box.commands()).includes(`\\"${path}\\" hook `));
  await writeFile(path, "", { mode: 0o755 });
  await (await import("node:fs/promises")).rm(path);
  await box.go(["setup", "--refresh"]);
  assert.match(await box.commands(), /"relo hook /u);
});
