import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { findDesktopTitle, desktopSessions } from "../src/harness/adapters/claude-code/desktop-title.mjs";

const home = () => mkdtempSync(join(tmpdir(), "relo-desktop-"));
const folder = (root, account = "acct-1", org = "org-1") => {
  const dir = join(root, "Library", "Application Support", "Claude", "claude-code-sessions", account, org);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const put = (dir, name, body) => writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body));

test("findDesktopTitle returns the sidebar title for a session id", () => {
  const root = home();
  const dir = folder(root);
  put(dir, "local_a.json", { cliSessionId: "sess-one", title: "Plan the quarterly review" });
  put(dir, "local_b.json", { cliSessionId: "sess-two", title: "Fix the importer" });
  assert.equal(findDesktopTitle({ sessionId: "sess-two", home: root }), "Fix the importer");
  assert.equal(findDesktopTitle({ sessionId: "sess-none", home: root }), undefined);
  assert.equal(findDesktopTitle({ sessionId: "../escape", home: root }), undefined);
});

test("no Desktop folder is no title, not an error", () => {
  assert.equal(findDesktopTitle({ sessionId: "sess-one", home: home() }), undefined);
  assert.equal(desktopSessions({ home: home() }).size, 0);
});

test("a malformed or untitled file is skipped and the rest are read", () => {
  const root = home();
  const dir = folder(root);
  put(dir, "local_bad.json", "{not json");
  put(dir, "local_empty.json", { cliSessionId: "sess-empty", title: "" });
  put(dir, "local_other.txt", { cliSessionId: "sess-text", title: "Not a session file" });
  put(dir, "local_ok.json", { cliSessionId: "sess-ok", title: "Review the release notes" });
  assert.equal(findDesktopTitle({ sessionId: "sess-ok", home: root }), "Review the release notes");
  assert.equal(findDesktopTitle({ sessionId: "sess-empty", home: root }), undefined);
  assert.equal(findDesktopTitle({ sessionId: "sess-text", home: root }), undefined);
});

test("the scan opens at most the given number of files", () => {
  const root = home();
  const dir = folder(root);
  for (let index = 0; index < 5; index += 1) put(dir, `local_${index}.json`, { cliSessionId: `sess-${index}`, title: `Session number ${index}` });
  assert.equal(desktopSessions({ home: root, limit: 3 }).size, 3);
  assert.equal(desktopSessions({ home: root }).size, 5);
});
