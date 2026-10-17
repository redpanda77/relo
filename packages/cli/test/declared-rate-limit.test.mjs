import "./hermetic-env.mjs";
// Plan 10 C3: a work write the server rate-limits is queued like an offline one (sent in order once the
// wait is over), never thrown at the agent; any other refusal still is.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pending } from "../src/outbox/index.mjs";
import { declaredLane } from "../src/work/declared-lane.mjs";

const SERVER = "https://relo.example.test";
const form = { route: { method: "PATCH", path: "/api/session/works/current" }, key: "k-1", seal: "never", readable: { status: "Reproducing" } };

async function laneAnswering(status, payload) {
  const directory = await mkdtemp(join(tmpdir(), "relo-declared-429-"));
  const fetchImpl = async () => new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  const client = { apiUrl: SERVER, token: "relo_test", version: "test", request: async () => ({}), fetchImpl };
  const lane = declaredLane({ client, config: { apiUrl: SERVER }, dependencies: { outboxDirectory: directory },
    identity: { sessionKey: "session-1", harness: "claude-code" }, sealer: async () => undefined });
  return { lane, directory };
}

test("a 429 queues the write instead of failing the command", async () => {
  const { lane, directory } = await laneAnswering(429, { error: "rate_limited", scope: "client", retryAfterSeconds: 40 });
  assert.equal(await lane.write(form), null);
  assert.equal(lane.queued, true);
  assert.equal((await pending({ directory })).declared, 1);
});

test("a refusal that is about the write itself is still thrown", async () => {
  const { lane, directory } = await laneAnswering(422, { error: "invalid_request" });
  await assert.rejects(lane.write(form));
  assert.equal((await pending({ directory })).declared, 0);
});
