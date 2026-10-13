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
  const prompts = [];
  const printed = [];
  const dependencies = {
    configPath: () => join(folder, "config.json"),
    env: {},
    now: () => Date.parse("2026-10-13T17:00:00.000Z"),
    stdinIsTTY: tty,
    confirm: async (question) => { prompts.push(question); return answer; },
    stderr: (line) => printed.push(line),
  };
  const client = {
    publishClientKey: async (body) => { published.push(body); return { keyId: "k" }; },
    listDeviceKeys: async () => ({ devices }),
  };
  const run = (action, rest = []) => runKeysCommand({
    group: "keys", action, rest, options: {}, dependencies, client, config: { apiUrl },
  });
  return { folder, published, prompts, printed, run, storePath: keyStorePath(join(folder, "config.json"), {}),
    cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

test("status creates a private identity, publishes only its public half and lists unverified phones", async () => {
  const device = phone();
  const h = harness({ devices: [device.resource] });
  try {
    const output = await h.run("status");
    const store = await loadKeyStore(h.storePath);
    assert.equal(statSync(h.storePath).mode & 0o777, 0o600);
    assert.deepEqual(h.published, [{ identityKey: store.identity.publicKey }]);
    assert.equal(output.data.identity.keyId, store.identity.keyId);
    assert.deepEqual(output.data.devices, [{ deviceId: device.resource.deviceId, name: "Owner iPhone", keyId: device.resource.identityKey.keyId, trust: "unverified", prekey: "fresh" }]);
    assert.equal(output.data.next, `relo keys verify ${device.resource.deviceId}`);
    assert.equal((await h.run("status")).data.identity.keyId, store.identity.keyId, "the identity is created once");
  } finally {
    h.cleanup();
  }
});

test("an agent without a terminal cannot verify a phone", async () => {
  const device = phone();
  const h = harness({ devices: [device.resource], tty: false });
  try {
    await assert.rejects(h.run("verify", [device.resource.deviceId]), (error) => error.code === "PERSON_REQUIRED" && error.exitCode === 2);
    assert.deepEqual((await loadKeyStore(h.storePath)).trusted, {});
  } finally {
    h.cleanup();
  }
});

test("a person who confirms the safety number pins that exact phone key; a changed key is not trusted", async () => {
  const device = phone();
  const h = harness({ devices: [device.resource], tty: true, answer: true });
  try {
    const output = await h.run("verify", [device.resource.deviceId]);
    const store = await loadKeyStore(h.storePath);
    const expected = safetyNumber(Buffer.from(store.identity.publicKey, "base64url"), device.identity.publicKey);
    assert.equal(output.data.trust, "trusted");
    assert.equal(output.data.safetyNumber, expected);
    assert.ok(h.printed.join("\n").includes(expected.split(" ").slice(0, 6).join(" ")));
    assert.equal(store.trusted[`${apiUrl}|${device.resource.deviceId}`].publicKey, device.resource.identityKey.publicKey);
    assert.equal((await h.run("status")).data.devices[0].trust, "trusted");

    // The server swaps in its own key for the same phone id: the CLI reports it as changed.
    const impostor = phone("Owner iPhone", device.resource.deviceId);
    const swapped = harness({ devices: [impostor.resource] });
    swapped.storePath = h.storePath;
    const status = await runKeysCommand({ group: "keys", action: "status", rest: [], options: {},
      dependencies: { configPath: () => join(h.folder, "config.json"), env: {}, now: () => 0 }, client: {
        publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices: [impostor.resource] }) }, config: { apiUrl } });
    swapped.cleanup();
    assert.equal(status.data.devices[0].trust, "changed");

    assert.equal((await h.run("forget", [device.resource.deviceId])).data.removed, true);
    assert.equal((await h.run("status")).data.devices[0].trust, "unverified");
  } finally {
    h.cleanup();
  }
});

test("declining keeps the phone untrusted, and a forged prekey signature shows as invalid", async () => {
  const device = phone();
  device.resource.prekey.signature = b64u(Buffer.alloc(64, 1));
  const h = harness({ devices: [device.resource], tty: true, answer: false });
  try {
    assert.equal((await h.run("verify", [device.resource.deviceId])).data.trust, "unverified");
    assert.equal((await h.run("status")).data.devices[0].prekey, "invalid");
    await assert.rejects(h.run("verify", ["not-a-device"]), /Usage/);
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
    const agent = harness({ devices: [], tty: false });
    await assert.rejects(agent.run("rotate"), (error) => error.code === "PERSON_REQUIRED");
    agent.cleanup();
  } finally {
    h.cleanup();
  }
});

test("the key store refuses loose permissions and corrupted identities", async () => {
  const folder = mkdtempSync(join(tmpdir(), "relo-keystore-"));
  const path = join(folder, "e2ee.json");
  try {
    const { store } = await ensureIdentity(path);
    chmodSync(path, 0o644);
    await assert.rejects(loadKeyStore(path), (error) => error.code === "INSECURE_KEY_STORE");
    chmodSync(path, 0o600);
    writeFileSync(path, JSON.stringify({ ...store, identity: { ...store.identity, publicKey: b64u(generateKeyPair().publicKey) } }));
    await assert.rejects(loadKeyStore(path), (error) => error.code === "INSECURE_KEY_STORE");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("require needs a person and reports the account setting", async () => {
  const calls = [];
  const h = harness({ devices: [], tty: true, answer: true });
  try {
    const client = { endToEndPolicy: async () => ({ required: false }), setEndToEndPolicy: async (required) => { calls.push(required); return { required }; } };
    const run = (rest, dependencies) => runKeysCommand({ group: "keys", action: "require", rest, options: {},
      dependencies, client, config: { apiUrl } });
    const dependencies = { configPath: () => join(h.folder, "config.json"), env: {}, now: () => 0, stdinIsTTY: true, confirm: async () => true };
    assert.deepEqual((await run(["on"], dependencies)).data, { required: true, changed: true });
    assert.deepEqual((await run(["off"], { ...dependencies, confirm: async () => false })).data, { required: true, changed: false });
    await assert.rejects(run(["on"], { ...dependencies, stdinIsTTY: false }), (error) => error.code === "PERSON_REQUIRED");
    await assert.rejects(run(["maybe"], dependencies), /Usage/);
    assert.deepEqual(calls, [true]);
  } finally {
    h.cleanup();
  }
});
