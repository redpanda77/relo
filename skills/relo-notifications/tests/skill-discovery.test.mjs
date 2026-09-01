import assert from "node:assert/strict";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { archiveSkillSnapshots, inspectSkillDiscovery } from "../scripts/skill-discovery.mjs";

function skillCopy(root, name, version = "0.7.10") {
  const directory = join(root, name);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "SKILL.md"), "---\nname: relo-notifications\n---\n");
  writeFileSync(join(directory, "package.json"), `${JSON.stringify({
    name: "@relo/notifications-skill",
    version,
  })}\n`);
  return directory;
}

test("discovery audit requires one exact active version and rejects sibling snapshots", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relo-discovery-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skills = join(root, ".agents", "skills");
  skillCopy(skills, "relo-notifications");
  skillCopy(skills, "relo-notifications.rollback-0.7.2", "0.7.2");
  symlinkSync(join(skills, "relo-notifications"), join(skills, "relo-notifications.link"));
  const result = inspectSkillDiscovery(skills, "0.7.10");
  assert.equal(result.ok, false);
  assert.equal(result.activeCount, 1);
  assert.equal(result.duplicateCount, 1);
  assert.equal(result.linkedCount, 1);
  assert.deepEqual(result.duplicates, ["relo-notifications.rollback-0.7.2"]);
  assert.equal(inspectSkillDiscovery(skills, "0.7.2").ok, false);
});

test("snapshot archive is recoverable, private, and outside discovery", (t) => {
  const root = mkdtempSync(join(tmpdir(), "relo-discovery-archive-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const skills = join(root, ".agents", "skills");
  const active = skillCopy(skills, "relo-notifications");
  const duplicate = skillCopy(skills, "relo-notifications.before-update", "0.7.2");
  writeFileSync(join(duplicate, "sentinel"), "retained\n");
  const archive = join(root, ".local", "share", "relo", "skill-archives", "release");
  const result = archiveSkillSnapshots({
    skillsDir: skills,
    archiveDir: archive,
    expectedVersion: "0.7.10",
    execute: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.archivedCount, 1);
  assert.equal(existsSync(active), true);
  assert.equal(existsSync(join(skills, "relo-notifications.before-update")), false);
  assert.equal(existsSync(join(archive, "relo-notifications.before-update", "sentinel")), true);
  assert.throws(() => archiveSkillSnapshots({
    skillsDir: skills,
    archiveDir: join(skills, "archives"),
    expectedVersion: "0.7.10",
    execute: true,
  }), /outside the skill discovery root/);
  cpSync(active, join(skills, "relo-notifications.rejected"), { recursive: true });
  assert.throws(() => archiveSkillSnapshots({
    skillsDir: skills,
    archiveDir: archive,
    expectedVersion: "0.7.10",
    execute: false,
  }), /requires --execute/);
});
