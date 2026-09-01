import { randomBytes } from "node:crypto";
import { chmod,lstat,mkdir,open,readFile,rename,rm } from "node:fs/promises";
import { dirname,isAbsolute,join } from "node:path";

const EVENTS = ["UserPromptSubmit","PostToolUse","PermissionRequest","Stop","SessionEnd"];
const MARKER = "Relo: Live Activity lifecycle";
const MAX_BYTES = 2 * 1024 * 1024;

function absolute(value,label) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`${label} must be absolute`);
  return value;
}

function quote(value) {
  return `'${String(value).replaceAll("'",`'"'"'`)}'`;
}

function handler(event,values) {
  return {
    type: "command",
    command: [values.hook,"--relo-bin",values.relo,"--installation-id-path",values.installationIdPath]
      .map(quote).join(" "),
    timeout: event === "SessionEnd" ? 3 : 15,
    statusMessage: `${MARKER} · ${event}`,
  };
}

function owned(value,event) {
  return value?.type === "command" && value?.statusMessage === `${MARKER} · ${event}`;
}

async function readConfig(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) {
      throw new Error("Codex hooks config must be a bounded regular file");
    }
    return { contents: await readFile(path,"utf8"),mode: info.mode & 0o777 };
  } catch (error) {
    if (error?.code === "ENOENT") return { contents: null,mode: 0o600 };
    throw error;
  }
}

function parse(contents) {
  if (contents === null) return {};
  const value = JSON.parse(contents);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Codex hooks config must be an object");
  if (value.hooks !== undefined && (!value.hooks || typeof value.hooks !== "object" || Array.isArray(value.hooks))) {
    throw new Error("Codex hooks must be an object");
  }
  return value;
}

function merge(config,values) {
  const next = structuredClone(config);
  next.description ??= "Codex hooks for this installation.";
  next.hooks ??= {};
  for (const event of EVENTS) {
    const groups = next.hooks[event];
    if (groups !== undefined && !Array.isArray(groups)) throw new Error(`${event} hooks must be an array`);
    const retained = [];
    for (const group of groups ?? []) {
      if (!group || typeof group !== "object" || Array.isArray(group) || !Array.isArray(group.hooks)) {
        throw new Error(`${event} hook group is invalid`);
      }
      const hooks = group.hooks.filter((entry) => !owned(entry,event));
      if (hooks.length) retained.push({ ...group,hooks });
    }
    retained.push({ hooks: [handler(event,values)] });
    next.hooks[event] = retained;
  }
  return next;
}

function remove(config) {
  const next = structuredClone(config);
  let removed = 0;
  for (const event of EVENTS) {
    const groups = next.hooks?.[event];
    if (!Array.isArray(groups)) continue;
    const retained = [];
    for (const group of groups) {
      if (!group || typeof group !== "object" || Array.isArray(group) || !Array.isArray(group.hooks)) {
        retained.push(group);
        continue;
      }
      const hooks = group.hooks.filter((entry) => {
        if (!owned(entry,event)) return true;
        removed += 1;
        return false;
      });
      if (hooks.length) retained.push({ ...group,hooks });
    }
    if (retained.length) next.hooks[event] = retained;
    else delete next.hooks[event];
  }
  if (next.hooks && !Object.keys(next.hooks).length) delete next.hooks;
  return { next,removed };
}

async function writeAtomic(path,contents,mode = 0o600) {
  await mkdir(dirname(path),{ recursive: true,mode: 0o700 });
  const temporary = join(dirname(path),`.relo-hooks.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary,"wx",0o600);
    await handle.writeFile(contents,"utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(temporary,mode & ~0o077);
    await rename(temporary,path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary,{ force: true }).catch(() => {});
    throw error;
  }
}

async function replaceIfUnchanged(path,contents,mode,expectedContents,dependencies = {}) {
  const directory = dirname(path);
  await mkdir(directory,{ recursive: true,mode: 0o700 });
  const temporary = join(directory,`.relo-hooks.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary,"wx",0o600);
    await handle.writeFile(contents,"utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(temporary,mode & ~0o077);
    await dependencies.beforeCommit?.(path);
    const latest = await readConfig(path);
    if (latest.contents !== expectedContents) {
      const error = new Error("Codex hooks config changed while configuring Relo; no update was applied");
      error.code = "CONFIGURATION_CHANGED";
      throw error;
    }
    await rename(temporary,path);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary,{ force: true }).catch(() => {});
    throw error;
  }
}

function normalizedValues(values) {
  return {
    hooksConfig: absolute(values.hooksConfig,"Hooks config"),
    hook: absolute(values.hook,"Codex hook executable"),
    relo: absolute(values.relo,"Relo executable"),
    installationIdPath: absolute(values.installationIdPath,"Installation identity path"),
  };
}

export async function inspectCodexLifecycleHooks(values) {
  const expected = normalizedValues(values);
  const current = await readConfig(expected.hooksConfig);
  const config = parse(current.contents);
  const states = Object.fromEntries(EVENTS.map((event) => {
    const handlers = Array.isArray(config.hooks?.[event])
      ? config.hooks[event].flatMap((group) => Array.isArray(group?.hooks) ? group.hooks : [])
      : [];
    const target = handler(event,expected);
    const installed = handlers.some((entry) => owned(entry,event) && entry.command === target.command
      && entry.timeout === target.timeout);
    return [event,installed ? "installed" : handlers.some((entry) => owned(entry,event)) ? "stale" : "missing"];
  }));
  const staleEvents = Object.entries(states)
    .filter(([,state]) => state !== "installed")
    .map(([event]) => event);
  return { installed: staleEvents.length === 0,states,staleEvents,
    trust: "manual-review-required",path: expected.hooksConfig };
}

export async function installCodexLifecycleHooks(values,dependencies = {}) {
  const expected = normalizedValues(values);
  const current = await readConfig(expected.hooksConfig);
  const updated = `${JSON.stringify(merge(parse(current.contents),expected),null,2)}\n`;
  if (current.contents === updated) {
    return { installed: true,changed: false,path: expected.hooksConfig,
      trust: "manual-review-required" };
  }
  let backup;
  if (current.contents !== null) {
    backup = `${expected.hooksConfig}.before-relo-${Date.now()}-${randomBytes(4).toString("hex")}.bak`;
    await writeAtomic(backup,current.contents,current.mode);
  }
  await replaceIfUnchanged(
    expected.hooksConfig,updated,current.mode,current.contents,dependencies,
  );
  return { installed: true,changed: true,path: expected.hooksConfig,...(backup ? { backup } : {}),
    trust: "manual-review-required" };
}

export async function uninstallCodexLifecycleHooks(values,dependencies = {}) {
  const expected = normalizedValues(values);
  const current = await readConfig(expected.hooksConfig);
  if (current.contents === null) return { removed: 0,path: expected.hooksConfig };
  const result = remove(parse(current.contents));
  if (!result.removed) return { removed: 0,path: expected.hooksConfig };
  const backup = `${expected.hooksConfig}.before-relo-${Date.now()}-${randomBytes(4).toString("hex")}.bak`;
  await writeAtomic(backup,current.contents,current.mode);
  await replaceIfUnchanged(
    expected.hooksConfig,`${JSON.stringify(result.next,null,2)}\n`,current.mode,
    current.contents,dependencies,
  );
  return { removed: result.removed,path: expected.hooksConfig,backup };
}

export const codexLifecycleHookEvents = Object.freeze([...EVENTS]);
