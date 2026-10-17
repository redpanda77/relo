// How relo setup and relo uninstall report a plan: the JSON line for agents and scripts, and a short list a
// person can read at a terminal (what changed, what was skipped and why, what to do next).
import { harnessLabel } from "../harness/catalog.mjs";
import { EXIT } from "../shared/errors.mjs";

const KINDS = { block: "instructions", skill: "skill", hooks: "hooks", mcp: "MCP entry", credential: "harness credential", statusline: "status line", agent: "agent file", "subagent-model": "subagent model", computer: "computer name" };

const row = ({ kind, harness, file, action, level, reason }) =>
  `  ${(harness ? harnessLabel(harness) : "").padEnd(14)} ${KINDS[kind].padEnd(18)} ${[file, action && `(${action}${level ? ` ${level}` : ""})`, reason].filter(Boolean).join(" ")}`;

/**
 * `lead` ({ title, lines }) puts the setup depth first: its title ("Set up: guide (approvals off)") and one line per
 * harness, then what changed. Without it the title heads the changed list (refresh, uninstall).
 */
export function installResult(command, report, { dryRun, next, title, extra = {}, lead }) {
  const data = {
    ...(dryRun ? { dryRun: true } : {}),
    changed: report.changed, unchanged: report.unchanged, skipped: report.skipped, errors: report.errors, next,
    ...(report.credential && report.credential !== "none" ? { harnessCredential: report.credential } : {}), ...extra,
  };
  const sections = [
    [lead ? (dryRun ? "Would change" : "Changed") : dryRun ? `${title} would change` : title, report.changed],
    ["Already as it should be", report.unchanged],
    ["Skipped", report.skipped],
    ["Could not change", report.errors],
  ].filter(([, rows]) => rows.length > 0);
  const text = [
    ...(lead ? [lead.title, ...lead.lines, ""] : []),
    ...(sections.length ? sections.flatMap(([heading, rows]) => [heading, ...rows.map(row), ""]) : ["Nothing to do.", ""]),
    ...(next.length ? ["Next", ...next.map((step) => `  ${step}`)] : []),
  ].join("\n").trimEnd();
  return { exitCode: report.errors.length ? EXIT.USAGE : EXIT.OK, command, data, text };
}
