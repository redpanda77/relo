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
import { VERSION, run } from "../src/cli.mjs";
import { compareVersions, parseSums } from "../src/update.mjs";
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
  const overrides = {
    home, version, env: { RELO_RELEASES_URL: server?.url, ...env },
    runNpm: async (args) => { npmCalls.push(args); return { code: npmCode, stderr: npmCode ? "EACCES: permission denied, mkdir '/usr/lib/node_modules'" : "" }; },
  };
  return {
    home, npmCalls, overrides,
    async cli(argv, extra = {}) {
      const stdout = [];
      const exitCode = await run(argv, { stdout: (line) => stdout.push(line), stderr: () => {}, stdoutIsTTY: false }, { ...overrides, ...extra });
      return { exitCode, line: stdout[0] ? JSON.parse(stdout[0]) : undefined };
    },
    stored: () => readdir(join(home, ".local", "share", "relo", "cli-releases")).catch(() => []),
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
  assert.deepEqual(updated.line, { ok: true, from: VERSION, to: NEWER, verified: true });
  const tarball = join(b.home, ".local", "share", "relo", "cli-releases", NEWER, `relo-cli-${NEWER}.tgz`);
  assert.deepEqual(b.npmCalls, [["install", "--global", tarball]]);
  assert.equal(sha(await readFile(tarball)), sha(Buffer.from(`tarball ${NEWER}`)));
  assert.match(await readFile(join(b.home, ".local", "share", "relo", "cli-releases", NEWER, "SHA256SUMS"), "utf8"), /^[0-9a-f]{64} {2}relo-cli-9\.9\.9\.tgz\n$/u);
  assert.deepEqual((await b.stored()).sort(), [VERSION, NEWER].sort(), "the installed release is stored too, and no partial folder is left");
});

test("rollback reinstalls the previous stored release after re-verifying it", async () => {
  const server = await releaseServer({ releases: [release(VERSION), release(NEWER)] });
  const b = await box({ server });
  await b.cli(["update"]);
  b.npmCalls.length = 0;
  const rolled = await b.cli(["update", "--rollback"], { version: NEWER });
  assert.deepEqual(rolled.line, { ok: true, from: NEWER, to: VERSION, rollback: true, verified: true });
  assert.deepEqual(b.npmCalls, [["install", "--global", join(b.home, ".local", "share", "relo", "cli-releases", VERSION, `relo-cli-${VERSION}.tgz`)]]);

  // A stored tarball that no longer matches its checksum is never installed.
  b.npmCalls.length = 0;
  await writeFile(join(b.home, ".local", "share", "relo", "cli-releases", VERSION, `relo-cli-${VERSION}.tgz`), "tampered");
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
  assert.deepEqual(picked.line, { ok: true, from: VERSION, to: "0.9.0", verified: true });
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
const cachePath = (home) => join(home, ".local", "share", "relo", "update-check.json");

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
  assert.equal(existsSync(join(out.home, ".local", "share", "relo", "cli-releases")), false);

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

async function packedVersion(temp, version) {
  const root = join(temp, `source-${version}`);
  await cp(PACKAGE_ROOT, root, { recursive: true, filter: (path) => !path.includes("node_modules") });
  const edit = async (path, change) => {
    const file = join(root, path);
    await writeFile(file, change(await readFile(file, "utf8")));
  };
  await edit("package.json", (text) => text.replace(/"version": "[^"]+"/u, `"version": "${version}"`));
  await edit("src/cli.mjs", (text) => text.replace(/const VERSION = "[^"]+";/u, `const VERSION = "${version}";`));
  await edit("skill/package.json", (text) => text.replace(/"version": "[^"]+"/u, `"version": "${version}"`).replace(/"@relo\/cli": "[^"]+"/u, `"@relo/cli": "${version}"`));
  const env = { ...process.env, npm_config_cache: join(temp, "npm-cache"), npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
  const [packed] = JSON.parse(execFileSync("npm", ["pack", "--json", "--pack-destination", temp], { cwd: root, env, encoding: "utf8" }));
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
  const relo = async (...args) => (await promisify(execFile)(join(prefix, "bin", "relo"), args, { env, encoding: "utf8" })).stdout.trim();
  execFileSync("npm", ["install", "--global", oldRelease.file], { env, encoding: "utf8" });
  assert.equal(await relo("--version"), "0.9.1");
  assert.deepEqual(JSON.parse(await relo("update", "--check")), { ok: true, current: "0.9.1", latest: "0.9.2", updateAvailable: true });
  assert.deepEqual(JSON.parse(await relo("update")), { ok: true, from: "0.9.1", to: "0.9.2", verified: true });
  assert.equal(await relo("--version"), "0.9.2");
  assert.deepEqual(JSON.parse(await relo("update")), { ok: true, current: "0.9.2", latest: "0.9.2", updateAvailable: false });
  assert.deepEqual(JSON.parse(await relo("update", "--rollback")), { ok: true, from: "0.9.2", to: "0.9.1", rollback: true, verified: true });
  assert.equal(await relo("--version"), "0.9.1");
});
