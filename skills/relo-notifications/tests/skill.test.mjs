import assert from "node:assert/strict";
import { appendFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { validateSkill } from "../scripts/validate-skill.mjs";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repositoryToolingAvailable = existsSync(resolve(packageRoot, "..", "cli", "package.json"));

function fixture(t) {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "relo-skill-test-"));
  const root = join(temporaryRoot, "relo-notifications");
  cpSync(packageRoot, root, { recursive: true });
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  return root;
}

test("the distributed skill satisfies structure, progressive disclosure, and safety gates", () => {
  const result = validateSkill(packageRoot);
  assert.deepEqual(result.errors, []);
  assert.ok(result.stats.lineCount < 100);
  assert.equal(result.stats.referenceCount, 8);
  assert.equal(result.stats.reachableReferenceCount, 8);
});

test("Live Activity guidance plans exploratory work and separates semantics from appearance", () => {
  const guidance = readFileSync(join(packageRoot, "references", "live-activities.md"), "utf8");
  assert.match(guidance, /completed outer phases \/ total outer phases/);
  assert.match(guidance, /Steps and progress answer different questions/);
  assert.match(guidance, /Prefer omission or `automatic`/);
  assert.match(guidance, /Choose appearance at start/);
  assert.match(guidance, /End exactly once/);
});

test("Live Activity readiness requires downstream evidence access", () => {
  const skill = readFileSync(join(packageRoot, "SKILL.md"), "utf8");
  const cli = readFileSync(join(packageRoot, "references", "cli.md"), "utf8");
  assert.match(skill, /Live Activity work requires `devices:read`/);
  assert.match(cli, /activity-capable credential must include `devices:read`/);
});

test("manual notifications and Live Activities require stable project and thread identity", () => {
  const skill = readFileSync(join(packageRoot, "SKILL.md"), "utf8");
  const cli = readFileSync(join(packageRoot, "references", "cli.md"), "utf8");
  assert.match(skill, /Always pass both `--project` and `--thread-name`/);
  assert.match(skill, /`Direct CLI` is origin, not identity/);
  assert.match(skill, /neither field may be empty/);
  assert.match(skill, /End preserves[\s\S]*that pair/);
  assert.match(cli, /Every agent-authored notification and Live Activity must carry both/);
  assert.match(cli, /Activity end deliberately accepts[\s\S]*no context replacement/);
  assert.match(cli, /notify send[\s\S]*--project "Relo" --thread-name "Release verification"/);
  assert.match(
    readFileSync(join(packageRoot, "references", "live-activities.md"), "utf8"),
    /Project\/thread \| Always supply both/,
  );
});

test("reviewed tooling versions match package manifests and installation references", {
  skip: !repositoryToolingAvailable,
}, () => {
  const manifest = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8"));
  const install = readFileSync(join(packageRoot, "references", "install.md"), "utf8");
  for (const [packageName, directory, tarballStem] of [
    ["@relo/cli", "reloctl", "relo-cli"],
    ["@relo/codex-notify", "codex-notify", "relo-codex-notify"],
  ]) {
    const toolingManifest = JSON.parse(
      readFileSync(resolve(packageRoot, "..", directory, "package.json"), "utf8"),
    );
    assert.equal(toolingManifest.name, packageName);
    assert.equal(manifest.reviewedToolingVersions[packageName], toolingManifest.version);
    assert.equal(install.includes(`${tarballStem}-${toolingManifest.version}.tgz`), true);
  }
  assert.match(install, /npm root --global/);
  assert.match(install, /\/@relo\/codex-notify/);
  assert.match(install, /scripts\/configure-codex-notify\.mjs/);
  assert.doesNotMatch(install, /node\s+["']?configure-codex-notify\.mjs/);
  assert.match(install, /release:artifacts --[\s\\]+pack --output/);
  assert.match(install, /artifact-pair\.mjs verify/);
  assert.match(install, /bind-transition/);
  assert.match(install, /relo-tooling-pair-0\.7\.2\.json/);
  assert.match(install, /skill-discovery\.mjs audit/);
  assert.match(install, /\.local\/share\/relo\/skill-archives/);
  assert.doesNotMatch(install, /create a recoverable backup beside it/i);
  const checklist = readFileSync(join(packageRoot, "references", "release-checklist.md"), "utf8");
  assert.match(checklist, /release:host -- lifecycle --execute/);
  assert.match(checklist, /skills@1\.5\.22 add \.\/skills\/relo-notifications/);
  assert.match(checklist, /Repository-root discovery[\s\S]*unsupported/);
  assert.match(checklist, /bind-transition[\s\S]*verify-transition/);
  assert.match(checklist, /skill-discovery\.mjs audit/);
  assert.match(checklist, /\.local\/share\/relo\/skill-archives/);
});

test("CLI reference covers every interactive style and canonical action order", () => {
  const cli = readFileSync(join(packageRoot, "references", "cli.md"), "utf8");
  for (const style of ["approval", "shell", "verdict", "signal"]) {
    assert.equal(cli.includes(`\`${style}\``), true);
  }
  assert.match(cli, /require[\s\S]*`--approval` or `--yes-no`/);
  assert.match(cli, /primary\s+label is affirmative/);
  assert.match(cli, /secondary label declines/);
  assert.match(cli, /default interactive style is `approval`/);
  assert.match(cli, /`error\.details\.result`/);
  assert.match(cli, /1–200 characters/);
  assert.match(cli, /devices list[\s\S]*`--page-size 1\.\.100`/);
  assert.match(cli, /activity wait[\s\S]*exact canonical ID/);
  assert.match(cli, /durable_inbox_refresh_only[\s\S]*not direct phone delivery/);
});

test("triggering and functional eval cases are distinct and cover fail-closed approval", () => {
  const cases = JSON.parse(readFileSync(join(packageRoot, "tests", "cases.json"), "utf8"));
  assert.ok(cases.shouldTrigger.length >= 8);
  assert.ok(cases.shouldNotTrigger.length >= 8);
  assert.equal(
    new Set([...cases.shouldTrigger, ...cases.shouldNotTrigger].map((item) => item.prompt)).size,
    cases.shouldTrigger.length + cases.shouldNotTrigger.length,
  );
  assert.equal(cases.modelTriggerQuality.status, "not-automated");
  const permissionCase = cases.functional.find((item) => item.name === "permission approval");
  assert.ok(permissionCase);
  assert.match(permissionCase.then.join(" "), /type approval, state approved, action approve/);
  assert.match(permissionCase.then.join(" "), /yes-no, text, timeout, cancel, expiry, error/);
  assert.ok(cases.functional.some((item) => item.name === "context-aware installation"));
  assert.ok(cases.functional.some((item) => item.name === "style selection"));
  assert.ok(cases.functional.some((item) => item.name === "secret service creation"));
  assert.ok(cases.functional.some((item) => item.name === "browser authentication"));
  assert.ok(cases.functional.some((item) => item.name === "notifier maintenance"));
  const triggerText = cases.shouldTrigger.map((item) => item.prompt).join(" ");
  for (const term of ["Log this host", "webhook service", "permission hook", "Codex notifier"]) {
    assert.equal(triggerText.includes(term), true);
  }
  assert.equal(cases.errorTranscripts.length >= 5, true);
  for (const transcript of cases.errorTranscripts) {
    assert.equal(typeof transcript.input, "string");
    assert.equal(typeof transcript.expected, "string");
    assert.equal(typeof transcript.fixture, "string");
    assert.equal(typeof transcript.expectedAction, "string");
  }
  assert.match(
    cases.errorTranscripts.map((item) => item.expected).join(" "),
    /deny permission|do not perform the protected action/i,
  );
});

test("validator rejects an oversized root skill and forbidden README", (t) => {
  const root = fixture(t);
  appendFileSync(join(root, "SKILL.md"), "extra\n".repeat(101));
  writeFileSync(join(root, "README.md"), "not allowed\n");
  const result = validateSkill(root);
  assert.ok(result.errors.some((error) => error.includes("maximum is 100")));
  assert.ok(result.errors.some((error) => error.includes("README.md")));
});

test("validator rejects a broken progressive-disclosure link", (t) => {
  const root = fixture(t);
  const path = join(root, "SKILL.md");
  writeFileSync(
    path,
    readFileSync(path, "utf8").replace(
      "](references/security.md)",
      "](references/missing.md)",
    ),
  );
  assert.ok(validateSkill(root).errors.some((error) => error.includes("Broken reference link")));
});

test("validator traverses every reference from SKILL.md and rejects path escapes", (t) => {
  const root = fixture(t);
  const skillPath = join(root, "SKILL.md");
  writeFileSync(
    skillPath,
    readFileSync(skillPath, "utf8").replace(
      "[references/troubleshooting.md](references/troubleshooting.md)",
      "references/troubleshooting.md",
    ),
  );
  let result = validateSkill(root);
  assert.ok(result.errors.some((error) => error.includes("not reachable")));

  writeFileSync(skillPath, `${readFileSync(skillPath, "utf8")}\n[escape](../../outside.md)\n`);
  result = validateSkill(root);
  assert.ok(result.errors.some((error) => error.includes("escapes skill root")));
});

test("a repository-scoped copied installation remains complete and valid", (t) => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "relo-skill-install-"));
  t.after(() => rmSync(temporaryRoot, { recursive: true, force: true }));
  const installed = join(temporaryRoot, ".agents", "skills", "relo-notifications");
  cpSync(packageRoot, installed, { recursive: true });
  const result = validateSkill(installed);
  assert.deepEqual(result.errors, []);
  assert.match(readFileSync(join(installed, "LICENSE"), "utf8"), /PolyForm Noncommercial License 1\.0\.0/);
  assert.equal(readFileSync(join(installed, "references", "install.md"), "utf8").includes("skills@1.5.22"), true);
});

test("validator rejects removal of the yes-no and text permission denial", (t) => {
  const root = fixture(t);
  for (const relative of ["SKILL.md", join("references", "security.md"), join("references", "permissions.md")]) {
    const path = join(root, relative);
    writeFileSync(
      path,
      readFileSync(path, "utf8")
        .replace(/A yes\/no or text answer is never permission\./g, "Answers are handled separately.")
        .replace(/Never treat yes\/no or text interactions as permission[^\n]*\n?/g, "")
        .replace(/A yes\/no or text response is\nnever permission[^\n]*\n?/g, ""),
    );
  }
  assert.ok(validateSkill(root).errors.some((error) => error.includes("yes-no and text deny")));
});

test("validator rejects a stale idempotency range or missing tooling review version", (t) => {
  const root = fixture(t);
  const securityPath = join(root, "references", "security.md");
  writeFileSync(
    securityPath,
    readFileSync(securityPath, "utf8").replace("1–200 characters", "8–200 characters"),
  );
  assert.ok(validateSkill(root).errors.some((error) => error.includes("idempotency key range")));

  const manifestPath = join(root, "package.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  delete manifest.reviewedToolingVersions["@relo/codex-notify"];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  assert.ok(
    validateSkill(root).errors.some((error) => error.includes("@relo/codex-notify")),
  );
});
