import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { run } from "../src/cli.mjs";

const TOKEN = "t".repeat(44);
const PHONE = { verifiedAt: "2026-10-01T10:00:00.000Z", deviceId: "dev_abcdefghijkl" };
const principal = { id: "key_0123456789ab", name: "Studio", scopes: ["activities:read"], expiresAt: "2027-01-01T00:00:00Z" };
const SHAPES = {
  legacy: { version: 1, apiUrl: "https://home.example", token: TOKEN, principal, phoneTest: PHONE, accounts: { "/x/.claude": "me" } },
  migrated: { version: 1, activeProfile: "default", accounts: { "/x/.claude": "me" }, computerName: "Studio",
    profiles: { default: { version: 1, apiUrl: "https://home.example", token: TOKEN, principal, phoneTest: PHONE } } },
};

async function doctor(shape, devices) {
  const dir = await mkdtemp(join(tmpdir(), "relo-legacy-"));
  const path = join(dir, "config.json");
  await writeFile(path, JSON.stringify(SHAPES[shape]), { mode: 0o600 });
  const client = { ready: async () => ({ ready: true }), doctor: async () => ({ version: 1, ok: true }),
    authStatus: async () => ({ authenticated: true, credential: { id: "c", clientName: "S", prefix: "p", scopes: ["activities:read", "activities:write", "devices:read"] } }),
    listDevices: async () => ({ hasMore: false, cursor: null, devices }) };
  const out = [];
  await run(["doctor"], { stdout: (line) => out.push(line), stderr: () => {}, stdoutIsTTY: false }, { env: { RELO_CONFIG_PATH: path }, clientFactory: () => client });
  return JSON.parse(out[0]);
}

for (const shape of Object.keys(SHAPES)) {
  test(`doctor is ready with a remembered phone test in the ${shape} config shape`, async () => {
    const line = await doctor(shape, [{ deviceId: PHONE.deviceId, liveActivityAuthorization: "authorized" }]);
    assert.equal(line.ready, true);
    assert.notEqual(line.next?.step, "test");
  });
  test(`doctor keeps a confirmed test when the phone re-registers under a new ID (${shape})`, async () => {
    const line = await doctor(shape, [{ deviceId: "dev_zzzzzzzzzzzz", liveActivityAuthorization: "authorized" }]);
    assert.notEqual(line.next?.step, "test");
  });
}
