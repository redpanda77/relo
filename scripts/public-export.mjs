import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifestPath = join(repositoryRoot, "public-export.json");
const privateRulesPath = join(
  repositoryRoot,
  "docs/internal/operations/release/public-export-private-rules.json",
);

function normalizePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\//u, "");
}

function isAllowedDotPath(path, allowedDotPaths = []) {
  const hasDotSegment = path.split("/").some((segment) => segment.startsWith("."));
  if (!hasDotSegment) return true;
  return allowedDotPaths.some((allowedPath) => (
    allowedPath.endsWith("/") ? path.startsWith(allowedPath) : path === allowedPath
  ));
}

export function selectPublicPaths(paths, manifest) {
  const rootFiles = new Set(manifest.rootFiles);
  const prefixes = manifest.roots.map((root) => `${root}/`);
  return paths
    .map(normalizePath)
    .filter((path) => rootFiles.has(path) || prefixes.some((prefix) => path.startsWith(prefix)))
    .filter((path) => !manifest.excludedPrefixes.some((prefix) => path.startsWith(prefix)))
    .filter((path) => isAllowedDotPath(path, manifest.allowedDotPaths))
    .sort();
}

function lineFor(text, index) {
  return text.slice(0, index).split("\n").length;
}

export async function auditPublicFiles({ paths, manifest, readText, stat }) {
  const blockers = [];
  const pathSet = new Set(paths);

  for (const required of manifest.requiredFiles) {
    if (!pathSet.has(required)) blockers.push({ rule: "required-file", path: required });
  }

  for (const path of paths) {
    const metadata = await stat(path);
    if (metadata.isSymbolicLink()) {
      blockers.push({ rule: "symbolic-link", path });
      continue;
    }
    if (!metadata.isFile()) continue;

    const text = await readText(path);
    if (text === null) continue;
    for (const rule of manifest.forbiddenText) {
      const haystack = rule.caseSensitive ? text : text.toLocaleLowerCase("en-US");
      const needle = rule.caseSensitive ? rule.value : rule.value.toLocaleLowerCase("en-US");
      let offset = haystack.indexOf(needle);
      while (offset >= 0) {
        blockers.push({ rule: rule.id, path, line: lineFor(text, offset) });
        offset = haystack.indexOf(needle, offset + needle.length);
      }
    }
  }
  return blockers;
}

function trackedPaths(root) {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter(Boolean);
}

async function loadManifest() {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  try {
    const privateRules = JSON.parse(await readFile(privateRulesPath, "utf8"));
    return {
      ...manifest,
      forbiddenText: [...manifest.forbiddenText, ...(privateRules.forbiddenText ?? [])],
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return manifest;
  }
}

async function inspectRepository() {
  const manifest = await loadManifest();
  const paths = selectPublicPaths(trackedPaths(repositoryRoot), manifest)
    .filter((path) => existsSync(join(repositoryRoot, path)));
  const blockers = await auditPublicFiles({
    paths,
    manifest,
    readText: async (path) => {
      const buffer = await readFile(join(repositoryRoot, path));
      return buffer.includes(0) ? null : buffer.toString("utf8");
    },
    stat: (path) => lstat(join(repositoryRoot, path)),
  });
  return { blockers, paths };
}

function printReport(paths, blockers) {
  console.log(`Public export candidate: ${paths.length} tracked files`);
  if (blockers.length === 0) {
    console.log("Public export boundary is clean.");
    return;
  }

  const counts = new Map();
  for (const blocker of blockers) counts.set(blocker.rule, (counts.get(blocker.rule) ?? 0) + 1);
  console.log(`Blocked by ${blockers.length} finding(s):`);
  for (const [rule, count] of [...counts].sort()) console.log(`- ${rule}: ${count}`);
  console.log("First findings:");
  for (const blocker of blockers.slice(0, 20)) {
    console.log(`- ${blocker.rule}: ${blocker.path}${blocker.line ? `:${blocker.line}` : ""}`);
  }
}

export function isLicenseOnlyCandidate(blockers) {
  return blockers.length === 1
    && blockers[0].rule === "required-file"
    && blockers[0].path === "LICENSE";
}

export function parseTargetArgument(arguments_) {
  const values = arguments_.filter((argument) => argument !== "--");
  return values.length === 1 ? values[0] : undefined;
}

async function writeExport(targetArgument, { candidate = false } = {}) {
  if (!targetArgument) {
    throw new Error(`Usage: pnpm public:${candidate ? "stage" : "export"} -- <new-empty-directory>`);
  }
  const target = resolve(process.cwd(), targetArgument);
  if (relative(repositoryRoot, target) === "") throw new Error("Export target cannot be the repository root");

  const { blockers, paths } = await inspectRepository();
  printReport(paths, blockers);
  if (blockers.length > 0 && !(candidate && isLicenseOnlyCandidate(blockers))) {
    throw new Error("Refusing to write a blocked public export");
  }

  await mkdir(target, { recursive: false });
  for (const path of paths) {
    const destination = join(target, path);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(repositoryRoot, path), destination);
  }
  const marker = candidate ? ".relo-public-candidate" : ".relo-public-export";
  const state = candidate ? "not-publishable: repository LICENSE pending\n" : "";
  await writeFile(join(target, marker), `${new Date().toISOString()}\n${state}`, "utf8");
  console.log(`Wrote ${paths.length} ${candidate ? "candidate" : "public"} files to ${target}`);
}

async function main() {
  const command = process.argv[2] ?? "report";
  const targetArgument = parseTargetArgument(process.argv.slice(3));
  if (command === "write") {
    await writeExport(targetArgument);
    return;
  }
  if (command === "stage") {
    await writeExport(targetArgument, { candidate: true });
    return;
  }
  if (!new Set(["check", "report"]).has(command)) {
    throw new Error("Usage: public-export.mjs <report|check|stage|write> [target]");
  }
  const { blockers, paths } = await inspectRepository();
  printReport(paths, blockers);
  if (command === "check" && blockers.length > 0) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
