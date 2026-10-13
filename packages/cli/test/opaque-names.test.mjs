import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateKeyPair } from "../src/e2ee.mjs";
import { groupingKey, HANDLE_PATTERN, loadKnownNames, nameHandle, opaqueContext, rememberNames } from "../src/opaque-names.mjs";

test("handles are stable per computer, case-insensitive, unguessable without the key", () => {
  const key = groupingKey(generateKeyPair().privateKey);
  const other = groupingKey(generateKeyPair().privateKey);
  const handle = nameHandle(key, "p", "Relo");
  assert.match(handle, HANDLE_PATTERN);
  assert.equal(nameHandle(key, "p", "  relo "), handle);
  assert.notEqual(nameHandle(key, "t", "Relo"), handle, "a topic and a project with the same name differ");
  assert.notEqual(nameHandle(other, "p", "Relo"), handle, "another computer's key gives another handle");
  assert.equal(handle, handle.toLowerCase(), "the server's case folding keeps it intact");
});

test("opaque context replaces names, keeps handles, and never sends a plain hash of names", () => {
  const key = groupingKey(generateKeyPair().privateKey);
  const { context, names } = opaqueContext({ providerName: "Codex", project: "relo", threadName: "Release 0.12", taskTitle: "Ship it",
    computer: "studio", providerThreadId: "cli-topic:plain" }, key);
  assert.match(context.project, /^p-/);
  assert.match(context.threadName, /^t-/);
  assert.match(context.taskTitle, /^w-/);
  assert.equal(context.providerName, "Codex");
  assert.match(context.computer, /^c-[a-z2-7]{16}$/);
  assert.notEqual(context.providerThreadId, "cli-topic:plain");
  assert.deepEqual(Object.values(names).sort(), ["Release 0.12", "Ship it", "relo", "studio"]);
  const again = opaqueContext(context, key, names);
  assert.deepEqual(again.context.project, context.project, "a context read back from the server stays as it is");
  assert.equal(again.names[context.project], "relo");
  assert.equal(opaqueContext(undefined, key).context, undefined);
});

test("the names this computer made are remembered privately", async () => {
  const folder = mkdtempSync(join(tmpdir(), "relo-names-"));
  const env = { RELO_SEALED_CARD_DIR: join(folder, "state", "cards") };
  try {
    await rememberNames(env, { "p-aaaaaaaaaaaaaaaa": "relo" });
    await rememberNames(env, { "t-bbbbbbbbbbbbbbbb": "Release" });
    assert.deepEqual(await loadKnownNames(env), { "p-aaaaaaaaaaaaaaaa": "relo", "t-bbbbbbbbbbbbbbbb": "Release" });
    assert.equal(statSync(join(folder, "state", "names.json")).mode & 0o777, 0o600);
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
