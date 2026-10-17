import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EXIT } from "../src/shared/errors.mjs";
import { compactData } from "../src/shared/output.mjs";
import { execute, run, overrides } from "./cli-fixtures.mjs";

const TOKEN = `relo_${"c".repeat(43)}`;

function client() {
  const calls = [];
  return { calls, request: async (method, path, options = {}) => {
    calls.push([method, path, options.body]);
    if (method === "POST") return { token: TOKEN, credential: { id: "key_123456789012", name: options.body.name, scopes: options.body.scopes ?? ["notifications:send"], expiresAt: "2026-11-14T00:00:00.000Z" } };
    if (method === "GET") return { tokens: [{ id: "key_123456789012", name: "Deploy", scopes: ["notifications:send"], expiresAt: "2026-11-14T00:00:00.000Z", lastUsedAt: null }] };
    return { revoked: true };
  } };
}

test("relo auth token create sends the name, scopes and expiry in days; list and revoke", async () => {
  const api = client();
  const made = await execute(["auth", "token", "create", "--client-name", "Deploy", "--scope", "notifications:send", "--expires-in", "7d"], overrides(api));
  assert.equal(made.data.token, TOKEN);
  assert.deepEqual(api.calls[0], ["POST", "/api/credentials", { name: "Deploy", scopes: ["notifications:send"], expiresInDays: 7 }]);
  const listed = await execute(["auth", "token", "list"], overrides(api));
  assert.deepEqual(compactData("auth.token.list", listed.data).tokens[0], { id: "key_123456789012", name: "Deploy", scopes: ["notifications:send"], expiresAt: "2026-11-14T00:00:00.000Z" });
  await execute(["auth", "token", "revoke", "key_123456789012"], overrides(api));
  assert.deepEqual(api.calls.at(-1), ["DELETE", "/api/credentials/key_123456789012", undefined]);
});

test("--secret-file keeps the token out of the output; an expiry past the maximum is refused before sending", async () => {
  const api = client();
  const directory = await mkdtemp(join(tmpdir(), "relo-ci-token-"));
  const path = join(directory, "token");
  const made = await execute(["auth", "token", "create", "--client-name", "CI", "--secret-file", path], overrides(api));
  assert.equal(made.data.token, undefined);
  assert.equal(await readFile(path, "utf8"), `${TOKEN}\n`);
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.equal(api.calls[0][2].expiresInDays, 30);
  const refused = await run(["auth", "token", "create", "--client-name", "CI", "--expires-in", "365d"], { stdout: () => {}, stderr: () => {} }, overrides(api));
  assert.equal(refused, EXIT.USAGE);
  assert.equal(api.calls.length, 1);
  await rm(directory, { recursive: true, force: true });
});

test("relo auth token rotate posts to the token's rotate route; --secret-file keeps the new token out of the output", async () => {
  const api = client();
  api.request = async (method, path, options = {}) => { api.calls.push([method, path, options.body]); return { token: TOKEN, credential: { id: "key_123456789012", name: "Deploy", expiresAt: "2026-11-14T00:00:00.000Z" } }; };
  const shown = await execute(["auth", "token", "rotate", "key_123456789012"], overrides(api));
  assert.equal(shown.data.token, TOKEN);
  assert.deepEqual(api.calls[0], ["POST", "/api/credentials/key_123456789012/rotate", {}]);
  const directory = await mkdtemp(join(tmpdir(), "relo-ci-rotate-"));
  const path = join(directory, "token");
  const filed = await execute(["auth", "token", "rotate", "key_123456789012", "--secret-file", path], overrides(api));
  assert.equal(filed.data.token, undefined);
  assert.equal(await readFile(path, "utf8"), `${TOKEN}\n`);
  assert.equal(await run(["auth", "token", "rotate", "nope"], { stdout: () => {}, stderr: () => {} }, overrides(api)), EXIT.USAGE);
  await rm(directory, { recursive: true, force: true });
});
