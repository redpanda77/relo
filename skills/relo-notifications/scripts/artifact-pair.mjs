#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { lstat, mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const skillRoot = resolve(dirname(scriptPath), "..");
const repositoryRoot = resolve(skillRoot, "../..");
const MAX_IDENTITY_BYTES = 4 * 1024 * 1024;
const PACKAGE_SPECS = Object.freeze([
  {
    name: "@relo/cli",
    root: resolve(repositoryRoot, "packages/cli"),
    artifactStem: "relo-cli",
  },
  {
    name: "@relo/codex-notify",
    root: resolve(repositoryRoot, "packages/codex-notify"),
    artifactStem: "relo-codex-notify",
  },
]);

function hash(algorithm, value, encoding = "hex") {
  return createHash(algorithm).update(value).digest(encoding);
}

function safeRelativePath(value) {
  return typeof value === "string"
    && value.length > 0
    && !isAbsolute(value)
    && !value.split(/[\\/]/u).includes("..");
}

async function readRegularFile(path, maximum = Number.POSITIVE_INFINITY) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) {
    throw new Error(`Refusing unsafe artifact input: ${basename(path)}`);
  }
  return { info, contents: await readFile(path) };
}

async function writeExclusive(path, contents) {
  let handle;
  try {
    handle = await open(path, "wx", 0o600);
    await handle.writeFile(contents, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
  } finally {
    await handle?.close().catch(() => {});
  }
}

async function sourceTreeDigest(root, files) {
  const digest = createHash("sha256");
  for (const file of [...files].sort((left, right) => left.path.localeCompare(right.path))) {
    if (!safeRelativePath(file.path)) throw new Error("npm pack returned an unsafe file path");
    const path = resolve(root, file.path);
    if (relative(root, path).startsWith(`..${sep}`)) {
      throw new Error("npm pack file escaped its package root");
    }
    const { contents } = await readRegularFile(path);
    digest.update(`${Buffer.byteLength(file.path, "utf8")}:`);
    digest.update(file.path);
    digest.update(`${contents.length}:`);
    digest.update(contents);
  }
  return digest.digest("hex");
}

function artifactIdentity(fileName, contents) {
  return {
    artifactFile: fileName,
    sha256: hash("sha256", contents),
    integrity: `sha512-${hash("sha512", contents, "base64")}`,
    npmShasum: hash("sha1", contents),
    bytes: contents.length,
  };
}

function pairMaterial(manifest) {
  return {
    schemaVersion: manifest.schemaVersion,
    releaseVersion: manifest.releaseVersion,
    packages: manifest.packages.map((entry) => ({
      name: entry.name,
      version: entry.version,
      artifactFile: entry.artifactFile,
      sha256: entry.sha256,
      integrity: entry.integrity,
      npmShasum: entry.npmShasum,
      bytes: entry.bytes,
      sourceTreeSha256: entry.sourceTreeSha256,
      packedFiles: entry.packedFiles,
    })),
  };
}

export function pairSha256(manifest) {
  return hash("sha256", JSON.stringify(pairMaterial(manifest)));
}

function transitionSide(manifestFile, manifestBytes, manifest) {
  return {
    manifestFile: basename(manifestFile),
    manifestSha256: hash("sha256", manifestBytes),
    releaseVersion: manifest.releaseVersion,
    pairSha256: manifest.pairSha256,
    packages: manifest.packages.map((entry) => ({
      name: entry.name,
      artifactFile: entry.artifactFile,
      sha256: entry.sha256,
      bytes: entry.bytes,
    })),
  };
}

function transitionMaterial(transition) {
  return {
    schemaVersion: transition.schemaVersion,
    prior: transition.prior,
    candidate: transition.candidate,
  };
}

export function transitionSha256(transition) {
  return hash("sha256", JSON.stringify(transitionMaterial(transition)));
}

function validateManifestShape(manifest) {
  if (!manifest || manifest.schemaVersion !== 1 || typeof manifest.releaseVersion !== "string"
    || typeof manifest.nodeVersion !== "string" || manifest.nodeVersion.length === 0
    || typeof manifest.npmVersion !== "string" || manifest.npmVersion.length === 0
    || !Array.isArray(manifest.packages) || manifest.packages.length !== 2
    || typeof manifest.pairSha256 !== "string" || manifest.pairSha256 !== pairSha256(manifest)) {
    throw new Error("Artifact pair identity is malformed or internally inconsistent");
  }
  for (const entry of manifest.packages) {
    const spec = PACKAGE_SPECS.find((candidate) => candidate.name === entry.name);
    if (!spec
      || entry.version !== manifest.releaseVersion
      || !safeRelativePath(entry.artifactFile)
      || basename(entry.artifactFile) !== entry.artifactFile
      || entry.artifactFile !== `${spec.artifactStem}-${entry.version}.tgz`
      || !/^[a-f0-9]{64}$/u.test(entry.sha256)
      || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity)
      || !/^[a-f0-9]{40}$/u.test(entry.npmShasum)
      || !Number.isInteger(entry.bytes) || entry.bytes <= 0
      || !/^[a-f0-9]{64}$/u.test(entry.sourceTreeSha256)
      || !Array.isArray(entry.packedFiles) || entry.packedFiles.length === 0
      || entry.packedFiles.some((file) => !safeRelativePath(file.path)
        || !Number.isInteger(file.size) || file.size < 0)) {
      throw new Error("Artifact pair identity contains invalid package metadata");
    }
  }
  if (new Set(manifest.packages.map((entry) => entry.name)).size !== 2) {
    throw new Error("Artifact pair identity must contain each reviewed package exactly once");
  }
  return manifest;
}

function validateTransitionShape(transition) {
  const validSide = (side) => side
    && safeRelativePath(side.manifestFile)
    && basename(side.manifestFile) === side.manifestFile
    && /^[a-f0-9]{64}$/u.test(side.manifestSha256)
    && typeof side.releaseVersion === "string"
    && side.releaseVersion.length > 0
    && /^[a-f0-9]{64}$/u.test(side.pairSha256)
    && Array.isArray(side.packages)
    && side.packages.length === 2
    && side.packages.every((entry) => PACKAGE_SPECS.some((spec) => spec.name === entry.name)
      && safeRelativePath(entry.artifactFile)
      && basename(entry.artifactFile) === entry.artifactFile
      && /^[a-f0-9]{64}$/u.test(entry.sha256)
      && Number.isInteger(entry.bytes)
      && entry.bytes > 0);
  if (!transition || transition.schemaVersion !== 1
    || !validSide(transition.prior) || !validSide(transition.candidate)
    || transition.prior.releaseVersion === transition.candidate.releaseVersion
    || new Set(transition.prior.packages.map((entry) => entry.name)).size !== 2
    || new Set(transition.candidate.packages.map((entry) => entry.name)).size !== 2
    || typeof transition.transitionSha256 !== "string"
    || transition.transitionSha256 !== transitionSha256(transition)) {
    throw new Error("Artifact transition identity is malformed or internally inconsistent");
  }
  return transition;
}

async function safeOutputDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("Artifact output directory must be a private mode-0700 directory");
  }
}

async function ensureAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error(`Refusing to overwrite retained artifact: ${basename(path)}`);
}

async function npmPack(spec, output, npmCommand) {
  const { stdout } = await execFileAsync(npmCommand, [
    "pack", "--json", "--pack-destination", output,
  ], {
    cwd: spec.root,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_update_notifier: "false",
    },
  });
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    throw new Error(`npm pack returned an invalid record for ${spec.name}`);
  }
  return parsed[0];
}

export async function packArtifactPair({ output, npmCommand = "npm" }) {
  if (!isAbsolute(output)) throw new Error("--output must be an absolute private directory");
  await safeOutputDirectory(output);
  const skillManifest = JSON.parse(await readFile(resolve(skillRoot, "package.json"), "utf8"));
  const packages = [];
  let releaseVersion;

  for (const spec of PACKAGE_SPECS) {
    const packageManifest = JSON.parse(await readFile(resolve(spec.root, "package.json"), "utf8"));
    if (packageManifest.name !== spec.name || packageManifest.private !== true) {
      throw new Error(`Refusing unexpected or public package: ${spec.name}`);
    }
    if (skillManifest.reviewedToolingVersions?.[spec.name] !== packageManifest.version) {
      throw new Error(`Skill review version does not match ${spec.name}`);
    }
    releaseVersion ??= packageManifest.version;
    if (packageManifest.version !== releaseVersion) {
      throw new Error("CLI and notifier release versions must match");
    }
    const artifactFile = `${spec.artifactStem}-${packageManifest.version}.tgz`;
    await ensureAbsent(resolve(output, artifactFile));
    packages.push({ spec, packageManifest, artifactFile });
  }

  const manifestFile = `relo-tooling-pair-${releaseVersion}.json`;
  await ensureAbsent(resolve(output, manifestFile));
  const { stdout: npmVersionOutput } = await execFileAsync(npmCommand, ["--version"], {
    encoding: "utf8",
  });
  const identities = [];
  for (const item of packages) {
    const packed = await npmPack(item.spec, output, npmCommand);
    if (packed.filename !== item.artifactFile || packed.name !== item.spec.name
      || packed.version !== item.packageManifest.version || !Array.isArray(packed.files)) {
      throw new Error(`npm pack identity did not match ${item.spec.name}`);
    }
    const artifactPath = resolve(output, packed.filename);
    const { contents } = await readRegularFile(artifactPath);
    const identity = artifactIdentity(packed.filename, contents);
    if (packed.size !== identity.bytes || packed.integrity !== identity.integrity
      || packed.shasum !== identity.npmShasum) {
      throw new Error(`Packed bytes did not match npm identity for ${item.spec.name}`);
    }
    identities.push({
      name: item.spec.name,
      version: item.packageManifest.version,
      ...identity,
      sourceTreeSha256: await sourceTreeDigest(item.spec.root, packed.files),
      packedFiles: packed.files.map((file) => ({ path: file.path, size: file.size })),
    });
  }

  const manifest = {
    schemaVersion: 1,
    releaseVersion,
    nodeVersion: process.version,
    npmVersion: npmVersionOutput.trim(),
    packages: identities,
  };
  manifest.pairSha256 = pairSha256(manifest);
  validateManifestShape(manifest);
  await writeExclusive(resolve(output, manifestFile), `${JSON.stringify(manifest, null, 2)}\n`);
  return { manifestFile, manifest };
}

export async function verifyArtifactPair({ manifest: manifestPath, cli, notifier }) {
  for (const [name, value] of Object.entries({ manifest: manifestPath, cli, notifier })) {
    if (!isAbsolute(value)) throw new Error(`--${name} must be an absolute path`);
  }
  const { contents: manifestBytes } = await readRegularFile(manifestPath, MAX_IDENTITY_BYTES);
  const manifest = validateManifestShape(JSON.parse(manifestBytes.toString("utf8")));
  const artifacts = new Map([
    ["@relo/cli", cli],
    ["@relo/codex-notify", notifier],
  ]);
  for (const entry of manifest.packages) {
    const path = artifacts.get(entry.name);
    if (basename(path) !== entry.artifactFile) {
      throw new Error(`Artifact filename does not match retained identity for ${entry.name}`);
    }
    const { contents } = await readRegularFile(path);
    const actual = artifactIdentity(entry.artifactFile, contents);
    for (const field of ["sha256", "integrity", "npmShasum", "bytes"]) {
      if (actual[field] !== entry[field]) {
        throw new Error(`Artifact content does not match retained identity for ${entry.name}`);
      }
    }
  }
  return { verified: true, releaseVersion: manifest.releaseVersion, pairSha256: manifest.pairSha256 };
}

async function readPairSide(manifestPath, cli, notifier) {
  await verifyArtifactPair({ manifest: manifestPath, cli, notifier });
  const { contents } = await readRegularFile(manifestPath, MAX_IDENTITY_BYTES);
  const manifest = validateManifestShape(JSON.parse(contents.toString("utf8")));
  return { manifest, side: transitionSide(manifestPath, contents, manifest) };
}

function transitionInputs(values, prefix) {
  return {
    manifest: values[`${prefix}Manifest`],
    cli: values[`${prefix}Cli`],
    notifier: values[`${prefix}Notifier`],
  };
}

export async function bindArtifactTransition({ output, prior, candidate }) {
  if (!isAbsolute(output)) throw new Error("--output must be an absolute private directory");
  await safeOutputDirectory(output);
  const priorPair = await readPairSide(prior.manifest, prior.cli, prior.notifier);
  const candidatePair = await readPairSide(candidate.manifest, candidate.cli, candidate.notifier);
  const skillManifest = JSON.parse(await readFile(resolve(skillRoot, "package.json"), "utf8"));
  for (const entry of candidatePair.manifest.packages) {
    if (skillManifest.reviewedToolingVersions?.[entry.name] !== entry.version) {
      throw new Error(`Candidate identity does not match reviewed ${entry.name}`);
    }
  }
  if (priorPair.manifest.releaseVersion === candidatePair.manifest.releaseVersion) {
    throw new Error("Prior and candidate artifact versions must be distinct");
  }
  const transition = {
    schemaVersion: 1,
    prior: priorPair.side,
    candidate: candidatePair.side,
  };
  transition.transitionSha256 = transitionSha256(transition);
  validateTransitionShape(transition);
  const transitionFile = `relo-tooling-transition-${transition.prior.releaseVersion}-to-${transition.candidate.releaseVersion}.json`;
  await ensureAbsent(resolve(output, transitionFile));
  await writeExclusive(resolve(output, transitionFile), `${JSON.stringify(transition, null, 2)}\n`);
  return { transitionFile, transition };
}

export async function verifyArtifactTransition({ transition: transitionPath, prior, candidate }) {
  if (!isAbsolute(transitionPath)) throw new Error("--transition must be an absolute path");
  const { contents } = await readRegularFile(transitionPath, MAX_IDENTITY_BYTES);
  const transition = validateTransitionShape(JSON.parse(contents.toString("utf8")));
  const actualPrior = (await readPairSide(prior.manifest, prior.cli, prior.notifier)).side;
  const actualCandidate = (await readPairSide(candidate.manifest, candidate.cli, candidate.notifier)).side;
  if (JSON.stringify(actualPrior) !== JSON.stringify(transition.prior)
    || JSON.stringify(actualCandidate) !== JSON.stringify(transition.candidate)) {
    throw new Error("Retained artifacts do not match the bound prior/candidate transition");
  }
  return {
    verified: true,
    priorVersion: transition.prior.releaseVersion,
    candidateVersion: transition.candidate.releaseVersion,
    transitionSha256: transition.transitionSha256,
  };
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = { command };
  const optionKeys = new Map([
    ["--output", "output"],
    ["--manifest", "manifest"],
    ["--cli", "cli"],
    ["--notifier", "notifier"],
    ["--transition", "transition"],
    ["--prior-manifest", "priorManifest"],
    ["--prior-cli", "priorCli"],
    ["--prior-notifier", "priorNotifier"],
    ["--candidate-manifest", "candidateManifest"],
    ["--candidate-cli", "candidateCli"],
    ["--candidate-notifier", "candidateNotifier"],
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const name = rest[index];
    const key = optionKeys.get(name);
    if (!key) throw new Error(`Unknown option: ${name}`);
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value`);
    if (values[key] !== undefined) throw new Error(`Duplicate option: ${name}`);
    values[key] = value;
  }
  return values;
}

async function main(argv) {
  const values = parseArguments(argv);
  const exactOptions = (...allowed) => Object.entries(values).every(([key, value]) => (
    key === "command" || value === undefined || allowed.includes(key)
  ));
  if (values.command === "pack" && values.output && exactOptions("output")) {
    const result = await packArtifactPair({ output: values.output });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      releaseVersion: result.manifest.releaseVersion,
      manifestFile: result.manifestFile,
      pairSha256: result.manifest.pairSha256,
    })}\n`);
    return;
  }
  if (values.command === "verify" && values.manifest && values.cli && values.notifier
    && exactOptions("manifest", "cli", "notifier")) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...await verifyArtifactPair(values) })}\n`);
    return;
  }
  const transitionKeys = [
    "priorManifest", "priorCli", "priorNotifier",
    "candidateManifest", "candidateCli", "candidateNotifier",
  ];
  const hasTransitionInputs = transitionKeys.every((key) => values[key]);
  if (values.command === "bind-transition" && values.output && hasTransitionInputs
    && exactOptions("output", ...transitionKeys)) {
    const result = await bindArtifactTransition({
      output: values.output,
      prior: transitionInputs(values, "prior"),
      candidate: transitionInputs(values, "candidate"),
    });
    process.stdout.write(`${JSON.stringify({
      ok: true,
      transitionFile: result.transitionFile,
      priorVersion: result.transition.prior.releaseVersion,
      candidateVersion: result.transition.candidate.releaseVersion,
      transitionSha256: result.transition.transitionSha256,
    })}\n`);
    return;
  }
  if (values.command === "verify-transition" && values.transition && hasTransitionInputs
    && exactOptions("transition", ...transitionKeys)) {
    const result = await verifyArtifactTransition({
      transition: values.transition,
      prior: transitionInputs(values, "prior"),
      candidate: transitionInputs(values, "candidate"),
    });
    process.stdout.write(`${JSON.stringify({ ok: true, ...result })}\n`);
    return;
  }
  throw new Error(
    "Usage: artifact-pair.mjs pack|verify|bind-transition|verify-transition with the documented exact artifact paths",
  );
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`artifact-pair: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 1;
  });
}
