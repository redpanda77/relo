import "./hermetic-env.mjs";
// ADR 0008 principles 11 and 12 over caller detection (src/caller.mjs): identity comes from the harness,
// never from the producer's say-so, and each producer type is served by its own module.
import assert from "node:assert/strict";
import test from "node:test";
import { CALLER_TYPES, cardOwner, detectCaller, surfaceFor } from "../src/caller.mjs";
import { sessionKey } from "../src/shared/session-key.mjs";
import { guardWorkFlags } from "../src/agent/guards.mjs";
import { execute } from "../src/cli.mjs";
import { COMMANDS } from "../src/registry.mjs";

test("principle 11: the same id under another harness is another session", () => {
  assert.notEqual(sessionKey({ harness: "claude-code", id: "abc" }), sessionKey({ harness: "codex", id: "abc" }));
  assert.equal(sessionKey({ harness: "codex", id: "abc" }), sessionKey({ harness: "codex", id: "abc" }));
});

test("principle 11: --name and RELO_SESSION never change an agent session's identity", () => {
  const plain = detectCaller({ CODEX_THREAD_ID: "t-1" });
  const claimed = detectCaller({ CODEX_THREAD_ID: "t-1", RELO_SESSION: "someone-else" }, { name: "other" });
  assert.equal(claimed.type, CALLER_TYPES.AGENT_SESSION);
  assert.equal(claimed.sessionKey, plain.sessionKey);
});

test("principle 11: a harness without an id is unidentified, and RELO_SESSION cannot name a session for it", () => {
  const caller = detectCaller({ GEMINI_CLI: "1", RELO_SESSION: "borrowed" });
  assert.equal(caller.type, CALLER_TYPES.UNIDENTIFIED);
  assert.equal(cardOwner(caller), undefined);
});

test("principle 11: --name types a script but never makes it an agent session", () => {
  const caller = detectCaller({}, { name: "nightly-backup" });
  assert.deepEqual(caller, { type: CALLER_TYPES.SCRIPT, producerKey: "nightly-backup" });
  assert.equal(cardOwner(caller), undefined);
});

test("principle 11: the MCP connection id yields to a harness id", () => {
  assert.equal(detectCaller({ RELO_MCP_SESSION: "m-1" }).harness, "mcp");
  assert.equal(detectCaller({ RELO_MCP_SESSION: "m-1", CLAUDE_CODE_SESSION_ID: "c-1" }).harness, "claude-code");
});

test("principle 12: each caller type is routed to its own producer module", () => {
  assert.equal(surfaceFor(detectCaller({ CLAUDE_CODE_SESSION_ID: "c-1" })), "agent");
  assert.equal(surfaceFor(detectCaller({ CLAUDECODE: "1" })), "agent");
  assert.equal(surfaceFor(detectCaller({})), "script");
  assert.equal(surfaceFor(detectCaller({ RELO_SESSION: "s-1" })), "script");
});

test("principle 11: cross-session views and this computer's setup are the owner's: every owner-only verb is refused to agent callers", async () => {
  const ownerOnly = COMMANDS.filter((entry) => entry.ownerOnly).map((entry) => entry.name);
  assert.deepEqual(ownerOnly.sort(), ["activity diagnose", "activity get", "activity list", "activity status", "config", "listen", "sessions"]);
  for (const env of [{ CLAUDE_CODE_SESSION_ID: "c-1" }, { CLAUDECODE: "1" }]) {
    for (const name of ownerOnly) {
      await assert.rejects(execute(name.split(" "), { env, loadConfig: async () => { throw new Error("never signs in"); } }),
        (error) => error.code === "OWNER_ONLY", name);
    }
  }
});

test("principles 3 and 11: a session cannot name, re-time or heartbeat its work like a script", () => {
  const caller = detectCaller({ CLAUDE_CODE_SESSION_ID: "c-1" });
  const refuse = (options, verb = "start") => assert.throws(() => guardWorkFlags({ verb, options, positionals: [], argv: ["work", verb], caller, state: "" }));
  refuse({ name: "other-session" });
  refuse({ producer: "nightly" });
  refuse({ "idempotency-key": "k" });
  refuse({ lease: "60" });
  refuse({ "stale-after": "5m" });
  refuse({}, "heartbeat");
  refuse({ work: "wrk_x" }, "update");
  assert.doesNotThrow(() => guardWorkFlags({ verb: "start", options: {}, positionals: [], argv: ["work", "start"], caller, state: "" }));
});
