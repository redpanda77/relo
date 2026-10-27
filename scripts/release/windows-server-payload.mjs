#!/usr/bin/env node
// The server Relo for Windows carries (the twin of mac-server-payload.sh): Node, the server with its production
// dependencies, the Dashboard, migrations, the CLI and PostgreSQL, laid out the way the server finds its pieces by
// relative path (the Dockerfile's workspace layout). The app puts it at <app dir>\server and ReloServer.exe runs it.
//
//   node scripts/release/windows-server-payload.mjs OUT_DIR [--release-identity X.Y.Z]
//
// OUT_DIR\release-identity.txt is the app's version (default: apps/windows/src-tauri/tauri.conf.json). The app and
// ReloServer.exe both read it: ReloServer.exe hands it to the server as RELO_RELEASE_IDENTITY, the server reports it as
// `release` in /health/ready, and the app compares that with the same file to decide whether to restart the server.
//
// OUT_DIR\ gets: node.exe (the official win-x64 build), NODE-LICENSE, cli\ (the relo CLI, unpacked),
// app\server\{dist,migrations,node_modules,package.json,cli}, app\dashboard\dist, app\postgres (17, pruned of the
// pgAdmin/wx leftovers, import libraries and message catalogs) and VERSION (the server's package version).
// Node and PostgreSQL are pinned and checked against their published digests. A payload is cached by the tree of what
// it is built from, so an unchanged server is not built again.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readdir, readFile, rename, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

export const NODE_VERSION = "22.23.4";
export const POSTGRES_PACKAGE = "@embedded-postgres/windows-x64@17.10.0-beta.17";
export const POSTGRES_TARBALL = "https://registry.npmjs.org/@embedded-postgres/windows-x64/-/windows-x64-17.10.0-beta.17.tgz";
export const POSTGRES_INTEGRITY = "sha512-q6xIETTkv67i1QlTWz1LAKb3Z+vG2V3qrp+BjLEWhCQ9jE4hbbsQ/J/3wiOPFLJbuwak7CfHC9EUJG7txAbGKw==";
const NODE_FILE = `node-v${NODE_VERSION}-win-x64`;

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
/** What the payload is built from: the pinned releases in the key, the code, the lockfile, and the scripts that lay it out. */
export const BUILT_FROM = [
  "apps/server", "apps/dashboard", "packages/contracts", "packages/owner-crypto", "packages/cli", "skills/relo-notifications",
  "scripts/release/windows-server-payload.mjs", "pnpm-lock.yaml",
];
const NOT_SHIPPED = /(\.test\.[a-z]+|\/test\/|\/tests\/|\/test-support\/|\/fixtures\/)/u;

const say = (message) => process.stderr.write(`server-payload: ${message}\n`);
export class PayloadError extends Error {}
const die = (message) => { throw new PayloadError(message); };

/** The SHA-256 SHASUMS256.txt lists for `file`. */
export function shasumFor(shasums, file) {
  for (const line of shasums.split(/\r?\n/u)) {
    const [digest, name] = line.trim().split(/\s+/u);
    if (name === file && /^[0-9a-f]{64}$/u.test(digest ?? "")) return digest;
  }
  return die(`${file} is not in Node's SHASUMS256.txt`);
}

export const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");
export const integrityOf = (buffer) => `sha512-${createHash("sha512").update(buffer).digest("base64")}`;

export function assertIntegrity(buffer, expected) {
  if (integrityOf(buffer) !== expected) die("PostgreSQL did not match its integrity");
}

/** The cache key: the tree of what the payload is built from (tests excluded), and the pinned releases. */
export function payloadKey(treeListing, node = NODE_VERSION) {
  const kept = treeListing.split(/\r?\n/u).filter((line) => line && !NOT_SHIPPED.test(line)).join("\n");
  return `${sha256(kept).slice(0, 16)}-node${node}-pg17.10-win-x64`;
}

/** Files of the EnterpriseDB build the server never runs: pgAdmin's wx libraries, a test plugin, import libraries, message catalogs. */
export const PRUNE = [
  { dir: "bin", match: /^(wx.*\.dll|testplug\.dll)$/iu },
  { dir: "lib", match: /\.lib$/iu },
  { dir: ".", match: /^pg-symlinks\.json$/u },
  { dir: "share", match: /^locale$/u },
];

export async function prunePostgres(postgresDir) {
  const removed = [];
  for (const { dir, match } of PRUNE) {
    const folder = join(postgresDir, dir);
    if (!existsSync(folder)) continue;
    for (const name of await readdir(folder)) {
      if (!match.test(name)) continue;
      await rm(join(folder, name), { recursive: true, force: true });
      removed.push(`${dir}/${name}`);
    }
  }
  return removed;
}

function cacheRoot(env = process.env) {
  return join(env.XDG_CACHE_HOME || env.LOCALAPPDATA || join(homedir(), "AppData", "Local"), "relo", "server-payload");
}

const WINDOWS_TAR = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
/** tar.exe (bsdtar, in Windows 10+) reads zip and tgz alike; Git's GNU tar would read `C:` as a remote host. */
function tar(args) {
  const command = process.platform === "win32" && existsSync(WINDOWS_TAR) ? WINDOWS_TAR : "tar";
  const result = spawnSync(command, args, { stdio: ["ignore", "ignore", "inherit"] });
  if (result.status !== 0) die(`tar ${args.join(" ")} failed`);
}

/** npm and npx are .cmd files on Windows: run their JavaScript entry with this Node instead (no shell, no quoting). */
function npmTool(name, args) {
  const entry = join(dirname(process.execPath), "node_modules", "npm", "bin", `${name}-cli.js`);
  return existsSync(entry) ? [process.execPath, [entry, ...args]] : [name, args];
}

function run(command, args, options = {}) {
  const [file, fileArgs] = command === "npm" || command === "npx" ? npmTool(command, args) : [command, args];
  const result = spawnSync(file, fileArgs, { stdio: ["ignore", 2, 2], ...options });
  if (result.status !== 0) die(`${command} ${args.join(" ")} failed (${result.status ?? result.error?.message})`);
}

function output(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.status !== 0) die(`${command} ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

async function download(url, to) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10 * 60_000) });
  if (!response.ok || !response.body) die(`${url} answered ${response.status}`);
  await pipeline(Readable.fromWeb(response.body), createWriteStream(to));
  return readFile(to);
}

/** pnpm at the version the repository pins, run through npx so a fresh clone needs only Node. */
const pnpm = (...args) => run("npx", ["-y", `pnpm@${JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).packageManager.replace(/^pnpm@/u, "")}`, ...args]);

function git(...args) {
  return output("git", ["-C", ROOT, ...args]);
}

/** The PostgreSQL licence text, kept in one place: the Mac payload script's heredoc. */
export function postgresLicense(macScript) {
  const match = /<<'LICENSE'\r?\n([\s\S]*?)\r?\nLICENSE\r?\n/u.exec(macScript);
  if (!match) die("can't find the PostgreSQL licence text in mac-server-payload.sh");
  return `${match[1]}\n`;
}

/** The app's version: what a payload's release-identity.txt holds unless the build names another. */
export function defaultReleaseIdentity(root = ROOT) {
  return JSON.parse(readFileSync(join(root, "apps", "windows", "src-tauri", "tauri.conf.json"), "utf8")).version;
}

/** Writes release-identity.txt (LF, one line) into a payload folder. */
export function writeReleaseIdentity(outDir, identity) {
  if (!/^\d+\.\d+\.\d+([-+][0-9A-Za-z.+-]+)?$/u.test(identity ?? "")) die(`release identity ${identity} must look like 1.2.3 or 1.2.3+45`);
  writeFileSync(join(outDir, "release-identity.txt"), `${identity}\n`);
}

export async function buildPayload(outDir, { root = ROOT, log = say, releaseIdentity = defaultReleaseIdentity(root) } = {}) {
  const out = resolve(outDir);
  const done = () => { writeReleaseIdentity(out, releaseIdentity); return out; };
  const tree = git("ls-tree", "-r", "HEAD", "--", ...BUILT_FROM);
  const key = payloadKey(tree);
  let cache = join(cacheRoot(), key);
  const dirty = spawnSync("git", ["-C", root, "diff", "--quiet", "HEAD", "--", ...BUILT_FROM]).status !== 0;
  if (dirty) {
    log("what the payload is built from has uncommitted changes: building them, not caching");
    cache = "";
  }
  if (cache && existsSync(join(cache, "VERSION"))) {
    log(`unchanged (${key}): reusing it`);
    await rm(out, { recursive: true, force: true });
    await mkdir(dirname(out), { recursive: true });
    await cp(cache, out, { recursive: true });
    return done();
  }

  const work = await mkdtemp(join(tmpdir(), "relo-server-payload-"));
  try {
    const payload = join(work, "payload");
    await mkdir(join(payload, "app", "server"), { recursive: true });
    await mkdir(join(payload, "app", "dashboard"), { recursive: true });

    // Node: the official build, checked against nodejs.org's SHASUMS256.
    const shasums = (await (await fetch(`https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt`, { signal: AbortSignal.timeout(120_000) })).text());
    const zip = join(work, `${NODE_FILE}.zip`);
    const zipBytes = await download(`https://nodejs.org/dist/v${NODE_VERSION}/${NODE_FILE}.zip`, zip);
    if (sha256(zipBytes) !== shasumFor(shasums, `${NODE_FILE}.zip`)) die("Node did not match its checksum");
    tar(["-xf", zip, "-C", work, `${NODE_FILE}/node.exe`, `${NODE_FILE}/LICENSE`]);
    await rename(join(work, NODE_FILE, "node.exe"), join(payload, "node.exe"));
    await rename(join(work, NODE_FILE, "LICENSE"), join(payload, "NODE-LICENSE"));

    // PostgreSQL: EnterpriseDB's build from the embedded-postgres package, checked against its registry integrity.
    const tgz = join(work, "pg.tgz");
    assertIntegrity(await download(POSTGRES_TARBALL, tgz), POSTGRES_INTEGRITY);
    await mkdir(join(work, "pg"));
    tar(["-xzf", tgz, "-C", join(work, "pg")]);
    await rename(join(work, "pg", "package", "native"), join(payload, "app", "postgres"));
    const pruned = await prunePostgres(join(payload, "app", "postgres"));
    log(`PostgreSQL pruned of ${pruned.length} entries`);
    writeFileSync(join(payload, "app", "postgres", "LICENSE"), postgresLicense(readFileSync(join(root, "scripts", "release", "mac-server-payload.sh"), "utf8")));

    // The server, the contracts it imports and the Dashboard, built from this checkout. A release builds from a fresh
    // clone with no node_modules: the workspace's dependencies come from the lockfile first.
    if (!existsSync(join(root, "apps", "server", "node_modules", "typescript")) || !existsSync(join(root, "packages", "contracts", "node_modules"))) {
      pnpm("--dir", root, "install", "--frozen-lockfile");
    }
    pnpm("--dir", root, "--filter", "@relo/notification-contracts", "build");
    pnpm("--dir", root, "--filter", "@relo/dashboard", "build");
    run(process.execPath, [join(root, "apps", "server", "node_modules", "typescript", "bin", "tsc"), "-p", join(root, "apps", "server", "tsconfig.json"), "--outDir", join(payload, "app", "server", "dist")]);
    await cp(join(root, "apps", "server", "migrations"), join(payload, "app", "server", "migrations"), { recursive: true });
    await cp(join(root, "apps", "server", "package.json"), join(payload, "app", "server", "package.json"));
    await cp(join(root, "apps", "dashboard", "dist"), join(payload, "app", "dashboard", "dist"), { recursive: true });

    // Production dependencies only, hoisted (plain node_modules), at the versions the workspace resolved.
    const deps = join(work, "deps");
    await mkdir(deps);
    const server = JSON.parse(readFileSync(join(root, "apps", "server", "package.json"), "utf8"));
    const wanted = { ...server.dependencies };
    delete wanted["@relo/notification-contracts"];
    const resolved = Object.fromEntries(Object.keys(wanted).map((name) =>
      [name, JSON.parse(readFileSync(join(root, "apps", "server", "node_modules", name, "package.json"), "utf8")).version]));
    writeFileSync(join(deps, "package.json"), JSON.stringify({ name: "relo-server-payload", private: true, dependencies: resolved }, null, 2));
    writeFileSync(join(deps, ".npmrc"), "node-linker=hoisted\nauto-install-peers=false\n");
    // Hoisted by flag: pnpm 11 ignores .npmrc for this, and a linked layout's Windows junctions are absolute, so they
    // would break the moment the folder moves.
    pnpm("--dir", deps, "install", "--prod", "--ignore-scripts", "--config.node-linker=hoisted", "--config.auto-install-peers=false");
    await rename(join(deps, "node_modules"), join(payload, "app", "server", "node_modules"));
    const contracts = join(payload, "app", "server", "node_modules", "@relo", "notification-contracts");
    await mkdir(contracts, { recursive: true });
    await cp(join(root, "packages", "contracts", "package.json"), join(contracts, "package.json"));
    await cp(join(root, "packages", "contracts", "dist"), join(contracts, "dist"), { recursive: true });
    writeFileSync(join(payload, "VERSION"), `${server.version}\n`);

    // The CLI: the tarball and manifest where the server serves it (dist/../cli), and an unpacked copy the app's
    // `relo` launcher runs (the CLI has no dependencies). The same steps as pack-cli.sh, without bash.
    const cliOut = join(payload, "app", "server", "cli");
    await mkdir(cliOut, { recursive: true });
    run(process.execPath, [join(root, "packages", "cli", "scripts", "bundle-skill.mjs")], { cwd: root });
    run("npm", ["pack", "--ignore-scripts", "--silent", "--pack-destination", cliOut], { cwd: join(root, "packages", "cli") });
    const packed = (await readdir(cliOut)).find((name) => /^relo-cli-.*\.tgz$/u.test(name));
    if (!packed) die("npm pack made no CLI tarball");
    await rename(join(cliOut, packed), join(cliOut, "relo-cli.tgz"));
    const cliVersion = JSON.parse(readFileSync(join(root, "packages", "cli", "package.json"), "utf8")).version;
    writeFileSync(join(cliOut, "manifest.json"), JSON.stringify({ version: cliVersion, sha256: sha256(await readFile(join(cliOut, "relo-cli.tgz"))) }));
    await mkdir(join(payload, "cli"));
    tar(["-xzf", join(cliOut, "relo-cli.tgz"), "-C", join(payload, "cli"), "--strip-components=1"]);

    // Smoke checks: the bundled Node runs the CLI and loads the server, and PostgreSQL runs.
    const node = join(payload, "node.exe");
    run(node, [join(payload, "cli", "bin", "relo.mjs"), "--version"], { stdio: ["ignore", "ignore", 2] });
    run(node, ["--input-type=module", "-e", `await import(${JSON.stringify(`file:///${join(payload, "app", "server", "dist", "app.js").replaceAll("\\", "/")}`)})`], { stdio: ["ignore", "ignore", 2] });
    run(join(payload, "app", "postgres", "bin", "postgres.exe"), ["--version"], { stdio: ["ignore", "ignore", 2] });

    if (cache) {
      await rm(dirname(cache), { recursive: true, force: true });
      await mkdir(dirname(cache), { recursive: true });
      await cp(payload, cache, { recursive: true });
    }
    await rm(out, { recursive: true, force: true });
    await mkdir(dirname(out), { recursive: true });
    await cp(payload, out, { recursive: true });
    log(`ready: server ${server.version}, release ${releaseIdentity}, Node ${NODE_VERSION}, PostgreSQL 17.10, in ${out}`);
    return done();
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}

// Real paths on both sides: a script started through a symlinked folder (macOS /var -> /private/var) still runs.
if (process.argv[1] && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url))) {
  const args = process.argv.slice(2);
  const flag = args.indexOf("--release-identity");
  const releaseIdentity = flag >= 0 ? args.splice(flag, 2)[1] : undefined;
  const out = args[0];
  if (!out || (flag >= 0 && !releaseIdentity)) {
    say("usage: windows-server-payload.mjs OUT_DIR [--release-identity X.Y.Z]");
    process.exit(2);
  }
  buildPayload(out, releaseIdentity ? { releaseIdentity } : {}).catch((error) => {
    say(error instanceof PayloadError ? error.message : error.stack);
    process.exit(1);
  });
}
