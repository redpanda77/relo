#!/usr/bin/env node

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDirectory, "..");
const requiredReferences = [
  "security.md",
  "cli.md",
  "live-activities.md",
  "services.md",
  "permissions.md",
  "install.md",
  "release-checklist.md",
  "troubleshooting.md",
];

function filesBelow(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) files.push(...filesBelow(path));
    else files.push(path);
  }
  return files;
}

function frontmatterField(frontmatter, name) {
  const match = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, "m"));
  return match?.[1]?.trim();
}

export function validateSkill(root = defaultRoot) {
  const errors = [];
  const skillPath = join(root, "SKILL.md");
  if (!existsSync(skillPath)) return { errors: ["Missing SKILL.md"], stats: {} };

  const allFiles = filesBelow(root);
  const skill = readFileSync(skillPath, "utf8");
  const packagePath = join(root, "package.json");
  let manifest;
  if (!existsSync(packagePath)) {
    errors.push("Missing package.json");
  } else {
    try {
      manifest = JSON.parse(readFileSync(packagePath, "utf8"));
    } catch {
      errors.push("package.json must contain valid JSON");
    }
  }
  const lineCount = skill.split(/\r?\n/).length - (skill.endsWith("\n") ? 1 : 0);
  if (lineCount > 100) errors.push(`SKILL.md has ${lineCount} lines; maximum is 100`);
  if (allFiles.some((path) => basename(path).toLowerCase() === "readme.md")) {
    errors.push("README.md is not allowed inside a skill directory");
  }

  const frontmatterMatch = skill.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!frontmatterMatch) {
    errors.push("SKILL.md must begin with YAML frontmatter");
  } else {
    const frontmatter = frontmatterMatch[1];
    const name = frontmatterField(frontmatter, "name");
    const description = frontmatterField(frontmatter, "description") ?? "";
    if (name !== "relo-notifications" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name ?? "")) {
      errors.push("Frontmatter name must be relo-notifications in kebab-case");
    }
    if (!description.includes("Use when ")) errors.push("Description must contain trigger phrase 'Use when'");
    if (description.length > 1_024) errors.push("Description exceeds 1024 characters");
    if (/[<>]/.test(frontmatter)) errors.push("Frontmatter must not contain angle brackets");
    const frontmatterKeys = [...frontmatter.matchAll(/^([A-Za-z0-9_-]+):/gmu)]
      .map((match) => match[1]);
    if (frontmatterKeys.some((key) => !["name", "description"].includes(key))) {
      errors.push("Frontmatter may contain only name and description");
    }
  }

  for (const reference of requiredReferences) {
    if (!existsSync(join(root, "references", reference))) {
      errors.push(`Missing required reference: references/${reference}`);
    }
  }

  const markdownFiles = allFiles.filter((path) => path.endsWith(".md"));
  const links = new Map();
  for (const source of markdownFiles) {
    const sourceLinks = [];
    const contents = readFileSync(source, "utf8");
    for (const match of contents.matchAll(/\]\(([^)]+)\)/g)) {
      const rawTarget = match[1];
      if (/^[a-z]+:/i.test(rawTarget) || rawTarget.startsWith("#")) continue;
      const target = rawTarget.split("#", 1)[0];
      const resolved = resolve(dirname(source), target);
      const fromRoot = relative(root, resolved);
      if (fromRoot === ".." || fromRoot.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
        errors.push(`Reference link escapes skill root: ${relative(root, source)} -> ${rawTarget}`);
        continue;
      }
      if (!existsSync(resolved)) {
        errors.push(`Broken reference link: ${relative(root, source)} -> ${rawTarget}`);
        continue;
      }
      sourceLinks.push(resolved);
    }
    links.set(source, sourceLinks);
  }
  const reachable = new Set([skillPath]);
  const queue = [skillPath];
  while (queue.length > 0) {
    for (const target of links.get(queue.shift()) ?? []) {
      if (!target.endsWith(".md") || reachable.has(target)) continue;
      reachable.add(target);
      queue.push(target);
    }
  }
  for (const reference of requiredReferences) {
    const path = join(root, "references", reference);
    if (existsSync(path) && !reachable.has(path)) {
      errors.push(`Required reference is not reachable from SKILL.md: references/${reference}`);
    }
  }

  const markdown = markdownFiles
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  const requiredSafety = [
    ["explicit approval gate", /type`? is exactly `?approval|`approval` interaction/],
    ["approved terminal state", /state`? is exactly `?approved|state `approved`/],
    ["yes-no and text deny", /yes\/no or text (?:answer|response|interaction) is never permission/i],
    ["raw-command prohibition", /Never transmit raw commands/i],
    ["absolute-path prohibition", /absolute paths/i],
    ["durable command gate", /durableCommands > 0/],
    ["server source of truth", /server record is the source of truth/i],
    ["permission setup", /permissions setup/],
    ["permission doctor", /permissions doctor/],
    ["permission uninstall", /permissions uninstall/],
    ["allow once", /allow-once/i],
    ["captured service secret-file", /forbids captured agents from using that mode/i],
    ["idempotency key range", /1–200 characters/],
  ];
  for (const [label, pattern] of requiredSafety) {
    if (!pattern.test(markdown)) errors.push(`Missing safety contract: ${label}`);
  }

  if (/\/Users\//.test(markdown) || /\/home\/[A-Za-z0-9._-]+\//.test(markdown)) {
    errors.push("Skill documentation contains a host-specific absolute path");
  }
  if (/--(?:api-)?token(?:\s|=)/.test(markdown)) {
    errors.push("Skill documentation must not teach credential flags");
  }

  const cliPath = join(root, "references", "cli.md");
  if (existsSync(cliPath)) {
    const cli = readFileSync(cliPath, "utf8");
    if (!/1–200 characters/.test(cli)) {
      errors.push("CLI reference is missing the idempotency key range");
    }
    if (!cli.includes("--page-size 1..100")) {
      errors.push("CLI reference is missing the bounded device page size");
    }
    for (const [code, meaning] of [
      ["1", "API, prerequisite, or other failure"],
      ["3", "Missing, invalid, or insufficient authentication"],
      ["4", "Canceled, expired, or timed-out interaction"],
      ["5", "Explicit denial or `no`"],
      ["6", "Network unreachable"],
      ["7", "No durable device command was enqueued"],
    ]) {
      if (!cli.includes(`| \`${code}\` | ${meaning}`)) {
        errors.push(`CLI reference is missing stable exit ${code}`);
      }
    }
    if (cli.includes("| `8` |")) errors.push("CLI reference retains the pre-parity exit 8 mapping");
    for (const command of [
      "notify send",
      "notify ask",
      "interaction get",
      "interaction wait",
      "interaction cancel",
      "activity start",
      "activity wait",
      "activity update",
      "activity end",
      "devices list",
      "services create",
      "services list",
    ]) {
      if (!cli.includes(command)) errors.push(`CLI reference is missing command: ${command}`);
    }
  }

  const securityPath = join(root, "references", "security.md");
  if (existsSync(securityPath) && !/1–200 characters/.test(readFileSync(securityPath, "utf8"))) {
    errors.push("Security reference is missing the idempotency key range");
  }

  const troubleshootingPath = join(root, "references", "troubleshooting.md");
  if (existsSync(troubleshootingPath)) {
    const troubleshooting = readFileSync(troubleshootingPath, "utf8");
    if (!troubleshooting.includes("Exit `6` means") || !troubleshooting.includes("Exit `7` means no durable")) {
      errors.push("Troubleshooting reference is missing stable network/no-delivery exits");
    }
    if (troubleshooting.includes("Exit `8`")) {
      errors.push("Troubleshooting reference retains the pre-parity exit 8 mapping");
    }
  }

  const reviewedTooling = manifest?.reviewedToolingVersions;
  const installPath = join(root, "references", "install.md");
  if (existsSync(installPath)) {
    const install = readFileSync(installPath, "utf8");
    if (!install.includes("npm root --global")) {
      errors.push("Install reference must resolve the notifier helper from npm's global root");
    }
    if (
      !install.includes("/@relo/codex-notify")
      || !install.includes("scripts/configure-codex-notify.mjs")
    ) {
      errors.push("Install reference is missing the packaged notifier configuration helper path");
    }
    if (/node\s+["']?configure-codex-notify\.mjs/u.test(install)) {
      errors.push("Install reference must not invoke the notifier helper relative to cwd");
    }
    const packageInstall = "skills@1.5.22 add ./skills/relo-notifications --skill relo-notifications --agent codex --yes --copy";
    if (!install.includes(packageInstall) || install.includes("skills@1.5.22 add . --skill")) {
      errors.push("Install reference must use the reviewed package directory, not repository-root discovery");
    }
    if (!install.includes("SHA-256") || !install.includes("same-version")) {
      errors.push("Install reference is missing private artifact identity requirements");
    }
    if (!install.includes("release:artifacts") || !install.includes("artifact-pair.mjs verify")
      || !install.includes(`relo-tooling-pair-${reviewedTooling?.["@relo/cli"]}.json`)) {
      errors.push("Install reference is missing paired pack-once and retained-byte verification");
    }
    if (!install.includes("bind-transition") || !install.includes("release-checklist.md")) {
      errors.push("Install reference is missing the bound transition and consolidated release gate");
    }
    if (!install.includes("skill-discovery.mjs")
      || !install.includes(".local/share/relo/skill-archives")) {
      errors.push("Install reference is missing the non-discovery skill backup gate");
    }
    if (/create a recoverable backup beside it/i.test(install)) {
      errors.push("Install reference must not place skill backups inside discovery");
    }
  }
  const releaseChecklistPath = join(root, "references", "release-checklist.md");
  if (existsSync(releaseChecklistPath)) {
    const releaseChecklist = readFileSync(releaseChecklistPath, "utf8");
    for (const requirement of [
      "bind-transition",
      "verify-transition",
      "release:host -- lifecycle --execute",
      "skill-discovery.mjs audit",
      ".local/share/relo/skill-archives",
      "./skills/relo-notifications",
      "Repository-root discovery",
      "exact event/device `received`",
      "auth logout --json",
      "OpenCode V1",
      "OpenCode V2",
      "CLI-EXIT-P1-04 exit-code migration",
    ]) {
      if (!releaseChecklist.includes(requirement)) {
        errors.push(`Release checklist is missing: ${requirement}`);
      }
    }
  }
  for (const script of ["artifact-pair.mjs", "installed-host-gate.mjs", "skill-discovery.mjs"]) {
    if (!existsSync(join(root, "scripts", script))) errors.push(`Missing release script: scripts/${script}`);
  }
  for (const [packageName, tarballStem] of [
    ["@relo/cli", "relo-cli"],
    ["@relo/codex-notify", "relo-codex-notify"],
  ]) {
    const version = reviewedTooling?.[packageName];
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
      errors.push(`Missing reviewed tooling version for ${packageName}`);
      continue;
    }
    if (
      existsSync(installPath)
      && !readFileSync(installPath, "utf8").includes(`${tarballStem}-${version}.tgz`)
    ) {
      errors.push(`Install reference does not use reviewed ${packageName} version ${version}`);
    }
  }

  const openAiConfig = join(root, "agents", "openai.yaml");
  if (!existsSync(openAiConfig)) errors.push("Missing agents/openai.yaml");
  else if (!readFileSync(openAiConfig, "utf8").includes("$relo-notifications")) {
    errors.push("agents/openai.yaml must name $relo-notifications in its default prompt");
  }
  if (!existsSync(join(root, "LICENSE"))) errors.push("Missing package-scoped open-source license");

  const casesPath = join(root, "tests", "cases.json");
  if (!existsSync(casesPath)) {
    errors.push("Missing tests/cases.json triggering and functional evals");
  } else {
    try {
      const cases = JSON.parse(readFileSync(casesPath, "utf8"));
      if (!Array.isArray(cases.shouldTrigger) || cases.shouldTrigger.length < 8) {
        errors.push("Trigger evals require at least eight shouldTrigger cases");
      }
      if (!Array.isArray(cases.shouldNotTrigger) || cases.shouldNotTrigger.length < 8) {
        errors.push("Trigger evals require at least eight shouldNotTrigger cases");
      }
      for (const [label, entries] of [
        ["shouldTrigger", cases.shouldTrigger],
        ["shouldNotTrigger", cases.shouldNotTrigger],
      ]) {
        if (Array.isArray(entries) && entries.some((item) =>
          typeof item?.name !== "string" || typeof item?.prompt !== "string"
        )) errors.push(`${label} cases require names and prompts`);
      }
      if (cases.modelTriggerQuality?.status !== "not-automated") {
        errors.push("Model-dependent trigger quality must remain explicitly not-automated");
      }
      if (!Array.isArray(cases.functional) || cases.functional.length < 5) {
        errors.push("Functional evals require at least five cases");
      }
      if (!Array.isArray(cases.errorTranscripts) || cases.errorTranscripts.length < 5) {
        errors.push("Error transcript evals require at least five cases");
      }
      for (const requiredName of ["permission approval", "context-aware installation", "style selection"]) {
        if (!cases.functional?.some((item) => item?.name === requiredName)) {
          errors.push(`Missing functional eval: ${requiredName}`);
        }
      }
      if (cases.functional?.some((item) => typeof item?.workflow !== "string")) {
        errors.push("Every functional eval requires an executable workflow name");
      }
      for (const workflow of ["ordinary-send", "browser-auth", "notifier-maintenance"]) {
        if (!cases.functional?.some((item) => item?.workflow === workflow)) {
          errors.push(`Missing executable workflow eval: ${workflow}`);
        }
      }
      if (cases.errorTranscripts?.some((item) =>
        typeof item?.fixture !== "string" || typeof item?.expectedAction !== "string"
      )) errors.push("Every error transcript requires an executable fixture and expected action");
    } catch {
      errors.push("tests/cases.json must contain valid JSON");
    }
  }

  return {
    errors,
    stats: {
      lineCount,
      referenceCount: requiredReferences.length,
      markdownFileCount: markdownFiles.length,
      reachableReferenceCount: [...reachable].filter((path) => path !== skillPath).length,
    },
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = validateSkill(process.argv[2] ? resolve(process.argv[2]) : defaultRoot);
  if (result.errors.length) {
    for (const error of result.errors) process.stderr.write(`ERROR: ${error}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(
      `Relo skill validation passed: ${result.stats.lineCount} SKILL.md lines, ` +
        `${result.stats.referenceCount} required references.\n`,
    );
  }
}
