// relo setup, relo setup --refresh and relo uninstall as one plan: a list of items, one per file Relo owns a
// part of, built from the harness descriptors (harness/catalog.mjs) and applied by the editors in this folder.
// An item only ever touches Relo's own part of a file. A file Relo cannot read safely becomes an error item;
// the rest of the plan still runs. Nothing here prints: the commands render the report.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { ADAPTERS } from "../harness/adapters/index.mjs";
import { HARNESSES, detectHarness, harnessFor, harnessLabel, presentHarnesses } from "../harness/catalog.mjs";
import { ensureHarnessCredential, revokeHarnessCredential } from "../harness/core/credential.mjs";
import { inferLevel } from "../harness/core/install.mjs";
import { resolveLauncher } from "../harness/core/launch.mjs";
import { installedHarnesses, isInstalled } from "../harness/installed.mjs";
import { harnessPath, projectPath } from "../harness/paths.mjs";
import { discard } from "../outbox/index.mjs";
import { UsageError } from "../shared/errors.mjs";
import { DEPTHS, commitPlan, findBlocks, normalizeModules, planFile, projectFile, removeCompanion, shortPath, writeCompanion } from "./block.mjs";
import { commitLevel, findHooks, planLevelFile } from "./hooks.mjs";
import { AGENT_NAMES, agentItem, managedAgentFiles, ownsStatusLine, recordedExtras, statusLineItem, subagentModelItem } from "./optimize.mjs";
import { commitMcp, findMcp, planMcpFile, wantedEntry } from "./mcp.mjs";
import { findSkillCopies, installSkill, removeSkill } from "./skill.mjs";

const CHANGED = new Set(["created", "appended", "added", "updated", "installed", "removed"]);
const SUPPORTED = HARNESSES.filter((harness) => harness.instructions || harness.skills || harness.mcp).map((harness) => harness.id);

/** A file item: what it changes, run through `apply(item, dryRun)`. */
const item = (kind, harness, path, apply) => ({ kind, harness, path, apply });
const skipped = (kind, harness, reason) => ({ kind, harness, skipped: reason });

/**
 * The harnesses setup works for: the ones named with --agent, else the one running this command plus every
 * harness that is installed on this computer (harness/installed.mjs). `requireInstalled` refuses a named harness
 * that is not installed, so setup never writes into the folders of an app that is not there; uninstall and --show
 * name any harness. `all` lists every harness that has something to set up, installed or not (--show --all).
 */
export function chooseHarnesses(names, probe, { requireInstalled = false, all = false } = {}) {
  if (names.length > 0) {
    const named = names.map((name) => harnessFor(name) ?? (() => {
      throw new UsageError(`Unknown agent "${name}".`, { hint: `Supported: ${SUPPORTED.join(", ")}` });
    })());
    const missing = requireInstalled ? named.find((harness) => harness.installation && !isInstalled(harness, probe)) : undefined;
    if (missing) {
      throw new UsageError(`${missing.label} isn't installed on this ${(probe.platform ?? process.platform) === "darwin" ? "Mac" : "computer"}.`,
        { hint: "Install it first; relo setup --show --all lists every agent and whether it is installed." });
    }
    return named;
  }
  if (all) return HARNESSES.filter((harness) => harness.installation && SUPPORTED.includes(harness.id));
  const running = detectHarness(probe.env);
  return [...new Set([running, ...installedHarnesses(probe)].filter(Boolean))].filter((harness) => SUPPORTED.includes(harness.id));
}

/**
 * One setup depth as what it installs (plan 12 §4.7): the block's modules, whether the skill goes in, and the hook
 * set. The only place that maps a depth to files. Hooks need the session phase and continuity, so they start at
 * guide; `approvals` (permission prompts from the phone) is the set above presence and only at guide or optimize.
 */
export function depthPlan({ level, modules, approvals = false, extras = {} }) {
  if (!DEPTHS[level]) throw new UsageError(`Unknown level "${level}".`, { hint: `Levels: ${Object.keys(DEPTHS).join(", ")}` });
  const hooked = level === "guide" || level === "optimize";
  if (approvals && !hooked) {
    throw new UsageError(`--approvals on needs --level guide or optimize: approvals ride on the session hooks, and ${level} installs none.`);
  }
  if (level !== "optimize" && Object.values(extras).some((value) => value !== undefined)) {
    throw new UsageError(`--statusline, --agents and --subagent-model need --level optimize; ${level} installs none of them.`);
  }
  // `lean`: optimize's hook set is the guide set plus the subagent model nudge (a hook level of its own, "+lean").
  return { level, modules: modules ? normalizeModules(modules) : [...DEPTHS[level]], skill: level !== "notify", hooks: !hooked ? "off" : approvals ? "approvals" : "presence", approvals,
    lean: level === "optimize", extras };
}

function blockItem(harness, path, { remove = false, companion, modules, keepModules = false } = {}) {
  return item("block", harness, path, async (dryRun) => {
    const planned = await planFile(path, { remove, modules, keepModules });
    if (planned.plan.action === "skipped") throw new UsageError(`${planned.plan.reason}; fix the stray marker, then run setup again.`);
    if (planned.plan.action === "kept") return { action: "kept", reason: "marked <!-- relo:keep -->: edit or delete it by hand" };
    if (!dryRun) {
      await commitPlan(planned, { makeDirectory: true });
      if (companion && !remove) await writeCompanion(companion);
      if (remove) await removeCompanion(path);
    }
    return { action: planned.plan.action };
  });
}

const readText = (path) => { try { return readFileSync(path, "utf8"); } catch { return undefined; } };

function skillItem(harness, root, { remove = false } = {}, dependencies) {
  return item("skill", harness, root, async (dryRun) => {
    const args = { root, agent: harness, dryRun, home: dependencies.home, now: dependencies.now() };
    const report = remove ? await removeSkill(args) : await installSkill(args);
    return { action: report.action === "absent" ? "unchanged" : report.action, ...(report.archived ? { archived: report.archived } : {}) };
  });
}

function hooksItem(harness, path, level, dependencies) {
  return item("hooks", harness, path, async (dryRun) => {
    const planned = await planLevelFile(path, harness, level, { nodePath: dependencies.nodePath, entrypoint: dependencies.entrypoint, launcher: resolveLauncher(dependencies, readText(path)), platform: dependencies.platform });
    if (!dryRun) await commitLevel(planned);
    return { action: planned.plan.action, level };
  });
}

function mcpItem(harness, path, entry, { remove = false } = {}) {
  return item("mcp", harness, path, async (dryRun) => {
    const planned = await planMcpFile(path, harness, entry, { remove });
    if (!dryRun) await commitMcp(planned, { makeDirectory: true });
    return { action: planned.plan.action };
  });
}

/**
 * The computer's name and icon (ADR 0011): appearance the server keeps for the phone, so `relo uninstall` does not
 * undo it. `apply(dryRun)` is the owner module's send (owner/computer-identity.mjs); the plan only orders it.
 */
export const computerItem = (apply) => item("computer", undefined, undefined, apply);
export const computerSkipped = (reason) => skipped("computer", undefined, reason);

/**
 * Why a harness needs no skill of its own (OpenCode reads Claude Code's and the shared skills folders): the folder it
 * reads, when Relo's copy is there or is being installed by this plan. Undefined when it needs its own. `skillsOff`
 * variables turn the reading off.
 */
function inheritedSkill(harness, probe, plannedSkills) {
  const inherits = harness.inherits;
  if (!inherits?.skills || (inherits.skillsOff ?? []).some((name) => probe.env[name]?.trim())) return undefined;
  return inherits.skills.map((spec) => harnessPath(harness, spec, probe))
    .find((root) => plannedSkills.has(root) || existsSync(join(root, "relo-notifications", "SKILL.md")));
}

/**
 * `relo setup`: for each harness the block with the plan's modules, the skill when the depth has one, and the hook
 * set (written, or removed with the credential revoked when the depth has none); the MCP entry when asked.
 * `plan` is depthPlan's answer; `keepModules` leaves an existing block at its own depth (setup without --level).
 */
export function setupPlan({ harnesses, project, plan, mcp, keepModules = false }, dependencies) {
  const probe = { env: dependencies.env, home: dependencies.home, cwd: dependencies.cwd, platform: dependencies.platform };
  const items = [];
  const plannedSkills = new Set(harnesses.filter((harness) => harness.skills && !harness.inherits)
    .map((harness) => harnessPath(harness, harness.skills, probe)));
  const blockOptions = { modules: plan.modules, keepModules };
  // A user-level block loads in every project: a repository copy for the same harnesses would load twice.
  const userBlocks = project ? new Set(findBlocks({ ...probe, globalOnly: true }).map((found) => found.path)) : new Set();
  const covered = harnesses.filter((harness) => harness.instructions?.global);
  if (project && covered.length > 0 && covered.every((harness) => userBlocks.has(harnessPath(harness, harness.instructions.global, probe)))) {
    items.push(skipped("block", undefined, "a user-level Relo block already loads in every project: a project copy would load twice"));
  } else if (project) {
    const file = projectFile(probe);
    if (file.conflict) {
      items.push({ kind: "block", path: file.conflict[0], error: "this repository has both AGENTS.md and CLAUDE.md with their own text: make CLAUDE.md the line @AGENTS.md, or add the block to one of them by hand" });
    } else {
      items.push(blockItem(undefined, file.path, { companion: file.companion, ...blockOptions }));
    }
  }
  const roots = new Set();
  const levels = new Map();
  // User-level hooks run in every project: a repository's own copy would fire each hook twice.
  const userHooks = project ? new Set(findHooks(probe).filter((found) => found.place === "global").map((found) => found.agent)) : new Set();
  for (const harness of harnesses) {
    if (!project && harness.instructions?.global) items.push(blockItem(harness.id, harnessPath(harness, harness.instructions.global, probe), blockOptions));
    if (harness.skills && plan.skill) {
      const root = harnessPath(harness, harness.skills, probe);
      const from = inheritedSkill(harness, probe, plannedSkills);
      if (from) items.push(skipped("skill", harness.id, `reads the skill from ${shortPath(from, probe.home)}`));
      else if (!roots.has(root)) { roots.add(root); items.push(skillItem(harness.id, root, {}, dependencies)); }
    }
    if (plan.hooks !== "off") {
      const adapter = ADAPTERS[harness.id];
      const path = project ? harness.hooks?.project && projectPath(harness.hooks.project, probe) : harness.hooks && harnessPath(harness, harness.hooks.global, probe);
      // A harness that offers fewer sets gets its highest (Gemini: presence without approvals).
      // A harness that has no "+lean" set (optimize's) gets the plain one.
      const level = [plan.lean ? `${plan.hooks}+lean` : plan.hooks, plan.hooks, "presence"].find((name) => adapter?.install.levels.includes(name)) ?? "presence";
      if (!adapter) items.push(skipped("hooks", harness.id, "no hooks for this harness"));
      else if (!path) items.push(skipped("hooks", harness.id, "no personal project settings file: run it without --project for user-level hooks"));
      else if (userHooks.has(harness.id)) items.push(skipped("hooks", harness.id, "user-level hooks already run in every project"));
      else { items.push(hooksItem(harness.id, path, level, dependencies)); levels.set(harness.id, level); }
    }
    if (!project) items.push(...extrasPlan(harness, plan, keepModules, probe, dependencies));
    if (mcp) {
      const path = harness.mcp?.global && harnessPath(harness, harness.mcp.global, probe);
      if (!harness.mcp) items.push(skipped("mcp", harness.id, "no MCP config is known for this harness"));
      else if (project) items.push(skipped("mcp", harness.id, "the MCP entry is user-level and works in every project: run it without --project"));
      else if (!path) items.push(skipped("mcp", harness.id, "no MCP config file on this platform"));
      else items.push(mcpItem(harness.id, path, wantedEntry(harness.id, dependencies)));
    }
  }
  // A depth without hooks removes what an earlier one installed, exactly as the old `--hooks off` did.
  if (plan.hooks === "off") items.push(...hooksOffPlan(dependencies, { harnesses: harnesses.map((harness) => harness.id), place: project ? "project" : "global" }));
  // Hooks that send (presence) need this computer's harness credential: minted now when the server answers,
  // else by the outbox flusher on its first send.
  else if ([...levels].some(([agent, level]) => ADAPTERS[agent].install.sending.includes(level))) items.push(credentialItem(dependencies));
  return items;
}

/**
 * Optimize's asked extras for one harness (plan 12 §4.6): at optimize, each switch installs (true), removes (false) or
 * leaves as is (undefined); at a shallower depth that was chosen, whatever Relo recorded is taken out.
 */
function extrasPlan(harness, plan, keepModules, probe, dependencies) {
  const settings = harness.statusLine && harnessPath(harness, harness.statusLine, probe);
  const folder = harness.agents && harnessPath(harness, harness.agents, probe);
  const directory = dependencies.hookStateDirectory;
  const items = [];
  const { statusline, agents, subagentModel } = plan.level === "optimize" ? plan.extras
    : keepModules ? {} : { statusline: false, agents: false, subagentModel: "off" };
  const recorded = recordedExtras(directory);
  if (settings && statusline === true) items.push(statusLineItem(harness.id, settings, directory, { launch: { nodePath: dependencies.nodePath, entrypoint: dependencies.entrypoint, launcher: resolveLauncher(dependencies, readText(settings)), platform: dependencies.platform } }));
  else if (settings && statusline === false && (ownsStatusLine(settings) || recorded.statusLine)) items.push(statusLineItem(harness.id, settings, directory, { remove: true }));
  if (settings && subagentModel === "off" && recorded.subagentModel) items.push(subagentModelItem(harness.id, settings, directory, { remove: true }));
  else if (settings && typeof subagentModel === "string" && subagentModel !== "off") items.push(subagentModelItem(harness.id, settings, directory, { value: subagentModel }));
  const format = harness.agentFormat ?? "md";
  if (folder && agents === true) items.push(...AGENT_NAMES.map((name) => agentItem(harness.id, join(folder, `${name}.${format}`), name, { format })));
  else if (folder && agents === false) items.push(...managedAgentFiles(folder, format).map((file) => agentItem(harness.id, file.path, file.name, { remove: true, format })));
  return items;
}

const credentialItem = (dependencies) => item("credential", undefined, undefined, async (dryRun) => (dryRun ? { action: "pending" }
  : { action: await ensureHarnessCredential(dependencies).then(() => "ready", () => "pending") }));

/**
 * Relo's hooks out of the settings files that hold them (`harnesses` and `place` narrow which), the harness
 * credential revoked once no hooks are left anywhere, queued snapshots dropped. `always` revokes even when no
 * file held hooks (uninstall).
 */
export function hooksOffPlan(dependencies, { harnesses, place, always = false, credential = true } = {}) {
  const probe = { env: dependencies.env, home: dependencies.home, cwd: dependencies.cwd };
  const all = findHooks(probe);
  const going = all.filter((found) => (!harnesses || harnesses.includes(found.agent)) && (!place || found.place === place));
  const items = going.map((found) => hooksItem(found.agent, found.path, "off", dependencies));
  const staying = all.some((found) => !going.includes(found));
  if (!credential || staying || (going.length === 0 && !always)) return items;
  return [...items, item("credential", undefined, undefined, async (dryRun) => {
    if (dryRun) return { action: "revoke" };
    const { state } = await revokeHarnessCredential(dependencies);
    await discard({ directory: dependencies.outboxDirectory, lane: "observed" }).catch(() => {});
    return { action: state };
  })];
}

/** `relo setup --refresh`: re-render what is installed (stale blocks, older skill copies, hook entries, MCP paths); adds nothing. */
export function refreshPlan(dependencies) {
  const probe = { env: dependencies.env, home: dependencies.home, cwd: dependencies.cwd, platform: dependencies.platform };
  // No modules given: each block is re-rendered with the modules its own marker names (a bare one is track's).
  const items = findBlocks(probe).filter((found) => found.state === "found").map((found) => blockItem(undefined, found.path));
  for (const copy of findSkillCopies({ env: probe.env, home: probe.home, cliVersion: dependencies.version })) {
    if (!copy.current) items.push(skillItem(copy.agent, copy.root, {}, dependencies));
  }
  const kept = [];
  for (const found of findHooks(probe)) {
    const { level, nearest } = inferLevel(found.settings, ADAPTERS[found.agent]);
    if (ADAPTERS[found.agent].install.levels.includes(level) || nearest) { items.push(hooksItem(found.agent, found.path, nearest ?? level, dependencies)); kept.push([found.agent, nearest ?? level]); }
    else items.push(skipped("hooks", found.agent, `${shortPath(found.path, probe.home)} holds a ${level} set of Relo hooks: choose a depth with relo setup --level guide`));
  }
  // A smaller older set (reminders) is rewritten to presence, which sends: it needs the credential too.
  if (kept.some(([agent, level]) => ADAPTERS[agent].install.sending.includes(level))) items.push(credentialItem(dependencies));
  for (const found of findMcp(probe)) items.push(mcpItem(found.agent, found.path, wantedEntry(found.agent, dependencies)));
  for (const harness of HARNESSES.filter((candidate) => candidate.agents)) {
    const folder = harnessPath(harness, harness.agents, probe);
    const format = harness.agentFormat ?? "md";
    items.push(...managedAgentFiles(folder, format).map((file) => agentItem(harness.id, file.path, file.name, { format })));
  }
  return items;
}

/** `relo uninstall`: everything Relo wrote on this computer, Relo's parts only. */
export function uninstallPlan(dependencies, { harnesses } = {}) {
  const probe = { env: dependencies.env, home: dependencies.home, cwd: dependencies.cwd, platform: dependencies.platform };
  if (harnesses) return uninstallHarnessesPlan(harnesses, probe, dependencies);
  return [
    ...findBlocks(probe).map((found) => blockItem(undefined, found.path, { remove: true })),
    ...findSkillCopies({ env: probe.env, home: probe.home, cliVersion: dependencies.version })
      .map((copy) => skillItem(copy.agent, copy.root, { remove: true }, dependencies)),
    ...findMcp(probe).map((found) => mcpItem(found.agent, found.path, wantedEntry(found.agent, dependencies), { remove: true })),
    ...hooksOffPlan(dependencies, { always: true }),
    ...HARNESSES.filter((harness) => harness.statusLine || harness.agents).flatMap((harness) => extrasPlan(harness, { level: "track", extras: {} }, false, probe, dependencies)),
  ];
}

const realOrSame = (path) => { try { return realpathSync(path); } catch { return path; } };
// The pseudo-harnesses that only name a shared folder or the MCP entry: they are not agents that read anything.
const FOLDER_ONLY = new Set(["agents", "mcp"]);

/**
 * `relo uninstall --agent NAME`: only these harnesses' parts (their user-level instructions block, skill copy, MCP
 * entries, hook entries, status line and subagent files). Never the shared harness credential, project files or
 * anything of another harness. A file another present harness also reads stays, reported as skipped.
 */
function uninstallHarnessesPlan(harnesses, probe, dependencies) {
  const ids = new Set(harnesses.map((harness) => harness.id));
  const others = presentHarnesses(probe).filter((harness) => !ids.has(harness.id) && !FOLDER_ONLY.has(harness.id));
  const items = [];
  const blocks = new Map(findBlocks({ ...probe, globalOnly: true }).map((found) => [realOrSame(found.path), found]));
  const doneBlocks = new Set();
  for (const harness of harnesses) {
    if (!harness.instructions?.global) continue;
    const path = harnessPath(harness, harness.instructions.global, probe);
    const real = realOrSame(path);
    if (doneBlocks.has(real) || !blocks.has(real)) continue;
    doneBlocks.add(real);
    const sharedWith = others.filter((other) => other.instructions?.global && realOrSame(harnessPath(other, other.instructions.global, probe)) === real);
    if (sharedWith.length > 0) {
      items.push(skipped("block", harness.id, `${shortPath(blocks.get(real).path, probe.home)} is also read by ${sharedWith.map((other) => other.label ?? other.id).join(", ")}: it stays; run relo uninstall --agent for them too`));
    } else items.push(blockItem(harness.id, blocks.get(real).path, { remove: true }));
  }
  const rootsOf = (harness) => [harness.skills, ...(harness.legacySkills ? [harness.legacySkills] : [])].filter(Boolean).map((spec) => harnessPath(harness, spec, probe));
  const mine = new Map(harnesses.flatMap((harness) => rootsOf(harness).map((root) => [root, harness.id])));
  const readByOthers = (root) => others.filter((other) => rootsOf(other).includes(root)
    || (other.inherits?.skills ?? []).some((spec) => harnessPath(other, spec, probe) === root));
  for (const copy of findSkillCopies({ env: probe.env, home: probe.home, cliVersion: dependencies.version })) {
    const owner = mine.get(copy.root);
    if (!owner) continue;
    const sharedWith = readByOthers(copy.root);
    if (sharedWith.length > 0) {
      items.push(skipped("skill", owner, `${shortPath(copy.root, probe.home)} is also read by ${sharedWith.map((other) => other.label ?? other.id).join(", ")}: the skill stays; run relo uninstall --agent for them too`));
    } else items.push(skillItem(owner, copy.root, { remove: true }, dependencies));
  }
  items.push(
    ...findMcp(probe).filter((found) => ids.has(found.agent)).map((found) => mcpItem(found.agent, found.path, wantedEntry(found.agent, dependencies), { remove: true })),
    ...hooksOffPlan(dependencies, { harnesses: [...ids], credential: false }),
    ...harnesses.filter((harness) => harness.statusLine || harness.agents).flatMap((harness) => extrasPlan(harness, { level: "track", extras: {} }, false, probe, dependencies)),
  );
  return items;
}

/**
 * Runs a plan (nothing is written on a dry run) and sorts what happened:
 * { changed, unchanged, skipped, errors, credential? }, each row { kind, harness?, file?, action?, reason? }.
 */
export async function applyPlan(items, { dryRun, home }) {
  // The harness credential is not a file: its state (ready, pending, revoked, none) is reported on its own.
  const report = { changed: [], unchanged: [], skipped: [], errors: [], credential: undefined };
  for (const entry of items) {
    const base = { kind: entry.kind, ...(entry.harness ? { harness: entry.harness } : {}), ...(entry.path ? { file: shortPath(entry.path, home) } : {}) };
    if (entry.skipped) { report.skipped.push({ ...base, reason: entry.skipped }); continue; }
    if (entry.error) { report.errors.push({ ...base, reason: entry.error }); continue; }
    try {
      const outcome = await entry.apply(dryRun);
      if (entry.kind === "credential") { report.credential = outcome.action; continue; }
      // A block the owner froze (relo:keep) is a deliberate skip, not "already as it should be".
      if (outcome.action === "kept") report.skipped.push({ ...base, reason: outcome.reason });
      else (CHANGED.has(outcome.action) ? report.changed : report.unchanged).push({ ...base, ...outcome });
    } catch (error) {
      report.errors.push({ ...base, reason: error.message });
    }
  }
  return report;
}

/** "Claude Code, Codex": the harnesses a report changed, by name, for its next step. */
export const changedHarnesses = (report) => [...new Set(report.changed.map((row) => row.harness).filter(Boolean))].map(harnessLabel);
