import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ApiError, UsageError } from "./errors.mjs";
import { probeOpenCodeV2Runtime } from "./opencode-bridge.mjs";

export const PERMISSION_TARGETS = Object.freeze(["codex", "claude", "opencode"]);

const MAX_SETTINGS_BYTES = 2 * 1024 * 1024;
const OWNED_STATUS = "Relo: waiting for phone permission approval";
const OPEN_CODE_MARKER = "// Relo-OWNED permission adapter. Managed by `relo permissions`.";
const OPEN_CODE_LABEL = "com.relo.permissions.opencode";
const OPEN_CODE_PLUGIN_NAME = "relo-permissions-v1.js";

function digest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

function targetPath(target, home) {
  if (target === "codex") return join(home, ".codex", "hooks.json");
  if (target === "claude") return join(home, ".claude", "settings.json");
  if (target === "opencode") {
    return join(home, ".config", "opencode", "plugin", OPEN_CODE_PLUGIN_NAME);
  }
  throw new UsageError(`Unsupported permission target: ${target}`);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function adapterCommand(target, { nodePath, entrypoint }) {
  return `${shellQuote(nodePath)} ${shellQuote(entrypoint)} permissions hook ${target}`;
}

function commandHandler(target, runtime) {
  return {
    type: "command",
    command: adapterCommand(target, runtime),
    timeout: 330,
    statusMessage: OWNED_STATUS,
  };
}

function isOwnedHandler(value, target) {
  return (
    value?.type === "command" &&
    value?.statusMessage === OWNED_STATUS &&
    typeof value?.command === "string" &&
    value.command.endsWith(` permissions hook ${target}`)
  );
}

function mergeCommandHook(settings, target, runtime) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) {
    throw new ApiError(`${target} settings must be a JSON object.`, {
      code: "INVALID_HOOK_CONFIG",
    });
  }
  const next = structuredClone(settings);
  if (next.hooks !== undefined && (!next.hooks || typeof next.hooks !== "object" || Array.isArray(next.hooks))) {
    throw new ApiError(`${target} hooks must be a JSON object.`, {
      code: "INVALID_HOOK_CONFIG",
    });
  }
  next.hooks ??= {};
  const existing = next.hooks.PermissionRequest;
  if (existing !== undefined && !Array.isArray(existing)) {
    throw new ApiError(`${target} PermissionRequest hooks must be an array.`, {
      code: "INVALID_HOOK_CONFIG",
    });
  }

  const groups = [];
  for (const group of existing ?? []) {
    if (!group || typeof group !== "object" || Array.isArray(group) || !Array.isArray(group.hooks)) {
      throw new ApiError(`${target} PermissionRequest hook entry is invalid.`, {
        code: "INVALID_HOOK_CONFIG",
      });
    }
    const hooks = group.hooks.filter((hook) => !isOwnedHandler(hook, target));
    if (hooks.length > 0) groups.push({ ...group, hooks });
  }
  groups.push({ hooks: [commandHandler(target, runtime)] });
  next.hooks.PermissionRequest = groups;
  return next;
}

function removeCommandHook(settings, target) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return null;
  const existing = settings.hooks?.PermissionRequest;
  if (!Array.isArray(existing)) return null;
  let removed = false;
  const groups = [];
  for (const group of existing) {
    if (!group || typeof group !== "object" || Array.isArray(group) || !Array.isArray(group.hooks)) {
      groups.push(group);
      continue;
    }
    const hooks = group.hooks.filter((hook) => {
      if (!isOwnedHandler(hook, target)) return true;
      removed = true;
      return false;
    });
    if (hooks.length > 0) groups.push({ ...group, hooks });
  }
  if (!removed) return null;
  const next = structuredClone(settings);
  next.hooks.PermissionRequest = groups;
  if (groups.length === 0) delete next.hooks.PermissionRequest;
  if (Object.keys(next.hooks).length === 0) delete next.hooks;
  return next;
}

function openCodePlugin({ nodePath, entrypoint }) {
  return `${OPEN_CODE_MARKER}
import { spawn } from "node:child_process";

const NODE = ${JSON.stringify(nodePath)};
const ENTRYPOINT = ${JSON.stringify(entrypoint)};
const relevant = new Set(["server.connected", "permission.asked", "permission.updated"]);

function authHeaders() {
  const password = process.env.OPENCODE_SERVER_PASSWORD;
  if (!password) return {};
  const username = process.env.OPENCODE_SERVER_USERNAME ?? "opencode";
  return { authorization: "Basic " + Buffer.from(username + ":" + password).toString("base64") };
}

async function rejectFallback(serverUrl, directory, event) {
  const permission = event?.properties;
  if (!permission?.id || !permission?.sessionID) return;
  const request = async (path, body) => {
    const url = new URL(path, serverUrl);
    if (directory) url.searchParams.set("directory", directory);
    const response = await fetch(url, {
      method: "POST",
      headers: { ...authHeaders(), "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) throw new Error("OpenCode rejection failed");
  };
  try {
    await request("/permission/" + encodeURIComponent(permission.id) + "/reply", {
      reply: "reject", message: "Denied through Relo.",
    });
  } catch {
    await request("/session/" + encodeURIComponent(permission.sessionID) + "/permissions/" + encodeURIComponent(permission.id), {
      response: "reject",
    }).catch(() => {});
  }
}

export const ReloPermissionsV1Plugin = async ({ serverUrl, directory }) => ({
  event: async ({ event }) => {
    if (!relevant.has(event?.type)) return;
    const child = spawn(NODE, [ENTRYPOINT, "permissions", "opencode-v1-event"], {
      stdio: ["pipe", "ignore", "ignore"],
      windowsHide: true,
    });
    child.once("error", () => void rejectFallback(serverUrl, directory, event));
    child.once("close", (code) => {
      if (code !== 0) void rejectFallback(serverUrl, directory, event);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ serverUrl: String(serverUrl), directory, event }));
  },
});
`;
}

function xml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function openCodeLaunchAgent({ home, nodePath, entrypoint }) {
  const stateDirectory = join(home, "Library", "Application Support", "Relo", "permission-bridge");
  const logPath = join(home, "Library", "Logs", "Relo", "permission-bridge.log");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>${OPEN_CODE_LABEL}</string>
  <key>ProgramArguments</key><array>
    <string>${xml(nodePath)}</string><string>${xml(entrypoint)}</string>
    <string>permissions</string><string>daemon</string><string>opencode</string>
  </array>
  <key>WorkingDirectory</key><string>${xml(stateDirectory)}</string>
  <key>RunAtLoad</key><true/><key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>ThrottleInterval</key><integer>10</integer><key>Umask</key><integer>63</integer>
  <key>StandardOutPath</key><string>${xml(logPath)}</string>
  <key>StandardErrorPath</key><string>${xml(logPath)}</string>
</dict></plist>
`;
}

function openCodePaths(home) {
  return {
    pluginPath: targetPath("opencode", home),
    launchAgentPath: join(home, "Library", "LaunchAgents", `${OPEN_CODE_LABEL}.plist`),
    stateDirectory: join(home, "Library", "Application Support", "Relo", "permission-bridge"),
    logDirectory: join(home, "Library", "Logs", "Relo"),
  };
}

async function readExisting(path) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new ApiError(`Refusing non-regular permission config at ${path}.`, {
      code: "INSECURE_HOOK_CONFIG",
    });
  }
  if (info.size > MAX_SETTINGS_BYTES) {
    throw new ApiError(`Refusing oversized permission config at ${path}.`, {
      code: "INVALID_HOOK_CONFIG",
    });
  }
  return readFile(path, "utf8");
}

async function writePrivateAtomic(path, contents, expected = undefined, beforeCommit) {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.relo-permissions.${process.pid}.${randomBytes(8).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    if (process.platform !== "win32") await chmod(temporary, 0o600);
    await beforeCommit?.(path);
    const latest = await readExisting(path);
    const expectedDigest = expected === null ? null : expected === undefined ? undefined : digest(expected);
    const latestDigest = latest === null ? null : digest(latest);
    if (expectedDigest !== undefined && latestDigest !== expectedDigest) {
      throw new ApiError(`Permission configuration changed while installing: ${path}.`, {
        code: "CONFIGURATION_CHANGED",
      });
    }
    await rename(temporary, path);
    if (process.platform !== "win32") await chmod(path, 0o600);
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

async function backup(path, contents) {
  const backupPath = `${path}.before-relo-${Date.now()}-${randomBytes(4).toString("hex")}.bak`;
  await writePrivateAtomic(backupPath, contents, null);
  return backupPath;
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: "ignore", shell: false });
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`${command} failed`)));
  });
}

async function launchctlLoaded(options, launchAgentPath) {
  if ((options.platform ?? process.platform) !== "darwin") return false;
  try {
    await (options.runCommand ?? runCommand)("launchctl", [
      "print",
      `gui/${options.uid ?? process.getuid()}/${OPEN_CODE_LABEL}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

function parseSettings(contents, path) {
  if (contents === null) return {};
  try {
    return JSON.parse(contents);
  } catch {
    throw new ApiError(`Invalid JSON in ${path}.`, { code: "INVALID_HOOK_CONFIG" });
  }
}

function inspectCommandSettings(contents, target, runtime, path) {
  if (contents === null) return { installed: false, state: "not-installed", path };
  let settings;
  try {
    settings = JSON.parse(contents);
  } catch {
    return { installed: false, state: "invalid", path };
  }
  const handlers = Array.isArray(settings?.hooks?.PermissionRequest)
    ? settings.hooks.PermissionRequest.flatMap((group) =>
        Array.isArray(group?.hooks) ? group.hooks : [],
      )
    : [];
  const owned = handlers.filter((handler) => isOwnedHandler(handler, target));
  const current = owned.some(
    (handler) => handler.command === adapterCommand(target, runtime) && handler.timeout === 330,
  );
  return {
    installed: current,
    state: current ? "installed" : owned.length > 0 ? "stale" : "not-installed",
    path,
    ...(target === "codex" ? { trust: "manual-review-required" } : {}),
  };
}

export async function inspectPermissionTarget(target, options = {}) {
  const runtime = {
    home: options.home ?? homedir(),
    nodePath: options.nodePath ?? process.execPath,
    entrypoint: options.entrypoint,
  };
  const path = targetPath(target, runtime.home);
  let contents;
  try {
    contents = await readExisting(path);
  } catch (error) {
    return { installed: false, state: "unsafe", path, error: error.code ?? "READ_ERROR" };
  }
  if (target !== "opencode") {
    return inspectCommandSettings(contents, target, runtime, path);
  }
  const paths = openCodePaths(runtime.home);
  let launchAgent;
  try {
    launchAgent = await readExisting(paths.launchAgentPath);
  } catch (error) {
    return { installed: false, state: "unsafe", path: paths.launchAgentPath, error: error.code ?? "READ_ERROR" };
  }
  const expected = openCodePlugin(runtime);
  const expectedLaunchAgent = openCodeLaunchAgent(runtime);
  const v1 = contents === expected;
  const v2File = launchAgent === expectedLaunchAgent;
  const v2Runtime = v2File && await launchctlLoaded(options, paths.launchAgentPath);
  const protocol = v2Runtime
    ? await (options.probeOpenCodeRuntime ?? probeOpenCodeV2Runtime)({
        home: runtime.home,
        env: options.env,
        uid: options.uid,
        fetchImpl: options.fetchImpl,
      })
    : { functional: false, state: "bridge-not-loaded" };
  const unmanaged =
    (contents !== null && !contents.startsWith(OPEN_CODE_MARKER))
    || (launchAgent !== null && !launchAgent.includes(`<string>${OPEN_CODE_LABEL}</string>`));
  return {
    installed: v1 && v2File && v2Runtime && protocol.functional === true,
    state: unmanaged
      ? "occupied-by-unmanaged-file"
      : v1 && v2File && v2Runtime && protocol.functional === true
        ? "installed"
        : contents === null && launchAgent === null
          ? "not-installed"
          : "stale",
    path,
    pluginPath: paths.pluginPath,
    launchAgentPath: paths.launchAgentPath,
    runtime: { v1, v2File, v2Runtime, protocol },
  };
}

export async function installPermissionTarget(target, options = {}) {
  const runtime = {
    home: options.home ?? homedir(),
    nodePath: options.nodePath ?? process.execPath,
    entrypoint: options.entrypoint,
  };
  const path = targetPath(target, runtime.home);
  if (target === "opencode") {
    const currentPlatform = options.platform ?? process.platform;
    if (currentPlatform !== "darwin") {
      throw new ApiError("OpenCode permission bridge setup currently supports macOS.", {
        code: "UNSUPPORTED_PLATFORM",
      });
    }
    const paths = openCodePaths(runtime.home);
    const plugin = await readExisting(paths.pluginPath);
    const agent = await readExisting(paths.launchAgentPath);
    if (plugin !== null && !plugin.startsWith(OPEN_CODE_MARKER)) {
      throw new ApiError(`Refusing to replace unmanaged OpenCode plugin at ${paths.pluginPath}.`, {
        code: "HOOK_CONFIG_CONFLICT",
      });
    }
    if (agent !== null && !agent.includes(`<string>${OPEN_CODE_LABEL}</string>`)) {
      throw new ApiError(`Refusing to replace unmanaged launch agent at ${paths.launchAgentPath}.`, {
        code: "HOOK_CONFIG_CONFLICT",
      });
    }
    await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 });
    await mkdir(paths.logDirectory, { recursive: true, mode: 0o700 });
    const nextPlugin = openCodePlugin(runtime);
    const nextAgent = openCodeLaunchAgent(runtime);
    const backupPaths = [];
    if (plugin !== null && plugin !== nextPlugin) backupPaths.push(await backup(paths.pluginPath, plugin));
    if (agent !== null && agent !== nextAgent) backupPaths.push(await backup(paths.launchAgentPath, agent));
    if (plugin !== nextPlugin) {
      await writePrivateAtomic(paths.pluginPath, nextPlugin, plugin, options.beforeCommit);
    }
    if (agent !== nextAgent) {
      await writePrivateAtomic(paths.launchAgentPath, nextAgent, agent, options.beforeCommit);
    }
    const command = options.runCommand ?? runCommand;
    const domain = `gui/${options.uid ?? process.getuid()}`;
    await command("launchctl", ["bootout", domain, paths.launchAgentPath]).catch(() => {});
    try {
      await command("launchctl", ["bootstrap", domain, paths.launchAgentPath]);
    } catch (error) {
      throw new ApiError("OpenCode permission bridge could not be started.", {
        code: "OPENCODE_BRIDGE_START_FAILED",
        cause: error,
      });
    }
    return {
      target,
      installed: true,
      changed: plugin !== nextPlugin || agent !== nextAgent,
      path: paths.pluginPath,
      pluginPath: paths.pluginPath,
      launchAgentPath: paths.launchAgentPath,
      ...(backupPaths.length > 0 ? { backupPaths } : {}),
    };
  }
  const existing = await readExisting(path);
  let next;
  next = `${JSON.stringify(mergeCommandHook(parseSettings(existing, path), target, runtime), null, 2)}\n`;
  if (existing === next) {
    return { target, installed: true, changed: false, path };
  }
  const backupPath = existing === null ? undefined : await backup(path, existing);
  await writePrivateAtomic(path, next, existing, options.beforeCommit);
  return { target, installed: true, changed: true, path, ...(backupPath ? { backupPath } : {}) };
}

export async function uninstallPermissionTarget(target, options = {}) {
  const runtime = {
    home: options.home ?? homedir(),
    nodePath: options.nodePath ?? process.execPath,
    entrypoint: options.entrypoint,
  };
  const path = targetPath(target, runtime.home);
  if (target === "opencode") {
    const paths = openCodePaths(runtime.home);
    const plugin = await readExisting(paths.pluginPath);
    const agent = await readExisting(paths.launchAgentPath);
    const managedPlugin = plugin !== null && plugin.startsWith(OPEN_CODE_MARKER);
    const managedAgent = agent !== null && agent.includes(`<string>${OPEN_CODE_LABEL}</string>`);
    if ((plugin !== null && !managedPlugin) || (agent !== null && !managedAgent)) {
      return { target, removed: false, changed: false, path, state: "unmanaged" };
    }
    if (managedPlugin) await backup(paths.pluginPath, plugin);
    if (managedAgent) await backup(paths.launchAgentPath, agent);
    if ((options.platform ?? process.platform) === "darwin") {
      await (options.runCommand ?? runCommand)("launchctl", [
        "bootout",
        `gui/${options.uid ?? process.getuid()}`,
        paths.launchAgentPath,
      ]).catch(() => {});
    }
    if (managedPlugin) {
      if (await readExisting(paths.pluginPath) !== plugin) {
        throw new ApiError(`Permission configuration changed while uninstalling: ${paths.pluginPath}.`, { code: "CONFIGURATION_CHANGED" });
      }
      await rm(paths.pluginPath);
    }
    if (managedAgent) {
      if (await readExisting(paths.launchAgentPath) !== agent) {
        throw new ApiError(`Permission configuration changed while uninstalling: ${paths.launchAgentPath}.`, { code: "CONFIGURATION_CHANGED" });
      }
      await rm(paths.launchAgentPath);
    }
    return {
      target,
      removed: managedPlugin || managedAgent,
      changed: managedPlugin || managedAgent,
      path: paths.pluginPath,
      pluginPath: paths.pluginPath,
      launchAgentPath: paths.launchAgentPath,
    };
  }
  const existing = await readExisting(path);
  if (existing === null) return { target, removed: false, changed: false, path };

  const settings = parseSettings(existing, path);
  const next = removeCommandHook(settings, target);
  if (next === null) return { target, removed: false, changed: false, path };
  const backupPath = await backup(path, existing);
  await writePrivateAtomic(path, `${JSON.stringify(next, null, 2)}\n`, existing, options.beforeCommit);
  return { target, removed: true, changed: true, path, backupPath };
}

export async function snapshotPermissionTarget(target, options = {}) {
  const home = options.home ?? homedir();
  const runtime = {
    home,
    nodePath: options.nodePath ?? process.execPath,
    entrypoint: options.entrypoint,
  };
  const paths = target === "opencode" ? Object.values(openCodePaths(home)).slice(0, 2) : [targetPath(target, home)];
  const files = await Promise.all(paths.map(async (path) => ({ path, contents: await readExisting(path) })));
  if (target === "opencode") {
    files[0].expectedPostInstall = openCodePlugin(runtime);
    files[1].expectedPostInstall = openCodeLaunchAgent(runtime);
  } else {
    files[0].expectedPostInstall = `${JSON.stringify(
      mergeCommandHook(parseSettings(files[0].contents, files[0].path), target, runtime),
      null,
      2,
    )}\n`;
  }
  return {
    target,
    files,
    running: target === "opencode" ? await launchctlLoaded(options, openCodePaths(home).launchAgentPath) : false,
  };
}

export async function restorePermissionSnapshot(snapshot, options = {}) {
  const conflicts = [];
  for (const file of snapshot.files) {
    const current = await readExisting(file.path);
    if (current === file.contents) continue;
    if (current !== file.expectedPostInstall) {
      conflicts.push({ path: file.path, reason: "changed-after-install" });
      continue;
    }
    if (file.contents === null) {
      if (await readExisting(file.path) !== file.expectedPostInstall) {
        conflicts.push({ path: file.path, reason: "changed-during-rollback" });
        continue;
      }
      await rm(file.path);
    } else {
      await writePrivateAtomic(file.path, file.contents, current);
    }
  }
  if (conflicts.length === 0 && snapshot.target === "opencode" && (options.platform ?? process.platform) === "darwin") {
    const paths = openCodePaths(options.home ?? homedir());
    const command = options.runCommand ?? runCommand;
    const domain = `gui/${options.uid ?? process.getuid()}`;
    if (snapshot.running) await command("launchctl", ["bootstrap", domain, paths.launchAgentPath]);
    else await command("launchctl", ["bootout", domain, paths.launchAgentPath]).catch(() => {});
  }
  if (conflicts.length > 0) {
    throw new ApiError("Permission rollback preserved concurrently changed files.", {
      code: "CONFIGURATION_CHANGED",
      details: { conflicts },
    });
  }
}

export function expandPermissionTargets(value = "all") {
  if (value === "all") return [...PERMISSION_TARGETS];
  if (!PERMISSION_TARGETS.includes(value)) {
    throw new UsageError(`Permission target must be one of: ${PERMISSION_TARGETS.join(", ")}, all`);
  }
  return [value];
}

export const permissionInternals = Object.freeze({
  adapterCommand,
  isOwnedHandler,
  openCodePlugin,
  openCodeLaunchAgent,
  openCodePaths,
  targetPath,
});
