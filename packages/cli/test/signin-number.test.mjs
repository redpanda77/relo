import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { signinNumber } from "../src/crypto/signin-number.mjs";
import { ephemeralEnvironment } from "../src/harness/catalog.mjs";
import { UsageError } from "../src/shared/errors.mjs";
import { execute, CONFIG, authorizationStart, issuedCredential } from "./cli-fixtures.mjs";

const vectors = JSON.parse(readFileSync(new URL("../../contracts/fixtures/signin-number-v1.json", import.meta.url), "utf8"));

test("the sign-in number matches the shared vectors", () => {
  assert.ok(vectors.length >= 3);
  for (const { userCode, identityKey, number } of vectors) assert.equal(signinNumber(userCode, identityKey), number);
});

test("auth login sends the identity key first and prints the number", async () => {
  let body;
  const lines = [];
  await execute(["auth", "login", "--no-open", "--client-name", "Mac Codex", "--scope", "notifications:send", "--scope", "interactions:create", "--scope", "interactions:read"], {
    env: { RELO_API_URL: "http://192.168.1.10:8180", RELO_KEY_STORE_PATH: join(mkdtempSync(join(tmpdir(), "signin-")), "e2ee.json") },
    configPath: () => CONFIG.path, configRevision: async () => null, computerName: () => undefined,
    clientFactory: () => ({
      startDeviceAuthorization: async (b) => { body = b; return authorizationStart(); },
      pollDeviceAuthorization: async () => issuedCredential(),
    }),
    now: () => 0, sleep: async () => {}, writeConfig: async () => {}, stderr: (line) => lines.push(line),
  });
  assert.match(body.identityKey, /^[A-Za-z0-9_-]{87}$/u);
  const number = signinNumber(authorizationStart().userCode, body.identityKey);
  assert.ok(lines.includes(`Number on your phone: ${number}`), lines.join("\n"));
  assert.ok(lines.includes("Approve it in the Relo app (scan or type the code) or open the link."));
});

test("a cloud sandbox is refused before any network call", async () => {
  assert.equal(ephemeralEnvironment({ CLAUDE_CODE_REMOTE: "true" })?.label, "Claude Code on the web");
  assert.equal(ephemeralEnvironment({ CLAUDE_CODE_REMOTE: "false" }), undefined);
  assert.equal(ephemeralEnvironment({}), undefined);
  for (const argv of [["auth", "login"], ["auth", "join", `rci_${"a".repeat(32)}`]]) {
    let called = false;
    await assert.rejects(execute(argv, {
      env: { RELO_API_URL: "http://192.168.1.10:8180", CLAUDE_CODE_REMOTE: "true" },
      configPath: () => CONFIG.path, configRevision: async () => null,
      clientFactory: () => { called = true; return {}; },
    }), (error) => error instanceof UsageError
      && error.message === "This looks like a cloud sandbox (Claude Code on the web), not a computer. Use a CI token there: set RELO_API_URL and RELO_TOKEN.");
    assert.equal(called, false);
  }
});

test("auth login --wait prints the number stored with the pending login", async () => {
  const lines = [];
  const pending = { version: 1, apiUrl: "http://192.168.1.10:8180", deviceCode: "d".repeat(43), userCode: "ABCD-EFGH", url: "http://192.168.1.10:8180/cli/authorize?code=ABCD-EFGH",
    number: "46", clientName: "Mac Codex", scopes: ["notifications:send"], intervalSeconds: 5, expiresAtMs: 600_000 };
  await execute(["auth", "login", "--wait"], {
    env: { RELO_API_URL: "http://192.168.1.10:8180" },
    configPath: () => CONFIG.path, configRevision: async () => null, computerName: () => undefined,
    pendingLogin: { read: async () => pending, write: async () => {}, clear: async () => {} },
    clientFactory: () => ({ pollDeviceAuthorization: async () => issuedCredential() }),
    now: () => 0, sleep: async () => {}, writeConfig: async () => {}, stderr: (line) => lines.push(line),
  }).catch(() => {});
  assert.ok(lines.includes("Code ABCD-EFGH. Number on your phone: 46"), lines.join("\n"));
});
