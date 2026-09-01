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
  await writeFile(join(root, "README.md"), `${await readFile(join(root, "README.md"), "utf8")}\nArtifact ${version}.\n`);
  const [packed] = JSON.parse(npm(temp, ["pack", "--json", "--pack-destination", temp], { cwd: root }));
  return { packed, tarball: join(temp, packed.filename) };
}

test("uses distinct notifier artifacts for install, update, rollback, and removal while preserving config", async () => {
  const temp = await mkdtemp(join(tmpdir(), "relo-codex-notify-install-"));
  const prefix = join(temp, "prefix");
  const home = join(temp, "home");
  const codexConfig = join(home, ".codex", "config.toml");
  const chainConfig = join(home, ".config", "relo", "notify-chain.json");
  const codexSentinel = 'model = "sentinel"\nnotify = ["/user/notifier"]\n';
  const chainSentinel = '{"nextCommand":["/user/notifier"]}\n';
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".config", "relo"), { recursive: true });
    await writeFile(codexConfig, codexSentinel, { mode: 0o600 });
    await writeFile(chainConfig, chainSentinel, { mode: 0o600 });
    const oldArtifact = await versionedFixture(temp, "0.1.0");
    const newArtifact = await versionedFixture(temp, "0.5.2");
    assert.notEqual(oldArtifact.tarball, newArtifact.tarball);
    assert.equal(oldArtifact.packed.files.some((file) => file.path.startsWith("test/")), false);
    assert.equal(oldArtifact.packed.files.some((file) => file.path === "scripts/configure-codex-notify.mjs"), true);
    assert.equal(oldArtifact.packed.files.some((file) => file.path === "scripts/configure-codex-hooks.mjs"), true);
    assert.equal(oldArtifact.packed.files.some((file) => file.path === "scripts/install-runtime-wrappers.mjs"), true);
    assert.equal(oldArtifact.packed.files.some((file) => file.path === "bin/relo-codex-hook.mjs"), true);

    const install = (tarball) => npm(temp, [
      "install", "--global", "--ignore-scripts", "--prefix", prefix, tarball,
    ], { env: { HOME: home } });
    const assertSentinels = async () => {
      assert.equal(await readFile(codexConfig, "utf8"), codexSentinel);
      assert.equal(await readFile(chainConfig, "utf8"), chainSentinel);
    };
    const bin = join(prefix, "bin", "relo-codex-notify");
    const hookBin = join(prefix, "bin", "relo-codex-hook");
    const manifest = join(prefix, "lib", "node_modules", "@relo", "codex-notify", "package.json");
    const payload = JSON.stringify({
      type: "agent-turn-complete", "thread-id": "packaging-thread", "turn-id": "packaging-turn",
    });

    install(oldArtifact.tarball);
    assert.match(execFileSync(bin, ["--dry-run", payload], { encoding: "utf8" }), /"ok":true/);
    assert.match(execFileSync(hookBin, ["--help"], { encoding: "utf8" }), /Usage:/);
    assert.equal(JSON.parse(await readFile(manifest, "utf8")).version, "0.1.0");
    await assertSentinels();

    install(newArtifact.tarball);
    assert.equal(JSON.parse(await readFile(manifest, "utf8")).version, "0.5.2");
    assert.match(await readFile(join(prefix, "lib", "node_modules", "@relo", "codex-notify", "README.md"), "utf8"), /Artifact 0\.5\.2/);
    await assertSentinels();

    install(oldArtifact.tarball);
    assert.equal(JSON.parse(await readFile(manifest, "utf8")).version, "0.1.0");
    const installedConfigure = join(prefix, "lib", "node_modules", "@relo", "codex-notify", "scripts", "configure-codex-notify.mjs");
    const installedHookConfigure = join(prefix, "lib", "node_modules", "@relo", "codex-notify", "scripts", "configure-codex-hooks.mjs");
    const installedWrappers = join(prefix, "lib", "node_modules", "@relo", "codex-notify", "scripts", "install-runtime-wrappers.mjs");
    assert.match(execFileSync(process.execPath, [installedConfigure, "--help"], { encoding: "utf8" }), /Usage:/);
    assert.match(execFileSync(process.execPath, [installedHookConfigure, "--help"], { encoding: "utf8" }), /Usage:/);
    execFileSync(process.execPath, ["--check", installedWrappers]);
    await assertSentinels();

    npm(temp, ["uninstall", "--global", "--prefix", prefix, "@relo/codex-notify"], {
      env: { HOME: home },
    });
    await assert.rejects(access(bin), (error) => error.code === "ENOENT");
    await assert.rejects(access(hookBin), (error) => error.code === "ENOENT");
    await assertSentinels();
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
});
