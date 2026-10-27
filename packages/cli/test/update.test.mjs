import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";
import { VERSION } from "../src/version.mjs";
import { compareVersions, parseSums } from "../src/owner/releases.mjs";
import { dataRoot } from "../src/work/state-file.mjs";
import { cmdLauncherText, shLauncherText, windowsPaths } from "../src/owner/windows-launcher.mjs";
import { cardDependencies, fakeHome } from "./fake-cards.mjs";

const PREFIX = "/repos/redpanda77/relo/releases";
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** A local stand-in for the GitHub Releases API plus asset downloads. Nothing here touches the network. */
async function releaseServer({ releases, latestTag, corrupt = [], foreign = false, listOnly = false } = {}) {
  const requests = [];
  let origin = "";
  const json = (release) => ({
    tag_name: release.tag ?? `cli-v${release.version}`, draft: false, prerelease: false,
    assets: [`relo-cli-${release.version}.tgz`, "SHA256SUMS"].map((name) => ({
      name, browser_download_url: `${foreign ? "http://203.0.113.9:1" : origin}/dl/${release.version}/${name}`,
    })),
  });
  const server = createServer((request, response) => {
    requests.push(request.url);
    const send = (status, body, type = "application/json") => { response.writeHead(status, { "content-type": type }); response.end(body); };
    const url = new URL(request.url, "http://x");
    const byVersion = (version) => releases.find((release) => release.version === version);
    if (url.pathname === `${PREFIX}/latest`) {
      if (listOnly) return send(200, JSON.stringify({ tag_name: "site-v2", assets: [] }));
      const pick = latestTag ? releases.find((release) => (release.tag ?? `cli-v${release.version}`) === latestTag) : releases.at(-1);
      return pick ? send(200, JSON.stringify(json(pick))) : send(404, "{}");
    }
    if (url.pathname.startsWith(`${PREFIX}/tags/cli-v`)) {
      const found = byVersion(url.pathname.slice(`${PREFIX}/tags/cli-v`.length));
      return found ? send(200, JSON.stringify(json(found))) : send(404, "{}");
    }
    if (url.pathname === PREFIX) return send(200, JSON.stringify([{ tag_name: "site-v2", assets: [] }, ...releases.map(json)]));
    const asset = /^\/dl\/([^/]+)\/(.+)$/u.exec(url.pathname);
    if (asset) {
      const release = byVersion(asset[1]);
      if (!release) return send(404, "{}");
      if (asset[2] === "SHA256SUMS") return send(200, `${sha(release.bytes)}  relo-cli-${release.version}.tgz\n`, "text/plain");
      return send(200, corrupt.includes(release.version) ? Buffer.from("tampered") : release.bytes, "application/octet-stream");
    }
    return send(404, "{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  test.after(() => server.close());
  return { url: `${origin}${PREFIX}`, requests, downloads: () => requests.filter((path) => path.startsWith("/dl/")) };
}

const release = (version, content = `tarball ${version}`) => ({ version, bytes: Buffer.from(content) });
const NEWER = "9.9.9";

async function box({ server, version = VERSION, npmCode = 0, env = {} } = {}) {
  const home = await mkdtemp(join(tmpdir(), "relo-update-"));
  const npmCalls = [];
  const refreshes = [];
  const overrides = {
    home, version, env: { RELO_RELEASES_URL: server?.url, ...env },
    runNpm: async (args) => { npmCalls.push(args); return { code: npmCode, stderr: npmCode ? "EACCES: permission denied, mkdir '/usr/lib/node_modules'" : "" }; },
    // The new CLI's relo setup --refresh: one block brought up to date.
    runRefresh: async () => { refreshes.push(true); return { ok: true, changed: [{ kind: "block", harness: "claude-code", file: "~/.claude/CLAUDE.md", action: "updated" }] }; },
  };
  return {
    home, npmCalls, refreshes, overrides,
    async cli(argv, extra = {}) {
      const stdout = [];
      const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, { ...overrides, ...extra });
      return { exitCode, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
    },
    stored: () => readdir(join(dataRoot(home), "cli-releases")).catch(() => []),
  };
}

test("versions compare numerically and SHA256SUMS parses both text and binary lines", () => {
  assert.ok(compareVersions("0.9.10", "0.9.9") > 0);
  assert.ok(compareVersions("0.9.8", "0.9.8") === 0);
  assert.ok(compareVersions("1.0.0", "0.99.99") > 0);
  const sums = parseSums(`${"a".repeat(64)}  one.tgz\n${"b".repeat(64)} *two.tgz\nnot a line\n`);
  assert.equal(sums.get("one.tgz"), "a".repeat(64));
  assert.equal(sums.get("two.tgz"), "b".repeat(64));
});

test("update --check reports behind or current and installs nothing", async () => {
  const server = await releaseServer({ releases: [release(VERSION), release(NEWER)] });
  const b = await box({ server });
  const behind = await b.cli(["update", "--check"]);
  assert.equal(behind.exitCode, 0);
  assert.deepEqual(behind.line, { ok: true, current: VERSION, latest: NEWER, updateAvailable: true });
  assert.deepEqual(b.npmCalls, []);
  assert.deepEqual(server.downloads(), []);
  assert.deepEqual(await b.stored(), []);

  const current = await box({ server, version: NEWER });
  assert.deepEqual((await current.cli(["update", "--check"])).line, { ok: true, current: NEWER, latest: NEWER, updateAvailable: false });
  assert.deepEqual((await current.cli(["update"])).line, { ok: true, current: NEWER, latest: NEWER, updateAvailable: false });
  assert.deepEqual(current.npmCalls, []);
});

test("update downloads, verifies the checksum, installs the stored tarball and keeps the old release for rollback", async () => {
  const server = await releaseServer({ releases: [release(VERSION), release(NEWER)] });
  const b = await box({ server });
  const updated = await b.cli(["update"]);
  assert.equal(updated.exitCode, 0);
  assert.deepEqual(updated.line, { ok: true, from: VERSION, to: NEWER, verified: true, refreshed: [{ kind: "block", harness: "claude-code", file: "~/.claude/CLAUDE.md", action: "updated" }] });
  const tarball = join(dataRoot(b.home), "cli-releases", NEWER, `relo-cli-${NEWER}.tgz`);
  assert.deepEqual(b.npmCalls, [["install", "--global", tarball]]);
  assert.equal(sha(await readFile(tarball)), sha(Buffer.from(`tarball ${NEWER}`)));
  assert.match(await readFile(join(dataRoot(b.home), "cli-releases", NEWER, "SHA256SUMS"), "utf8"), /^[0-9a-f]{64} {2}relo-cli-9\.9\.9\.tgz\n$/u);
  assert.deepEqual((await b.stored()).sort(), [VERSION, NEWER].sort(), "the installed release is stored too, and no partial folder is left");
});

test("update keeps only the new release and the one before it (no pile of old tarballs)", async () => {
  const server = await releaseServer({ releases: [release(VERSION), release(NEWER)] });
  const b = await box({ server });
  for (const old of ["0.0.1", "0.0.2", "0.0.3"]) await mkdir(join(dataRoot(b.home), "cli-releases", old), { recursive: true });
  assert.equal((await b.cli(["update"])).exitCode, 0);
  assert.deepEqual((await b.stored()).sort(), [VERSION, NEWER].sort());
});

test("rollback reinstalls the previous stored release after re-verifying it", async () => {
  const server = await releaseServer({ releases: [release(VERSION), release(NEWER)] });
  const b = await box({ server });
  await b.cli(["update"]);
  b.npmCalls.length = 0;
  const rolled = await b.cli(["update", "--rollback"], { version: NEWER });
  assert.deepEqual(rolled.line, { ok: true, from: NEWER, to: VERSION, rollback: true, verified: true, refreshed: [{ kind: "block", harness: "claude-code", file: "~/.claude/CLAUDE.md", action: "updated" }] });
  assert.deepEqual(b.npmCalls, [["install", "--global", join(dataRoot(b.home), "cli-releases", VERSION, `relo-cli-${VERSION}.tgz`)]]);

  // A stored tarball that no longer matches its checksum is never installed.
  b.npmCalls.length = 0;
  await writeFile(join(dataRoot(b.home), "cli-releases", VERSION, `relo-cli-${VERSION}.tgz`), "tampered");
  const refused = await b.cli(["update", "--rollback"], { version: NEWER });
  assert.equal(refused.exitCode, 1);
  assert.equal(refused.line.error.code, "NO_PREVIOUS_RELEASE");
  assert.deepEqual(b.npmCalls, []);
});

test("rollback with nothing stored explains itself, and conflicting flags are a usage error", async () => {
  const b = await box({ server: await releaseServer({ releases: [release(VERSION)] }) });
  const none = await b.cli(["update", "--rollback"]);
  assert.equal(none.line.error.code, "NO_PREVIOUS_RELEASE");
  assert.ok(none.line.error.hint);
  const conflict = await b.cli(["update", "--rollback", "--check"]);
  assert.equal(conflict.exitCode, 2);
});

test("a checksum mismatch installs nothing and leaves nothing behind", async () => {
  const server = await releaseServer({ releases: [release(VERSION), release(NEWER)], corrupt: [NEWER] });
  const b = await box({ server });
  const failed = await b.cli(["update"]);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.line.error.code, "CHECKSUM_MISMATCH");
  assert.match(failed.line.error.hint, /Nothing was installed/u);
  assert.deepEqual(b.npmCalls, []);
  assert.deepEqual(await b.stored(), []);
});

test("--dry-run resolves the release but downloads and installs nothing", async () => {
  const server = await releaseServer({ releases: [release(VERSION), release(NEWER)] });
  const b = await box({ server });
  assert.deepEqual((await b.cli(["update", "--dry-run"])).line, { ok: true, from: VERSION, to: NEWER, dryRun: true });
  assert.deepEqual(server.downloads(), []);
  assert.deepEqual(b.npmCalls, []);
  assert.deepEqual(await b.stored(), []);
});

test("--version picks a release (v and cli-v prefixes work), and the version flag still prints the version", async () => {
  const server = await releaseServer({ releases: [release("0.9.0"), release(VERSION), release(NEWER)] });
  const b = await box({ server });
  const picked = await b.cli(["update", "--version", "cli-v0.9.0"]);
  assert.deepEqual(picked.line, { ok: true, from: VERSION, to: "0.9.0", verified: true, refreshed: [{ kind: "block", harness: "claude-code", file: "~/.claude/CLAUDE.md", action: "updated" }] });
  // The refresh never undoes the update: when it fails, the line says to run it by hand.
  const unrefreshed = await b.cli(["update", "--version", "0.9.0"], { runRefresh: async () => undefined });
  assert.match(unrefreshed.line.note ?? "", /run relo setup --refresh/u);
  assert.equal((await b.cli(["update", "--version", "v1.2.3"])).line.error.code, "RELEASE_NOT_FOUND");
  assert.equal((await b.cli(["update", "--version", "latest"])).exitCode, 2);
  const stdout = [];
  await run(["--version"], { stdout: (line) => stdout.push(line), stderr: () => {} }, { home: b.home });
  assert.equal(stdout[0], VERSION);
});

test("an npm failure leaves Relo unchanged and says how to retry; an unreachable server is exit 6", async () => {
  const server = await releaseServer({ releases: [release(VERSION), release(NEWER)] });
  const failing = await box({ server, npmCode: 1 });
  const failed = await failing.cli(["update"]);
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.line.error.code, "UPDATE_INSTALL_FAILED");
  assert.match(failed.line.error.hint, /Relo is unchanged/u);

  const offline = await box({ env: { RELO_RELEASES_URL: "http://127.0.0.1:9/repos/redpanda77/relo/releases" } });
  const unreachable = await offline.cli(["update", "--check"]);
  assert.equal(unreachable.exitCode, 6);
  assert.equal(unreachable.line.error.code, "RELEASES_UNREACHABLE");
  assert.ok(unreachable.line.error.hint);
});

test("when latest is not a CLI release the newest cli-v release is used, and foreign download hosts are refused", async () => {
  const listed = await releaseServer({ releases: [release(VERSION), release(NEWER)], listOnly: true });
  assert.equal((await (await box({ server: listed })).cli(["update", "--check"])).line.latest, NEWER);

  const foreign = await releaseServer({ releases: [release(VERSION), release(NEWER)], foreign: true });
  const b = await box({ server: foreign });
  const refused = await b.cli(["update"]);
  assert.equal(refused.line.error.code, "RELEASE_ASSET_UNTRUSTED");
  assert.deepEqual(b.npmCalls, []);
});

// ---- doctor: the update warning --------------------------------------------------------------

async function doctorDeps({ server, env = {}, now, fetchImpl } = {}) {
  const home = await fakeHome({ skillVersion: VERSION });
  const client = {
    ready: async () => ({ ready: true }),
    authStatus: async () => ({ authenticated: true, credential: { id: "c", clientName: "Studio", prefix: "p", expiresAt: "2027-01-01T00:00:00Z",
      scopes: ["activities:read", "activities:write", "devices:read", "interactions:create", "interactions:read", "notifications:send"] } }),
    doctor: async () => ({ version: 1, ok: true }),
    listDevices: async () => ({ hasMore: false, cursor: null, devices: [{ deviceId: "dev_abcdefghijkl", liveActivityAuthorization: "authorized" }] }),
  };
  const base = cardDependencies(client, { env: { RELO_RELEASES_URL: server.url, ...env } });
  return { home, deps: { ...base, home, releaseFetch: fetchImpl ?? fetch, ...(now ? { now } : {}),
    loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), phoneTest: { deviceId: "dev_abcdefghijkl" } }),
    pendingLogin: { read: async () => null } } };
}

const doctor = async (deps) => {
  const stdout = [];
  const exitCode = await run(["doctor"], { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, deps);
  return { exitCode, line: JSON.parse(stdout[0]) };
};
const cachePath = (home) => join(dataRoot(home), "update-check.json");

test("doctor shows warnings.update when behind, caches for 24 hours, and never changes ready", async () => {
  const server = await releaseServer({ releases: [release(VERSION), release(NEWER)] });
  let clock = Date.UTC(2026, 9, 13, 10, 0, 0);
  const { home, deps } = await doctorDeps({ server, now: () => clock });
  const first = await doctor(deps);
  assert.equal(first.exitCode, 0);
  assert.equal(first.line.ok, true);
  assert.equal(first.line.ready, true);
  assert.deepEqual(first.line.warnings, { update: { state: "behind", latest: NEWER, hint: "relo update" } });
  assert.equal(server.requests.length, 1);
  assert.equal(JSON.parse(await readFile(cachePath(home), "utf8")).latest, NEWER);

  clock += 23 * 3600_000;
  await doctor(deps);
  assert.equal(server.requests.length, 1, "served from the cache inside 24 hours");
  clock += 2 * 3600_000;
  await doctor(deps);
  assert.equal(server.requests.length, 2, "asked again after 24 hours");

  const quiet = await doctorDeps({ server, env: { RELO_NO_UPDATE_CHECK: "1" } });
  const optedOut = await doctor(quiet.deps);
  assert.equal(optedOut.line.ready, first.line.ready);
  assert.equal(optedOut.line.warnings, undefined);
});

test("doctor is silent when up to date, opted out, offline or the release server fails, and writes nothing else", async () => {
  const server = await releaseServer({ releases: [release(VERSION)] });
  const current = await doctorDeps({ server });
  assert.equal((await doctor(current.deps)).line.warnings, undefined);

  const behind = await releaseServer({ releases: [release(VERSION), release(NEWER)] });
  const out = await doctorDeps({ server: behind, env: { RELO_NO_UPDATE_CHECK: "1" } });
  await doctor(out.deps);
  assert.equal(behind.requests.length, 0, "no request at all when opted out");
  assert.equal(existsSync(cachePath(out.home)), false, "and no cache file");
  assert.equal(existsSync(join(dataRoot(out.home), "cli-releases")), false);

  const failing = await doctorDeps({ server: behind, fetchImpl: async () => { throw new TypeError("fetch failed"); } });
  const down = await doctor(failing.deps);
  assert.equal(down.exitCode, 0);
  assert.equal(down.line.ready, true);
  assert.equal(down.line.warnings, undefined);
  assert.equal(JSON.parse(await readFile(cachePath(failing.home), "utf8")).latest, null, "failure is remembered briefly, so doctor stays fast offline");

  const noNetwork = await doctorDeps({ server: behind, fetchImpl: undefined });
  noNetwork.deps.releaseFetch = undefined;
  assert.equal((await doctor(noNetwork.deps)).line.warnings, undefined);
});

test("doctor skips the update check when the Relo server is unreachable", async () => {
  const server = await releaseServer({ releases: [release(VERSION), release(NEWER)] });
  const { home, deps } = await doctorDeps({ server });
  const offline = { ...deps, clientFactory: () => ({ ready: async () => { throw new TypeError("fetch failed"); } }) };
  await doctor(offline);
  assert.equal(server.requests.length, 0);
  assert.equal(existsSync(cachePath(home)), false);
});

// ---- the whole path with a real npm, in a temp prefix ----------------------------------------

const PACKAGE_ROOT = new URL("..", import.meta.url);

const WIN = process.platform === "win32";
const NPM = WIN ? "npm.cmd" : "npm";

async function packedVersion(temp, version) {
  const root = join(temp, `source-${version}`);
  await cp(PACKAGE_ROOT, root, { recursive: true, filter: (path) => !path.includes("node_modules") });
  const edit = async (path, change) => {
    const file = join(root, path);
    await writeFile(file, change(await readFile(file, "utf8")));
  };
  await edit("package.json", (text) => text.replace(/"version": "[^"]+"/u, `"version": "${version}"`));
  await edit("src/version.mjs", (text) => text.replace(/export const VERSION = "[^"]+";/u, `export const VERSION = "${version}";`));
  await edit("skill/package.json", (text) => text.replace(/"version": "[^"]+"/u, `"version": "${version}"`).replace(/"@relo\/cli": "[^"]+"/u, `"@relo/cli": "${version}"`));
  const env = { ...process.env, npm_config_cache: join(temp, "npm-cache"), npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
  const [packed] = JSON.parse(execFileSync(NPM, ["pack", "--json", "--pack-destination", temp], { cwd: root, env, encoding: "utf8", shell: WIN }));
  return { bytes: await readFile(join(temp, packed.filename)), file: join(temp, packed.filename) };
}

test("end to end in a temp prefix: install the old release, update with a verified checksum, roll back", async () => {
  const temp = await mkdtemp(join(tmpdir(), "relo-update-e2e-"));
  const [oldRelease, newRelease] = [await packedVersion(temp, "0.9.1"), await packedVersion(temp, "0.9.2")];
  const server = await releaseServer({ releases: [{ version: "0.9.1", bytes: oldRelease.bytes }, { version: "0.9.2", bytes: newRelease.bytes }] });
  const prefix = join(temp, "prefix");
  const home = join(temp, "home");
  await mkdir(home, { recursive: true });
  const env = { ...process.env, HOME: home, npm_config_prefix: prefix, npm_config_cache: join(temp, "npm-cache"), npm_config_audit: "false",
    npm_config_fund: "false", npm_config_update_notifier: "false", RELO_RELEASES_URL: server.url, RELO_NO_UPDATE_CHECK: "1" };
  // Async: the fake release server lives in this process, so a blocking spawn would starve it.
  // npm --global puts the shim at prefix\relo.cmd on Windows (a .cmd runs only through a shell), prefix/bin/relo elsewhere.
  const relo = async (...args) => (await promisify(execFile)(WIN ? join(prefix, "relo.cmd") : join(prefix, "bin", "relo"), args, { env, encoding: "utf8", shell: WIN })).stdout.trim();
  execFileSync(NPM, ["install", "--global", oldRelease.file], { env, encoding: "utf8", shell: WIN });
  assert.equal(await relo("--version"), "0.9.1");
  assert.deepEqual(JSON.parse(await relo("update", "--check")), { ok: true, current: "0.9.1", latest: "0.9.2", updateAvailable: true });
  assert.deepEqual(JSON.parse(await relo("update")), { ok: true, from: "0.9.1", to: "0.9.2", verified: true, refreshed: [] },
    "the new CLI ran its own relo setup --refresh (nothing installed in this home)");
  assert.equal(await relo("--version"), "0.9.2");
  assert.deepEqual(JSON.parse(await relo("update")), { ok: true, current: "0.9.2", latest: "0.9.2", updateAvailable: false });
  assert.deepEqual(JSON.parse(await relo("update", "--rollback")), { ok: true, from: "0.9.2", to: "0.9.1", rollback: true, verified: true, refreshed: [] });
  assert.equal(await relo("--version"), "0.9.1");
});

/** A Relo server that hands out its CLI (/cli/version, /cli/relo-cli.tgz), as `install.sh` installs it. */
async function reloServer(version) {
  const work = await mkdtemp(join(tmpdir(), "relo-cli-pack-"));
  await mkdir(join(work, "package", "bin"), { recursive: true });
  await writeFile(join(work, "package", "bin", "relo.mjs"), `console.log("relo ${version}")\n`);
  await writeFile(join(work, "package", "package.json"), JSON.stringify({ name: "@relo/cli", version }));
  // Relative names: GNU tar (Git Bash) reads "C:" in an absolute path as a remote host.
  execFileSync("tar", ["-czf", "relo-cli.tgz", "package"], { cwd: work });
  const bytes = await readFile(join(work, "relo-cli.tgz"));
  const requests = [];
  const server = createServer((request, response) => {
    requests.push(request.url);
    if (request.url === "/cli/version") { response.writeHead(200, { "content-type": "application/json" }); return response.end(JSON.stringify({ version, sha256: sha(bytes) })); }
    if (request.url === "/cli/relo-cli.tgz") { response.writeHead(200, { "content-type": "application/gzip" }); return response.end(bytes); }
    response.writeHead(404); response.end("{}");
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  test.after(() => server.close());
  return { origin: `http://127.0.0.1:${server.address().port}`, requests };
}

test("a CLI the install script installed updates from its own server, beside itself, and the launcher follows", async () => {
  const server = await reloServer(NEWER);
  const home = await mkdtemp(join(tmpdir(), "relo-update-launcher-"));
  const entry = join(dataRoot(home), "cli", VERSION, "bin", "relo.mjs");
  await mkdir(join(dataRoot(home), "cli", VERSION, "bin"), { recursive: true });
  await writeFile(entry, "// the running CLI\n");
  await mkdir(join(home, ".local", "bin"), { recursive: true });
  const launcher = join(home, ".local", "bin", "relo");
  await writeFile(launcher, `#!/bin/sh\n# relo launcher: ${entry}\nexec "/opt/node/bin/node" "${entry}" "$@"\n`);
  const npmCalls = [];
  const deps = { home, version: VERSION, entrypoint: entry, env: {}, platform: "linux",
    loadConfig: async () => ({ apiUrl: server.origin, token: "x".repeat(44) }),
    runNpm: async (args) => { npmCalls.push(args); return { code: 0 }; },
    runRefresh: async () => ({ ok: true, changed: [] }) };
  const stdout = [];
  const exitCode = await run(["update"], { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, deps);
  const line = JSON.parse(stdout[0]);
  assert.equal(exitCode, 0, stdout[0]);
  assert.equal(line.to, NEWER);
  assert.equal(line.source, server.origin);
  assert.deepEqual(npmCalls, [], "no npm: the new version is unpacked beside the old one");
  const next = join(dataRoot(home), "cli", NEWER, "bin", "relo.mjs");
  assert.equal(await readFile(next, "utf8"), `console.log("relo ${NEWER}")\n`);
  assert.equal(await readFile(launcher, "utf8"), `#!/bin/sh\n# relo launcher: ${next}\nexec "/opt/node/bin/node" "${next}" "$@"\n`);
  assert.ok(existsSync(entry), "the old version stays for --rollback");
  // Checked against the server's digest, never GitHub.
  assert.ok(server.requests.includes("/cli/version") && server.requests.includes("/cli/relo-cli.tgz"));
});

test("on Windows a CLI behind relo.cmd updates beside itself and relo.cmd (and the Git Bash sibling) follow", async () => {
  const server = await reloServer(NEWER);
  const home = await mkdtemp(join(tmpdir(), "relo-update-win-"));
  const env = { LOCALAPPDATA: join(home, "Local") };
  const paths = windowsPaths({ home, env });
  const entry = join(paths.cli, VERSION, "bin", "relo.mjs");
  await mkdir(join(paths.cli, VERSION, "bin"), { recursive: true });
  await writeFile(entry, "// the running CLI\n");
  await mkdir(paths.bin, { recursive: true });
  const node = "C:\\Program Files\\nodejs\\node.exe";
  await writeFile(paths.cmd, cmdLauncherText(node, entry));
  await writeFile(paths.sh, shLauncherText(node, entry));
  const npmCalls = [];
  const deps = { home, version: VERSION, entrypoint: entry, env, platform: "win32",
    loadConfig: async () => ({ apiUrl: server.origin, token: "x".repeat(44) }),
    runNpm: async (args) => { npmCalls.push(args); return { code: 0 }; },
    runRefresh: async () => ({ ok: true, changed: [] }) };
  const stdout = [];
  const exitCode = await run(["update"], { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, deps);
  assert.equal(exitCode, 0, stdout[0]);
  assert.deepEqual(npmCalls, []);
  const next = join(paths.cli, NEWER, "bin", "relo.mjs");
  assert.equal(await readFile(paths.cmd, "utf8"), cmdLauncherText(node, next));
  assert.equal(await readFile(paths.sh, "utf8"), shLauncherText(node, next));
  assert.ok(existsSync(entry), "the old version stays for --rollback");
  assert.deepEqual((await readdir(paths.bin)).sort(), ["relo", "relo.cmd"], "no temp file left behind");
});
