import { randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, lstat, mkdir, open, readFile, readlink, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";

export const WRAPPER_MARKER = "# Relo-OWNED runtime wrapper v1";

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

async function readExisting(path, expectedTarget) {
  let info;
  try { info = await lstat(path); }
  catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (info.isSymbolicLink()) {
    const linkTarget = await readlink(path);
    if (resolve(dirname(path), linkTarget) !== resolve(expectedTarget)) {
      throw new Error(`Refusing symlink outside the expected package target: ${path}`);
    }
    return { kind: "package-link", linkTarget };
  }
  if (!info.isFile()) {
    throw new Error(`Refusing non-regular wrapper path: ${path}`);
  }
  if (info.size > 1024 * 1024) throw new Error(`Refusing oversized wrapper path: ${path}`);
  return { kind: "file", contents: await readFile(path, "utf8"), mode: info.mode & 0o777 };
}

function sameExisting(left, right) {
  if (!left || !right) return left === right;
  if (left.kind !== right.kind) return false;
  return left.kind === "package-link"
    ? left.linkTarget === right.linkTarget
    : left.contents === right.contents && left.mode === right.mode;
}

async function writeExclusive(path, contents, mode) {
  let handle;
  try {
    handle = await open(path, "wx", mode);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(path, mode);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(path, { force: true }).catch(() => {});
    throw error;
  }
}

async function prepareWrapper(name, target, values) {
  if (!isAbsolute(target)) throw new Error(`Target for ${name} must be absolute`);
  await access(target, constants.R_OK);
  const path = join(values.prefix, "bin", name);
  const existing = await readExisting(path, target);
  if (existing?.kind === "file" && !existing.contents.startsWith(`#!/bin/sh\n${WRAPPER_MARKER}\n`)) {
    const backup = `${path}.before-relo-wrapper-${Date.now()}-${randomBytes(4).toString("hex")}.bak`;
    await writeExclusive(backup, existing.contents, existing.mode);
    const error = new Error(`Refusing to replace unmanaged wrapper path: ${path}; backup: ${backup}`);
    error.code = "UNMANAGED_WRAPPER";
    error.backup = backup;
    throw error;
  }
  const content = `#!/bin/sh\n${WRAPPER_MARKER}\nexec ${shellQuote(values.node)} ${shellQuote(target)} "$@"\n`;
  return { name, path, target, existing, content };
}

async function installWrapper(prepared, dependencies) {
  const { name, path, target, existing, content } = prepared;
  if (existing?.kind === "file" && existing.contents === content) return { name, path, changed: false };
  const temporary = `${path}.relo-install-${process.pid}-${randomBytes(4).toString("hex")}`;
  await writeExclusive(temporary, content, 0o755);
  try {
    await dependencies.beforeCommit?.(path);
    const latest = await readExisting(path, target);
    if (!sameExisting(latest, existing)) {
      const error = new Error(`Wrapper changed while installing: ${path}`);
      error.code = "CONFIGURATION_CHANGED";
      throw error;
    }
    await rename(temporary, path);
    return { name, path, changed: true };
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

export async function installRuntimeWrappers(values, dependencies = {}) {
  if (!values.node || !isAbsolute(values.node) || !values.prefix || !isAbsolute(values.prefix)) {
    throw new Error("Usage: install-runtime-wrappers.mjs --node ABSOLUTE_NODE --prefix ABSOLUTE_PREFIX");
  }
  await access(values.node, constants.X_OK);
  const moduleRoot = join(values.prefix, "lib", "node_modules", "@relo");
  const cliTarget = join(moduleRoot, "cli", "bin", "relo.mjs");
  const targets = [
    ["relo", cliTarget],
    ["reloctl", cliTarget],
    ["relo-codex-notify", join(moduleRoot, "codex-notify", "bin", "relo-codex-notify.mjs")],
    ["relo-codex-hook", join(moduleRoot, "codex-notify", "bin", "relo-codex-hook.mjs")],
  ];
  await mkdir(join(values.prefix, "bin"), { recursive: true, mode: 0o755 });
  const prepared = [];
  for (const [name, target] of targets) prepared.push(await prepareWrapper(name, target, values));
  const installed = [];
  for (const wrapper of prepared) installed.push(await installWrapper(wrapper, dependencies));
  return { installed };
}
