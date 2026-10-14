import { realpathSync, statSync } from "node:fs";
import { ADAPTERS, DEFAULT_ADAPTER } from "../harness/adapters/index.mjs";
import { ensureHarnessCredential } from "../harness/core/credential.mjs";
import { UsageError } from "../errors.mjs";
import { GLOBAL_AGENT_NAMES, expandPath, findBlocks, globalFile, commitPlan, planFile, projectFile, shortPath } from "../setup.mjs";
import { commitLevel, findHooks, hookAgent, planLevelFile } from "../hooks-settings.mjs";
import { turnHooksOff } from "./hooks.mjs";
import { MCP_AGENT_NAMES, commitMcp, findMcp, mcpAgent, mcpPath, planMcpFile, wantedEntry } from "../mcp-config.mjs";
import { inspectSkill, skillAdvice } from "../skill.mjs";
import { assertAllowedOptions, assertNoExtra, result } from "../support.mjs";

const USAGE = "Usage: relo setup --mcp --agent NAME (--global | --project) [--move] [--dry-run] | relo setup --mcp --remove | relo setup (--project | --global --agent NAME | --file PATH) [--move] [--dry-run] | relo setup --remove | relo setup (--project | --global --agent NAME) --hooks <reminders|presence> [--move] [--dry-run] | relo setup --hooks off";
const CHOICES = `relo setup --project (this repo) | relo setup --global --agent <${GLOBAL_AGENT_NAMES.join("|")}> | relo setup --file PATH`;

function chooseTarget(options, { env, home, cwd }) {
  const files = Array.isArray(options.file) ? options.file : [];
  const modes = [options.project ? "--project" : undefined, options.global ? "--global" : undefined, files.length > 0 ? "--file" : undefined].filter(Boolean);
  if (options.agent !== undefined && !options.global) {
    throw new UsageError("--agent goes with --global.", { hint: `relo setup --global --agent ${options.agent}` });
  }
  if (modes.length === 0) {
    throw new UsageError("Nothing was written: pick the one file Relo's block goes in.", { hint: CHOICES });
  }
  if (modes.length > 1 || files.length > 1) {
    throw new UsageError("Pick exactly one of --project, --global --agent NAME, or --file PATH (the block lives in one file).", { hint: CHOICES });
  }
  if (options.project) {
    const project = projectFile({ cwd });
    if (project.conflict) {
      throw new UsageError("This repository has both AGENTS.md and CLAUDE.md.", { hint: `Pick one: relo setup --file ${project.conflict[0]}  (or ${project.conflict[1]})` });
    }
    return { path: project.path, kind: "project" };
  }
  if (options.global) {
    if (options.agent === undefined) {
      throw new UsageError("--global needs the harness whose file to use.", { hint: `relo setup --global --agent <${GLOBAL_AGENT_NAMES.join("|")}>, or relo setup --file PATH for another harness` });
    }
    const found = globalFile(options.agent, { env, home });
    if (!found) {
      throw new UsageError(`Unknown agent "${options.agent}": no global instructions file is known for it.`, {
        hint: `Supported: ${GLOBAL_AGENT_NAMES.join(", ")}. For another harness: relo setup --file PATH`,
      });
    }
    return { path: found.path, kind: "global" };
  }
  return { path: expandPath(files[0], home, cwd), kind: "file" };
}

const skillFields = (dependencies) => {
  const skill = inspectSkill({ env: dependencies.env, home: dependencies.home, cliVersion: dependencies.version });
  const { hint } = skillAdvice({ env: dependencies.env, home: dependencies.home, cliVersion: dependencies.version });
  return { skill, ...(hint === undefined ? {} : { hint }) };
};

/** `relo setup`: write (or remove) the marked Relo block in exactly one instruction file the owner chose. */
export async function runSetupCommand(command) {
  const { options, group, action, rest, dependencies } = command;
  if (group !== "setup") return undefined;
  if (options.hooks) return setupHookLevel(command);
  assertNoExtra([action, ...rest].filter((word) => word !== undefined), 0, USAGE);
  assertAllowedOptions(options, ["global", "project", "file", "agent", "dry-run", "remove", "move", "hooks", "mcp"]);
  const { home, cwd, env } = dependencies;
  const dryRun = Boolean(options["dry-run"]);
  const probe = { env, home, cwd };
  if (options.mcp && options.hooks) throw new UsageError("--mcp and --hooks are separate: run setup once for each.");
  if (options.mcp) return setupMcp(options, { ...probe, platform: dependencies.platform }, dryRun, dependencies);

  if (options.remove) {
    if (options.move) throw new UsageError("--remove and --move cannot be combined.");
    const extra = (Array.isArray(options.file) ? options.file : []).map((file) => expandPath(file, home, cwd));
    const plans = [];
    for (const { path } of findBlocks({ ...probe, extra })) plans.push(await planFile(path, { remove: true }));
    const removable = plans.filter(({ plan }) => plan.action === "removed");
    if (!dryRun) for (const item of removable) await commitPlan(item);
    const kept = plans.filter(({ plan }) => plan.action === "kept");
    if (removable.length === 0) {
      return result("setup", { action: kept.length > 0 ? "kept" : "unchanged", ...(kept[0] ? { file: shortPath(kept[0].path, home) } : {}), ...(dryRun ? { dryRun: true } : {}) },
        { message: kept.length > 0 ? "The block is marked <!-- relo:keep -->; delete it by hand." : "No Relo block found." });
    }
    return result("setup", {
      file: shortPath(removable[0].path, home), action: "removed",
      ...(removable.length > 1 ? { files: removable.map(({ path }) => shortPath(path, home)) } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    });
  }

  const target = chooseTarget(options, probe);
  const targetShown = shortPath(target.path, home);
  const existing = findBlocks({ ...probe, extra: [target.path] });
  const others = existing.filter(({ path }) => path !== target.path && realPathKey(path) !== realPathKey(target.path));
  if (others.length > 0 && !options.move) {
    const shown = shortPath(others[0].path, home);
    throw new UsageError(`Relo is already set up in ${shown}.`, {
      hint: `Keep it, or move it: relo setup ${moveFlags(options)} --move`,
    });
  }
  const targetFolder = target.path.slice(0, Math.max(target.path.lastIndexOf("/"), target.path.lastIndexOf("\\")));
  if (target.kind !== "global" && targetFolder && !(await folderExists(targetFolder))) {
    throw new UsageError(`${shortPath(targetFolder, home)} does not exist.`, { hint: "Create the folder first, or pick another file." });
  }
  const removals = [];
  for (const { path } of others) {
    const planned = await planFile(path, { remove: true });
    if (planned.plan.action === "kept") {
      throw new UsageError(`The block in ${shortPath(path, home)} is marked <!-- relo:keep -->, so it will not be moved.`, { hint: "Delete it by hand, then run setup again." });
    }
    removals.push(planned);
  }
  const written = await planFile(target.path, { remove: false });
  if (written.plan.action === "skipped") {
    throw new UsageError(`${targetShown}: ${written.plan.reason}.`, { hint: "Fix or delete the stray marker, then run setup again." });
  }
  if (!dryRun) {
    await commitPlan(written, { makeDirectory: target.kind === "global" });
    for (const item of removals) await commitPlan(item);
  }
  const moved = removals.length > 0;
  return result("setup", {
    file: targetShown,
    action: moved ? "moved" : written.plan.action,
    ...(moved ? { from: shortPath(others[0].path, home) } : {}),
    ...skillFields(dependencies),
    ...(dryRun ? { dryRun: true } : {}),
  });
}

function realPathKey(path) { try { return realpathSync(path); } catch { return path; } }
async function folderExists(path) { try { return statSync(path).isDirectory(); } catch { return false; } }

function moveFlags(options) {
  if (options.project) return "--project";
  if (options.global) return `--global --agent ${options.agent}`;
  return `--file ${(options.file ?? [])[0]}`;
}

const shownPath = (path, home) => shortPath(path, home);
const ALL_HOOK_LEVELS = [...new Set(Object.values(ADAPTERS).flatMap((adapter) => adapter.install.levels))];

/** `relo setup --hooks <off|reminders|presence>` (slice 3 §3.1): the level is required; bare --hooks is refused. */
async function setupHookLevel({ options, action, rest, dependencies }) {
  assertNoExtra(rest.filter((word) => word !== undefined), 0, USAGE);
  if (options.mcp) throw new UsageError("--mcp and --hooks are separate: run setup once for each.");
  assertAllowedOptions(options, ["global", "project", "agent", "dry-run", "move", "hooks", "yes", "file", "remove"]);
  if (Array.isArray(options.file) && options.file.length > 0) throw new UsageError("--hooks goes in a harness's settings.json: use --project or --global --agent NAME, not --file.");
  if (options.remove) throw new UsageError("--hooks --remove is gone: use relo setup --hooks off (or relo hooks off).");
  const level = action;
  if (!ALL_HOOK_LEVELS.includes(level)) {
    throw new UsageError(level === undefined ? "--hooks needs a level: off, reminders or presence." : `Unknown hook level "${level}".`, {
      hint: "relo setup --project --hooks reminders (recommended for Claude Code) | --hooks presence (reminders plus session presence) | --hooks off",
    });
  }
  const { home, cwd, env } = dependencies;
  const probe = { env, home, cwd };
  const dryRun = Boolean(options["dry-run"]);
  if (level === "off") return setupHooksOff(options, probe, dryRun, dependencies);
  const agent = options.project && options.agent === undefined ? DEFAULT_ADAPTER : hookAgent(options.agent ?? DEFAULT_ADAPTER);
  const adapter = ADAPTERS[agent];
  if (!adapter.install.levels.includes(level)) {
    const offered = adapter.install.levels.filter((name) => name !== "off").map((name) => `--hooks ${name}`).join(", ");
    throw new UsageError(`${agent} offers only ${offered} or --hooks off.`);
  }
  if (options.project && options.global) throw new UsageError("Pick exactly one of --project or --global --agent NAME (the hooks live in one file).");
  if (!options.project && !options.global) {
    throw new UsageError("Nothing was written: pick the one settings file Relo's hooks go in.", {
      hint: `relo setup --project --hooks ${level} | relo setup --global --agent ${agent} --hooks ${level}`,
    });
  }
  const path = adapter.install[options.project ? "project" : "global"](probe);
  const others = findHooks(probe).filter((found) => found.agent === agent && found.path !== path);
  if (others.length > 0 && !options.move) {
    throw new UsageError(`Relo hooks are already set up in ${shownPath(others[0].path, home)}.`, {
      hint: `Keep them, or move them: relo setup ${options.project ? "--project" : `--global --agent ${agent}`} --hooks ${level} --move`,
    });
  }
  const written = await planLevelFile(path, agent, level);
  const removals = [];
  for (const other of others) removals.push(await planLevelFile(other.path, agent, "off"));
  let harnessCredential;
  if (!dryRun) {
    await commitLevel(written);
    for (const item of removals) await commitLevel(item);
    // Hooks that send need this computer's harness credential. Minted now when the server is reachable;
    // otherwise the outbox flusher mints it on its first send.
    if (adapter.install.sending.includes(level)) {
      harnessCredential = await ensureHarnessCredential(dependencies).then(() => "ready", () => "pending");
    }
  }
  const moved = removals.some((item) => item.plan.action === "removed");
  return result("setup", {
    file: shownPath(path, home), level, action: moved ? "moved" : written.plan.action, hooks: written.plan.changes.after,
    ...(moved ? { from: shownPath(others[0].path, home) } : {}), ...(harnessCredential ? { harnessCredential } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  });
}

/** `relo setup --hooks off`: Relo's hooks out of every settings file, and the harness credential revoked. */
async function setupHooksOff(options, probe, dryRun, dependencies) {
  if (options.move) throw new UsageError("--hooks off and --move cannot be combined.");
  const { removable, credential } = await turnHooksOff(probe, dependencies, { dryRun });
  const revoked = credential && credential !== "none" ? { harnessCredential: credential } : {};
  if (removable.length === 0) {
    return result("setup", { action: "unchanged", hooks: [], ...revoked, ...(dryRun ? { dryRun: true } : {}) }, { message: "No Relo hooks found." });
  }
  return result("setup", {
    file: shownPath(removable[0].path, probe.home), action: "removed", hooks: removable[0].plan.changes.before,
    ...(removable.length > 1 ? { files: removable.map(({ path }) => shownPath(path, probe.home)) } : {}),
    ...revoked, ...(dryRun ? { dryRun: true } : {}),
  });
}

/** `relo setup --mcp`: Relo's MCP server entry in exactly one harness config file (see mcp-config.mjs). */
async function setupMcp(options, probe, dryRun, dependencies) {
  const { home } = probe;
  if (Array.isArray(options.file) && options.file.length > 0) throw new UsageError("--mcp goes in a harness's MCP config: use --agent NAME with --global or --project, not --file.");
  const entryProbe = { nodePath: dependencies.nodePath, entrypoint: dependencies.entrypoint };
  if (options.remove) {
    if (options.move) throw new UsageError("--remove and --move cannot be combined.");
    const agent = options.agent === undefined ? undefined : mcpAgent(options.agent);
    const plans = [];
    for (const found of findMcp(probe)) {
      if (agent === undefined || found.agent === agent) plans.push(await planMcpFile(found.path, found.agent, wantedEntry(found.agent, entryProbe), { remove: true }));
    }
    const removable = plans.filter(({ plan }) => plan.action === "removed");
    if (!dryRun) for (const item of removable) await commitMcp(item);
    if (removable.length === 0) return result("setup", { action: "unchanged", mcp: [], ...(dryRun ? { dryRun: true } : {}) }, { message: "No Relo MCP entry found." });
    return result("setup", {
      file: shownPath(removable[0].path, home), action: "removed", mcp: removable.map(({ agent }) => agent),
      ...(removable.length > 1 ? { files: removable.map(({ path }) => shownPath(path, home)) } : {}),
      ...(dryRun ? { dryRun: true } : {}),
    });
  }
  if (options.project && options.global) throw new UsageError("Pick exactly one of --project or --global (the entry lives in one file).");
  const agent = mcpAgent(options.agent);
  const { path } = mcpPath(agent, options.project ? "project" : options.global ? "global" : undefined, probe);
  const others = findMcp(probe).filter((found) => found.agent === agent && found.path !== path);
  if (others.length > 0 && !options.move) {
    throw new UsageError(`Relo's MCP entry is already set up in ${shownPath(others[0].path, home)}.`, {
      hint: `Keep it, or move it: relo setup --mcp --agent ${agent} ${options.project ? "--project" : "--global"} --move`,
    });
  }
  const entry = wantedEntry(agent, entryProbe);
  const removals = [];
  for (const other of others) removals.push(await planMcpFile(other.path, agent, entry, { remove: true }));
  const written = await planMcpFile(path, agent, entry, {});
  if (!dryRun) {
    await commitMcp(written, { makeDirectory: true });
    for (const item of removals) await commitMcp(item);
  }
  const moved = removals.some(({ plan }) => plan.action === "removed");
  return result("setup", {
    file: shownPath(path, home), action: moved ? "moved" : written.plan.action, mcp: [agent],
    ...(moved ? { from: shownPath(others[0].path, home) } : {}),
    ...(dryRun ? { dryRun: true } : {}),
  });
}
