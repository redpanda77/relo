#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const skillName = "relo-notifications";

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = { command };
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === "--execute") {
      if (values.execute) throw new Error("Duplicate option: --execute");
      values.execute = true;
      continue;
    }
    const key = new Map([
      ["--skills-dir", "skillsDir"],
      ["--archive-dir", "archiveDir"],
      ["--expected-version", "expectedVersion"],
    ]).get(option);
    if (!key) throw new Error(`Unknown option: ${option}`);
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    if (values[key] !== undefined) throw new Error(`Duplicate option: ${option}`);
    values[key] = value;
  }
  return values;
}

function assertDirectory(path, label) {
  const info = lstatSync(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(`${label} must be a real directory`);
}

function frontmatterName(path) {
  const match = readFileSync(path, "utf8").match(/^---\n([\s\S]*?)\n---(?:\n|$)/u);
  return match?.[1].match(/^name:\s*(.+)$/mu)?.[1]?.trim();
}

function installedVersion(path) {
  const manifestPath = join(path, "package.json");
  if (!existsSync(manifestPath)) throw new Error("Active skill is missing package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (manifest.name !== "@relo/notifications-skill" || typeof manifest.version !== "string") {
    throw new Error("Active skill package identity is invalid");
  }
  return manifest.version;
}

export function inspectSkillDiscovery(skillsDir, expectedVersion) {
  if (!isAbsolute(skillsDir)) throw new Error("--skills-dir must be absolute");
  assertDirectory(skillsDir, "Skill discovery root");
  const copies = [];
  const linked = [];
  for (const entry of readdirSync(skillsDir, { withFileTypes: true })) {
    const directory = join(skillsDir, entry.name);
    if (entry.isSymbolicLink()) {
      if (entry.name === skillName || entry.name.startsWith(`${skillName}.`)
        || entry.name.startsWith(`${skillName}-`)) linked.push(entry.name);
      continue;
    }
    if (!entry.isDirectory()) continue;
    const skillPath = join(directory, "SKILL.md");
    if (!existsSync(skillPath) || frontmatterName(skillPath) !== skillName) continue;
    const info = lstatSync(directory);
    if (info.isSymbolicLink()) throw new Error("Relo skill copies must not be symbolic links");
    copies.push({ name: entry.name, path: directory, active: entry.name === skillName });
  }
  copies.sort((left, right) => left.name.localeCompare(right.name));
  const active = copies.filter((copy) => copy.active);
  const duplicates = copies.filter((copy) => !copy.active);
  const version = active.length === 1 ? installedVersion(active[0].path) : undefined;
  const errors = [];
  if (active.length !== 1) errors.push(`Expected one active ${skillName} directory; found ${active.length}`);
  if (duplicates.length > 0) errors.push(`Found ${duplicates.length} discoverable Relo snapshot(s)`);
  if (linked.length > 0) errors.push(`Found ${linked.length} symbolic-link Relo copy or snapshot(s)`);
  if (expectedVersion && version !== expectedVersion) {
    errors.push(`Active Relo skill version does not match ${expectedVersion}`);
  }
  return {
    ok: errors.length === 0,
    activeCount: active.length,
    duplicateCount: duplicates.length,
    linkedCount: linked.length,
    version,
    active: active.map((copy) => copy.name),
    duplicates: duplicates.map((copy) => copy.name),
    linked,
    errors,
  };
}

function outsideDiscovery(skillsDir, archiveDir) {
  const fromSkills = relative(skillsDir, archiveDir);
  const fromArchive = relative(archiveDir, skillsDir);
  return fromSkills.startsWith("..") && fromArchive.startsWith("..");
}

export function archiveSkillSnapshots({ skillsDir, archiveDir, expectedVersion, execute }) {
  if (!execute) throw new Error("Archiving requires --execute");
  if (!isAbsolute(archiveDir ?? "")) throw new Error("--archive-dir must be absolute");
  const resolvedSkills = resolve(skillsDir);
  const resolvedArchive = resolve(archiveDir);
  if (!outsideDiscovery(resolvedSkills, resolvedArchive)) {
    throw new Error("Archive directory must be outside the skill discovery root");
  }
  const before = inspectSkillDiscovery(resolvedSkills, expectedVersion);
  if (before.activeCount !== 1) throw new Error(before.errors[0]);
  mkdirSync(resolvedArchive, { recursive: true, mode: 0o700 });
  chmodSync(resolvedArchive, 0o700);
  assertDirectory(resolvedArchive, "Skill archive");
  const destinations = before.duplicates.map((name) => ({
    name,
    source: join(resolvedSkills, name),
    destination: join(resolvedArchive, name),
  }));
  for (const item of destinations) {
    if (existsSync(item.destination)) throw new Error(`Archive already contains ${item.name}`);
  }
  const moved = [];
  try {
    for (const item of destinations) {
      renameSync(item.source, item.destination);
      moved.push(item);
    }
  } catch (error) {
    for (const item of moved.reverse()) renameSync(item.destination, item.source);
    throw error;
  }
  const after = inspectSkillDiscovery(resolvedSkills, expectedVersion);
  if (!after.ok) throw new Error(after.errors.join("; "));
  return { ...after, archivedCount: destinations.length, archived: destinations.map((item) => item.name) };
}

async function main(argv) {
  const values = parseArguments(argv);
  if (!values.skillsDir) throw new Error("--skills-dir is required");
  let result;
  if (values.command === "audit") {
    result = inspectSkillDiscovery(values.skillsDir, values.expectedVersion);
  } else if (values.command === "archive") {
    result = archiveSkillSnapshots(values);
  } else {
    throw new Error("Command must be audit or archive");
  }
  process.stdout.write(`${JSON.stringify(result)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`skill-discovery: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 1;
  });
}
