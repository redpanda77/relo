import "./hermetic-env.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withSessionNotes } from "../src/agent/session-notes.mjs";
import { trustNotices } from "../src/crypto/trust.mjs";

const agent = (key) => ({ type: "agent_session", harness: "claude-code", sessionId: key, sessionKey: key });

test("a trust note is shown once per agent session; keys status and other callers always see it", async () => {
  const state = await mkdtemp(join(tmpdir(), "relo-seen-"));
  const api = "https://relo.test";
  const store = { trusted: { [`${api}|dev_aaaaaaaaaaaaaaaa`]: { deviceId: "dev_aaaaaaaaaaaaaaaa", level: "pending", name: "iPhone" } } };
  const [note] = trustNotices(store, api, Date.now());
  assert.ok(note);
  const output = { command: "activity.update", notes: [note, "status shortened to 60 characters"] };
  const deps = (key) => ({ caller: agent(key), env: { RELO_STATE_DIR: state, HOME: state }, home: state, version: "0.0.0" });
  assert.deepEqual((await withSessionNotes(output, deps("s1"))).notes, [note, "status shortened to 60 characters"]);
  assert.deepEqual((await withSessionNotes(output, deps("s1"))).notes, ["status shortened to 60 characters"]);
  assert.deepEqual((await withSessionNotes(output, deps("s2"))).notes, [note, "status shortened to 60 characters"]);
  assert.deepEqual((await withSessionNotes({ ...output, command: "keys.status" }, deps("s1"))).notes, output.notes);
  assert.deepEqual((await withSessionNotes(output, { ...deps("s1"), caller: { type: "script" } })).notes, output.notes);
});

test("the skill version warning appears once per agent session", async () => {
  const home = await mkdtemp(join(tmpdir(), "relo-skill-"));
  const skill = join(home, ".claude", "skills", "relo-notifications");
  await mkdir(skill, { recursive: true });
  await writeFile(join(skill, "SKILL.md"), "---\nname: relo-notifications\nmetadata:\n  version: 0.0.1\n---\n");
  await writeFile(join(skill, "VERSION"), "0.0.1\n");
  const deps = { caller: agent("s3"), env: { RELO_STATE_DIR: home, HOME: home }, home, version: "9.9.9" };
  const first = await withSessionNotes({ command: "activity.update" }, deps);
  const second = await withSessionNotes({ command: "activity.update" }, deps);
  assert.equal(first.notes?.length, 1, JSON.stringify(first));
  assert.match(first.notes[0], /9\.9\.9/u);
  assert.equal(second.notes, undefined);
});
