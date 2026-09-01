import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";
import {
  configureCodexNotify,configureInternals,projectCodexNotify,
} from "../src/configure-codex-notify.mjs";

const execFileAsync = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/configure-codex-notify.mjs", import.meta.url));

test("backs up config and inserts top-level notify before TOML tables", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-codex-config-"));
  const config = join(directory, "config.toml");
  const original = 'model = "test"\n\n[features]\napps = true\n';
  try {
    await writeFile(config, original, { mode: 0o600 });
    await execFileAsync(process.execPath, [
      script,
      "--config",
      config,
      "--adapter",
      "/home/test/.local/bin/relo-codex-notify",
      "--relo",
      "/home/test/.local/bin/relo",
      "--backup-suffix",
      "test-20260806",
    ]);
    const updated = await readFile(config, "utf8");
    assert.match(updated, /^model = "test"\n\nnotify = \[/u);
    assert.ok(updated.indexOf("notify =") < updated.indexOf("[features]"));
    assert.equal(await readFile(`${config}.before-relo-notify-test-20260806`, "utf8"), original);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("refuses existing notify and insecure config modes", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "relo-codex-refuse-"));
  const config = join(directory, "config.toml");
  const args = [
    script,
    "--config",
    config,
    "--adapter",
    "/opt/adapter",
    "--relo",
    "/opt/relo",
    "--backup-suffix",
    "test-20260806",
  ];
  try {
    await writeFile(config, 'notify = ["/existing"]\n', { mode: 0o600 });
    await assert.rejects(execFileAsync(process.execPath, args), /already contains an unrelated notifier/);
    await writeFile(config, 'model = "test"\n', { mode: 0o644 });
    await chmod(config, 0o644);
    await assert.rejects(execFileAsync(process.execPath, args), /must not be accessible/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("reconciles lifecycle-only Relo inside an existing notifier and diagnoses exact paths",() => {
  const oldRelo = [
    "/old/relo-codex-notify","--relo-bin","/old/relo",
    "--installation-id-path","/private/relo.identity",
  ];
  const outer = [
    "/opt/computer-use-notifier","--previous-notify",JSON.stringify(oldRelo),"--mode","quiet",
  ];
  const values = {
    action: "install",config: "/private/config.toml",
    adapter: "/new/relo-codex-notify",relo: "/new/relo",
    installationIdPath: "/private/relo.identity",
  };
  const installed = projectCodexNotify(`model = "test"\nnotify = ${JSON.stringify(outer)}\n`,values);
  assert.equal(installed.changed,true);
  assert.match(installed.contents,/\/opt\/computer-use-notifier/u);
  assert.match(installed.contents,/--lifecycle-only/u);
  assert.equal(installed.contents.includes("/old/relo"),false);
  assert.deepEqual(projectCodexNotify(installed.contents,{ ...values,action: "doctor" }),{
    installed: true,found: 1,reason: undefined,
  });
  const removed = projectCodexNotify(installed.contents,{ ...values,action: "uninstall" });
  assert.equal(removed.contents.includes("relo-codex-notify"),false);
  assert.match(removed.contents,/\/opt\/computer-use-notifier/u);
  assert.match(removed.contents,/--mode/u);
});

test("doctor rejects stale managed paths and ambiguous duplicate integrations",() => {
  const values = {
    action: "doctor",config: "/private/config.toml",
    adapter: "/new/relo-codex-notify",relo: "/new/relo",
    installationIdPath: "/private/relo.identity",
  };
  const stale = `notify = ${JSON.stringify([
    "/old/relo-codex-notify","--relo-bin","/old/relo",
    "--installation-id-path","/private/relo.identity",
  ])}\n`;
  assert.equal(projectCodexNotify(stale,values).installed,false);
  const managed = [
    "/old/relo-codex-notify","--relo-bin","/old/relo",
    "--installation-id-path","/private/relo.identity",
  ];
  const duplicate = `notify = ${JSON.stringify([
    "/outer","--previous-notify",JSON.stringify(managed),"--other",JSON.stringify(managed),
  ])}\n`;
  assert.throws(() => projectCodexNotify(duplicate,values),/multiple Relo integrations/);
});

test("compare-and-swap preserves a concurrent config update and removes its temporary file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-codex-race-"));
  const config = join(directory, "config.toml");
  try {
    await writeFile(config, 'model = "before"\n', { mode: 0o600 });
    await assert.rejects(
      configureCodexNotify(
        {
          config,
          adapter: "/opt/relo-codex-notify",
          relo: "/opt/relo",
          backupSuffix: "race-test",
        },
        {
          beforeCommit: async () => writeFile(config, 'model = "concurrent"\n', { mode: 0o600 }),
        },
      ),
      (error) => error.code === "CONFIGURATION_CHANGED",
    );
    assert.equal(await readFile(config, "utf8"), 'model = "concurrent"\n');
    const files = await import("node:fs/promises").then(({ readdir }) => readdir(directory));
    assert.equal(files.some((name) => name.endsWith(".tmp")), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an exclusive backup collision preserves the pre-existing backup", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-codex-backup-collision-"));
  const config = join(directory, "config.toml");
  const backup = `${config}.before-relo-notify-collision-test`;
  try {
    await writeFile(config, 'model = "before"\n', { mode: 0o600 });
    await writeFile(backup, "user-owned backup\n", { mode: 0o600 });
    await assert.rejects(
      configureCodexNotify({
        config,
        adapter: "/opt/relo-codex-notify",
        relo: "/opt/relo",
        backupSuffix: "collision-test",
      }),
      (error) => error.code === "EEXIST",
    );
    assert.equal(await readFile(backup, "utf8"), "user-owned backup\n");
    assert.equal(await readFile(config, "utf8"), 'model = "before"\n');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("exclusive backup failure uses only the held handle and leaves its owned artifact", async () => {
  const calls = [];
  const failure = new Error("injected write failure");
  const info = {
    dev: 1,
    ino: 2,
    nlink: 1,
    size: 0,
    isFile: () => true,
    isSymbolicLink: () => false,
  };
  const handle = {
    chmod: async (mode) => calls.push(["chmod", mode]),
    stat: async () => { calls.push(["stat"]); return info; },
    writeFile: async () => { calls.push(["write"]); throw failure; },
    sync: async () => calls.push(["sync"]),
    close: async () => calls.push(["close"]),
  };
  await assert.rejects(
    configureInternals.exclusiveWrite("/not-used", "backup", 0o600, {
      openImpl: async (_path, flag, mode) => {
        calls.push(["open", flag, mode]);
        return handle;
      },
      lstatImpl: async () => { calls.push(["lstat"]); return info; },
    }),
    (error) => error === failure,
  );
  assert.deepEqual(calls, [
    ["open", "wx", 0o600],
    ["chmod", 0o600],
    ["stat"],
    ["lstat"],
    ["write"],
    ["close"],
  ]);
});

test("exclusive backup detects rename-away after writing and retains both artifacts", async () => {
  const directory = await mkdtemp(join(tmpdir(), "relo-codex-backup-rename-"));
  const backup = join(directory, "config.backup");
  const moved = join(directory, "renamed-owned-backup");
  try {
    await assert.rejects(
      configureInternals.exclusiveWrite(backup, "owned backup\n", 0o600, {
        afterWrite: async () => {
          await rename(backup, moved);
          await writeFile(backup, "external replacement\n", { flag: "wx", mode: 0o600 });
        },
      }),
      (error) => error.code === "BACKUP_PATH_CHANGED",
    );
    assert.equal(await readFile(backup, "utf8"), "external replacement\n");
    assert.equal(await readFile(moved, "utf8"), "owned backup\n");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
