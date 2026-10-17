import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sessionNamesDiffer } from "../src/owner/doctor.mjs";
import { sessionKey } from "../src/shared/session-key.mjs";

const NOW = Date.parse("2026-10-17T12:00:00Z");

/** A throwaway home with Claude Code's own title files and Desktop's session files; sessions: [{id, relo, sidebar, phase, seen}]. */
function fixture(sessions, { desktop = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), "relo-names-"));
  const observed = join(home, "observed");
  mkdirSync(observed, { recursive: true });
  const desktopDir = join(home, "Library", "Application Support", "Claude", "claude-code-sessions", "acct", "org");
  if (desktop) mkdirSync(desktopDir, { recursive: true });
  for (const { id, relo, sidebar, phase = "open", seen = "2026-10-17T11:00:00Z" } of sessions) {
    const key = sessionKey({ harness: "claude-code", id });
    writeFileSync(join(observed, `${key.slice(0, 32)}.json`), JSON.stringify({ v: 1, session: key, harness: "claude-code", phase, lastSeenAt: seen }));
    if (relo) {
      const dir = join(home, ".claude", "projects", "-work-sample", id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "custom-title.json"), JSON.stringify({ customTitle: relo }));
    }
    if (desktop && sidebar) writeFileSync(join(desktopDir, `local_${id}.json`), JSON.stringify({ cliSessionId: id, title: sidebar, cwd: "/work/sample" }));
  }
  return { home, dependencies: { home, caller: { type: "script" }, env: {}, cwd: "/work/sample", observedStateDirectory: observed, now: () => NOW } };
}

test("matching names raise no warning", async () => {
  const { dependencies } = fixture([{ id: "sess-a", relo: "Mobile web experience", sidebar: "Mobile web experience" }]);
  assert.deepEqual(await sessionNamesDiffer(dependencies), {});
});

test("a differing name is counted, with both names kept for the local output only", async () => {
  const { dependencies } = fixture([
    { id: "sess-a", relo: "Mobile web experience", sidebar: "Command line in the cloud" },
    { id: "sess-b", relo: "Same name here", sidebar: "Same name here" },
    { id: "sess-c", relo: "Another old name", sidebar: "Another new name" },
  ]);
  const { sessionNamesDiffer: warning } = await sessionNamesDiffer(dependencies);
  assert.equal(warning.ok, false);
  assert.equal(warning.state, "2 sessions named differently from the Claude Desktop sidebar");
  assert.equal(warning.count, 2);
  assert.match(warning.hint, /follow the sidebar/u);
  assert.equal(warning.hint.includes("Mobile web experience"), false, "names are not in the hint");
});

test("an agent session or unidentified caller gets no names", async () => {
  const { dependencies } = fixture([{ id: "sess-a", relo: "Mobile web experience", sidebar: "Command line in the cloud" }]);
  assert.deepEqual(await sessionNamesDiffer({ ...dependencies, caller: { type: "agent_session", harness: "claude-code", sessionId: "sess-z", sessionKey: "k" } }), {});
  assert.deepEqual(await sessionNamesDiffer({ ...dependencies, caller: { type: "unidentified", reason: "no_session_id" } }), {});
  assert.ok((await sessionNamesDiffer({ ...dependencies, caller: { type: "script" } })).sessionNamesDiffer, "the owner's terminal still sees them");
});

test("ended, stale and Desktop-less sessions are not compared", async () => {
  const { dependencies } = fixture([
    { id: "sess-a", relo: "Old name one", sidebar: "New name one", phase: "ended" },
    { id: "sess-b", relo: "Old name two", sidebar: "New name two", seen: "2026-10-15T11:00:00Z" },
    { id: "sess-c", relo: "Old name three" },
  ]);
  assert.deepEqual(await sessionNamesDiffer(dependencies), {});
});

test("no Desktop folder and a malformed Desktop file are tolerated", async () => {
  const none = fixture([{ id: "sess-a", relo: "Old name one", sidebar: "New name one" }], { desktop: false });
  assert.deepEqual(await sessionNamesDiffer(none.dependencies), {});
  const bad = fixture([{ id: "sess-a", relo: "Old name one" }]);
  writeFileSync(join(bad.home, "Library", "Application Support", "Claude", "claude-code-sessions", "acct", "org", "local_x.json"), "{oops");
  assert.deepEqual(await sessionNamesDiffer(bad.dependencies), {});
  assert.deepEqual(await sessionNamesDiffer({ ...bad.dependencies, observedStateDirectory: join(bad.home, "missing") }), {});
});
