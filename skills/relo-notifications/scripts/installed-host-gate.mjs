#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, lstat, mkdir, open, readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyArtifactTransition } from "./artifact-pair.mjs";

const execFileAsync = promisify(execFile);
const scriptPath = fileURLToPath(import.meta.url);
const SAFE_ID = /^[A-Za-z0-9._-]{1,64}$/u;

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const values = { command, preserveFiles: [] };
  const valueOptions = new Map([
    ["--transition", "transition"],
    ["--prior-manifest", "priorManifest"],
    ["--prior-cli", "priorCli"],
    ["--prior-notifier", "priorNotifier"],
    ["--candidate-manifest", "candidateManifest"],
    ["--candidate-cli", "candidateCli"],
    ["--candidate-notifier", "candidateNotifier"],
    ["--skill-source", "skillSource"],
    ["--evidence-dir", "evidenceDir"],
    ["--prefix", "prefix"],
    ["--host-id", "hostId"],
    ["--run-id", "runId"],
    ["--codex-hooks-config", "codexHooksConfig"],
    ["--codex-config", "codexConfig"],
    ["--installation-id-path", "installationIdPath"],
    ["--preserve-file", "preserveFiles"],
  ]);
  for (let index = 0; index < rest.length; index += 1) {
    const option = rest[index];
    if (option === "--execute" || option === "--system-global") {
      const key = option === "--execute" ? "execute" : "systemGlobal";
      if (values[key]) throw new Error(`Duplicate option: ${option}`);
      values[key] = true;
      continue;
    }
    const key = valueOptions.get(option);
    if (!key) throw new Error(`Unknown option: ${option}`);
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`${option} requires a value`);
    if (key === "preserveFiles") values.preserveFiles.push(value);
    else if (values[key] !== undefined) throw new Error(`Duplicate option: ${option}`);
    else values[key] = value;
  }
  return values;
}

function artifactInputs(values, prefix) {
  return {
    manifest: values[`${prefix}Manifest`],
    cli: values[`${prefix}Cli`],
    notifier: values[`${prefix}Notifier`],
  };
}

function requireAbsolute(values, names) {
  for (const name of names) {
    if (!isAbsolute(values[name] ?? "")) throw new Error(`--${name.replace(/[A-Z]/gu, (letter) => `-${letter.toLowerCase()}`)} must be absolute`);
  }
}

async function privateDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()
    || (process.platform !== "win32" && (info.mode & 0o077) !== 0)) {
    throw new Error("Evidence directory must be a private mode-0700 directory");
  }
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

async function validateSkillSource(path, candidateVersion) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()
    || basename(path) !== "relo-notifications" || basename(dirname(path)) !== "skills") {
    throw new Error("Skill source must be the reviewed skills/relo-notifications directory");
  }
  const manifest = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  if (manifest.name !== "@relo/notifications-skill" || manifest.version !== candidateVersion
    || manifest.reviewedToolingVersions?.["@relo/cli"] !== candidateVersion
    || manifest.reviewedToolingVersions?.["@relo/codex-notify"] !== candidateVersion) {
    throw new Error("Skill source does not match the candidate tooling identity");
  }
  await access(join(path, "SKILL.md"));
  await access(join(path, "scripts", "validate-skill.mjs"));
}

async function fingerprint(path) {
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("Preserved state path is not a regular file");
    const contents = await readFile(path);
    return {
      exists: true,
      mode: process.platform === "win32" ? undefined : info.mode & 0o777,
      bytes: contents.length,
      sha256: createHash("sha256").update(contents).digest("hex"),
    };
  } catch (error) {
    if (error?.code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function preservedState(paths) {
  const state = [];
  for (const path of paths) state.push(await fingerprint(path));
  return state;
}

export function childEnvironment(environment = process.env) {
  const child = { ...environment };
  for (const name of Object.keys(child)) {
    if (name.toLowerCase() === "npm_config_prefix") delete child[name];
  }
  return {
    ...child,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
}

async function run(command, args) {
  try {
    return await execFileAsync(command, args, {
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      env: childEnvironment(),
    });
  } catch {
    throw new Error(`Installed-host command failed: ${basename(command)}`);
  }
}

function npmScope(values) {
  return values.systemGlobal ? [] : ["--prefix", values.prefix];
}

async function npmPrefix(values) {
  if (values.prefix) return values.prefix;
  const { stdout } = await run("npm", ["prefix", "--global"]);
  const lines = stdout.trimEnd().split("\n");
  if (lines.length !== 1 || !isAbsolute(lines[0])) throw new Error("npm returned an unsafe global prefix");
  return lines[0];
}

async function assertInstalled(values, expectedVersion) {
  const prefix = await npmPrefix(values);
  const extension = process.platform === "win32" ? ".cmd" : "";
  const cli = join(prefix, "bin", `relo${extension}`);
  const notifier = join(prefix, "bin", `relo-codex-notify${extension}`);
  const rootResult = await run("npm", ["root", "--global", ...npmScope(values)]);
  const roots = rootResult.stdout.trimEnd().split("\n");
  if (roots.length !== 1 || !isAbsolute(roots[0])) throw new Error("npm returned an unsafe package root");
  const cliManifest = JSON.parse(await readFile(join(roots[0], "@relo", "cli", "package.json"), "utf8"));
  const notifierManifest = JSON.parse(await readFile(join(roots[0], "@relo", "codex-notify", "package.json"), "utf8"));
  if (cliManifest.version !== expectedVersion || notifierManifest.version !== expectedVersion) {
    throw new Error("Installed package versions do not match the retained identity");
  }
  const version = await run(cli, ["--version"]);
  if (version.stdout.trim() !== expectedVersion) throw new Error("Installed CLI reported the wrong version");
  await run(notifier, ["--dry-run", JSON.stringify({
    type: "agent-turn-complete",
    "thread-id": "release-gate",
    "turn-id": expectedVersion,
  })]);
}

async function codexHookRuntime(values) {
  if (!values.codexHooksConfig) return undefined;
  const prefix = await npmPrefix(values);
  const extension = process.platform === "win32" ? ".cmd" : "";
  const rootResult = await run("npm", ["root", "--global", ...npmScope(values)]);
  const roots = rootResult.stdout.trimEnd().split("\n");
  if (roots.length !== 1 || !isAbsolute(roots[0])) throw new Error("npm returned an unsafe package root");
  return {
    script: join(roots[0], "@relo", "codex-notify", "scripts", "configure-codex-hooks.mjs"),
    hooksConfig: values.codexHooksConfig,
    hook: join(prefix, "bin", `relo-codex-hook${extension}`),
    relo: join(prefix, "bin", `relo${extension}`),
    installationIdPath: values.installationIdPath,
  };
}

async function codexNotifyRuntime(values) {
  if (!values.codexConfig) return undefined;
  const prefix = await npmPrefix(values);
  const extension = process.platform === "win32" ? ".cmd" : "";
  const rootResult = await run("npm", ["root", "--global", ...npmScope(values)]);
  const roots = rootResult.stdout.trimEnd().split("\n");
  if (roots.length !== 1 || !isAbsolute(roots[0])) throw new Error("npm returned an unsafe package root");
  return {
    script: join(roots[0],"@relo","codex-notify","scripts","configure-codex-notify.mjs"),
    config: values.codexConfig,
    adapter: join(prefix, "bin", `relo-codex-notify${extension}`),
    relo: join(prefix, "bin", `relo${extension}`),
    installationIdPath: values.installationIdPath,
  };
}

async function reconcileCodexHooks(values, action = "install") {
  const runtime = await codexHookRuntime(values);
  if (!runtime) return false;
  const argumentsFor = (command) => [
    runtime.script, command,
    "--hooks-config", runtime.hooksConfig,
    "--hook", runtime.hook,
    "--relo", runtime.relo,
    "--installation-id-path", runtime.installationIdPath,
  ];
  await run(process.execPath, argumentsFor(action));
  if (action === "install") {
    const inspected = await run(process.execPath, argumentsFor("doctor"));
    let result;
    try {
      result = JSON.parse(inspected.stdout);
    } catch {
      throw new Error("Codex lifecycle hook doctor returned invalid output");
    }
    if (result?.installed !== true) throw new Error("Codex lifecycle hooks do not target the installed pair");
  }
  return true;
}

async function reconcileCodexNotify(values, action = "install", stage = action) {
  const runtime = await codexNotifyRuntime(values);
  if (!runtime) return false;
  const argumentsFor = (command) => [
    runtime.script,command,
    "--config",runtime.config,
    "--adapter",runtime.adapter,
    "--relo",runtime.relo,
    "--installation-id-path",runtime.installationIdPath,
    ...(command === "doctor" ? [] : ["--backup-suffix",`gate-${values.runId.slice(0,32)}-${stage}`]),
  ];
  await run(process.execPath,argumentsFor(action));
  if (action === "install") {
    const inspected = await run(process.execPath,argumentsFor("doctor"));
    let result;
    try {
      result = JSON.parse(inspected.stdout);
    } catch {
      throw new Error("Codex completion notifier doctor returned invalid output");
    }
    if (result?.installed !== true) {
      throw new Error("Codex completion notifier does not target the installed lifecycle-only pair");
    }
  }
  return true;
}

async function assertMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  throw new Error("Package uninstall left an installed file");
}

async function assertUninstalled(values) {
  const prefix = await npmPrefix(values);
  const extension = process.platform === "win32" ? ".cmd" : "";
  const rootResult = await run("npm", ["root", "--global", ...npmScope(values)]);
  const roots = rootResult.stdout.trimEnd().split("\n");
  if (roots.length !== 1 || !isAbsolute(roots[0])) throw new Error("npm returned an unsafe package root");
  await Promise.all([
    assertMissing(join(prefix, "bin", `relo${extension}`)),
    assertMissing(join(prefix, "bin", `reloctl${extension}`)),
    assertMissing(join(prefix, "bin", `relo-codex-notify${extension}`)),
    assertMissing(join(roots[0], "@relo", "cli")),
    assertMissing(join(roots[0], "@relo", "reloctl")),
    assertMissing(join(roots[0], "@relo", "codex-notify")),
  ]);
}

async function install(values, pair) {
  await run("npm", ["install", "--global", ...npmScope(values), pair.cli, pair.notifier]);
}

async function verifyBound(values) {
  return verifyArtifactTransition({
    transition: values.transition,
    prior: artifactInputs(values, "prior"),
    candidate: artifactInputs(values, "candidate"),
  });
}

async function preflight(values) {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new Error("Node.js 22 or newer is required");
  requireAbsolute(values, [
    "transition", "priorManifest", "priorCli", "priorNotifier",
    "candidateManifest", "candidateCli", "candidateNotifier", "skillSource", "evidenceDir",
  ]);
  if (values.prefix && values.systemGlobal) throw new Error("Choose --prefix or --system-global, not both");
  if (!values.prefix && !values.systemGlobal) throw new Error("Choose an explicit --prefix or --system-global");
  if (values.prefix && !isAbsolute(values.prefix)) throw new Error("--prefix must be absolute");
  if (!SAFE_ID.test(values.hostId ?? "") || !SAFE_ID.test(values.runId ?? "")) {
    throw new Error("--host-id and --run-id must be safe opaque identifiers");
  }
  for (const path of values.preserveFiles) {
    if (!isAbsolute(path)) throw new Error("--preserve-file must be absolute");
  }
  const managesCodex = values.codexHooksConfig !== undefined
    || values.codexConfig !== undefined || values.installationIdPath !== undefined;
  if (managesCodex) {
    if (!values.installationIdPath) throw new Error("--installation-id-path must be absolute");
    requireAbsolute(values, ["installationIdPath"]);
    if (values.codexHooksConfig) requireAbsolute(values,["codexHooksConfig"]);
    if (values.codexConfig) requireAbsolute(values,["codexConfig"]);
    if (values.preserveFiles.includes(values.codexHooksConfig)) {
      throw new Error("Managed Codex hooks cannot also be a byte-preserved file");
    }
    if (values.preserveFiles.includes(values.codexConfig)) {
      throw new Error("Managed Codex config cannot also be a byte-preserved file");
    }
  }
  await privateDirectory(values.evidenceDir);
  const identity = await verifyBound(values);
  await validateSkillSource(values.skillSource, identity.candidateVersion);
  const npmVersion = (await run("npm", ["--version"])).stdout.trim();
  if (!npmVersion || npmVersion.includes("\n")) throw new Error("npm returned an invalid version");
  return { ...identity, npmVersion };
}

async function writeEvidence(values, identity, action, steps, preservedFiles) {
  const record = {
    schemaVersion: 1,
    release: identity.candidateVersion,
    priorVersion: identity.priorVersion,
    candidateVersion: identity.candidateVersion,
    transitionSha256: identity.transitionSha256,
    nodeVersion: process.version,
    npmVersion: identity.npmVersion,
    hostId: values.hostId,
    runId: values.runId,
    action,
    steps,
    preservedFiles,
  };
  const file = `cli-${identity.candidateVersion}-${values.hostId}-${action}-${values.runId}.json`;
  await writeExclusive(join(values.evidenceDir, file), `${JSON.stringify(record, null, 2)}\n`);
  return { file, record };
}

export async function runInstalledHostGate(values) {
  const identity = await preflight(values);
  if (values.command === "preflight") {
    return {
      ready: true,
      priorVersion: identity.priorVersion,
      candidateVersion: identity.candidateVersion,
      transitionSha256: identity.transitionSha256,
      nodeVersion: process.version,
      npmVersion: identity.npmVersion,
      hostId: values.hostId,
      runId: values.runId,
    };
  }
  if (!values.execute) throw new Error("Mutation requires the explicit --execute flag");
  const before = await preservedState(values.preserveFiles);
  const steps = [];
  if (values.command === "lifecycle") {
    await verifyBound(values);
    await install(values, artifactInputs(values, "prior"));
    await assertInstalled(values, identity.priorVersion);
    if (await reconcileCodexHooks(values)) steps.push("reconcile-prior-codex-hooks");
    if (await reconcileCodexNotify(values,"install","prior")) steps.push("reconcile-prior-codex-notify");
    steps.push("install-prior");
    await verifyBound(values);
    await install(values, artifactInputs(values, "candidate"));
    await assertInstalled(values, identity.candidateVersion);
    if (await reconcileCodexHooks(values)) steps.push("reconcile-candidate-codex-hooks");
    if (await reconcileCodexNotify(values,"install","candidate")) steps.push("reconcile-candidate-codex-notify");
    steps.push("update-candidate");
    await verifyBound(values);
    await install(values, artifactInputs(values, "prior"));
    await assertInstalled(values, identity.priorVersion);
    if (await reconcileCodexHooks(values)) steps.push("reconcile-rollback-codex-hooks");
    if (await reconcileCodexNotify(values,"install","rollback")) steps.push("reconcile-rollback-codex-notify");
    steps.push("rollback-prior");
    await verifyBound(values);
    await install(values, artifactInputs(values, "candidate"));
    await assertInstalled(values, identity.candidateVersion);
    if (await reconcileCodexHooks(values)) steps.push("reconcile-restored-codex-hooks");
    if (await reconcileCodexNotify(values,"install","restored")) steps.push("reconcile-restored-codex-notify");
    steps.push("restore-candidate");
  } else if (values.command === "uninstall") {
    await assertInstalled(values, identity.candidateVersion);
    if (await reconcileCodexHooks(values, "uninstall")) steps.push("remove-codex-hooks");
    if (await reconcileCodexNotify(values,"uninstall","uninstall")) steps.push("remove-codex-notify");
    await run("npm", [
      "uninstall", "--global", ...npmScope(values),
      "@relo/codex-notify", "@relo/cli",
    ]);
    await assertUninstalled(values);
    steps.push("uninstall-candidate");
  } else {
    throw new Error("Command must be preflight, lifecycle, or uninstall");
  }
  const after = await preservedState(values.preserveFiles);
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    throw new Error("Package lifecycle changed a preserved state file");
  }
  const evidence = await writeEvidence(values, identity, values.command, steps, before.length);
  return {
    ok: true,
    action: values.command,
    evidenceFile: evidence.file,
    transitionSha256: identity.transitionSha256,
    preservedFiles: before.length,
  };
}

async function main(argv) {
  const values = parseArguments(argv);
  const result = await runInstalledHostGate(values);
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === scriptPath) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`installed-host-gate: ${error instanceof Error ? error.message : "failed"}\n`);
    process.exitCode = 1;
  });
}
