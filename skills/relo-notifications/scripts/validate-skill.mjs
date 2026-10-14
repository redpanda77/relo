#!/usr/bin/env node
// Structural checks for the Relo skill bundle: frontmatter, size, reachable references, and the
// guidance an agent must always see. Behavioural checks live in tests/skill.test.mjs.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const REQUIRED_REFERENCES = ["cards.md", "cli.md", "security.md", "services.md", "troubleshooting.md", "install.md"];
const MAX_SKILL_LINES = 100;
// Guidance that must stay in SKILL.md itself, not only in a reference.
const REQUIRED_GUIDANCE = [
  ["the work is the default tool", /\*\*The work\*\*/u],
  ["notifications are not for questions or progress", /Never a question, never\s+progress/u],
  ["one open work per session", /One open work per session/u],
  ["the goal is yours", /Only the\s+\*\*goal\*\* is yours/u],
  ["parallel work is one step", /Parallel work is one step with a count/u],
  ["late answers are not permission", /A late answer[^.]*is never permission/u],
  ["relo state", /relo state/u],
  ["the ask recipe", /relo ask ".+" --approval/u],
  ["approval-only permission", /A yes\/no answer is never permission/u],
  ["exit 0 is not authorization", /Exit `0` alone never authorizes anything/u],
  ["measured progress", /Progress is measured or absent/u],
];
// Commands and flags that no longer exist must never be taught.
const REMOVED = [/relo permissions/u, /--origin-file/u, /activity heartbeat/u, /--live-activity/u, /notify ask/u, /--text\b/u,
  /relo activity/u, /--steps\b/u, /--title\b/u, /--topic\b/u, /--step-current/u];

export function validateSkill(root = defaultRoot) {
  const errors = [];
  const skillPath = join(root, "SKILL.md");
  if (!existsSync(skillPath)) return { errors: ["Missing SKILL.md"], stats: {} };
  const skill = readFileSync(skillPath, "utf8");
  const lineCount = skill.trimEnd().split("\n").length;
  if (lineCount > MAX_SKILL_LINES) errors.push(`SKILL.md has ${lineCount} lines; maximum is ${MAX_SKILL_LINES}`);

  const frontmatter = skill.match(/^---\n([\s\S]*?)\n---\n/u)?.[1];
  if (!frontmatter) errors.push("SKILL.md must begin with YAML frontmatter");
  else {
    const keys = [...frontmatter.matchAll(/^([A-Za-z0-9_-]+):/gmu)].map((match) => match[1]);
    if (keys.join(",") !== "name,description") errors.push("Frontmatter must contain exactly name and description");
    if (frontmatter.match(/^name:\s*(.+)$/mu)?.[1]?.trim() !== "relo-notifications") errors.push("Skill name must be relo-notifications");
    const description = frontmatter.match(/^description:\s*(.+)$/mu)?.[1] ?? "";
    if (!description.includes("Use whenever") && !description.includes("Use when ")) errors.push("Description must say when to use the skill");
    if (description.length > 1024) errors.push("Description must be at most 1024 characters");
  }

  for (const [label, pattern] of REQUIRED_GUIDANCE) {
    if (!pattern.test(skill)) errors.push(`SKILL.md is missing required guidance: ${label}`);
  }
  for (const file of ["SKILL.md", ...REQUIRED_REFERENCES.map((name) => `references/${name}`)]) {
    const path = join(root, file);
    if (!existsSync(path)) { errors.push(`Missing ${file}`); continue; }
    const text = readFileSync(path, "utf8");
    const taught = text.replace(/^## Deprecated and removed[\s\S]*?(?=^## |(?![\s\S]))/mu, "")
      .replace(/^Hooks are optional[\s\S]*$/mu, "");
    for (const pattern of REMOVED) if (pattern.test(taught)) errors.push(`${file} still teaches removed ${pattern}`);
    for (const match of text.matchAll(/\]\(([^)#]+)(?:#[^)]*)?\)/gu)) {
      const target = match[1];
      if (/^[a-z]+:/u.test(target)) continue;
      if (!existsSync(join(dirname(path), target))) errors.push(`${file} links to missing ${target}`);
    }
  }
  for (const reference of REQUIRED_REFERENCES) {
    if (!skill.includes(`references/${reference}`)) errors.push(`SKILL.md does not point to references/${reference}`);
  }
  const extra = readdirSync(join(root, "references")).filter((name) => !REQUIRED_REFERENCES.includes(name));
  if (extra.length) errors.push(`Unlisted references: ${extra.join(", ")}`);
  return { errors, stats: { lineCount } };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validateSkill(process.argv[2] ? resolve(process.argv[2]) : defaultRoot);
  if (result.errors.length) {
    for (const error of result.errors) console.error(`error: ${error}`);
    process.exitCode = 1;
  } else {
    console.log(`Relo skill validation passed: ${result.stats.lineCount} SKILL.md lines, ${REQUIRED_REFERENCES.length} references.`);
  }
}
