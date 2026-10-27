import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import test from "node:test";
import { execute, overrides, CONFIG, issuedCredential } from "./cli-fixtures.mjs";
import { VERSION } from "../src/version.mjs";

const client = (ready = async () => ({ status: "ok" })) => ({
  ready, authStatus: async () => ({ authenticated: true, credential: issuedCredential().credential }),
  doctor: async () => ({ version: 1, ok: true, checks: {} }),
});
const LOCAL = { ...CONFIG, apiUrl: "http://127.0.0.1:4815", local: true };
const facts = (patch = {}) => ({ health: { release: "1.2.0+45" }, app: { path: "/Applications/Relo.app", version: "1.2.0+45" }, bundledCli: VERSION, ...patch });
const run = (config, localFacts, extra = {}) => execute(["doctor"], { ...overrides(client(extra.ready)), loadConfig: async () => config, localFacts: async () => localFacts, env: { RELO_UPDATES: "managed" } });

test("local doctor: a ready server matching the app is healthy", async () => {
  const output = await run(LOCAL, facts());
  const local = output.data.checks.local;
  assert.equal(local.server, "ready");
  assert.equal(local.release, "1.2.0+45");
  assert.equal(local.app.path, "/Applications/Relo.app");
  assert.equal(local.versionsMatch, true);
  assert.equal(local.cli.match, true);
  assert.equal(local.updates, "managed");
  assert.equal(output.data.warnings.localVersion, undefined);
  assert.equal(output.data.ok, true);
});

test("local doctor: an unreachable server is not ready and says to open the app", async () => {
  const output = await run(LOCAL, facts({ health: null }), { ready: async () => { throw new Error("refused"); } });
  assert.equal(output.data.checks.local.server, "unreachable");
  assert.equal(output.data.checks.local.hint, "Open Relo for Mac: it starts its server");
  assert.equal(output.data.ok, false);
  assert.equal(output.data.ready, false);
  assert.equal(output.data.next, undefined);
});

test("local doctor: a version mismatch is a warning, not a failure", async () => {
  const output = await run(LOCAL, facts({ health: { release: "1.1.0+40" } }));
  assert.equal(output.data.checks.local.versionsMatch, false);
  assert.equal(output.data.ok, true);
  assert.equal(output.data.warnings.localVersion.hint, "Quit and reopen Relo for Mac to restart its server");
});

test("local doctor: other accounts are unchanged", async () => {
  const remote = await run(CONFIG, facts());
  assert.equal(remote.data.checks.local, undefined);
  const nonLoopback = await run({ ...CONFIG, local: true }, facts());
  assert.equal(nonLoopback.data.checks.local, undefined);
  const unmarked = await run({ ...CONFIG, apiUrl: "http://127.0.0.1:4815" }, facts());
  assert.equal(unmarked.data.checks.local, undefined);
});
