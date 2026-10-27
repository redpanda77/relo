// `relo update` and the doctor's "you are behind" signal. The source is the Relo server this CLI is signed in to
// when it hands out a CLI (`/cli/version` and `/cli/relo-cli.tgz`, the one its install script installs), else the
// GitHub Releases of the public repository, tagged `cli-v<version>`, each carrying `relo-cli-<version>.tgz` and
// `SHA256SUMS`. A CLI the install script installed (a launcher in ~/.local/bin naming ~/.local/share/relo/cli/<v>)
// is updated by unpacking the new version beside it and pointing the launcher at it; any other by npm.
// Nothing here runs by itself: `relo update` is the owner's command, and doctor only reads (and caches) the latest version.
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import { EXIT, ReloError, UsageError } from "../shared/errors.mjs";
import { renameWithRetry } from "../shared/atomic-write.mjs";
import { cmdLauncherText, parseCmdLauncher, shLauncherText, windowsPaths } from "./windows-launcher.mjs";
import { updateCheckDisabled } from "../shared/settings.mjs";
import { dataRoot } from "../work/state-file.mjs";

const RELEASES_URL = "https://api.github.com/repos/redpanda77/relo/releases";
const TAG_PREFIX = "cli-v";
const SUMS_NAME = "SHA256SUMS";
const tarballName = (version) => `relo-cli-${version}.tgz`;

const CHECK_TTL_MS = 24 * 60 * 60 * 1000;
const FAILURE_TTL_MS = 60 * 60 * 1000;
const MAX_TARBALL_BYTES = 20 * 1024 * 1024;
const MAX_SUMS_BYTES = 64 * 1024;
const API_TIMEOUT_MS = 15_000;
const DOWNLOAD_TIMEOUT_MS = 120_000;
const DOCTOR_TIMEOUT_MS = 2_000;
const VERSION_PATTERN = /^(\d+)\.(\d+)\.(\d+)$/u;

const dataDirectory = (home) => dataRoot(home);
/** Stored releases kept: the newest and the one --rollback goes back to. */
export const KEPT_RELEASES = 2;
const releasesDirectory = (home) => join(dataDirectory(home), "cli-releases");
const updateCheckPath = (home) => join(dataDirectory(home), "update-check.json");

function releasesBase(env = {}) {
  return String(env.RELO_RELEASES_URL || RELEASES_URL).replace(/\/+$/u, "");
}

const parts = (version) => VERSION_PATTERN.exec(version)?.slice(1).map(Number);

/** Negative, zero or positive, like a sort comparator; both must be plain x.y.z versions. */
export function compareVersions(a, b) {
  const left = parts(a);
  const right = parts(b);
  for (let index = 0; index < 3; index += 1) if (left[index] !== right[index]) return left[index] - right[index];
  return 0;
}

const isVersion = (value) => typeof value === "string" && VERSION_PATTERN.test(value);

/** `0.10.0`, `v0.10.0` and `cli-v0.10.0` all name the same release. */
function normalizeVersion(value) {
  const version = String(value).replace(/^cli-v/u, "").replace(/^v/u, "");
  if (!isVersion(version)) throw new UsageError(`--version must look like 0.10.0 (got ${value})`);
  return version;
}

const unreachable = (message) => new ReloError(message, {
  code: "RELEASES_UNREACHABLE", exitCode: EXIT.NETWORK,
  details: { hint: "Check the network; nothing was changed. Try again, or install the tarball by hand: see the CLI README." },
});

async function request(url, { fetchImpl, signal, version, accept }) {
  let response;
  try {
    response = await fetchImpl(url, { signal, redirect: "follow", headers: { accept, "user-agent": `relo-cli/${version}` } });
  } catch (error) {
    throw unreachable(error?.name === "TimeoutError" || error?.name === "AbortError"
      ? "The release server did not answer in time." : "Cannot reach the release server.");
  }
  if (response.status === 404) {
    throw new ReloError("No such release.", { code: "RELEASE_NOT_FOUND", details: { hint: "List versions at https://github.com/redpanda77/relo/releases (tags look like cli-v0.10.0)." } });
  }
  if (response.status === 403 || response.status === 429) {
    throw new ReloError("The release server is rate limiting this computer.", { code: "RELEASES_RATE_LIMITED", exitCode: EXIT.NETWORK, details: { hint: "Wait a few minutes, then run relo update again." } });
  }
  if (!response.ok) throw new ReloError(`The release server answered ${response.status}.`, { code: "RELEASES_ERROR", exitCode: EXIT.NETWORK, details: { hint: "Try again later; nothing was changed." } });
  return response;
}

async function readBounded(response, maximum, signal) {
  const declared = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(declared) && declared > maximum) throw new ReloError("The release asset is larger than expected.", { code: "RELEASE_ASSET_TOO_LARGE" });
  let buffer;
  try { buffer = Buffer.from(await response.arrayBuffer()); } catch {
    signal?.throwIfAborted?.();
    throw unreachable("The download was interrupted.");
  }
  if (buffer.length > maximum) throw new ReloError("The release asset is larger than expected.", { code: "RELEASE_ASSET_TOO_LARGE" });
  return buffer;
}

async function getJson(url, context) {
  const response = await request(url, { ...context, accept: "application/vnd.github+json" });
  try { return JSON.parse((await readBounded(response, 2 * 1024 * 1024, context.signal)).toString("utf8")); } catch (error) {
    if (error instanceof ReloError) throw error;
    throw new ReloError("The release server sent something that is not JSON.", { code: "RELEASES_ERROR", exitCode: EXIT.NETWORK });
  }
}

/**
 * The signed-in server's CLI as a release ({ version, tarballUrl, sha256, base, server }), or undefined when this
 * CLI is not signed in, RELO_RELEASES_URL names another source, or the server hands out no CLI.
 */
async function serverRelease({ dependencies, signal, cliVersion }) {
  if (dependencies.env?.RELO_RELEASES_URL) return undefined;
  let origin;
  try { origin = new URL((await dependencies.loadConfig(dependencies.configPath()))?.apiUrl).origin; } catch { return undefined; }
  let body;
  try {
    const response = await request(`${origin}/cli/version`, { fetchImpl: dependencies.releaseFetch ?? dependencies.fetchImpl, signal, version: cliVersion, accept: "application/json" });
    body = JSON.parse((await readBounded(response, 64 * 1024, signal)).toString("utf8"));
  } catch {
    return undefined;
  }
  if (!isVersion(body?.version) || !/^[0-9a-f]{64}$/u.test(body?.sha256 ?? "")) return undefined;
  return { version: body.version, tag: `v${body.version}`, tarballUrl: `${origin}/cli/relo-cli.tgz`, sha256: body.sha256, base: origin, server: true };
}

function describeRelease(release, base) {
  const tag = typeof release?.tag_name === "string" ? release.tag_name : "";
  if (!tag.startsWith(TAG_PREFIX) || !isVersion(tag.slice(TAG_PREFIX.length))) return undefined;
  if (release.draft === true || release.prerelease === true) return undefined;
  const version = tag.slice(TAG_PREFIX.length);
  const assets = Array.isArray(release.assets) ? release.assets : [];
  const url = (name) => assets.find((asset) => asset?.name === name)?.browser_download_url;
  return { version, tag, tarballUrl: url(tarballName(version)), sumsUrl: url(SUMS_NAME), base };
}

/**
 * The release for `version`, or the newest CLI release. The repository may carry other releases, so when
 * `latest` is not a cli-v tag the list is searched instead.
 */
async function resolveRelease({ env, fetchImpl, version, signal, cliVersion, dependencies }) {
  const fromServer = dependencies ? await serverRelease({ dependencies, signal, cliVersion }) : undefined;
  if (fromServer && (version === undefined || version === fromServer.version)) return fromServer;
  const base = releasesBase(env);
  const context = { fetchImpl, signal, version: cliVersion };
  if (version !== undefined) {
    const found = describeRelease(await getJson(`${base}/tags/${TAG_PREFIX}${version}`, context), base);
    if (!found || found.version !== version) throw new ReloError(`Release ${TAG_PREFIX}${version} is not a published CLI release.`, { code: "RELEASE_NOT_FOUND" });
    return found;
  }
  const latest = describeRelease(await getJson(`${base}/latest`, context).catch((error) => {
    if (error?.code === "RELEASE_NOT_FOUND") return {};
    throw error;
  }), base);
  if (latest) return latest;
  const listed = await getJson(`${base}?per_page=50`, context);
  const best = (Array.isArray(listed) ? listed : []).map((release) => describeRelease(release, base)).filter(Boolean)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  if (!best) throw new ReloError("No CLI release has been published yet.", { code: "RELEASE_NOT_FOUND" });
  return best;
}

export function parseSums(text) {
  const sums = new Map();
  for (const line of String(text).split(/\r?\n/u)) {
    const match = /^([0-9a-f]{64}) [ *](.+)$/u.exec(line.trim());
    if (match) sums.set(match[2].replace(/^\.\//u, ""), match[1]);
  }
  return sums;
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** Both assets may only come from the release server's own origin (or GitHub's, for the public default). */
function assertTrustedAsset(url, base) {
  let parsed;
  try { parsed = new URL(url); } catch { parsed = undefined; }
  const origin = new URL(base).origin;
  const github = parsed?.protocol === "https:" && ["github.com", "api.github.com"].includes(parsed.hostname);
  if (!parsed || (parsed.origin !== origin && !(base === RELEASES_URL && github))) {
    throw new ReloError("The release points at a download outside its own server.", { code: "RELEASE_ASSET_UNTRUSTED", details: { hint: "Nothing was downloaded. Report this to the release owner." } });
  }
}

/** Downloads a release into cli-releases/<version>/ and verifies it. A mismatch leaves nothing behind. */
async function stage({ release, home, fetchImpl, cliVersion, now }) {
  if (!release.tarballUrl || (!release.sumsUrl && !release.sha256)) {
    throw new ReloError(`Release ${release.tag} is missing ${tarballName(release.version)} or ${SUMS_NAME}.`, { code: "RELEASE_ASSETS_MISSING", details: { hint: "Nothing was changed. The release is incomplete; try an earlier one with --version." } });
  }
  assertTrustedAsset(release.tarballUrl, release.base);
  if (release.sumsUrl) assertTrustedAsset(release.sumsUrl, release.base);
  const root = releasesDirectory(home);
  const target = join(root, release.version);
  const partial = join(root, `.partial-${release.version}-${process.pid}-${now()}`);
  await mkdir(partial, { recursive: true, mode: 0o700 });
  try {
    const context = { fetchImpl, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), version: cliVersion, accept: "application/octet-stream" };
    // The server names its CLI's digest itself (/cli/version); a GitHub release carries SHA256SUMS.
    const expected = release.sha256
      ?? parseSums((await readBounded(await request(release.sumsUrl, context), MAX_SUMS_BYTES, context.signal)).toString("utf8")).get(tarballName(release.version));
    if (!expected) throw new ReloError(`${SUMS_NAME} has no entry for ${tarballName(release.version)}.`, { code: "CHECKSUM_MISSING", details: { hint: "Nothing was installed. The release is incomplete." } });
    const tarball = await readBounded(await request(release.tarballUrl, context), MAX_TARBALL_BYTES, context.signal);
    const actual = sha256(tarball);
    if (actual !== expected) {
      throw new ReloError("The downloaded tarball does not match SHA256SUMS.", {
        code: "CHECKSUM_MISMATCH", details: { hint: "Nothing was installed. Try again; if it repeats, do not install it and tell the release owner.", expected, actual },
      });
    }
    await writeFile(join(partial, tarballName(release.version)), tarball, { mode: 0o600 });
    await writeFile(join(partial, SUMS_NAME), `${expected}  ${tarballName(release.version)}\n`, { mode: 0o600 });
    await rm(target, { recursive: true, force: true });
    await rename(partial, target);
  } catch (error) {
    await rm(partial, { recursive: true, force: true });
    throw error;
  }
  // The new release and the one before it (relo update --rollback) stay; older ones only took space.
  for (const version of (await storedVersions(home)).sort((a, b) => compareVersions(b, a)).slice(KEPT_RELEASES)) {
    if (version !== cliVersion) await rm(join(root, version), { recursive: true, force: true });
  }
  return join(target, tarballName(release.version));
}

/** The stored tarball for `version` if it still matches its stored checksum; otherwise undefined. */
async function storedTarball(home, version) {
  const directory = join(releasesDirectory(home), version);
  try {
    const expected = parseSums(await readFile(join(directory, SUMS_NAME), "utf8")).get(tarballName(version));
    const path = join(directory, tarballName(version));
    return expected && sha256(await readFile(path)) === expected ? path : undefined;
  } catch { return undefined; }
}

async function storedVersions(home) {
  try { return (await readdir(releasesDirectory(home))).filter(isVersion); } catch { return []; }
}

/** Spawns `npm`, never through a shell on POSIX. Injectable as dependencies.runNpm for tests. */
function spawnNpm(args, { env = process.env, platform = process.platform } = {}) {
  return new Promise((resolve) => {
    execFile(platform === "win32" ? "npm.cmd" : "npm", args, {
      env: { ...process.env, ...env }, timeout: 180_000, maxBuffer: 1024 * 1024, shell: platform === "win32",
    }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout: String(stdout ?? ""), stderr: String(stderr || error?.message || ""),
        missing: error?.code === "ENOENT" });
    });
  });
}

/** The install script's launcher this CLI runs behind ({ path, node }), or undefined (an npm install, a checkout). */
async function launcherInstall(dependencies) {
  const { home, entrypoint } = dependencies;
  if (isWindows(dependencies)) {
    const paths = windowsPaths({ home, env: dependencies.env });
    if (!entrypoint || !resolve(entrypoint).toLowerCase().startsWith(`${resolve(paths.cli).toLowerCase()}${sep}`)) return undefined;
    try {
      const parsed = parseCmdLauncher(await readFile(paths.cmd, "utf8"));
      // A relo.cmd the Windows app wrote is the app's to update; this path only follows its own.
      return parsed && !parsed.managed && parsed.node && parsed.entry ? { path: paths.cmd, node: parsed.node, windows: paths } : undefined;
    } catch {
      return undefined;
    }
  }
  const root = resolve(join(dataRoot(home), "cli"));
  if (!entrypoint || !resolve(entrypoint).startsWith(`${root}${sep}`)) return undefined;
  const path = join(home, ".local", "bin", "relo");
  try {
    const text = await readFile(path, "utf8");
    const node = /^exec "([^"]+)" /mu.exec(text)?.[1];
    return text.includes("# relo launcher: ") && node ? { path, node } : undefined;
  } catch {
    return undefined;
  }
}

const isWindows = (dependencies) => (dependencies.platform ?? process.platform) === "win32";

async function replaceWindowsFile(path, contents) {
  const next = `${path}.${process.pid}.tmp`;
  await writeFile(next, contents);
  try { await renameWithRetry(next, path, { platform: "win32" }); } catch (error) { await rm(next, { force: true }).catch(() => {}); throw error; }
}

/** Unpacks a verified tarball beside the running version and points the launcher at it (no npm, no PATH). */
async function installBehindLauncher(tarball, version, launcher, dependencies) {
  const target = launcher.windows ? join(launcher.windows.cli, version) : join(dataRoot(dependencies.home), "cli", version);
  const partial = `${target}.partial-${process.pid}`;
  await rm(partial, { recursive: true, force: true });
  await mkdir(partial, { recursive: true });
  // On Windows the system's bsdtar by full path: GNU tar (Git for Windows, often first on PATH) reads "C:" in -f as a
  // remote host and mangles -C. The tarball stays relative to its folder all the same.
  const tar = process.platform === "win32" ? join(process.env.SystemRoot || "C:\\Windows", "System32", "tar.exe") : "tar";
  const untar = dependencies.runTar ?? ((args) => new Promise((done) => execFile(tar, args, { cwd: dirname(tarball), windowsHide: true }, (error) => done({ code: error ? 1 : 0 }))));
  if ((await untar(["-xzf", basename(tarball), "-C", partial, "--strip-components=1"]))?.code !== 0) {
    await rm(partial, { recursive: true, force: true });
    throw new ReloError("The update could not be unpacked.", { code: "UPDATE_INSTALL_FAILED", details: { hint: "Relo is unchanged; try again." } });
  }
  await rm(target, { recursive: true, force: true });
  await (launcher.windows ? renameWithRetry(partial, target, { platform: "win32" }) : rename(partial, target));
  const entry = join(target, "bin", "relo.mjs");
  if (launcher.windows) {
    // relo.cmd (and the Git Bash sibling, when there is one) swap in through a temp name; no chmod on Windows.
    const sibling = await readFile(launcher.windows.sh, "utf8").then(() => true, () => false);
    await replaceWindowsFile(launcher.path, cmdLauncherText(launcher.node, entry));
    if (sibling) await replaceWindowsFile(launcher.windows.sh, shLauncherText(launcher.node, entry));
    return;
  }
  const next = `${launcher.path}.${process.pid}.tmp`;
  await writeFile(next, `#!/bin/sh\n# relo launcher: ${entry}\nexec "${launcher.node}" "${entry}" "$@"\n`);
  await chmod(next, 0o755);
  await rename(next, launcher.path);
}

async function install(tarball, dependencies, version) {
  const launcher = await launcherInstall(dependencies);
  if (launcher && version) return installBehindLauncher(tarball, version, launcher, dependencies);
  const run = dependencies.runNpm ?? ((args) => spawnNpm(args, { env: dependencies.env, platform: dependencies.platform }));
  const outcome = await run(["install", "--global", tarball]);
  if (outcome?.code === 0) return;
  const tail = String(outcome?.stderr ?? "").trim().split("\n").slice(-3).join(" ").slice(0, 300);
  const permission = /EACCES|EPERM/u.test(tail);
  throw new ReloError(outcome?.missing ? "npm was not found." : `npm could not install the update${tail ? `: ${tail}` : "."}`, {
    code: "UPDATE_INSTALL_FAILED",
    details: { hint: permission
      ? `Relo is unchanged. npm cannot write its global folder: use a user-owned prefix (npm config set prefix ~/.local), then: npm install --global ${tarball}`
      : `Relo is unchanged. To retry by hand: npm install --global ${tarball}` },
  });
}

/**
 * After an install, the new CLI brings what relo setup wrote up to itself: `relo setup --refresh`, run by the
 * relo npm just installed (in npm's global prefix, which need not be the first relo on PATH). Injectable as
 * dependencies.runRefresh. A failure never undoes the update: the result says to run it by hand.
 */
async function refreshWithNewCli(dependencies) {
  if (dependencies.runRefresh) return dependencies.runRefresh();
  const launcher = await launcherInstall(dependencies);
  let binary = launcher?.path;
  if (!binary) {
    const npm = dependencies.runNpm ?? ((args) => spawnNpm(args, { env: dependencies.env, platform: dependencies.platform }));
    const prefix = String((await npm(["prefix", "--global"]))?.stdout ?? "").trim();
    if (!prefix) return undefined;
    binary = dependencies.platform === "win32" ? join(prefix, "relo.cmd") : join(prefix, "bin", "relo");
  }
  return new Promise((resolve) => {
    execFile(binary, ["setup", "--refresh", "--json"], {
      env: { ...process.env, ...dependencies.env }, timeout: 60_000, maxBuffer: 1024 * 1024, shell: isWindows(dependencies),
    }, (error, stdout) => {
      try { resolve(error ? undefined : JSON.parse(String(stdout).trim().split("\n").at(-1))); } catch { resolve(undefined); }
    });
  });
}

async function refreshed(dependencies, notes) {
  const outcome = await refreshWithNewCli(dependencies).catch(() => undefined);
  if (outcome?.ok !== true) {
    notes.push("the new CLI could not refresh what relo setup installed: run relo setup --refresh");
    return undefined;
  }
  return (outcome.changed ?? outcome.data?.changed ?? []).map(({ kind, harness, file, action }) => ({ kind, ...(harness ? { harness } : {}), file, action }));
}

/** `relo update [--check] [--rollback] [--version X] [--dry-run]`: { data, notes }. */
export async function runUpdate(options, dependencies) {
  const { home, env, version: current, fetchImpl } = dependencies;
  const now = dependencies.now;
  if (options.rollback && (options.check || options.version !== undefined)) {
    throw new UsageError("--rollback cannot be combined with --check or --version");
  }
  const dryRun = Boolean(options["dry-run"]);

  if (options.rollback) {
    const candidates = [];
    for (const version of (await storedVersions(home)).filter((candidate) => compareVersions(candidate, current) < 0)
      .sort((a, b) => compareVersions(b, a))) {
      const tarball = await storedTarball(home, version);
      if (tarball) candidates.push({ version, tarball });
    }
    const previous = candidates[0];
    if (!previous) {
      throw new ReloError(`No verified earlier release is stored on this computer (older than ${current}).`, {
        code: "NO_PREVIOUS_RELEASE", details: { hint: "relo update --version X installs a specific release; stored releases live in ~/.local/share/relo/cli-releases/." },
      });
    }
    if (dryRun) return { data: { ok: true, from: current, to: previous.version, rollback: true, dryRun: true }, notes: [] };
    await install(previous.tarball, dependencies, previous.version);
    const notes = [];
    const changes = await refreshed(dependencies, notes);
    return { data: { ok: true, from: current, to: previous.version, rollback: true, verified: true, ...(changes ? { refreshed: changes } : {}) }, notes };
  }

  const wanted = options.version === undefined ? undefined : normalizeVersion(options.version);
  const release = await resolveRelease({ env, fetchImpl, version: wanted, signal: AbortSignal.timeout(API_TIMEOUT_MS), cliVersion: current, dependencies });
  const available = compareVersions(release.version, current) > 0;
  if (options.check) return { data: { ok: true, current, latest: release.version, updateAvailable: available }, notes: [] };
  if (wanted === undefined ? !available : release.version === current) {
    return { data: { ok: true, current, latest: release.version, updateAvailable: false }, notes: [] };
  }
  if (dryRun) return { data: { ok: true, from: current, to: release.version, dryRun: true }, notes: [] };

  const tarball = await stage({ release, home, fetchImpl, cliVersion: current, now });
  const notes = [];
  // Keep what is installed now so --rollback has something to restore; failing to store it never blocks the update.
  if (isVersion(current) && !await storedTarball(home, current)) {
    try {
      await stage({ release: await resolveRelease({ env, fetchImpl, version: current, signal: AbortSignal.timeout(API_TIMEOUT_MS), cliVersion: current, dependencies }),
        home, fetchImpl, cliVersion: current, now });
    } catch { notes.push(`${current} could not be stored, so --rollback will not have it`); }
  }
  await install(tarball, dependencies, release.version);
  const changes = await refreshed(dependencies, notes);
  return { data: { ok: true, from: current, to: release.version, verified: true, ...(release.server ? { source: release.base } : {}), ...(changes ? { refreshed: changes } : {}) }, notes };
}

async function readCache(home, base, now) {
  try {
    const cache = JSON.parse(await readFile(updateCheckPath(home), "utf8"));
    const age = now - cache.checkedAt;
    if (cache.source !== base || !Number.isFinite(age) || age < 0) return undefined;
    if (cache.latest === null ? age < FAILURE_TTL_MS : isVersion(cache.latest) && age < CHECK_TTL_MS) return cache;
  } catch { /* no cache, or unreadable: ask again */ }
  return undefined;
}

async function writeCache(home, cache) {
  try {
    const path = updateCheckPath(home);
    await mkdir(dataDirectory(home), { recursive: true, mode: 0o700 });
    const partial = `${path}.${process.pid}.tmp`;
    await writeFile(partial, `${JSON.stringify(cache)}\n`, { mode: 0o600 });
    await rename(partial, path);
  } catch { /* a cache that cannot be written is only a missed optimization */ }
}

/** { ok, state: "behind"|"current", latest, hint?, run? } for a known latest version, else undefined. */
function adviceFor(latest, current) {
  if (latest === null) return undefined;
  return compareVersions(latest, current) > 0
    ? { ok: false, state: "behind", latest, hint: "relo update", run: "relo update" }
    : { ok: true, state: "current", latest };
}

/**
 * The same advice from the 24 h cache alone: never a network call, never a write. For the machine report,
 * which must not wait on GitHub. Undefined when opted out or nothing is cached.
 */
export async function cachedUpdateAdvice(dependencies) {
  const { env, home, version: current } = dependencies;
  if (updateCheckDisabled(env) || !isVersion(current)) return undefined;
  const cached = await readCache(home, releasesBase(env), dependencies.now());
  return cached ? adviceFor(cached.latest, current) : undefined;
}

/**
 * For doctor: undefined when there is nothing to say (opted out, offline, unreachable), else
 * { ok, state: "behind"|"current", latest, hint?, run? }. The cache file is the only thing it writes.
 */
export async function updateAdvice(dependencies) {
  const { env, home, version: current, releaseFetch } = dependencies;
  if (!releaseFetch || updateCheckDisabled(env)) return undefined;
  if (!isVersion(current)) return undefined;
  const base = releasesBase(env);
  const now = dependencies.now();
  let cached = await readCache(home, base, now);
  if (!cached) {
    try {
      const release = await resolveRelease({ env, fetchImpl: releaseFetch, signal: AbortSignal.timeout(DOCTOR_TIMEOUT_MS), cliVersion: current, dependencies });
      cached = { checkedAt: now, source: base, latest: release.version };
    } catch {
      cached = { checkedAt: now, source: base, latest: null };
    }
    await writeCache(home, cached);
  }
  return adviceFor(cached.latest, current);
}
