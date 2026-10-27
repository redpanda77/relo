#!/usr/bin/env node
// Builds the CLI release artifacts that a GitHub Release `cli-v<version>` carries:
//   dist/release/<version>/relo-cli-<version>.tgz   the npm pack of packages/cli (bundled skill included)
//                          sbom.cdx.json            CycloneDX inventory
//                          manifest.json            {version, gitCommit, files[{name,sha256,bytes}], node}
//                          SHA256SUMS               sha256 of every artifact, `<hex>  <name>` per line
// It first checks that the tree is clean and the CLI + skill checks pass, then scans the unpacked tarball
// for secrets, maintainer-private text and licence problems. Any failure exits 1 and leaves no artifacts.
//
//   node scripts/release/build-cli-release.mjs [--root DIR] [--out DIR] [--allow-dirty] [--skip-checks]
//
// --allow-dirty and --skip-checks exist for tests and local rehearsals; the manifest records `gitDirty`.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { auditPublicFiles } from "../public-export.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const DEFAULT_ROOT = resolve(here, "..", "..");
const PRIVATE_RULES = "docs/internal/operations/release/public-export-private-rules.json";
const TAG_PREFIX = "cli-v";

// Secret shapes that must never appear in a published artifact. Examples in docs use obvious placeholders
// (`relo_…`, `x`.repeat) that these do not match.
export const SECRET_PATTERNS = [
  { id: "private-key", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { id: "relo-token", pattern: /\brelo_[A-Za-z0-9_-]{32,}/u },
  { id: "github-token", pattern: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}/u },
  { id: "api-key", pattern: /\bsk-[A-Za-z0-9_-]{24,}|\bAKIA[0-9A-Z]{16}\b|\bxox[abprs]-[A-Za-z0-9-]{10,}/u },
  { id: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/u },
  { id: "bearer-header", pattern: /Bearer\s+[A-Za-z0-9._~+/-]{32,}/u },
  { id: "home-path", pattern: /(?:\/Users|\/home)\/(?!you\b|user\b|me\b|name\b|USER\b|\$|<|\.\.\.)[a-z][a-z0-9._-]{2,}\//u },
  { id: "inline-credential-url", pattern: /https?:\/\/[^\s/:@]+:[^\s/@]{3,}@/u },
];

const FOREIGN_LICENSE = [
  /SPDX-License-Identifier:\s*(?!PolyForm)\S+/u,
  /\bMIT License\b/u, /\bApache License\b/u, /GNU (?:Lesser |Affero )?General Public License/u, /\bBSD [23]-Clause\b/u,
  /Licensed under the (?:MIT|Apache|BSD|GPL)/iu,
];
const ALLOWED_TOP_LEVEL = new Set(["package.json", "LICENSE", "README.md", "bin", "src", "skill"]);
const DEPENDENCY_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies", "bundledDependencies", "bundleDependencies"];

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

export class ReleaseBuildError extends Error {
  constructor(message, findings = []) {
    super(message);
    this.name = "ReleaseBuildError";
    this.findings = findings;
  }
}

// npm is npm.cmd on Windows, which execFileSync can only start through a shell.
const NPM = process.platform === "win32" ? "npm.cmd" : "npm";

function run(command, args, options) {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: command === "npm.cmd", ...options });
  } catch (error) {
    const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim().split("\n").slice(-12).join("\n");
    throw new ReleaseBuildError(`${command} ${args.join(" ")} failed (cwd ${options?.cwd})\n${output}`);
  }
}

async function walk(directory, prefix = "") {
  const found = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) found.push(...await walk(path, `${prefix}${entry.name}/`));
    else found.push(`${prefix}${entry.name}`);
  }
  return found.sort();
}

async function forbiddenRules(root) {
  const publicRules = JSON.parse(await readFile(join(root, "public-export.json"), "utf8")).forbiddenText ?? [];
  let privateRules = [];
  try { privateRules = JSON.parse(await readFile(join(root, PRIVATE_RULES), "utf8")).forbiddenText ?? []; } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return [...publicRules, ...privateRules];
}

/** Secret, denylist and layout scan of the unpacked package. Returns findings (empty when clean). */
export async function scanUnpacked(packageDirectory, rules) {
  const paths = await walk(packageDirectory);
  const findings = [];
  const readText = async (path) => {
    const buffer = await readFile(join(packageDirectory, path));
    return buffer.includes(0) ? null : buffer.toString("utf8");
  };
  const stat = (path) => lstat(join(packageDirectory, path));
  const manifest = {
    requiredFiles: ["package.json", "LICENSE", "README.md", "bin/relo.mjs", "skill/SKILL.md", "skill/package.json"],
    forbiddenText: rules,
  };
  for (const blocker of await auditPublicFiles({ paths, manifest, readText, stat })) {
    findings.push(`denylist ${blocker.rule}: ${blocker.path}${blocker.line ? `:${blocker.line}` : ""}`);
  }
  for (const path of paths) {
    if (!ALLOWED_TOP_LEVEL.has(path.split("/")[0])) findings.push(`unexpected file in package: ${path}`);
    if (/(^|\/)(\.env|node_modules|\.git)(\/|$)|\.(?:map|pem|key|p12)$/u.test(path)) findings.push(`sensitive file in package: ${path}`);
    const text = await readText(path);
    if (text === null) continue;
    for (const { id, pattern } of SECRET_PATTERNS) {
      const match = pattern.exec(text);
      if (match) findings.push(`secret-scan ${id}: ${path}:${text.slice(0, match.index).split("\n").length}`);
    }
  }
  return findings;
}

/** Every file is covered by the package LICENSE, and nothing third-party is bundled or imported. */
export async function checkLicense(packageDirectory, rootLicense) {
  const findings = [];
  const manifest = JSON.parse(await readFile(join(packageDirectory, "package.json"), "utf8"));
  const license = await readFile(join(packageDirectory, "LICENSE"), "utf8");
  if (manifest.license !== "PolyForm-Noncommercial-1.0.0") findings.push(`package license is ${manifest.license}, expected PolyForm-Noncommercial-1.0.0`);
  if (!/PolyForm Noncommercial License 1\.0\.0/u.test(license)) findings.push("LICENSE is not the PolyForm Noncommercial 1.0.0 text");
  if (rootLicense !== undefined && rootLicense !== license) findings.push("package LICENSE differs from the repository LICENSE");
  for (const field of DEPENDENCY_FIELDS) {
    const value = manifest[field];
    if (value && (Array.isArray(value) ? value.length : Object.keys(value).length) > 0) findings.push(`third-party ${field} declared in package.json`);
  }
  const skill = JSON.parse(await readFile(join(packageDirectory, "skill", "package.json"), "utf8"));
  if (skill.license !== manifest.license) findings.push(`bundled skill license is ${skill.license}`);
  for (const field of DEPENDENCY_FIELDS) if (skill[field] && Object.keys(skill[field]).length > 0) findings.push(`third-party ${field} in the bundled skill`);
  if (existsSync(join(packageDirectory, "skill", "LICENSE")) && await readFile(join(packageDirectory, "skill", "LICENSE"), "utf8") !== license) {
    findings.push("bundled skill LICENSE differs from the package LICENSE");
  }
  const importPattern = /^\s*(?:import|export)\s[^;]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)|\brequire\(\s*["']([^"']+)["']\s*\)/gmu;
  for (const path of await walk(packageDirectory)) {
    if (!/\.(?:mjs|js|cjs)$/u.test(path)) continue;
    const text = await readFile(join(packageDirectory, path), "utf8");
    for (const match of text.matchAll(importPattern)) {
      const specifier = match[1] ?? match[2] ?? match[3] ?? match[4];
      if (!specifier.startsWith("node:") && !specifier.startsWith(".") && !specifier.startsWith("/")) findings.push(`third-party import "${specifier}": ${path}`);
    }
    for (const pattern of FOREIGN_LICENSE) if (pattern.test(text)) findings.push(`foreign license text (${pattern.source}): ${path}`);
  }
  return findings;
}

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

/** A minimal CycloneDX inventory, used only when `npm sbom` is unavailable on this npm. */
function fallbackSbom(manifest, files) {
  return {
    bomFormat: "CycloneDX", specVersion: "1.5", version: 1,
    metadata: { component: { type: "library", name: manifest.name, version: manifest.version, licenses: [{ license: { id: manifest.license } }] } },
    components: files.map(({ name, sha256: hash }) => ({ type: "file", name, hashes: [{ alg: "SHA-256", content: hash }] })),
    dependencies: [{ ref: `${manifest.name}@${manifest.version}`, dependsOn: [] }],
  };
}

export async function buildRelease({ root = DEFAULT_ROOT, out, allowDirty = false, skipChecks = false, log = () => {} } = {}) {
  root = resolve(root);
  const cliDirectory = join(root, "packages", "cli");
  const skillDirectory = join(root, "skills", "relo-notifications");
  const outputRoot = resolve(out ?? join(root, "dist", "release"));
  const manifestJson = JSON.parse(await readFile(join(cliDirectory, "package.json"), "utf8"));
  const version = manifestJson.version;
  if (!/^\d+\.\d+\.\d+$/u.test(version)) throw new ReleaseBuildError(`CLI version ${version} is not x.y.z`);

  // 1. Clean tree (only the paths this release is built from; unrelated work in the repo does not matter).
  let gitCommit = "unknown";
  let gitDirty = false;
  try {
    gitCommit = git(root, ["rev-parse", "HEAD"]);
    const dirty = git(root, ["status", "--porcelain", "--", "packages/cli", "skills/relo-notifications", "LICENSE", "public-export.json"]);
    gitDirty = dirty !== "";
    if (gitDirty && !allowDirty) {
      throw new ReleaseBuildError("The tree is not clean for packages/cli and skills/relo-notifications; commit first.", dirty.split("\n"));
    }
  } catch (error) {
    if (error instanceof ReleaseBuildError) throw error;
    if (!allowDirty) throw new ReleaseBuildError(`Cannot read the git state of ${root}: a release is built from a committed tree.`);
  }
  log(`building ${manifestJson.name}@${version} from ${gitCommit}${gitDirty ? " (dirty)" : ""}`);

  const work = await mkdtemp(join(tmpdir(), "relo-release-"));
  const env = { ...process.env, npm_config_cache: join(work, "npm-cache"), npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
  const partial = join(outputRoot, `.${version}.partial`);
  try {
    // 2. The CLI and skill checks.
    if (!skipChecks) {
      log("running CLI and skill checks");
      run(NPM, ["test"], { cwd: cliDirectory, env });
      run(NPM, ["run", "check"], { cwd: cliDirectory, env });
      run(NPM, ["run", "check"], { cwd: skillDirectory, env });
      run(NPM, ["test"], { cwd: skillDirectory, env });
    }

    // 3. Pack (prepack bundles the skill at the CLI's exact version and runs prepack-check).
    await rm(partial, { recursive: true, force: true });
    await mkdir(partial, { recursive: true });
    const packed = JSON.parse(run(NPM, ["pack", "--json", "--pack-destination", partial], { cwd: cliDirectory, env }))[0];
    const tarballName = `relo-cli-${version}.tgz`;
    if (packed.filename !== tarballName) throw new ReleaseBuildError(`npm pack produced ${packed.filename}, expected ${tarballName}`);
    const tarball = join(partial, tarballName);

    // 4. Scan what is actually inside the tarball.
    const unpacked = join(work, "unpacked");
    await mkdir(unpacked);
    run("tar", ["-xzf", tarball, "-C", unpacked], { cwd: work });
    const packageDirectory = join(unpacked, "package");
    const findings = [
      ...await scanUnpacked(packageDirectory, await forbiddenRules(root)),
      ...await checkLicense(packageDirectory, await readFile(join(root, "LICENSE"), "utf8").catch(() => undefined)),
    ];
    if (findings.length > 0) throw new ReleaseBuildError(`Release scan found ${findings.length} problem(s)`, findings);
    const packedFiles = await walk(packageDirectory);

    // 5. SBOM. The CLI has no runtime dependencies; assert that rather than assume it.
    let sbom;
    let sbomSource = "npm sbom";
    try {
      sbom = JSON.parse(run(NPM, ["sbom", "--sbom-format", "cyclonedx"], { cwd: cliDirectory, env }));
    } catch {
      sbomSource = "fallback inventory";
      const files = [];
      for (const name of packedFiles) files.push({ name, sha256: sha256(await readFile(join(packageDirectory, name))) });
      sbom = fallbackSbom(manifestJson, files);
    }
    if ((sbom.components ?? []).some((component) => component.type !== "file")) {
      throw new ReleaseBuildError("The SBOM lists third-party components; the CLI must ship with none.", sbom.components.map((c) => `${c.name}@${c.version}`));
    }
    await writeFile(join(partial, "sbom.cdx.json"), `${JSON.stringify(sbom, null, 2)}\n`);

    // 6. Manifest, then checksums over everything (the manifest included).
    const describe = async (name) => {
      const buffer = await readFile(join(partial, name));
      return { name, sha256: sha256(buffer), bytes: buffer.length };
    };
    const files = [await describe(tarballName), await describe("sbom.cdx.json")];
    const manifest = {
      name: manifestJson.name, version, tag: `${TAG_PREFIX}${version}`, gitCommit, gitDirty, node: manifestJson.engines?.node ?? ">=22",
      files, packagedFiles: packedFiles.length, sbom: sbomSource,
      scans: { secrets: "clean", denylist: "clean", license: "clean", thirdPartyDependencies: 0 },
    };
    await writeFile(join(partial, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    const everything = [...files, await describe("manifest.json")].sort((a, b) => (a.name < b.name ? -1 : 1));
    await writeFile(join(partial, "SHA256SUMS"), everything.map((file) => `${file.sha256}  ${file.name}`).join("\n") + "\n");

    // 7. Publish the directory only now that everything passed.
    const target = join(outputRoot, version);
    await rm(target, { recursive: true, force: true });
    await rename(partial, target);
    const listing = [];
    for (const name of (await readdir(target)).sort()) listing.push({ name, bytes: (await lstat(join(target, name))).size });
    return { version, directory: target, gitCommit, gitDirty, files: listing, manifest };
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--allow-dirty") options.allowDirty = true;
    else if (argument === "--skip-checks") options.skipChecks = true;
    else if (argument === "--root" || argument === "--out") options[argument.slice(2)] = argv[++index];
    else throw new Error(`Unknown argument ${argument}. Usage: build-cli-release.mjs [--root DIR] [--out DIR] [--allow-dirty] [--skip-checks]`);
  }
  return options;
}

if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  try {
    const built = await buildRelease({ ...parseArguments(process.argv.slice(2)), log: (line) => console.error(line) });
    console.log(JSON.stringify({ ok: true, version: built.version, directory: relative(process.cwd(), built.directory) || ".", gitCommit: built.gitCommit, gitDirty: built.gitDirty, files: built.files }, null, 2));
  } catch (error) {
    console.error(`RELEASE BUILD FAILED: ${error.message}`);
    for (const finding of error.findings ?? []) console.error(`  - ${finding}`);
    process.exit(1);
  }
}
