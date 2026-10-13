#!/usr/bin/env node
// Copies skills/relo-notifications into packages/cli/skill/ so the published package carries the skill.
// Run from prepack and from `npm test`. The bundle is generated (gitignored): never edit it.
// Fails when the skill's version differs from the CLI's, so the two can never ship apart.
import { cp, mkdir, readFile, rename, rm, stat } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(here, "..");
// Kept out of the bundle: dependencies and the maintainer test suite. `.DS_Store` is noise.
const EXCLUDED = new Set(["node_modules", "tests", "validate-skill.mjs", ".DS_Store", ".git"]);

const readVersion = async (directory) => JSON.parse(await readFile(join(directory, "package.json"), "utf8")).version;
const exists = async (path) => { try { await stat(path); return true; } catch { return false; } };

/** Throws unless the skill at `directory` has exactly the CLI's version (package version and the @relo/cli pin). */
export async function assertSkillVersion(directory, cliVersion) {
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const pinned = manifest.reviewedToolingVersions?.["@relo/cli"];
  if (manifest.version !== cliVersion || pinned !== cliVersion) {
    throw new Error(`skill version ${manifest.version} (pins @relo/cli ${pinned}) does not match CLI ${cliVersion}`);
  }
}

export async function bundleSkill({ packageRoot = PACKAGE_ROOT, source, out } = {}) {
  const from = resolve(source ?? join(packageRoot, "..", "..", "skills", "relo-notifications"));
  const to = resolve(out ?? join(packageRoot, "skill"));
  const cliVersion = await readVersion(packageRoot);
  if (!(await exists(join(from, "SKILL.md")))) {
    // A packed copy without the repository around it keeps the bundle it already has.
    if (await exists(join(to, "SKILL.md"))) { await assertSkillVersion(to, cliVersion); return { out: to, reused: true }; }
    throw new Error(`skill source not found: ${from}`);
  }
  await assertSkillVersion(from, cliVersion);
  const staging = join(dirname(to), `.${basename(to)}.tmp-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  await mkdir(dirname(to), { recursive: true });
  await cp(from, staging, {
    recursive: true,
    filter: (path) => !EXCLUDED.has(basename(path)),
  });
  await rm(to, { recursive: true, force: true });
  await rename(staging, to);
  return { out: to, reused: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flag = (name) => { const at = process.argv.indexOf(name); return at === -1 ? undefined : process.argv[at + 1]; };
  try {
    const { out, reused } = await bundleSkill({ source: flag("--source"), out: flag("--out") });
    process.stderr.write(`${reused ? "kept" : "bundled"} ${out}\n`);
  } catch (error) {
    process.stderr.write(`bundle-skill: ${error.message}\n`);
    process.exitCode = 1;
  }
}
