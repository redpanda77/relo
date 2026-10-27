import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { sealedCardDirectory } from "../src/crypto/paths.mjs";
import { b64u, fromB64u, generateKeyPair, keyId, openEnvelope, prekeySigningInput, signBytes } from "../src/crypto/e2ee.mjs";
import { ensureIdentity, saveKeyStore, trustKey } from "../src/crypto/keystore.mjs";
import { cachedStepLabels, fitCardText, forgetCardText, loadCardText, mergedCardText, placeholderCardBody, saveCardText, sealCardRequest, SEALED_CARD_STATUS, SEALED_CARD_TITLE, withCardTextLock } from "../src/crypto/seal-card.mjs";

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
  assert.ok(Buffer.byteLength(JSON.stringify(long)) <= 700);
});

test("the card cache is private, per card, and forgotten when the card ends", async () => {
  const directory = join(mkdtempSync(join(tmpdir(), "relo-cards-")), "sealed-cards");
  try {
    await saveCardText(directory, cardId, { title: "x", steps: ["Build", "Test"] });
    if (process.platform !== "win32") assert.equal(statSync(join(directory, `${cardId}.json`)).mode & 0o777, 0o600);
    if (process.platform !== "win32") assert.equal(statSync(directory).mode & 0o777, 0o700);
    assert.deepEqual(await loadCardText(directory, cardId), { title: "x", steps: ["Build", "Test"] });
    const dependencies = { env: { RELO_STATE_DIR: dirname(directory) } };
    assert.deepEqual(await cachedStepLabels(cardId, 2, dependencies), ["Build", "Test"]);
    assert.equal(await cachedStepLabels(cardId, 1, dependencies), undefined, "a mismatched cache never stands in for labels");
    assert.equal(await cachedStepLabels("act_00000000-0000-4000-8000-000000000009", 2, dependencies), undefined, "nor does a missing one");
    await forgetCardText(directory, cardId);
    assert.equal(await loadCardText(directory, cardId), null);
    assert.equal(await loadCardText(directory, "../escape"), null);
  } finally {
    rmSync(join(directory, ".."), { recursive: true, force: true });
  }
});

test("the account's phone opens the whole card text from its own envelope", async () => {
  const folder = mkdtempSync(join(tmpdir(), "relo-seal-card-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state") };
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
    await saveCardText(sealedCardDirectory({ env }), cardId, { title: "Deploy 0.12", status: "Building", steps: ["Build", "Ship"] });
    // The server's "Step n" labels (read back for --next-step) are never sealed as the card's text.
    const sealed = await sealCardRequest({ body: { status: "Shipping", steps: { labels: ["Step 1", "Step 2"], current: 2, labelsFromServer: true } },
      cardId, key: "k2", client, config: { apiUrl }, dependencies, notes: [] });
    assert.equal(sealed.body.status, SEALED_CARD_STATUS);
    assert.ok(!JSON.stringify(sealed.body).includes("Shipping"));
    assert.ok(!JSON.stringify(sealed.body).includes("labelsFromServer"));
    const opened = openEnvelope(sealed.body.sealed.alerts[0], { deviceId: device.resource.deviceId,
      prekeyPrivateKey: () => device.prekey.privateKey, trustedSenders: { [store.identity.keyId]: fromB64u(store.identity.publicKey) },
      expectedKind: "card" });
    assert.deepEqual(opened.content, { title: "Deploy 0.12", status: "Shipping", steps: ["Build", "Ship"] });
    // Without a matching cache the text carries no labels at all: the phone keeps the ones it has.
    await saveCardText(sealedCardDirectory({ env }), cardId, { title: "Deploy 0.12", steps: ["Build", "Test", "Ship"] });
    const mismatched = await sealCardRequest({ body: { status: "Shipping", steps: { labels: ["Step 1", "Step 2"], current: 2, labelsFromServer: true } },
      cardId, key: "k3", client, config: { apiUrl }, dependencies, notes: [] });
    const reopened = openEnvelope(mismatched.body.sealed.alerts[0], { deviceId: device.resource.deviceId,
      prekeyPrivateKey: () => device.prekey.privateKey, trustedSenders: { [store.identity.keyId]: fromB64u(store.identity.publicKey) },
      expectedKind: "card" });
    assert.deepEqual(reopened.content, { title: "Deploy 0.12", status: "Shipping" });
    assert.deepEqual(mismatched.body.steps, { labels: ["Step 1", "Step 2"], current: 2 }, "the server still gets the current step");
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
});

test("the card text lock serializes read, merge and save across commands, and outlives no crash", async () => {
  const directory = join(mkdtempSync(join(tmpdir(), "relo-card-lock-")), "sealed-cards");
  try {
    const order = [];
    let release;
    const first = withCardTextLock(directory, cardId, async () => {
      order.push("first:read");
      await new Promise((resolve) => { release = resolve; });
      order.push("first:save");
    });
    for (let waited = 0; waited < 15_000 && order.length === 0; waited += 5) await new Promise((resolve) => setTimeout(resolve, 5));
    const second = withCardTextLock(directory, cardId, async () => { order.push("second:read"); });
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.deepEqual(order, ["first:read"], "the second command waits for the first to save");
    release();
    await Promise.all([first, second]);
    assert.deepEqual(order, ["first:read", "first:save", "second:read"]);
    // A lock left behind by a crashed command is broken once it is clearly stale.
    const lock = join(directory, `${cardId}.lock`);
    writeFileSync(lock, "");
    utimesSync(lock, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000));
    assert.equal(await withCardTextLock(directory, cardId, async () => "ran"), "ran");
    // Without a writable cache folder there is nothing to protect: the command runs unlocked.
    assert.equal(await withCardTextLock(join(process.env.RELO_TEST_UNWRITABLE, "lock-test"), cardId, async () => "unlocked"), "unlocked");
  } finally {
    rmSync(join(directory, ".."), { recursive: true, force: true });
  }
});
