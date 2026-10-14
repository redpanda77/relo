import "./hermetic-env.mjs";
// One sessionKey() for the CLI and `relo hook` (STATE-SPEC 4.1): the same harness and id give the same key
// whether read from the agent's shell or from hook stdin; RELO_SESSION never overrides a harness; nested
// harness ids leave the caller unidentified.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { adapterFor } from "../src/harness/adapters/index.mjs";
import { processHook } from "../src/harness/core/process.mjs";
import { queuedEntries } from "./hook-fixture.mjs";
import { CALLER_TYPES, cardOwner, detectCaller, sessionKey, waitsShort } from "../src/caller.mjs";
import { agentSession, cardKey, inAgentContext } from "../src/identity.mjs";

const ID = "4d1e0c2a-7b9f-4e51-9a0d-2f6c8b3e1a77";

async function hookKey(sessionId, env = {}) {
  const state = await mkdtemp(join(tmpdir(), "relo-session-key-"));
  const outcome = await processHook({
    adapter: adapterFor("claude-code"), named: "start",
    input: { session_id: sessionId, hook_event_name: "SessionStart" },
    dependencies: {
      env, hookStateDirectory: join(state, "hooks"), observedStateDirectory: join(state, "observed"),
      outboxDirectory: join(state, "outbox"), now: () => 1_800_000_000_000, configPath: () => join(state, "config.json"),
      loadConfig: async () => ({ apiUrl: "https://relo.example", token: "x".repeat(44), computerName: "Mac" }),
      spawnFlusher: () => {},
    },
  });
  assert.equal(outcome.queued, true, JSON.stringify(outcome));
  const [entry] = await queuedEntries(join(state, "outbox"));
  return entry.body.session;
}

const agentSessionOf = (harness, id) => ({ type: CALLER_TYPES.AGENT_SESSION, harness, sessionId: id, sessionKey: sessionKey({ harness, id }) });
const UNIDENTIFIED = (reason, extra = {}) => ({ type: CALLER_TYPES.UNIDENTIFIED, reason, ...extra });

test("Claude Code: the Bash env id and the hook session_id give one identical key", async () => {
  const shell = detectCaller({ CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "cli", CLAUDE_CODE_SESSION_ID: ` ${ID} ` });
  assert.deepEqual(shell, agentSessionOf("claude-code", ID));
  assert.equal(await hookKey(ID), shell.sessionKey);
  assert.equal(await hookKey(` ${ID}\n`), shell.sessionKey, "both sides trim the id the same way");
  assert.notEqual(await hookKey("another-session"), shell.sessionKey);
});

test("RELO_SESSION is ignored inside Claude Code, by the CLI and by the hook", async () => {
  const claude = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: ID };
  const pinned = detectCaller({ ...claude, RELO_SESSION: "someone-else" }, { name: "my-card" });
  assert.deepEqual(pinned, agentSessionOf("claude-code", ID), "neither RELO_SESSION nor --name changes the type");
  assert.equal(cardKey({ env: { ...claude, RELO_SESSION: "someone-else" } }), cardKey({ env: claude }));
  assert.equal(await hookKey(ID, { RELO_SESSION: "someone-else" }), pinned.sessionKey);
  // A harness without a shell id (markers only) is unidentified rather than taking RELO_SESSION.
  for (const [marker, agent] of [[{ CLAUDECODE: "1" }, "Claude Code"], [{ GEMINI_CLI: "1" }, "Gemini CLI"],
    [{ CURSOR_AGENT: "1" }, "Cursor"], [{ OPENCODE: "1" }, "OpenCode"]]) {
    const caller = detectCaller({ ...marker, RELO_SESSION: "someone-else" });
    assert.deepEqual(caller, UNIDENTIFIED("no_session_id", { agent }));
    assert.equal(cardOwner(caller), undefined);
    assert.equal(waitsShort(caller), true);
  }
});

test("a script is typed by RELO_SESSION or --name, only without a harness", () => {
  assert.deepEqual(detectCaller({ RELO_SESSION: " s-1 " }), { type: CALLER_TYPES.SCRIPT, producerKey: "s-1", session: "s-1" });
  assert.deepEqual(detectCaller({ RELO_SESSION: "s-1" }, { name: "nightly" }), { type: CALLER_TYPES.SCRIPT, producerKey: "nightly", session: "s-1" });
  assert.deepEqual(detectCaller({}, { name: "nightly" }), { type: CALLER_TYPES.SCRIPT, producerKey: "nightly" });
  assert.deepEqual(detectCaller({}), { type: CALLER_TYPES.SCRIPT });
  assert.deepEqual(detectCaller({ RELO_SESSION: "   " }), { type: CALLER_TYPES.SCRIPT });
  assert.equal(waitsShort(detectCaller({})), false, "the owner's shell keeps long waits");
  assert.equal(waitsShort(detectCaller({ RELO_SESSION: "s-1" })), true);
  assert.deepEqual(cardOwner(detectCaller({ RELO_SESSION: "s-1" })), { label: "relo", id: "s-1" });
});

test("nested Claude Code and Codex ids: unidentified, no shared session state, never another session's card", () => {
  const nested = { CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: ID, CODEX_THREAD_ID: "thread-9", RELO_SESSION: "s-1" };
  assert.deepEqual(detectCaller(nested), UNIDENTIFIED("nested_harnesses"));
  assert.equal(agentSession(nested), null);
  assert.equal(inAgentContext(nested), true, "still an agent shell: waits stay short");
  const context = { providerName: "Claude Code", project: "relo", threadName: "Release" };
  const key = cardKey({ env: nested, context });
  assert.match(key, /^work-/u, "the keyless path: a card named by its topic");
  for (const one of [{ CLAUDE_CODE_SESSION_ID: ID }, { CODEX_THREAD_ID: "thread-9" }, { RELO_SESSION: "s-1" }]) {
    assert.notEqual(key, cardKey({ env: one, context }), JSON.stringify(one));
  }
});

test("Codex keeps its own session as today", () => {
  assert.deepEqual(detectCaller({ CODEX_THREAD_ID: "thread-9", CODEX_CI: "1" }), agentSessionOf("codex", "thread-9"));
  assert.match(cardKey({ env: { CODEX_THREAD_ID: "thread-9" } }), /^session-codex-[0-9a-f]{24}$/u);
});

test("relo mcp: each connection is an agent session; a harness id or an owner's RELO_SESSION outside a harness wins", () => {
  assert.deepEqual(detectCaller({ RELO_MCP_SESSION: "c-1" }), agentSessionOf("mcp", "c-1"));
  assert.deepEqual(detectCaller({ CLAUDECODE: "1", RELO_SESSION: "x", RELO_MCP_SESSION: "c-1" }), agentSessionOf("mcp", "c-1"));
  assert.deepEqual(detectCaller({ CLAUDE_CODE_SESSION_ID: ID, RELO_MCP_SESSION: "c-1" }), agentSessionOf("claude-code", ID));
  assert.equal(detectCaller({ RELO_SESSION: "mine", RELO_MCP_SESSION: "c-1" }).type, CALLER_TYPES.SCRIPT);
});
