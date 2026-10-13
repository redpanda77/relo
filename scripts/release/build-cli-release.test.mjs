import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { ReleaseBuildError, buildRelease } from "./build-cli-release.mjs";

const REPOSITORY = resolve(fileURLToPath(import.meta.url), "..", "..", "..");
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

/** A throwaway repository holding only what a CLI release is built from. */
async function fixture({ git = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "relo-release-test-"));
  const skip = (path) => /node_modules|\/dist(\/|$)|packages\/cli\/skill(\/|$)/u.test(path.replaceAll("\\", "/"));
  await cp(join(REPOSITORY, "packages", "cli"), join(root, "packages", "cli"), { recursive: true, filter: (path) => !skip(path) });
  await cp(join(REPOSITORY, "skills", "relo-notifications"), join(root, "skills", "relo-notifications"), { recursive: true, filter: (path) => !skip(path) });
  for (const file of ["LICENSE", ".gitignore"]) await cp(join(REPOSITORY, file), join(root, file));
  await writeFile(join(root, "public-export.json"), JSON.stringify({ forbiddenText: [{ id: "test-denylist", value: "ZZ-FORBIDDEN-ZZ", caseSensitive: true }] }));
  if (git) {
    const run = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: root, stdio: "ignore" });
    run("init", "-q");
    run("add", "-A");
    run("commit", "-q", "-m", "fixture");
  }
  return root;
}

const options = (root) => ({ root, out: join(root, "dist", "release"), skipChecks: true });
const failure = async (promise) => promise.then(() => assert.fail("expected the build to fail"), (error) => {
  assert.ok(error instanceof ReleaseBuildError, error.stack);
  return error;
});

test("builds the tarball, SBOM, manifest and checksums from a clean committed tree", async () => {
  const root = await fixture({ git: true });
  const built = await buildRelease(options(root));
  const { version } = JSON.parse(await readFile(join(root, "packages", "cli", "package.json"), "utf8"));
  assert.equal(built.directory, join(root, "dist", "release", version));
  assert.deepEqual((await readdir(built.directory)).sort(), ["SHA256SUMS", "manifest.json", `relo-cli-${version}.tgz`, "sbom.cdx.json"]);
  assert.equal(built.gitDirty, false);
  assert.match(built.gitCommit, /^[0-9a-f]{40}$/u);

  const sums = new Map((await readFile(join(built.directory, "SHA256SUMS"), "utf8")).trim().split("\n").map((line) => {
    const [hash, name] = line.split("  ");
    return [name, hash];
  }));
  assert.deepEqual([...sums.keys()].sort(), ["manifest.json", `relo-cli-${version}.tgz`, "sbom.cdx.json"]);
  for (const [name, hash] of sums) assert.equal(sha(await readFile(join(built.directory, name))), hash, `${name} matches SHA256SUMS`);

  const manifest = JSON.parse(await readFile(join(built.directory, "manifest.json"), "utf8"));
  assert.equal(manifest.version, version);
  assert.equal(manifest.tag, `cli-v${version}`);
  assert.equal(manifest.gitCommit, built.gitCommit);
  assert.equal(manifest.node, ">=22");
  assert.deepEqual(manifest.files.map((file) => file.name), [`relo-cli-${version}.tgz`, "sbom.cdx.json"]);
  for (const file of manifest.files) {
    const bytes = await readFile(join(built.directory, file.name));
    assert.equal(file.sha256, sha(bytes));
    assert.equal(file.bytes, bytes.length);
  }
  assert.equal(manifest.scans.thirdPartyDependencies, 0);

  const sbom = JSON.parse(await readFile(join(built.directory, "sbom.cdx.json"), "utf8"));
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.deepEqual(sbom.components ?? [], [], "the CLI has no runtime dependencies");

  const listing = execFileSync("tar", ["-tzf", join(built.directory, `relo-cli-${version}.tgz`)], { encoding: "utf8" });
  for (const path of ["package/bin/relo.mjs", "package/skill/SKILL.md", "package/LICENSE", "package/README.md"]) assert.ok(listing.includes(path), path);
  assert.equal(listing.includes("/test/"), false);
});

test("a dirty tree is refused unless explicitly allowed, and the manifest says so", async () => {
  const root = await fixture({ git: true });
  await writeFile(join(root, "packages", "cli", "README.md"), `${await readFile(join(root, "packages", "cli", "README.md"), "utf8")}\nextra\n`);
  const error = await failure(buildRelease(options(root)));
  assert.match(error.message, /not clean/u);
  const built = await buildRelease({ ...options(root), allowDirty: true });
  assert.equal(built.manifest.gitDirty, true);
});

test("a planted secret fails the build loudly and leaves no artifacts", async () => {
  const root = await fixture();
  const readme = join(root, "packages", "cli", "README.md");
  const token = `ghp_${"a1B2".repeat(10)}`;
  await writeFile(readme, `${await readFile(readme, "utf8")}\nexport GH=${token}\n`);
  const error = await failure(buildRelease({ ...options(root), allowDirty: true }));
  assert.ok(error.findings.some((finding) => finding.startsWith("secret-scan github-token: README.md")), error.findings.join("\n"));
  assert.equal(error.findings.join("\n").includes(token), false, "findings never echo the secret");
  const dist = join(root, "dist", "release");
  assert.deepEqual(existsSync(dist) ? await readdir(dist) : [], []);
});

test("a private key, a home path and a denylisted word each fail the scan", async () => {
  for (const [needle, expected] of [
    ["-----BEGIN OPENSSH PRIVATE KEY-----", "private-key"],
    ["/Users/someone/project/file", "home-path"],
    ["ZZ-FORBIDDEN-ZZ", "denylist test-denylist"],
  ]) {
    const root = await fixture();
    const file = join(root, "packages", "cli", "src", "help.mjs");
    await writeFile(file, `${await readFile(file, "utf8")}\n// ${needle}\n`);
    const error = await failure(buildRelease({ ...options(root), allowDirty: true }));
    assert.ok(error.findings.some((finding) => finding.includes(expected)), `${expected}: ${error.findings.join(" | ")}`);
  }
});

test("third-party code fails the licence check: a dependency, an import, or foreign licence text", async () => {
  const root = await fixture();
  const manifestPath = join(root, "packages", "cli", "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  await writeFile(manifestPath, JSON.stringify({ ...manifest, dependencies: { leftpad: "1.0.0" } }, null, 2));
  const help = join(root, "packages", "cli", "src", "help.mjs");
  await writeFile(help, `import leftpad from "leftpad";\n// SPDX-License-Identifier: MIT\n${await readFile(help, "utf8")}`);
  const error = await failure(buildRelease({ ...options(root), allowDirty: true }));
  const text = error.findings.join("\n");
  assert.match(text, /third-party dependencies declared/u);
  assert.match(text, /third-party import "leftpad": src\/help\.mjs/u);
  assert.match(text, /foreign license text/u);
});

test("a package LICENSE that differs from the repository LICENSE fails", async () => {
  const root = await fixture();
  await writeFile(join(root, "packages", "cli", "LICENSE"), "PolyForm Noncommercial License 1.0.0\nshort notice\n");
  const error = await failure(buildRelease({ ...options(root), allowDirty: true }));
  assert.match(error.findings.join("\n"), /differs from the repository LICENSE/u);
});
