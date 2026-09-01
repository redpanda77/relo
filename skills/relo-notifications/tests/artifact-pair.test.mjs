import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  bindArtifactTransition,
  pairSha256,
  verifyArtifactPair,
  verifyArtifactTransition,
} from "../scripts/artifact-pair.mjs";

function identity(name, version, artifactFile, contents) {
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

async function retainedPair(root, version, cliBytes, notifierBytes) {
  const cli = join(root, `relo-cli-${version}.tgz`);
  const notifier = join(root, `relo-codex-notify-${version}.tgz`);
  const manifestPath = join(root, `relo-tooling-pair-${version}.json`);
  await writeFile(cli, cliBytes, { mode: 0o600 });
  await writeFile(notifier, notifierBytes, { mode: 0o600 });
  const manifest = {
    schemaVersion: 1,
    releaseVersion: version,
    nodeVersion: process.version,
    npmVersion: "test",
    packages: [
      identity("@relo/cli", version, `relo-cli-${version}.tgz`, cliBytes),
      identity("@relo/codex-notify", version, `relo-codex-notify-${version}.tgz`, notifierBytes),
    ],
  };
  manifest.pairSha256 = pairSha256(manifest);
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });
  return { manifest: manifestPath, cli, notifier };
}

test("retained pair verification binds exact filenames, versions, and bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "relo-artifact-pair-"));
  const cli = join(root, "relo-cli-0.5.0.tgz");
  const notifier = join(root, "relo-codex-notify-0.5.0.tgz");
  const manifestPath = join(root, "relo-tooling-pair-0.5.0.json");
  const cliBytes = Buffer.from("exact-cli-artifact");
  const notifierBytes = Buffer.from("exact-notifier-artifact");
  try {
    await mkdir(root, { recursive: true, mode: 0o700 });
    await writeFile(cli, cliBytes, { mode: 0o600 });
    await writeFile(notifier, notifierBytes, { mode: 0o600 });
    const manifest = {
      schemaVersion: 1,
      releaseVersion: "0.5.0",
      nodeVersion: process.version,
      npmVersion: "test",
      packages: [
        identity("@relo/cli", "0.5.0", "relo-cli-0.5.0.tgz", cliBytes),
        identity("@relo/codex-notify", "0.5.0", "relo-codex-notify-0.5.0.tgz", notifierBytes),
      ],
    };
    manifest.pairSha256 = pairSha256(manifest);
    await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o600 });

    assert.deepEqual(await verifyArtifactPair({ manifest: manifestPath, cli, notifier }), {
      verified: true,
      releaseVersion: "0.5.0",
      pairSha256: manifest.pairSha256,
    });
    await writeFile(notifier, "same-version-substitute", { mode: 0o600 });
    await assert.rejects(
      verifyArtifactPair({ manifest: manifestPath, cli, notifier }),
      /does not match retained identity/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("transition identity binds exact retained prior and candidate pairs", async () => {
  const root = await mkdtemp(join(tmpdir(), "relo-artifact-transition-"));
  try {
    const prior = await retainedPair(
      root,
      "0.7.2",
      Buffer.from("retained-prior-cli"),
      Buffer.from("retained-prior-notifier"),
    );
    const candidate = await retainedPair(
      root,
      "0.7.17",
      Buffer.from("exact-candidate-cli"),
      Buffer.from("exact-candidate-notifier"),
    );
    const bound = await bindArtifactTransition({ output: root, prior, candidate });
    const transition = join(root, bound.transitionFile);
    assert.deepEqual(await verifyArtifactTransition({ transition, prior, candidate }), {
      verified: true,
      priorVersion: "0.7.2",
      candidateVersion: "0.7.17",
      transitionSha256: bound.transition.transitionSha256,
    });
    await writeFile(prior.cli, "changed-prior-bytes", { mode: 0o600 });
    await assert.rejects(
      verifyArtifactTransition({ transition, prior, candidate }),
      /does not match retained identity/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
