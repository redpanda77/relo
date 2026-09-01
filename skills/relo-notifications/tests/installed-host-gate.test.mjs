import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { bindArtifactTransition, pairSha256 } from "../scripts/artifact-pair.mjs";
import { childEnvironment, runInstalledHostGate } from "../scripts/installed-host-gate.mjs";

const skillRoot = fileURLToPath(new URL("..", import.meta.url));

test("installed-host child commands ignore npm --prefix inheritance", () => {
  const environment = childEnvironment({
    PATH: "/trusted/bin",
    npm_config_prefix: "/untrusted/lower",
    NPM_CONFIG_PREFIX: "/untrusted/upper",
    npm_config_registry: "https://registry.invalid",
  });
  assert.equal(environment.PATH, "/trusted/bin");
  assert.equal(environment.npm_config_prefix, undefined);
  assert.equal(environment.NPM_CONFIG_PREFIX, undefined);
  assert.equal(environment.npm_config_registry, "https://registry.invalid");
  assert.equal(environment.npm_config_audit, "false");
});

function packageIdentity(name, version, artifactFile, contents) {
  return {
    name,
    version,
    artifactFile,
    sha256: createHash("sha256").update(contents).digest("hex"),
    integrity: `sha512-${createHash("sha512").update(contents).digest("base64")}`,
    npmShasum: createHash("sha1").update(contents).digest("hex"),
    bytes: contents.length,
    sourceTreeSha256: createHash("sha256").update(`${name}-source`).digest("hex"),
    packedFiles: [{ path: "package.json", size: 100 }],
  };
}

async function retainedPair(root, version) {
  const cliBytes = Buffer.from(`cli-${version}`);
  const notifierBytes = Buffer.from(`notifier-${version}`);
  const cli = join(root, `relo-cli-${version}.tgz`);
  const notifier = join(root, `relo-codex-notify-${version}.tgz`);
  const manifest = join(root, `relo-tooling-pair-${version}.json`);
  await writeFile(cli, cliBytes, { mode: 0o600 });
  await writeFile(notifier, notifierBytes, { mode: 0o600 });
  const record = {
    schemaVersion: 1,
    releaseVersion: version,
    nodeVersion: process.version,
    npmVersion: "test",
    packages: [
      packageIdentity("@relo/cli", version, `relo-cli-${version}.tgz`, cliBytes),
      packageIdentity("@relo/codex-notify", version, `relo-codex-notify-${version}.tgz`, notifierBytes),
    ],
  };
  record.pairSha256 = pairSha256(record);
  await writeFile(manifest, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { manifest, cli, notifier };
}

test("installed-host preflight verifies transition, Node, and exact package skill source", async () => {
  const root = await mkdtemp(join(tmpdir(), "relo-installed-host-preflight-"));
  try {
    const prior = await retainedPair(root, "0.7.2");
    const candidate = await retainedPair(root, "0.7.17");
    const bound = await bindArtifactTransition({ output: root, prior, candidate });
    const reviewedSkillSource = join(root, "skills", "relo-notifications");
    await mkdir(join(reviewedSkillSource, "scripts"), { recursive: true });
    await writeFile(join(reviewedSkillSource, "package.json"), JSON.stringify({
      name: "@relo/notifications-skill",
      version: "0.7.17",
      reviewedToolingVersions: {
        "@relo/cli": "0.7.17",
        "@relo/codex-notify": "0.7.17",
      },
    }));
    await writeFile(join(reviewedSkillSource, "SKILL.md"), "---\nname: relo-notifications\n---\n");
    await writeFile(join(reviewedSkillSource, "scripts", "validate-skill.mjs"), "");
    const values = {
      command: "preflight",
      transition: join(root, bound.transitionFile),
      priorManifest: prior.manifest,
      priorCli: prior.cli,
      priorNotifier: prior.notifier,
      candidateManifest: candidate.manifest,
      candidateCli: candidate.cli,
      candidateNotifier: candidate.notifier,
      skillSource: reviewedSkillSource,
      evidenceDir: join(root, "evidence"),
      prefix: join(root, "prefix"),
      hostId: "host-a",
      runId: "preflight-1",
      preserveFiles: [],
    };
    const result = await runInstalledHostGate(values);
    assert.equal(result.ready, true);
    assert.equal(result.priorVersion, "0.7.2");
    assert.equal(result.candidateVersion, "0.7.17");
    assert.equal(result.transitionSha256, bound.transition.transitionSha256);
    assert.match(result.npmVersion, /^\d+\.\d+\.\d+/u);

    const hooksConfig = join(root, "home", ".codex", "hooks.json");
    const codexConfig = join(root, "home", ".codex", "config.toml");
    const installationIdPath = join(root, "home", ".codex", "relo.identity");
    const managed = await runInstalledHostGate({
      ...values,
      codexHooksConfig: hooksConfig,
      codexConfig,
      installationIdPath,
    });
    assert.equal(managed.ready, true);
    await assert.rejects(
      runInstalledHostGate({
        ...values,
        codexHooksConfig: hooksConfig,
        codexConfig,
        installationIdPath,
        preserveFiles: [hooksConfig],
      }),
      /cannot also be a byte-preserved file/,
    );
    await assert.rejects(
      runInstalledHostGate({
        ...values,codexHooksConfig: hooksConfig,codexConfig,installationIdPath,
        preserveFiles: [codexConfig],
      }),
      /Managed Codex config cannot also be a byte-preserved file/,
    );
    await assert.rejects(
      runInstalledHostGate({ ...values,codexHooksConfig: hooksConfig }),
      /installation-id-path must be absolute/,
    );

    await assert.rejects(
      runInstalledHostGate({ ...values, skillSource: dirname(skillRoot) }),
      /skills\/relo-notifications directory/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
