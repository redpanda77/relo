import { createHash } from "node:crypto";
import { chmod, lstat, open, readFile, rename, rm } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";

const MAX_CONFIG_BYTES = 2 * 1024 * 1024;

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function requireAbsolute(value, name) {
  if (!value || !isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  return value;
}

function managedCommand(values, config) {
  const adapter = requireAbsolute(values.adapter, "adapter");
  const relo = requireAbsolute(values.relo, "relo");
  const installationIdPath = values.installationIdPath
    ? requireAbsolute(values.installationIdPath,"installation-id-path")
    : join(dirname(config),"relo-codex-notify.identity");
  return [
    adapter,"--relo-bin",relo,"--installation-id-path",installationIdPath,
    "--lifecycle-only",
    ...(values.generic ? ["--generic"] : []),
  ];
}

function notifyAssignment(contents) {
  const matches = [...contents.matchAll(/^([ \t]*notify[ \t]*=[ \t]*)(.*)$/gmu)];
  if (matches.length > 1) throw new Error("Codex config contains multiple top-level notify assignments");
  if (matches.length === 0) return undefined;
  const match = matches[0];
  let command;
  try {
    command = JSON.parse(match[2]);
  } catch {
    throw new Error("Codex notify must be a one-line string array before Relo can manage it");
  }
  if (!Array.isArray(command) || command.length === 0 || command.some((part) => typeof part !== "string")) {
    throw new Error("Codex notify must be a non-empty string array");
  }
  return { command,index: match.index,length: match[0].length,prefix: match[1] };
}

function isManagedCommand(command) {
  return Array.isArray(command)
    && command.some((part) => /(?:^|[\\/])relo-codex-notify(?:\.mjs)?$/u.test(part))
    && command.includes("--relo-bin");
}

function rewriteManagedCommand(command, replacement, action) {
  if (isManagedCommand(command)) {
    return { command: action === "uninstall" ? undefined : replacement,found: 1 };
  }
  const rewritten = [...command];
  let found = 0;
  for (let index = 0; index < rewritten.length; index += 1) {
    const value = rewritten[index];
    if (!value.startsWith("[")) continue;
    let nested;
    try {
      nested = JSON.parse(value);
    } catch {
      continue;
    }
    if (!Array.isArray(nested) || nested.some((part) => typeof part !== "string")) continue;
    const result = rewriteManagedCommand(nested,replacement,action);
    if (result.found === 0) continue;
    found += result.found;
    if (result.command) {
      rewritten[index] = JSON.stringify(result.command);
    } else if (rewritten[index-1] === "--previous-notify") {
      rewritten.splice(index-1,2);
      index -= 2;
    } else {
      throw new Error("Relo is nested in an unsupported notifier argument");
    }
  }
  return { command: rewritten,found };
}

export function projectCodexNotify(contents, values) {
  const config = requireAbsolute(values.config, "config");
  const action = values.action ?? "install";
  if (!["install","doctor","uninstall"].includes(action)) {
    throw new Error("Action must be install, doctor, or uninstall");
  }
  const target = managedCommand(values,config);
  const assignment = notifyAssignment(contents);
  if (!assignment) {
    if (action === "doctor") return { installed: false,reason: "notify-missing" };
    if (action === "uninstall") return { changed: false,contents,found: 0 };
    const line = `notify = ${JSON.stringify(target)}\n`;
    const firstTable = contents.search(/^[ \t]*\[/mu);
    const updated = firstTable === -1
      ? `${contents}${contents.endsWith("\n") || contents.length === 0 ? "" : "\n"}${line}`
      : `${contents.slice(0, firstTable)}${line}\n${contents.slice(firstTable)}`;
    return { changed: true,contents: updated,found: 0,installed: true };
  }
  const rewritten = rewriteManagedCommand(assignment.command,target,action);
  if (rewritten.found > 1) throw new Error("Codex notify contains multiple Relo integrations");
  if (action === "doctor") {
    return {
      installed: rewritten.found === 1
        && JSON.stringify(rewritten.command) === JSON.stringify(assignment.command),
      found: rewritten.found,
      reason: rewritten.found === 0 ? "relo-not-found" : undefined,
    };
  }
  if (rewritten.found === 0) {
    if (action === "uninstall") return { changed: false,contents,found: 0 };
    throw new Error("Codex config already contains an unrelated notifier; chain Relo explicitly first");
  }
  const replacement = rewritten.command
    ? `${assignment.prefix}${JSON.stringify(rewritten.command)}`
    : "";
  const updated = `${contents.slice(0, assignment.index)}${replacement}${contents.slice(assignment.index+assignment.length)}`;
  return { changed: updated !== contents,contents: updated,found: rewritten.found,installed: action === "install" };
}

async function inspectConfig(path, uid = process.getuid?.()) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error("Codex config must be a regular file");
  if (process.platform !== "win32" && (info.mode & 0o077) !== 0) {
    throw new Error("Codex config must not be accessible by group or other users");
  }
  if (process.platform !== "win32" && uid !== undefined && info.uid !== uid) {
    throw new Error("Codex config must be owned by the current user");
  }
  if (info.size > MAX_CONFIG_BYTES) throw new Error("Codex config is unexpectedly large");
  return info;
}

function sameFile(info, identity) {
  return info.dev === identity.dev && info.ino === identity.ino;
}

function backupPathChanged() {
  const error = new Error("Exclusive backup path changed while writing; artifacts were retained");
  error.code = "BACKUP_PATH_CHANGED";
  return error;
}

async function inspectExclusivePath(path, lstatImpl) {
  try {
    return await lstatImpl(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw backupPathChanged();
    throw error;
  }
}

function assertExclusiveIdentity(named, held, identity, size) {
  if (
    !named.isFile() || named.isSymbolicLink() || !sameFile(named, identity)
    || !held.isFile() || held.isSymbolicLink() || !sameFile(held, identity)
    || held.nlink !== 1 || held.size !== size
  ) {
    throw backupPathChanged();
  }
}

async function exclusiveWrite(
  path,
  contents,
  mode,
  { openImpl = open, lstatImpl = lstat, afterWrite } = {},
) {
  let handle;
  try {
    handle = await openImpl(path, "wx", mode);
    await handle.chmod(mode);
    const initial = await handle.stat();
    const identity = { dev: initial.dev, ino: initial.ino };
    const initialPath = await inspectExclusivePath(path, lstatImpl);
    assertExclusiveIdentity(initialPath, initial, identity, 0);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await afterWrite?.();
    const finalPath = await inspectExclusivePath(path, lstatImpl);
    const final = await handle.stat();
    assertExclusiveIdentity(finalPath, final, identity, Buffer.byteLength(contents, "utf8"));
    await handle.close();
    handle = undefined;
  } catch (error) {
    await handle?.close().catch(() => {});
    throw error;
  }
}

export async function configureCodexNotify(values, dependencies = {}) {
  const config = requireAbsolute(values.config, "config");
  const info = await inspectConfig(config, dependencies.uid);
  const current = await readFile(config, "utf8");
  const projected = projectCodexNotify(current,{ ...values,config });
  if ((values.action ?? "install") === "doctor") return projected;
  if (!projected.changed) {
    return { configured: values.action !== "uninstall",changed: false };
  }
  if (!values.backupSuffix || !/^[A-Za-z0-9._-]{4,80}$/.test(values.backupSuffix)) {
    throw new Error("--backup-suffix must contain 4-80 safe characters");
  }

  const mode = info.mode & 0o777;
  const backup = `${config}.before-relo-notify-${values.backupSuffix}`;
  await exclusiveWrite(backup, current, mode);
  const temporary = join(dirname(config), `.config.toml.relo-${process.pid}-${Date.now()}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", mode);
    await handle.writeFile(projected.contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await chmod(temporary, mode);
    await dependencies.beforeCommit?.(config);
    await inspectConfig(config, dependencies.uid);
    const latest = await readFile(config, "utf8");
    if (digest(latest) !== digest(current)) {
      const error = new Error("Codex config changed while configuring notify; no update was applied");
      error.code = "CONFIGURATION_CHANGED";
      throw error;
    }
    await rename(temporary, config);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
  return {
    configured: (values.action ?? "install") !== "uninstall",
    changed: true,
    backup,
  };
}

export const configureInternals = Object.freeze({ exclusiveWrite });
