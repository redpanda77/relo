import "./hermetic-env.mjs";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { answerProblem } from "../src/crypto/answer-verify.mjs";
import { isOwnerOverview, modelName, phoneLabel } from "../src/crypto/device-names.mjs";
import { answerSigningInput, approveDeviceSigningInput, b64u, generateKeyPair, keyId, prekeySigningInput, signBytes } from "../src/crypto/e2ee.mjs";
import { loadKeyStore, trustKey } from "../src/crypto/keystore.mjs";
import { sealablePhones, sealNotice } from "../src/crypto/seal-notice.mjs";
import { ensureTrust } from "../src/crypto/trust.mjs";

// docs/CHOICE-QUESTIONS.md, "Device capabilities": an owner overview device (the Mac's notch app) reads
// the account's cards and questions, so computers seal to it as a reader; it is never alerted (an alert
// envelope would make it a delivery target), never vouches for a phone, and its signed answers count.
const apiUrl = "https://relo.internal";

function endpoint(deviceId, { name = "iPhone", model, capabilities } = {}) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = new Date().toISOString();
  return { identity, device: { deviceId, kind: "phone", name, ...(model ? { model } : {}), ...(capabilities ? { capabilities } : {}),
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: false,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } } };
}

const owner = endpoint("dev_00000000-0000-4000-8000-00000000000a", { model: "iPhone18,1", capabilities: ["choice_questions"] });
const mac = endpoint("dev_00000000-0000-4000-8000-0000000000e1", { name: "Mac", model: "Mac16,1", capabilities: ["choice_questions", "owner_overview"] });
const pinnedAs = (entry, level = "auto") => ({ [trustKey(apiUrl, entry.device.deviceId)]: {
  deviceId: entry.device.deviceId, publicKey: entry.device.identityKey.publicKey, keyId: entry.device.identityKey.keyId, level } });

function harness() {
  const folder = mkdtempSync(join(tmpdir(), "relo-overview-"));
  const env = { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state") };
  const dependencies = { configPath: () => join(folder, "config.json"), env, now: () => Date.now(), stdinIsTTY: false };
  const client = (devices) => ({ publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices }),
    listDevices: async () => ({ devices: [] }), endToEndPolicy: async () => ({ required: false }) });
  const trust = (devices) => ensureTrust({ client: client(devices), config: { apiUrl }, dependencies });
  const level = async (entry) => (await loadKeyStore(env.RELO_KEY_STORE_PATH)).trusted[trustKey(apiUrl, entry.device.deviceId)]?.level;
  return { trust, level, cleanup: () => rmSync(folder, { recursive: true, force: true }) };
}

test("a Mac is named a Mac and recognized from the key listing or its pin", () => {
  assert.equal(modelName("Mac16,1"), "Mac");
  assert.equal(modelName("MacBookPro18,3"), "MacBook Pro");
  assert.equal(phoneLabel(mac.device), "Mac");
  assert.equal(isOwnerOverview(mac.device), true);
  assert.equal(isOwnerOverview({ ownerOverview: true }), true);
  assert.equal(isOwnerOverview(owner.device), false);
});

test("an overview device is a sealing reader: content envelope only, never an alert, even when phones are targeted", () => {
  const store = { trusted: { ...pinnedAs(owner), ...pinnedAs(mac) } };
  const { eligible, readers, skipped } = sealablePhones(store, apiUrl, [owner.device, mac.device], [owner.device.deviceId]);
  assert.deepEqual(eligible.map((entry) => entry.deviceId), [owner.device.deviceId]);
  assert.deepEqual(readers.map((entry) => entry.deviceId), [mac.device.deviceId]);
  assert.deepEqual(skipped, []);
  const sender = generateKeyPair();
  const sealed = sealNotice({ kind: "question", sender: { ...sender, keyId: keyId(sender.publicKey) }, idempotencyKey: "q1",
    phones: eligible, readers, content: { title: "Question", summary: "Deploy?" } });
  // Alerts name the targets the server delivers to: the phone only.
  assert.deepEqual(sealed.alerts.map((alert) => alert.recipients[0].device), [owner.device.deviceId]);
  assert.deepEqual(sealed.content.recipients.map((recipient) => recipient.device).sort(), [owner.device.deviceId, mac.device.deviceId].sort());
});

test("a Mac never holds back the re-trust of an iPhone set up again", async () => {
  const h = harness();
  try {
    await h.trust([owner.device, mac.device]);
    assert.equal(await h.level(owner), "auto");
    const fresh = endpoint("dev_00000000-0000-4000-8000-0000000000f1", { model: "iPhone18,2" });
    await h.trust([mac.device, fresh.device]);
    assert.equal(await h.level(fresh), "auto");
  } finally { h.cleanup(); }
});

test("a Mac's approval of a new phone does not count", async () => {
  const h = harness();
  try {
    await h.trust([owner.device, mac.device]);
    assert.equal(await h.level(mac), "auto");
    const added = endpoint("dev_00000000-0000-4000-8000-0000000000f2", { model: "iPhone19,2" });
    const signedAt = new Date().toISOString();
    const approval = { deviceId: mac.device.deviceId, signedAt, signature: b64u(signBytes(mac.identity.privateKey,
      approveDeviceSigningInput({ deviceId: added.device.deviceId, identityKey: added.device.identityKey.publicKey,
        approverDeviceId: mac.device.deviceId, signedAt }))) };
    await h.trust([owner.device, mac.device, { ...added.device, approval }]);
    assert.equal(await h.level(added), "pending");
  } finally { h.cleanup(); }
});

test("a trusted Mac's signed answer on the asked copy verifies like a phone's", () => {
  const store = { trusted: pinnedAs(mac) };
  const copy = { id: "int_00000000-0000-4000-8000-000000000001", eventId: "ntf_00000000-0000-4000-8000-000000000001" };
  const at = new Date().toISOString();
  const fields = { interactionId: copy.id, notificationId: copy.eventId, deviceId: mac.device.deviceId, value: "approve", respondedAt: at };
  const interaction = { id: copy.id, eventId: copy.eventId, state: "approved", respondingDevice: { id: mac.device.deviceId, name: "Mac" },
    response: { e2eeKeyId: keyId(mac.identity.publicKey), e2eeSignedAt: at, e2eeSignature: b64u(signBytes(mac.identity.privateKey, answerSigningInput(fields))) } };
  assert.equal(answerProblem(interaction, store, apiUrl, { interactionId: copy.id }), null);
  assert.equal(answerProblem(interaction, { trusted: pinnedAs(mac, "pending") }, apiUrl, { interactionId: copy.id }),
    "answered on a phone this computer does not trust");
});

test("Relo for Mac alone never counts as the trusted phone that commits a computer to encryption", async () => {
  const { trustedPhones } = await import("../src/crypto/trust.mjs");
  const api = "https://relo.example";
  const store = { trusted: {
    [`${api}|dev_mac`]: { deviceId: "dev_mac", level: "auto", ownerOverview: true, publicKey: "k1" },
  } };
  assert.deepEqual(trustedPhones(store, api), []);
  store.trusted[`${api}|dev_phone`] = { deviceId: "dev_phone", level: "auto", publicKey: "k2" };
  assert.deepEqual(trustedPhones(store, api).map((entry) => entry.deviceId), ["dev_phone"]);
});

// A Mac-only account on a remote server: "Always" with no phone must not deadlock the owner.
async function macOnlyNotice({ required, committed = false, withPhone = false }) {
  const { sealNoticeRequest } = await import("../src/crypto/seal-notice.mjs");
  const h = harness();
  try {
    const devices = withPhone ? [owner.device, mac.device] : [mac.device];
    const client = { publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices }),
      listDevices: async () => ({ devices: [] }), endToEndPolicy: async () => ({ required }) };
    const folder = mkdtempSync(join(tmpdir(), "relo-overview-notice-"));
    const dependencies = { configPath: () => join(folder, "config.json"),
      env: { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state") }, now: () => Date.now(), stdinIsTTY: false };
    if (committed) {
      // The Mac is pinned on first contact; only then does the computer commit (for example after a phone was removed).
      const { saveKeyStore, loadKeyStore } = await import("../src/crypto/keystore.mjs");
      await ensureTrust({ client, config: { apiUrl, token: "t" }, dependencies });
      const store = await loadKeyStore(dependencies.env.RELO_KEY_STORE_PATH);
      store.committed = { [apiUrl]: true };
      await saveKeyStore(dependencies.env.RELO_KEY_STORE_PATH, store);
    }
    const notes = [];
    try {
      return await sealNoticeRequest({ body: { title: "Done", summary: "ok", context: undefined }, key: "k1", client, config: { apiUrl, token: "t" }, dependencies, notes });
    } finally { rmSync(folder, { recursive: true, force: true }); }
  } finally { h.cleanup(); }
}

test("Mac only and the server requires encryption: the notice is sealed for the Mac, never sent readable", async () => {
  const body = await macOnlyNotice({ required: true });
  assert.ok(body.sealed, "sealed");
  assert.equal(body.title, undefined, "no readable title");
  assert.deepEqual(body.sealed.alerts.map((alert) => alert.recipients[0].device), [mac.device.deviceId]);
  assert.deepEqual(body.sealed.content.recipients.map((recipient) => recipient.device), [mac.device.deviceId]);
});

test("Mac only and the server is Automatic: the notice stays readable", async () => {
  const body = await macOnlyNotice({ required: false });
  assert.equal(body.sealed, undefined);
  assert.equal(body.title, "Done");
});

test("Mac only on a computer already committed to encryption: sealed for the Mac, not refused", async () => {
  const body = await macOnlyNotice({ required: false, committed: true });
  assert.deepEqual(body.sealed.alerts.map((alert) => alert.recipients[0].device), [mac.device.deviceId]);
});

test("with a phone nothing changes: the phone is alerted and the Mac reads", async () => {
  const body = await macOnlyNotice({ required: true, withPhone: true });
  assert.deepEqual(body.sealed.alerts.map((alert) => alert.recipients[0].device), [owner.device.deviceId]);
  assert.deepEqual(body.sealed.content.recipients.map((recipient) => recipient.device).sort(), [owner.device.deviceId, mac.device.deviceId].sort());
});

// A pinned phone that was merely skipped is never replaced by the Mac: the phone would silently get nothing.
function staleEndpoint(deviceId) {
  const identity = generateKeyPair();
  const prekey = generateKeyPair();
  const createdAt = new Date(Date.now() - 60 * 86_400_000).toISOString();
  return { identity, device: { deviceId, kind: "phone", name: "iPhone", model: "iPhone18,1",
    identityKey: { keyId: keyId(identity.publicKey), publicKey: b64u(identity.publicKey), changedAt: createdAt },
    prekey: { prekeyId: "pk_1", publicKey: b64u(prekey.publicKey), createdAt, stale: true,
      signature: b64u(signBytes(identity.privateKey, prekeySigningInput({ deviceId, prekeyId: "pk_1", publicKey: prekey.publicKey, createdAt }))) } } };
}

// ensureTrust pins Relo for Mac with ownerOverview, which is what keeps it from counting as a phone.
const macPin = () => Object.fromEntries(Object.entries(pinnedAs(mac)).map(([key, entry]) => [key, { ...entry, ownerOverview: true }]));

async function recipientsFor({ pins, devices, required = true, committed = false }) {
  const { sealRecipients } = await import("../src/crypto/seal-notice.mjs");
  const trust = { store: { trusted: pins }, devices, committed };
  const client = { endToEndPolicy: async () => ({ required }) };
  return sealRecipients({ trust, client, config: { apiUrl } });
}

test("Mac only (no phone pinned) and the server requires encryption: the Mac stands in", async () => {
  const found = await recipientsFor({ pins: macPin(), devices: [mac.device] });
  assert.deepEqual(found.eligible.map((entry) => entry.deviceId), [mac.device.deviceId]);
  assert.deepEqual(found.skipped, []);
});

test("a pinned phone with a stale key is skipped with its reason and the Mac does not stand in", async () => {
  const stale = staleEndpoint("dev_00000000-0000-4000-8000-0000000000b1");
  const found = await recipientsFor({ pins: { ...pinnedAs(stale), ...macPin() }, devices: [stale.device, mac.device], committed: true });
  assert.deepEqual(found.eligible, []);
  assert.equal(found.skipped.length, 1);
  assert.match(found.skipped[0].reason, /no fresh key/u);
  const { noRecipientReason, sealNoticeRequest } = await import("../src/crypto/seal-notice.mjs");
  assert.match(noRecipientReason(found.skipped), /no fresh key/u);
  // Through a sealer: committed to encryption, the command is refused, naming the phone's reason.
  const h = harness();
  try {
    const client = { publishClientKey: async () => ({}), listDeviceKeys: async () => ({ devices: [stale.device, mac.device] }),
      listDevices: async () => ({ devices: [] }), endToEndPolicy: async () => ({ required: true }) };
    const folder = mkdtempSync(join(tmpdir(), "relo-stale-notice-"));
    const dependencies = { configPath: () => join(folder, "config.json"),
      env: { RELO_KEY_STORE_PATH: join(folder, "e2ee.json"), RELO_STATE_DIR: join(folder, "state") }, now: () => Date.now(), stdinIsTTY: false };
    try {
      const { saveKeyStore, loadKeyStore } = await import("../src/crypto/keystore.mjs");
      await ensureTrust({ client, config: { apiUrl, token: "t" }, dependencies });
      const store = await loadKeyStore(dependencies.env.RELO_KEY_STORE_PATH);
      store.committed = { [apiUrl]: true };
      await saveKeyStore(dependencies.env.RELO_KEY_STORE_PATH, store);
      await assert.rejects(sealNoticeRequest({ body: { title: "Done", summary: "ok" }, key: "k1", client, config: { apiUrl, token: "t" }, dependencies, notes: [] }),
        (error) => error.code === "E2EE_UNAVAILABLE" && /no fresh key/u.test(error.message));
    } finally { rmSync(folder, { recursive: true, force: true }); }
  } finally { h.cleanup(); }
});

test("a pinned phone held for approval is skipped and the Mac does not stand in", async () => {
  const waiting = endpoint("dev_00000000-0000-4000-8000-0000000000b2", { model: "iPhone18,1" });
  const found = await recipientsFor({ pins: { ...pinnedAs(waiting, "pending"), ...macPin() }, devices: [waiting.device, mac.device] });
  assert.deepEqual(found.eligible, []);
  assert.match(found.skipped[0].reason, /waiting for approval/u);
});

test("a phone changed in strict mode (key differs from the pin) is skipped and the Mac does not stand in", async () => {
  const original = endpoint("dev_00000000-0000-4000-8000-0000000000b3", { model: "iPhone18,1" });
  const changed = endpoint(original.device.deviceId, { model: "iPhone18,1" });
  const found = await recipientsFor({ pins: { ...pinnedAs(original), ...macPin() }, devices: [changed.device, mac.device] });
  assert.deepEqual(found.eligible, []);
  assert.match(found.skipped[0].reason, /security code changed/u);
});
