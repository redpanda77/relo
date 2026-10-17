// `relo setup`: the owner's one command to tell this computer's agents about Relo, at the depth the owner picks
// (plan 12 §4.7): notify (questions only), track (live cards and plans), guide (+ continuity and session hooks),
// optimize (+ lean context and subagents). For each harness here (or the ones named with --agent) it writes the
// block with that depth's modules into the harness's own instructions file, installs the skill and sets the hooks;
// with --project the block goes in this repository instead. The depth is not stored: it is what is installed, so
// running setup again without --level keeps it. --refresh brings what is installed up to this CLI (relo update runs
// it); --show reads what is installed and writes nothing; relo uninstall takes it all out.
import { ADAPTERS } from "../harness/adapters/index.mjs";
import { HARNESSES, harnessLabel } from "../harness/catalog.mjs";
import { harnessPath } from "../harness/paths.mjs";
import { inferLevel } from "../harness/core/install.mjs";
import { DEPTHS, depthReached, findBlocks, renderBlockText } from "../install/block.mjs";
import { findHooks } from "../install/hooks.mjs";
import { checkSubagentModel, managedAgentFiles, ownsStatusLine, recordedExtras } from "../install/optimize.mjs";
import { applyPlan, changedHarnesses, chooseHarnesses, depthPlan, refreshPlan, setupPlan } from "../install/plan.mjs";
import { EXIT, UsageError } from "../shared/errors.mjs";
import { atTerminal, computerIdentityItem } from "./computer-identity.mjs";
import { installResult } from "./install-report.mjs";
import { harnessesOf } from "./machine-report.mjs";

const USAGE = "relo setup [--level notify|track|guide|optimize] [--approvals on|off] [--statusline on|off] [--agents on|off] [--subagent-model MODEL|off] [--modules a,b] [--project] [--agent NAME]... [--mcp] [--computer NAME] [--icon ICON] [--show] [--dry-run] | relo setup --refresh [--dry-run]";
const LEVELS = Object.keys(DEPTHS);
const hooked = (level) => level === "guide" || level === "optimize";

// The question a person at the terminal is asked once per run. `(current)` marks the installed depth.
const CHOICES = [
  ["notify", "  1  notify     Questions and notifications only. No cards."],
  ["track", "  2  track      Live cards with plans on your phone."],
  ["guide", "  3  guide      Track, plus continuity across requests, compaction and /clear,\n                and which sessions are working (hooks)."],
  ["optimize", "  4  optimize   Guide, plus lean context and right-sized subagents."],
];

function depthQuestion(current) {
  const fallback = LEVELS.indexOf(current ?? "track") + 1;
  const lines = CHOICES.map(([level, text]) => {
    if (level !== current) return text;
    const [first, ...rest] = text.split("\n");
    return [`${first} (current)`, ...rest].join("\n");
  });
  return { fallback, text: ["How deep should Relo plug into your agents?", ...lines, `Choose 1-${LEVELS.length} [${fallback}]: `].join("\n") };
}

/** The depth a person picks (1-4 or its name) and whether permission prompts come to the phone; empty answers keep the defaults. */
async function askDepth(installed, dependencies) {
  const { text, fallback } = depthQuestion(installed.level);
  let level;
  for (let attempt = 0; attempt < 3 && !level; attempt += 1) {
    const answer = String(await dependencies.ask(text, String(fallback)) ?? "").trim().toLowerCase() || String(fallback);
    level = LEVELS[Number(answer) - 1] ?? LEVELS.find((name) => name === answer);
  }
  level ??= LEVELS[fallback - 1];
  if (!hooked(level)) return { level };
  const yes = installed.approvals;
  const answer = String(await dependencies.ask(`Answer permission prompts from your phone too? [${yes ? "Y/n" : "y/N"}] `, yes ? "y" : "n") ?? "").trim().toLowerCase();
  return { level, approvals: /^y/u.test(answer) ? true : /^n/u.test(answer) ? false : yes };
}

/** At a terminal with no --agent and more than one agent found: which of them to set up (Enter: all of them). */
async function askHarnesses(harnesses, dependencies) {
  if (harnesses.length < 2) return harnesses;
  const text = ["Relo found these agents on this computer:", ...harnesses.map((harness, index) => `  ${index + 1}  ${harness.label}`),
    "Set up which? Enter for all, or numbers like 1,3 [all]: "].join("\n");
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const answer = String(await dependencies.ask(text, "all") ?? "").trim().toLowerCase();
    if (!answer || answer === "all") return harnesses;
    const picks = answer.split(/[\s,]+/u).filter(Boolean).map(Number);
    if (picks.length && picks.every((pick) => Number.isInteger(pick) && pick >= 1 && pick <= harnesses.length)) {
      return [...new Set(picks)].map((pick) => harnesses[pick - 1]);
    }
  }
  return harnesses;
}

/**
 * What this computer has now, read from the files (nothing is stored): the deepest depth any global block's marker
 * names, at least guide while session hooks are installed, and whether the installed hook set answers permission prompts.
 */
export function installedDepth(dependencies) {
  const probe = { env: dependencies.env, home: dependencies.home, cwd: dependencies.cwd, platform: dependencies.platform };
  const reached = findBlocks({ ...probe, globalOnly: true }).map((found) => depthReached(found.modules)).filter(Boolean);
  const sets = findHooks(probe).filter((found) => found.place === "global").map((found) => inferLevel(found.settings, ADAPTERS[found.agent]));
  const deepest = LEVELS[Math.max(-1, ...reached.map((level) => LEVELS.indexOf(level)), sets.length ? LEVELS.indexOf("guide") : -1)];
  return { level: deepest, approvals: sets.some((set) => /^approvals/u.test(set.level) || /^approvals/u.test(set.nearest ?? "")) };
}

const modulesFlag = (options) => (options.modules === undefined ? undefined
  : String(options.modules).split(",").map((name) => name.trim()).filter(Boolean));

/** One line per harness: the block's modules, the skill, the hook set, or why one is missing. */
function harnessLine(harness, plan, modules, report) {
  const rows = report.changed.concat(report.unchanged);
  const extras = [];
  if (plan.level === "optimize" && harness.statusLine) {
    if (plan.extras.statusline === true) extras.push("status line");
    if (plan.extras.statusline === false) extras.push("no status line");
    if (typeof plan.extras.subagentModel === "string" && plan.extras.subagentModel !== "off") extras.push(`subagents default to ${plan.extras.subagentModel}`);
  }
  if (plan.level === "optimize" && plan.extras.agents !== undefined) {
    const names = rows.filter((row) => row.kind === "agent" && row.harness === harness.id).map((row) => String(row.file).split("/").pop().replace(/\.(md|toml)$/u, ""));
    const kept = report.skipped.filter((row) => row.kind === "agent" && row.harness === harness.id);
    if (plan.extras.agents === false) extras.push("no agents");
    else if (!harness.agents) { if (kept.length) extras.push("no agents for this harness"); }
    else if (names.length || kept.length) extras.push(`agents: ${names.join(", ") || "none"}${kept.length ? " (kept yours)" : ""}`);
  }
  const skipped = (kind) => report.skipped.find((row) => row.kind === kind && row.harness === harness.id);
  const block = skipped("block");
  const hooks = report.changed.concat(report.unchanged).find((row) => row.kind === "hooks" && row.harness === harness.id);
  const parts = [
    block ? block.reason : `instructions: ${modules.join(" ")}`,
    plan.skill ? (skipped("skill")?.reason ?? "skill") : "no skill",
    plan.hooks === "off" ? "no hooks" : skipped("hooks")?.reason ?? (hooks ? `hooks: ${hooks.level.replace("+lean", " + subagent nudge")}` : `hooks: ${plan.hooks}`),
    ...extras,
  ];
  return `  ${harnessLabel(harness.id).padEnd(14)} ${parts.join(" · ")}`;
}

const depthTitle = (plan, custom) => `${plan.level}${custom ? " with chosen modules" : ""}${hooked(plan.level) ? ` (approvals ${plan.approvals ? "on" : "off"})` : ""}`;

const onOff = (name, value) => {
  if (value === undefined) return undefined;
  if (value !== "on" && value !== "off") throw new UsageError(`--${name} takes on or off.`);
  return value === "on";
};

/** Optimize's asked extras from the flags: statusline/agents true|false, subagentModel a model or "off"; undefined leaves it as is. */
function extrasFromFlags(options) {
  const model = options["subagent-model"];
  return { statusline: onOff("statusline", options.statusline), agents: onOff("agents", options.agents),
    subagentModel: model === undefined ? undefined : String(model).trim() === "off" ? "off" : checkSubagentModel(model) };
}

/** Choosing optimize: each extra left unsaid is asked of a person (Enter: yes), and is on for an agent or a script. */
async function settleExtras(extras, { terminal, dependencies }) {
  const settled = { ...extras };
  const questions = [["statusline", "Wrap Claude Code's status line to read context use and cost? Yours keeps printing. [Y/n] "],
    ["agents", "Install the relo-explore and relo-worker subagents (small and mid model)? [Y/n] "]];
  for (const [key, text] of questions) {
    if (settled[key] !== undefined) continue;
    const answer = terminal ? String(await dependencies.ask(text, "y") ?? "").trim().toLowerCase() : "y";
    settled[key] = !/^n/u.test(answer);
  }
  return settled;
}

/** What optimize's extras are on this computer right now (read only), for --show. */
function installedExtras(dependencies) {
  const probe = { env: dependencies.env, home: dependencies.home, cwd: dependencies.cwd, platform: dependencies.platform };
  const harness = HARNESSES.find((candidate) => candidate.statusLine);
  const settings = harness && harnessPath(harness, harness.statusLine, probe);
  const folder = harness?.agents && harnessPath(harness, harness.agents, probe);
  return { statusline: Boolean(settings && ownsStatusLine(settings)), agents: folder ? managedAgentFiles(folder).map((file) => file.name) : [],
    subagentModel: recordedExtras(dependencies.hookStateDirectory).subagentModel };
}

/** `--show`: what is installed per harness, or with --level what that depth would install; the block text; nothing written. */
function showResult({ harnesses, plan, wanted, custom, dependencies }) {
  const probe = { env: dependencies.env, home: dependencies.home, cwd: dependencies.cwd, platform: dependencies.platform };
  const ids = harnesses.map((harness) => harness.id);
  const rows = harnessesOf(dependencies, probe).filter((row) => ids.includes(row.id)).map((row) => ({
    harness: row.id, level: row.level, modules: row.modules, hooks: row.hooks, approvals: row.hooks === "approvals", skill: row.skill,
    hooksAvailable: Boolean(ADAPTERS[row.id]),
  }));
  const installed = installedExtras(dependencies);
  const wouldExtras = plan.level === "optimize" ? plan.extras : {};
  const extrasText = wanted
    ? (plan.level === "optimize" ? [`  Optimize extras: status line ${wouldExtras.statusline === false ? "off" : wouldExtras.statusline ? "on" : "as installed"}, agents ${wouldExtras.agents === false ? "off" : wouldExtras.agents ? "on" : "as installed"}${wouldExtras.subagentModel ? `, subagent model ${wouldExtras.subagentModel}` : ""}`] : [])
    : (rows.some((row) => row.level === "optimize") || installed.statusline || installed.agents.length
      ? [`  Optimize extras: status line ${installed.statusline ? "on" : "off"}, agents ${installed.agents.length ? installed.agents.join(" ") : "none"}${installed.subagentModel ? ", subagent model set by Relo" : ""}`] : []);
  const text = [
    wanted ? `Would install: ${depthTitle(plan, custom)}` : "Installed",
    ...rows.map((row) => {
      const shown = wanted ? { modules: plan.modules, skill: plan.skill ? "skill" : "no skill", hooks: ADAPTERS[row.harness] ? plan.hooks : "no hooks for this harness" }
        : { modules: row.modules, skill: row.skill === "none" ? "no skill" : `skill ${row.skill}`, hooks: row.hooksAvailable ? row.hooks : "no hooks for this harness" };
      const depth = wanted ? "" : `${row.level} `;
      return `  ${harnessLabel(row.harness).padEnd(14)} ${depth}${shown.modules.length ? `[${shown.modules.join(" ")}]` : "no block"} · ${shown.skill} · ${shown.hooks === "off" || !shown.hooks ? "no hooks installed" : shown.hooks.startsWith("no hooks") ? shown.hooks : `hooks: ${shown.hooks}`}`;
    }),
    ...extrasText,
    "",
    `Block (${wanted ? depthTitle(plan, custom) : "the modules in use"})`,
    renderBlockText(plan.modules),
  ].join("\n");
  return {
    exitCode: EXIT.OK, command: "setup",
    data: { show: true, harnesses: rows, ...(wanted ? { would: { level: plan.level, modules: plan.modules, skill: plan.skill, hooks: plan.hooks, approvals: plan.approvals, ...(plan.level === "optimize" ? { extras: plan.extras } : {}) } } : {}),
      ...(installed.statusline || installed.agents.length || installed.subagentModel ? { extras: installed } : {}), block: renderBlockText(plan.modules) },
    text,
  };
}

export async function runSetupCommand({ options, action, rest, dependencies }) {
  const dryRun = Boolean(options["dry-run"]);
  const { env, home, cwd } = dependencies;
  if (rest.length > 0 || action !== undefined) throw new UsageError(`Usage: ${USAGE}`);
  const names = [options.agent ?? []].flat();
  if (options.refresh) {
    if (options.level || options.approvals || options.statusline || options.agents || options["subagent-model"] !== undefined || options.modules !== undefined || options.show || options.mcp || options.project || names.length || options.computer !== undefined || options.icon) {
      throw new UsageError("--refresh re-renders what is installed; it takes no other flags but --dry-run.");
    }
    const report = await applyPlan(refreshPlan(dependencies), { dryRun, home });
    return finish({ report, dryRun, dependencies, title: "Refreshed" });
  }
  if (options.show && (options.mcp || options.computer !== undefined || options.icon)) throw new UsageError("--show only reads: it takes --level, --approvals, --statusline, --agents, --subagent-model, --modules, --agent and --project.");
  const found = chooseHarnesses(names, { env, home, cwd, platform: dependencies.platform });
  if (found.length === 0) {
    throw new UsageError("No agent harness was found on this computer.", { hint: "Name it: relo setup --agent claude-code (or codex, gemini, opencode, cursor, copilot, amp)" });
  }
  // A person at the terminal who named no --agent picks among the agents found here (Enter keeps them all).
  const harnesses = !names.length && !options.show && !dryRun && atTerminal({ options, dependencies }) ? await askHarnesses(found, dependencies) : found;
  const installed = installedDepth(dependencies);
  // A person at the terminal who gave no --level is asked once; --show, --json and --dry-run never prompt.
  const asked = !options.level && !options.show && !dryRun && atTerminal({ options, dependencies }) ? await askDepth(installed, dependencies) : {};
  const chosen = options.level ?? asked.level;
  const level = chosen ?? installed.level ?? "track";
  const approvalsFlag = options.approvals === undefined ? asked.approvals : options.approvals === "on";
  const approvals = approvalsFlag ?? (hooked(level) && installed.approvals);
  const modules = modulesFlag(options);
  // Optimize's extras: the flags; choosing optimize settles the rest (asked of a person, on for an agent or a script).
  let extras = extrasFromFlags(options);
  if (chosen === "optimize") extras = await settleExtras(extras, { terminal: !options.show && !dryRun && atTerminal({ options, dependencies }), dependencies });
  const plan = depthPlan({ level, modules, approvals, extras });
  // Without a chosen depth an existing block keeps its own modules: setup never rewrites a file to another depth.
  const keepModules = !chosen && !modules;
  if (options.show) return showResult({ harnesses, plan, wanted: Boolean(chosen || modules), custom: Boolean(modules), dependencies });
  if (!options.show && options.project && (extras.statusline !== undefined || extras.agents !== undefined || extras.subagentModel !== undefined)) {
    throw new UsageError("--statusline, --agents and --subagent-model are user-level: run it without --project.");
  }
  const items = setupPlan({ harnesses, project: Boolean(options.project), plan, mcp: Boolean(options.mcp), keepModules }, dependencies);
  // The name and icon last, so a question at the terminal comes after the plan is known to be valid.
  const identity = await computerIdentityItem({ options, dependencies, dryRun });
  if (identity) items.push(identity);
  const report = await applyPlan(items, { dryRun, home });
  const before = keepModules ? harnessesOf(dependencies, { env, home, cwd, platform: dependencies.platform }) : [];
  const lead = {
    title: `Set up: ${depthTitle(plan, Boolean(modules))}`,
    lines: [...harnesses.map((harness) => {
      const own = before.find((row) => row.id === harness.id)?.modules;
      return harnessLine(harness, plan, own?.length ? own : plan.modules, report);
    })],
  };
  const extra = {
    depth: { level: plan.level, modules: plan.modules, skill: plan.skill, hooks: plan.hooks, approvals: plan.approvals,
      ...(plan.level === "optimize" ? { extras: plan.extras } : {}) },
    ...(dryRun && report.changed.some((row) => row.kind === "block") ? { block: renderBlockText(plan.modules) } : {}),
  };
  return finish({ report, dryRun, dependencies, title: "Set up", lead, extra });
}

async function finish({ report, dryRun, dependencies, title, lead, extra }) {
  if (!dryRun) await dependencies.sendMachineReport?.();
  const restart = changedHarnesses(report);
  const next = [
    ...(dryRun && report.changed.length ? ["Run it again without --dry-run to write these."] : []),
    ...(!dryRun && restart.length ? [`Restart ${restart.join(", ")} so ${restart.length > 1 ? "they read" : "it reads"} the changes.`] : []),
    "relo doctor",
  ];
  return installResult("setup", report, { dryRun, next, title, extra, lead });
}
