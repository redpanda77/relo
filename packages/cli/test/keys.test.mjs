import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runKeysCommand } from "../src/commands/keys.mjs";
import { b64u, generateKeyPair, keyId, prekeySigningInput, safetyNumber, signBytes } from "../src/e2ee.mjs";
import { ensureIdentity, keyStorePath, loadKeyStore } from "../src/keystore.mjs";

const apiUrl = "https://relo.example";

function phone(name = "Owner iPhone", deviceId = "dev_00000000-0000-4000-8000-000000000001") {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = "2026-10-13T16:00:00.000Z";
  const signature = signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }));
  return {
    identity,
    resource: {
      deviceId, name,
      identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
      prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, signature: b64u(signature), stale: false },
    },
  };
}

function harness({ devices, tty = false, answer = false }) {
  const folder = mkdtempSync(join(tmpdir(), "relo-keys-"));
  const published = [];
  const printed = [];
  const state = { devices };
  const dependencies = {
    configPath: () => join(folder, "config.json"),
    env: { RELO_KEY_STORE_PATH: join(folder, "e2ee.json") },
    now: () => Date.parse("2026-10-13T17:00:00.000Z"),
    stdinIsTTY: tty,
    confirm: async () => answer,
    stderr: (line) => printed.push(line),
  };
  const client = {
    publishClientKey: async (body) => { published.push(body); return { keyId: "k" }; },
    listDeviceKeys: async () => ({ devices: state.devices }),
    endToEndPolicy: async () => ({ required: true, mode: "auto" }),
    setEndToEndPolicy: async (required) => ({ required: required !== false, mode: required === null ? "auto" : required ? "on" : "off" }),
  };
  const run = (action, rest = [], overrides = {}) => runKeysCommand({
    group: "keys", action, rest, options: {}, dependencies: { ...dependencies, ...overrides }, client, config: { apiUrl },
  });
  return { folder, published, printed, state, run, storePath: join(folder, "e2ee.json"),
    cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

test("status creates a private identity, publishes it once and trusts the account's phones automatically", async () => {
  const device = phone();
  const h = harness({ devices: [device.resource] });
  try {
    const output = await h.run("status");
    const store = await loadKeyStore(h.storePath);
    assert.equal(statSync(h.storePath).mode & 0o777, 0o600);
    assert.deepEqual(h.published, [{ identityKey: store.identity.publicKey }]);
    assert.equal(output.data.identity.keyId, store.identity.keyId);
    assert.equal(output.data.required, true);
    assert.deepEqual(output.data.devices, [{ deviceId: device.resource.deviceId, name: "Owner iPhone", handle: "owner-iphone",
      keyId: device.resource.identityKey.keyId, trust: "auto", prekey: "fresh" }]);
    await h.run("status");
    assert.equal(h.published.length, 1, "the identity is published once per server");
  } finally {
    h.cleanup();
  }
});

test("a changed security code is trusted again with a notice, unless strict mode holds it", async () => {
  const device = phone();
  const h = harness({ devices: [device.resource], tty: true, answer: true });
  try {
    await h.run("status");
    const reinstalled = phone("Owner iPhone", device.resource.deviceId);
    h.state.devices = [reinstalled.resource];
    const changed = (await h.run("status")).data.devices[0];
    assert.equal(changed.trust, "auto");
    assert.equal(changed.notice.kind, "security_code_changed");
    assert.equal(changed.notice.previousKeyId, device.resource.identityKey.keyId);

    assert.deepEqual((await h.run("strict", ["on"])).data, { strict: true, changed: true });
    h.state.devices = [phone("Owner iPhone", device.resource.deviceId).resource];
    assert.equal((await h.run("status")).data.devices[0].trust, "changed", "strict mode does not re-trust");
    await assert.rejects(h.run("strict", ["off"], { stdinIsTTY: false }), (error) => error.code === "PERSON_REQUIRED");
  } finally {
    h.cleanup();
  }
});

test("verify is an optional upgrade that needs a person and the matching security code", async () => {
  const device = phone();
  const h = harness({ devices: [device.resource], tty: true, answer: true });
  try {
    await assert.rejects(h.run("verify", [device.resource.deviceId], { stdinIsTTY: false }), (error) => error.code === "PERSON_REQUIRED");
    const output = await h.run("verify", [device.resource.deviceId]);
    const store = await loadKeyStore(h.storePath);
    assert.equal(output.data.trust, "verified");
    assert.equal(output.data.safetyNumber, safetyNumber(Buffer.from(store.identity.publicKey, "base64url"), device.identity.publicKey));
    assert.equal((await h.run("status")).data.devices[0].trust, "verified");
    assert.equal((await h.run("verify", [device.resource.deviceId], { confirm: async () => false })).data.trust, "verified");
    assert.equal((await h.run("forget", [device.resource.deviceId])).data.removed, true);
    assert.equal((await h.run("status")).data.devices[0].trust, "auto", "forgotten phones are trusted again on use");
    await assert.rejects(h.run("verify", ["not-a-device"]), /Usage/);
  } finally {
    h.cleanup();
  }
});

test("require: on and auto need nobody, off needs a person", async () => {
  const h = harness({ devices: [], tty: false });
  try {
    assert.deepEqual((await h.run("require", ["on"])).data, { required: true, mode: "on", changed: true });
    assert.deepEqual((await h.run("require", ["auto"])).data, { required: true, mode: "auto", changed: true });
    await assert.rejects(h.run("require", ["off"]), (error) => error.code === "PERSON_REQUIRED");
    assert.deepEqual((await h.run("require", ["off"], { stdinIsTTY: true, confirm: async () => true })).data,
      { required: false, mode: "off", changed: true });
    await assert.rejects(h.run("require", ["maybe"]), /Usage/);
  } finally {
    h.cleanup();
  }
});

test("rotate needs a person and replaces the identity", async () => {
  const h = harness({ devices: [], tty: true, answer: true });
  try {
    const before = (await h.run("status")).data.identity.keyId;
    const rotated = await h.run("rotate");
    assert.equal(rotated.data.previous, before);
    assert.notEqual(rotated.data.keyId, before);
    assert.equal(h.published.at(-1).identityKey, (await loadKeyStore(h.storePath)).identity.publicKey);
    await assert.rejects(h.run("rotate", [], { stdinIsTTY: false }), (error) => error.code === "PERSON_REQUIRED");
  } finally {
    h.cleanup();
  }
});

test("the key store refuses loose permissions and corrupted identities, and tests never touch the real one", async () => {
  const folder = mkdtempSync(join(tmpdir(), "relo-keystore-"));
  const path = join(folder, "e2ee.json");
  try {
    const { store } = await ensureIdentity(path);
    chmodSync(path, 0o644);
    await assert.rejects(loadKeyStore(path), (error) => error.code === "INSECURE_KEY_STORE");
    chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify({ ...store, identity: { ...store.identity, publicKey: b64u(generateKeyPair().publicKey) } }));
    await assert.rejects(loadKeyStore(path), (error) => error.code === "INSECURE_KEY_STORE");
    assert.notEqual(keyStorePath(join(folder, "config.json"), {}), join(folder, "e2ee.json"),
      "with no override in the caller's env, the test-wide override still applies");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("a phone added after the first waits as pending until a person verifies it", async () => {
  const first = phone("Owner iPhone", "dev_00000000-0000-4000-8000-000000000001");
  const second = phone("Second phone", "dev_00000000-0000-4000-8000-000000000002");
  const h = harness({ devices: [first.resource], tty: true, answer: true });
  try {
    await h.run("status");
    h.state.devices = [first.resource, second.resource];
    const devices = (await h.run("status")).data.devices;
    assert.deepEqual(devices.map((device) => device.trust), ["auto", "pending"]);
    await assert.rejects(h.run("verify", [second.resource.deviceId], { stdinIsTTY: false }), (error) => error.code === "PERSON_REQUIRED");
    assert.equal((await h.run("verify", [second.resource.deviceId])).data.trust, "verified");
    assert.equal((await h.run("status")).data.devices[1].trust, "verified");
  } finally {
    h.cleanup();
  }
});
