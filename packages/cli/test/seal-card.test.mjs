import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { b64u, fromB64u, generateKeyPair, keyId, openEnvelope, prekeySigningInput, signBytes } from "../src/e2ee.mjs";
import { ensureIdentity, saveKeyStore, trustKey } from "../src/keystore.mjs";
import {
  cardStepLabelsFor, fitCardText, forgetCardText, loadCardText, mergedCardText, placeholderCardBody, saveCardText,
  SEALED_CARD_STATUS, SEALED_CARD_TITLE, sealCardRequest,
} from "../src/seal-card.mjs";

const apiUrl = "https://relo.example";
const cardId = "act_00000000-0000-4000-8000-000000000001";

function phone(deviceId) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = "2026-10-13T16:00:00.000Z";
  return { prekey, identity, resource: { deviceId, name: "iPhone",
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } } };
}

test("the server sees only placeholders and counts; the merged text keeps earlier fields", () => {
  const body = { title: "Deploy 0.12", status: "Building", detail: "secret detail", progressLabel: "3 of 10",
    steps: { labels: ["Build", "Test", "Ship"], current: 1 }, progress: 0.3 };
  assert.deepEqual(placeholderCardBody(body), { title: SEALED_CARD_TITLE, status: SEALED_CARD_STATUS,
    steps: { labels: ["Step 1", "Step 2", "Step 3"], current: 1 }, progress: 0.3 });
  const first = mergedCardText(null, body);
  assert.deepEqual(first, { title: "Deploy 0.12", status: "Building", detail: "secret detail", progressLabel: "3 of 10", steps: ["Build", "Test", "Ship"] });
  assert.deepEqual(mergedCardText(first, { status: "Testing", detail: null, steps: { labels: ["Build", "Test", "Ship"], current: 2 } }),
    { title: "Deploy 0.12", status: "Testing", progressLabel: "3 of 10", steps: ["Build", "Test", "Ship"] });
  const long = fitCardText({ title: "T".repeat(80), status: "S".repeat(60), detail: "D".repeat(240), steps: Array(8).fill("L".repeat(40)) });
  assert.ok(Buffer.byteLength(JSON.stringify(long)) <= 500);
});

test("the card cache is private, per card, and forgotten when the card ends", async () => {
  const directory = join(mkdtempSync(join(tmpdir(), "relo-cards-")), "sealed-cards");
  try {
    await saveCardText(directory, cardId, { title: "x", steps: ["Build", "Test"] });
    assert.equal(statSync(join(directory, `${cardId}.json`)).mode & 0o777, 0o600);
    assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.deepEqual(await loadCardText(directory, cardId), { title: "x", steps: ["Build", "Test"] });
    const dependencies = { env: { RELO_SEALED_CARD_DIR: directory } };
    assert.deepEqual(await cardStepLabelsFor(cardId, ["Step 1", "Step 2"], dependencies), ["Build", "Test"]);
    assert.deepEqual(await cardStepLabelsFor(cardId, ["Step 1"], dependencies), ["Step 1"], "a changed step count trusts the server");
    await forgetCardText(directory, cardId);
    assert.equal(await loadCardText(directory, cardId), null);
    assert.equal(await loadCardText(directory, "../escape"), null);
  } finally {
    rmSync(join(directory, ".."), { recursive: true, force: true });
  }
});

test("the account's phone opens the whole card text from its own envelope", async () => {
  const folder = mkdtempSync(join(tmpdir(), "relo-seal-card-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_SEALED_CARD_DIR: join(folder, "cards") };
  const device = phone("dev_00000000-0000-4000-8000-00000000000a");
  const dependencies = { configPath: () => join(folder, "config.json"), env };
  const client = { listDeviceKeys: async () => ({ devices: [device.resource] }), publishClientKey: async () => ({}) };
  const body = { title: "Deploy 0.12", status: "Building", steps: { labels: ["Build", "Ship"], current: 1 } };
  try {
    const noPhones = { listDeviceKeys: async () => ({ devices: [] }), publishClientKey: async () => ({}) };
    const plain = await sealCardRequest({ body, cardId: null, key: "k", client: noPhones, config: { apiUrl }, dependencies, notes: [] });
    assert.equal(plain.body, body);
    await sealCardRequest({ body, cardId: null, key: "k0", client, config: { apiUrl }, dependencies, notes: [] });
    const { store } = await ensureIdentity(env.RELO_KEY_STORE_PATH);
    await saveCardText(env.RELO_SEALED_CARD_DIR, cardId, { title: "Deploy 0.12", status: "Building", steps: ["Build", "Ship"] });
    const sealed = await sealCardRequest({ body: { status: "Shipping", steps: { labels: ["Step 1", "Step 2"], current: 2 } },
      cardId, key: "k2", client, config: { apiUrl }, dependencies, notes: [] });
    assert.equal(sealed.body.status, SEALED_CARD_STATUS);
    assert.ok(!JSON.stringify(sealed.body).includes("Shipping"));
    const opened = openEnvelope(sealed.body.sealed.alerts[0], { deviceId: device.resource.deviceId,
      prekeyPrivateKey: () => device.prekey.privateKey, trustedSenders: { [store.identity.keyId]: fromB64u(store.identity.publicKey) },
      expectedKind: "card" });
    assert.deepEqual(opened.content, { title: "Deploy 0.12", status: "Shipping", steps: ["Step 1", "Step 2"] });
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});
