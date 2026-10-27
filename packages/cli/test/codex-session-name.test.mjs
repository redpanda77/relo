import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import codex from "../src/harness/adapters/codex/index.mjs";
import { codexSessionName } from "../src/harness/adapters/codex/session-name.mjs";

const THREAD = "019d3ab6-59d0-7722-9060-3adfa42fe4cf";
const line = (id, thread_name) => JSON.stringify({ id, thread_name, updated_at: "2026-10-02T10:59:19.19732Z" });

function codexHome(t, lines) {
  const root = mkdtempSync(join(tmpdir(), "relo-codex-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  if (lines) writeFileSync(join(root, "session_index.jsonl"), `${lines.join("\n")}\n`);
  return root;
}

test("the newest index line for the thread names it, via CODEX_HOME", (t) => {
  const root = codexHome(t, [line(THREAD, "First name"), line("other", "Someone else"), line(THREAD, "Fix the login bug")]);
  assert.equal(codexSessionName({ sessionId: THREAD, env: { CODEX_HOME: root }, home: "/nonexistent" }), "Fix the login bug");
});

test("without CODEX_HOME the index is read from ~/.codex", (t) => {
  const home = mkdtempSync(join(tmpdir(), "relo-codex-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(join(home, ".codex"));
  writeFileSync(join(home, ".codex", "session_index.jsonl"), `${line(THREAD, "Home named")}\n`);
  assert.equal(codexSessionName({ sessionId: THREAD, env: {}, home }), "Home named");
});

test("no index, no entry, a path or a bad line gives no name", (t) => {
  assert.equal(codexSessionName({ sessionId: THREAD, env: { CODEX_HOME: codexHome(t) } }), undefined);
  const root = codexHome(t, ["not json", line("other", "Someone else"), line(THREAD, "/Users/someone/private/file")]);
  assert.equal(codexSessionName({ sessionId: THREAD, env: { CODEX_HOME: root } }), undefined);
  assert.equal(codexSessionName({ sessionId: "../x", env: { CODEX_HOME: root } }), undefined);
});

test("the adapter exposes it as sessionTitle from hook input", (t) => {
  const root = codexHome(t, [line(THREAD, "Ship the release")]);
  assert.equal(codex.sessionTitle({ session_id: THREAD }, { env: { CODEX_HOME: root }, home: "/nonexistent" }), "Ship the release");
});
