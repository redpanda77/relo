// What Relo has installed per harness, for `relo setup --show` (and the Mac app's Agents settings): one row per
// harness with whether the harness itself is installed here, what of Relo's is in it part by part, and the depth
// derived from those parts. Read-only; the same files `relo doctor` and the machine report read.
import { ADAPTERS } from "../harness/adapters/index.mjs";
import { HARNESSES, harnessLabel } from "../harness/catalog.mjs";
import { inferLevel } from "../harness/core/install.mjs";
import { harnessPath } from "../harness/paths.mjs";
import { DEPTHS } from "../install/block.mjs";
import { findHooks } from "../install/hooks.mjs";
import { findSkillCopies } from "../install/skill.mjs";
import { harnessesOf } from "./machine-report.mjs";

const LEVELS = Object.keys(DEPTHS);
const tried = (read) => { try { return read(); } catch { return undefined; } };

/** The depth the parts add up to: the deepest of the block's own depth, "guide" for session hooks ("optimize" with the lean nudge), "track" for a skill, "notify" for an MCP entry alone. */
function levelOf({ blockLevel, hooks, lean, skill, mcp }) {
  if (blockLevel === "custom") return "custom";
  const reached = [blockLevel, hooks !== "off" && hooks !== "n/a" ? (lean ? "optimize" : "guide") : undefined,
    skill !== "none" && skill !== "n/a" ? "track" : undefined, mcp ? "notify" : undefined].filter((level) => LEVELS.includes(level));
  return reached.length === 0 ? "none" : LEVELS[Math.max(...reached.map((level) => LEVELS.indexOf(level)))];
}

/**
 * One row per harness that has anything to set up, or only the `ids` given:
 * { harness, label, installed, configured, level, modules, parts: { instructions, skill, hooks, mcp, approvals },
 *   hooks, approvals, skill, hooksAvailable }. `parts.instructions` and `parts.skill` are current|outdated|none|n/a,
 * `parts.hooks` is the hook set (presence|approvals|custom|legacy), off or n/a, `mcp` and `approvals` are booleans.
 * The flat `hooks`, `approvals` and `skill` (none|current|outdated) are the older fields the app already reads.
 */
export function harnessRows(dependencies, probe, ids) {
  const rows = harnessesOf(dependencies, probe);
  const hookFiles = tried(() => findHooks(probe).filter((file) => file.place === "global")) ?? [];
  const copies = tried(() => findSkillCopies({ ...probe, cliVersion: dependencies.version })) ?? [];
  return rows.filter((row) => !ids || ids.includes(row.id)).map((row) => {
    const harness = HARNESSES.find((candidate) => candidate.id === row.id);
    const adapter = ADAPTERS[row.id];
    const lean = hookFiles.some((file) => file.agent === row.id && /\+lean$/u.test(inferLevel(file.settings, adapter).level));
    const inherited = (harness.inherits?.skills ?? []).map((spec) => harnessPath(harness, spec, probe));
    const readSkill = row.skill !== "none" ? row.skill
      : copies.filter((copy) => inherited.includes(copy.root)).length === 0 ? "none"
        : copies.filter((copy) => inherited.includes(copy.root)).every((copy) => copy.current) ? "current" : "outdated";
    const parts = {
      instructions: !harness.instructions?.global ? "n/a" : row.instructions === "none" ? "none" : row.instructions === "stale" || row.instructions === "hidden" ? "outdated" : "current",
      skill: !harness.skills ? "n/a" : readSkill,
      hooks: adapter && harness.hooks ? row.hooks : "n/a",
      mcp: row.mcp !== "none",
      approvals: row.hooks === "approvals",
    };
    const configured = parts.instructions !== "none" && parts.instructions !== "n/a" || parts.skill !== "none" && parts.skill !== "n/a"
      || parts.hooks !== "off" && parts.hooks !== "n/a" || parts.mcp;
    return {
      harness: row.id, label: harnessLabel(row.id), installed: row.detected, configured,
      level: levelOf({ blockLevel: row.level, hooks: parts.hooks, lean, skill: parts.skill, mcp: parts.mcp }),
      modules: row.modules, parts,
      hooks: parts.hooks === "n/a" ? "off" : parts.hooks, approvals: parts.approvals, skill: readSkill, hooksAvailable: Boolean(adapter),
    };
  });
}
