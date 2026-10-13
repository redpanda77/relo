import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const PACKAGE_ROOT = new URL("..", import.meta.url);

function npm(temp, args, options = {}) {
  const env = {
    ...process.env,
    npm_config_cache: join(temp, "npm-cache"),
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
    ...options.env,
  };
  const { env: _ignored, ...rest } = options;
  return execFileSync("npm", args, { encoding: "utf8", env, ...rest });
}

async function versionedFixture(temp, version) {
  const root = join(temp, `source-${version}`);
  await cp(PACKAGE_ROOT, root, { recursive: true });
  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.version = version;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  const cliPath = join(root, "src", "cli.mjs");
  await writeFile(
    cliPath,
    (await readFile(cliPath, "utf8")).replace(
      /const VERSION = "[^"]+";/,
      `const VERSION = ${JSON.stringify(version)};`,
    ),
  );
  const skillPath = join(root, "skill", "package.json");
  const skill = JSON.parse(await readFile(skillPath, "utf8"));
  skill.version = version;
  skill.reviewedToolingVersions = { "@relo/cli": version };
  await writeFile(skillPath, `${JSON.stringify(skill, null, 2)}\n`);
  const [packed] = JSON.parse(
    npm(temp, ["pack", "--json", "--pack-destination", temp], { cwd: root }),
  );
  return { packed, tarball: join(temp, packed.filename) };
}

test("uses distinct artifacts for install, update, exact rollback, and removal without touching state", async () => {
  const temp = await mkdtemp(join(tmpdir(), "reloctl-install-"));
  const prefix = join(temp, "prefix");
  const home = join(temp, "home");
  const config = join(home, ".config", "relo", "config.json");
  const hook = join(home, ".codex", "hooks.json");
  const configSentinel = '{"sentinel":"credential-config"}\n';
  const hookSentinel = '{"sentinel":"user-hook"}\n';
  try {
    await mkdir(join(home, ".config", "relo"), { recursive: true });
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(config, configSentinel, { mode: 0o600 });
    await writeFile(hook, hookSentinel, { mode: 0o600 });
    const oldArtifact = await versionedFixture(temp, "0.1.0");
    const newArtifact = await versionedFixture(temp, "0.5.2");
    assert.notEqual(oldArtifact.tarball, newArtifact.tarball);
    assert.equal(oldArtifact.packed.files.some((file) => file.path.startsWith("test/")), false);
    assert.equal(oldArtifact.packed.files.some((file) => file.path === "README.md"), true);
    assert.equal(oldArtifact.packed.files.some((file) => file.path === "skill/SKILL.md"), true, "the skill ships inside the package");
    assert.equal(oldArtifact.packed.files.some((file) => /skill\/(tests|node_modules)\//u.test(file.path)), false);

    const install = (tarball) => npm(temp, [
      "install", "--global", "--ignore-scripts", "--prefix", prefix, tarball,
    ], { env: { HOME: home, RELO_CONFIG_PATH: config } });
    const assertSentinels = async () => {
      assert.equal(await readFile(config, "utf8"), configSentinel);
      assert.equal(await readFile(hook, "utf8"), hookSentinel);
    };
    const bin = join(prefix, "bin", "relo");
    const alias = join(prefix, "bin", "reloctl");

    install(oldArtifact.tarball);
    assert.equal(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim(), "0.1.0");
    assert.match(execFileSync(alias, ["help", "all"], { encoding: "utf8" }), /--secret-file PATH/);
    await assertSentinels();

    install(newArtifact.tarball);
    assert.equal(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim(), "0.5.2");
    await assertSentinels();

    install(oldArtifact.tarball);
    assert.equal(execFileSync(bin, ["--version"], { encoding: "utf8" }).trim(), "0.1.0");
    await assertSentinels();

    npm(temp, ["uninstall", "--global", "--prefix", prefix, "@relo/cli"], {
      env: { HOME: home, RELO_CONFIG_PATH: config },
    });
    await assert.rejects(access(bin), (error) => error.code === "ENOENT");
    await assert.rejects(access(alias), (error) => error.code === "ENOENT");
    await assertSentinels();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
