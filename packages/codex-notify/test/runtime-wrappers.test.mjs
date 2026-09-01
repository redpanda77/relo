import assert from "node:assert/strict";
import { access, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { installRuntimeWrappers, WRAPPER_MARKER } from "../src/runtime-wrappers.mjs";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "relo-wrappers-"));
  const prefix = join(root, "prefix");
  const moduleRoot = join(prefix, "lib", "node_modules", "@relo");
  const targets = [
    join(moduleRoot, "cli", "bin", "relo.mjs"),
    join(moduleRoot, "codex-notify", "bin", "relo-codex-notify.mjs"),
    join(moduleRoot, "codex-notify", "bin", "relo-codex-hook.mjs"),
  ];
  for (const target of targets) {
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, "export {};\n", { mode: 0o644 });
  }
  return { root, prefix };
}

test("runtime wrapper install marks owned files and is idempotent", async () => {
  const { root, prefix } = await fixture();
  try {
    const first = await installRuntimeWrappers({ node: process.execPath, prefix });
    assert.equal(first.installed.every((item) => item.changed), true);
    for (const name of ["relo", "reloctl", "relo-codex-notify", "relo-codex-hook"]) {
      const contents = await readFile(join(prefix, "bin", name), "utf8");
      assert.match(contents, /^#!\/bin\/sh\n# Relo-OWNED runtime wrapper v1\n/);
    }
    const second = await installRuntimeWrappers({ node: process.execPath, prefix });
    assert.equal(second.installed.every((item) => !item.changed), true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime wrapper install replaces only npm-style links to the exact package targets", async () => {
  const { root, prefix } = await fixture();
  const bin = join(prefix, "bin");
  const moduleRoot = join(prefix, "lib", "node_modules", "@relo");
  const links = [
    ["relo", join(moduleRoot, "cli", "bin", "relo.mjs")],
    ["reloctl", join(moduleRoot, "cli", "bin", "relo.mjs")],
    ["relo-codex-notify", join(moduleRoot, "codex-notify", "bin", "relo-codex-notify.mjs")],
    ["relo-codex-hook", join(moduleRoot, "codex-notify", "bin", "relo-codex-hook.mjs")],
  ];
  try {
    await mkdir(bin, { recursive: true });
    for (const [name, target] of links) await symlink(target, join(bin, name));
    const result = await installRuntimeWrappers({ node: process.execPath, prefix });
    assert.equal(result.installed.every((item) => item.changed), true);
    for (const [name] of links) {
      const info = await lstat(join(bin, name));
      assert.equal(info.isFile(), true);
      assert.equal(info.isSymbolicLink(), false);
      assert.match(await readFile(join(bin, name), "utf8"), new RegExp(WRAPPER_MARKER));
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime wrapper install refuses a symlink to any other target", async () => {
  const { root, prefix } = await fixture();
  const path = join(prefix, "bin", "relo");
  const target = join(root, "user-owned-command");
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(target, "#!/bin/sh\n", { mode: 0o755 });
    await symlink(target, path);
    await assert.rejects(
      installRuntimeWrappers({ node: process.execPath, prefix }),
      /Refusing symlink outside the expected package target/,
    );
    assert.equal(await readlink(path), target);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime wrapper install backs up and refuses an unmanaged binary", async () => {
  const { root, prefix } = await fixture();
  const path = join(prefix, "bin", "relo");
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "#!/bin/sh\necho user-owned\n", { mode: 0o755 });
    await assert.rejects(
      installRuntimeWrappers({ node: process.execPath, prefix }),
      (error) => error.code === "UNMANAGED_WRAPPER" && typeof error.backup === "string",
    );
    assert.equal(await readFile(path, "utf8"), "#!/bin/sh\necho user-owned\n");
    const backups = (await readdir(dirname(path))).filter((name) => name.startsWith("relo.before-relo-wrapper-"));
    assert.equal(backups.length, 1);
    assert.equal(await readFile(join(dirname(path), backups[0]), "utf8"), "#!/bin/sh\necho user-owned\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime wrapper preflight prevents partial mutation when a later path is unmanaged", async () => {
  const { root, prefix } = await fixture();
  const first = join(prefix, "bin", "relo");
  const later = join(prefix, "bin", "reloctl");
  try {
    await mkdir(dirname(first), { recursive: true });
    await writeFile(later, "#!/bin/sh\necho user-owned\n", { mode: 0o755 });
    await assert.rejects(
      installRuntimeWrappers({ node: process.execPath, prefix }),
      (error) => error.code === "UNMANAGED_WRAPPER",
    );
    await assert.rejects(access(first), (error) => error.code === "ENOENT");
    assert.equal(await readFile(later, "utf8"), "#!/bin/sh\necho user-owned\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("runtime wrapper compare-and-swap preserves a concurrent managed edit", async () => {
  const { root, prefix } = await fixture();
  const path = join(prefix, "bin", "relo");
  try {
    await installRuntimeWrappers({ node: process.execPath, prefix });
    const concurrent = `#!/bin/sh\n${WRAPPER_MARKER}\n# concurrent owner edit\n`;
    let changed = false;
    await assert.rejects(
      installRuntimeWrappers(
        { node: "/bin/sh", prefix },
        { beforeCommit: async (candidate) => {
          if (candidate !== path || changed) return;
          changed = true;
          await writeFile(path, concurrent, { mode: 0o755 });
        } },
      ),
      (error) => error.code === "CONFIGURATION_CHANGED",
    );
    assert.equal(await readFile(path, "utf8"), concurrent);
    await access(path);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
